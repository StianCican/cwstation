// P2-015 试验记录目录：写前持久化意图并刷盘（fsync）。
//
// 边界：
//  - 记录是 append-only JSONL；每条写入后 fsync 才返回。调用方必须在真实
//    Command 17 写出之前先 await append({event:"intent"})，失败即不得发送。
//  - hasUnresolvedIntent 只要发现任一 intent 记录（或文件损坏/超大）就返回
//    true；本模块不提供任何自动清除或“无证据 clear”，重启同一目录不能清除
//    未解决意图。
//  - 不打开串口、不写 DB、不发射；目录与文件由调用方显式给出。

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const CW_TRIAL_RECORD_SCHEMA_VERSION = 1 as const;
export const CW_TRIAL_RECORD_FILE = "cw-trial-intent.jsonl";

const MAX_RECORD_BYTES = 1_048_576;
const MAX_RECORDS = 1_000;

export type CwTrialRecordEvent =
  | "intent"
  | "send_result"
  | "stop_intent"
  | "stop_result"
  | "session_close";

export interface CwTrialRecordInput {
  readonly event: CwTrialRecordEvent;
  readonly message?: "E" | "TEST" | null;
  readonly contextFingerprint?: string | null;
  readonly detail?: string | null;
}

export interface CwTrialRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly at: string;
  readonly event: CwTrialRecordEvent;
  readonly message: "E" | "TEST" | null;
  readonly contextFingerprint: string | null;
  readonly detail: string | null;
}

export interface CwTrialRecordScan {
  readonly records: readonly CwTrialRecord[];
  /** 文件存在但存在损坏/超限内容；调用方必须按未解决处理。 */
  readonly corrupted: boolean;
  readonly present: boolean;
}

const EVENTS: ReadonlySet<string> = new Set<CwTrialRecordEvent>([
  "intent",
  "send_result",
  "stop_intent",
  "stop_result",
  "session_close",
]);

function parseRecord(line: string): CwTrialRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== CW_TRIAL_RECORD_SCHEMA_VERSION) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return null;
  if (typeof raw.at !== "string" || raw.at.length === 0) return null;
  if (typeof raw.event !== "string" || !EVENTS.has(raw.event)) return null;
  const message = raw.message;
  if (message !== null && message !== "E" && message !== "TEST") return null;
  const fingerprint = raw.contextFingerprint;
  if (fingerprint !== null && typeof fingerprint !== "string") return null;
  const detail = raw.detail;
  if (detail !== null && typeof detail !== "string") return null;
  return {
    schemaVersion: CW_TRIAL_RECORD_SCHEMA_VERSION,
    id: raw.id,
    sessionId: raw.sessionId,
    at: raw.at,
    event: raw.event as CwTrialRecordEvent,
    message: message as "E" | "TEST" | null,
    contextFingerprint: fingerprint as string | null,
    detail: detail as string | null,
  };
}

/**
 * 试验目录的只追加记录器。一个实例串行化本进程内的写入；每次写入后 fsync，
 * 保证真实写出前意图已落盘。
 */
export class CwTrialRecordStore {
  readonly directory: string;
  readonly file: string;
  private readonly sessionId = randomUUID();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(directory: string) {
    this.directory = directory;
    this.file = join(directory, CW_TRIAL_RECORD_FILE);
  }

  static async open(directory: string): Promise<CwTrialRecordStore> {
    if (typeof directory !== "string" || directory.trim().length === 0) {
      throw new Error("CW trial record directory must be a non-empty path");
    }
    await fs.mkdir(directory, { recursive: true });
    // best-effort fsync 目录项；不支持目录 fsync 的平台上忽略。
    try {
      const dir = await fs.open(directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // 目录 fsync 失败不阻止记录写入；文件本身仍会 fsync。
    }
    return new CwTrialRecordStore(directory);
  }

  /** 追加一条记录；返回前已 fsync。 */
  async append(input: CwTrialRecordInput): Promise<CwTrialRecord> {
    const record: CwTrialRecord = {
      schemaVersion: CW_TRIAL_RECORD_SCHEMA_VERSION,
      id: randomUUID(),
      sessionId: this.sessionId,
      at: new Date().toISOString(),
      event: input.event,
      message: input.message ?? null,
      contextFingerprint: input.contextFingerprint ?? null,
      detail: input.detail ?? null,
    };
    const line = `${JSON.stringify(record)}\n`;
    const run = this.writeQueue.then(() => this.appendLine(line));
    this.writeQueue = run.catch(() => undefined);
    await run;
    return record;
  }

  /**
   * 读取全部合法记录。损坏行不抛出，而是通过 corrupted 标记向上报告；调用方
   * 必须把 corrupted 当作未解决证据处理（fail closed）。
   */
  async scan(): Promise<CwTrialRecordScan> {
    let content: string;
    try {
      content = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { records: [], corrupted: false, present: false };
      }
      throw error;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
      return { records: [], corrupted: true, present: true };
    }
    const records: CwTrialRecord[] = [];
    let corrupted = false;
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      const record = parseRecord(line);
      if (record === null) {
        corrupted = true;
        continue;
      }
      records.push(record);
      if (records.length > MAX_RECORDS) {
        corrupted = true;
        break;
      }
    }
    return { records, corrupted, present: true };
  }

  /** 只读记录副本。 */
  async readAll(): Promise<readonly CwTrialRecord[]> {
    const scan = await this.scan();
    return scan.records;
  }

  /**
   * 是否存在未解决意图。任何 intent 记录都保持未解决；损坏/超限内容同样
   * 视为未解决。本模块不提供清除入口。
   */
  async hasUnresolvedIntent(): Promise<boolean> {
    const scan = await this.scan();
    return scan.corrupted || scan.records.some((record) => record.event === "intent");
  }

  private async appendLine(line: string): Promise<void> {
    const handle = await fs.open(this.file, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
