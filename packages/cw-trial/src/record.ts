// P2-015 试验记录目录：写前持久化意图并刷盘（fsync）。
//
// 边界：
//  - 记录是 append-only JSONL；每条写入后 fsync 才返回。调用方必须在真实
//    Command 17 写出之前先 await append({event:"intent"})，失败即不得发送。
//  - intent 仅可由同账本绑定内容摘要的显式人工核查解除后续阻断；旧结果仍未知。
//    损坏/超限或无效核查保持阻断；不自动清除，不重放旧报文。
//  - 不打开串口、不写 DB、不发射；目录与文件由调用方显式给出。

import { createHash, randomUUID } from "node:crypto";
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

export interface CwTrialIntentReview {
  readonly intentId: string;
  readonly intentDigest: string;
  readonly operator: string;
  readonly note: string;
}

export interface CwTrialRecordInput {
  readonly event: CwTrialRecordEvent;
  readonly message?: string | null;
  readonly contextFingerprint?: string | null;
  readonly detail?: string | null;
}

export interface CwTrialRecord {
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly sessionId: string;
  readonly at: string;
  readonly event: CwTrialRecordEvent | "intent_review";
  readonly message: string | null;
  readonly contextFingerprint: string | null;
  readonly detail: string | null;
  readonly review?: CwTrialIntentReview;
}

export function cwTrialIntentDigest(record: CwTrialRecord): string {
  if (record.event !== "intent" || record.schemaVersion !== 1) throw new Error("review target must be a v1 intent");
  return createHash("sha256").update(JSON.stringify([
    record.schemaVersion, record.id, record.sessionId, record.at, record.event,
    record.message, record.contextFingerprint, record.detail,
  ])).digest("hex");
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
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return null;
  if (typeof raw.at !== "string" || raw.at.length === 0) return null;
  if (raw.schemaVersion === 1 && (typeof raw.event !== "string" || !EVENTS.has(raw.event))) return null;
  let review: CwTrialIntentReview | undefined;
  if (raw.schemaVersion === 2) {
    if (raw.event !== "intent_review" || raw.message !== null || raw.contextFingerprint !== null || raw.detail !== null
        || raw.review === null || typeof raw.review !== "object" || Array.isArray(raw.review)) return null;
    const item = raw.review as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "intentDigest,intentId,note,operator"
        || typeof item.intentId !== "string" || !item.intentId.trim()
        || typeof item.intentDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.intentDigest)
        || !validReviewText(item.operator, 100) || !validReviewText(item.note, 2000)) return null;
    review = { intentId: item.intentId, intentDigest: item.intentDigest,
      operator: item.operator as string, note: item.note as string };
  }
  const message = raw.message;
  if (message !== null && !validMessageText(message, 30)) return null;
  const fingerprint = raw.contextFingerprint;
  if (fingerprint !== null && typeof fingerprint !== "string") return null;
  const detail = raw.detail;
  if (detail !== null && typeof detail !== "string") return null;
  return {
    schemaVersion: raw.schemaVersion,
    id: raw.id,
    sessionId: raw.sessionId,
    at: raw.at,
    event: raw.event as CwTrialRecord["event"],
    message: message as string | null,
    contextFingerprint: fingerprint as string | null,
    detail: detail as string | null,
    ...(review === undefined ? {} : { review }),
  };
}

function validReviewText(value: unknown, max: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function validMessageText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function pendingIntents(scan: CwTrialRecordScan): CwTrialRecord[] {
  if (scan.corrupted) throw new Error("record file is corrupted or unsupported; review refused");
  const pending = new Map<string, CwTrialRecord>();
  const ids = new Set<string>();
  for (const row of scan.records) {
    if (ids.has(row.id)) throw new Error("duplicate record id; review refused");
    ids.add(row.id);
    if (row.event === "intent") pending.set(row.id, row);
    if (row.event === "intent_review") {
      const target = pending.get(row.review!.intentId);
      if (target === undefined || cwTrialIntentDigest(target) !== row.review!.intentDigest) {
        throw new Error("invalid intent review reference; record remains blocked");
      }
      pending.delete(target.id);
    }
  }
  return [...pending.values()];
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
  private exclusive = false;
  private reviewWriteUncertain = false;

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

  /** Shared by trial and review for their entire lifetime. Never reclaim stale locks automatically. */
  async acquireExclusive(): Promise<() => Promise<void>> {
    if (this.exclusive) throw new Error("record directory already locked by this store");
    const directory = await fs.realpath(this.directory);
    const lock = join(directory, ".cw-trial.lock");
    await fs.mkdir(lock).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`record directory is locked: ${lock}; stop competing tasks or manually inspect a stale lock; never delete ledger records`);
      }
      throw error;
    });
    try {
      const stat = await fs.lstat(this.file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (stat !== null && (!stat.isFile() || stat.nlink !== 1)) throw new Error("record aliases or non-regular files are not supported");
    } catch (error) { await fs.rmdir(lock); throw error; }
    this.exclusive = true;
    return async () => {
      if (!this.exclusive) return;
      await this.writeQueue;
      if (this.reviewWriteUncertain) throw new Error("review write outcome UNKNOWN; record directory lock retained; inspect ledger and persistence before manual recovery");
      await fs.rmdir(lock);
      this.exclusive = false;
    };
  }

  async intentForReview(id: string): Promise<CwTrialRecord> {
    if (!this.exclusive) throw new Error("intent review requires exclusive record directory");
    const target = pendingIntents(await this.scan()).find(row => row.id === id);
    if (target === undefined) throw new Error("intent is missing or already reviewed");
    return target;
  }

  async reviewIntent(input: CwTrialIntentReview, signal?: AbortSignal): Promise<void> {
    if (!validReviewText(input.operator, 100) || !validReviewText(input.note, 2000)) throw new Error("invalid operator or review note");
    const copy = { ...input };
    const run = this.writeQueue.then(async () => {
      signal?.throwIfAborted();
      const target = await this.intentForReview(copy.intentId);
      if (cwTrialIntentDigest(target) !== copy.intentDigest) throw new Error("intent changed since review confirmation");
      const record: CwTrialRecord = {
        schemaVersion: 2, id: randomUUID(), sessionId: this.sessionId, at: new Date().toISOString(),
        event: "intent_review", message: null, contextFingerprint: null, detail: null, review: copy,
      };
      signal?.throwIfAborted();
      try { await this.appendLine(`${JSON.stringify(record)}\n`); }
      catch (error) { this.reviewWriteUncertain = true; throw error; }
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
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
   * 人工核查只解除指定 intent 对后续新操作的阻断，不改变旧操作结果。
   * 损坏/超限、错误引用或未知版本仍阻断。
   */
  async hasUnresolvedIntent(): Promise<boolean> {
    const scan = await this.scan();
    try { return pendingIntents(scan).length > 0; }
    catch { return true; }
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
