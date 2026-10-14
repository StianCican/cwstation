import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RigStatusReport, RigStatusHistoryEvent, RigStatusHistorySink } from "./service.js";

export const RIG_STATUS_HISTORY_SCHEMA_VERSION = 1 as const;
export const RIG_STATUS_HISTORY_MAX_READ_BYTES = 8 * 1024 * 1024;
export const RIG_STATUS_HISTORY_MAX_TAIL = 1_000;

export interface RigStatusHistoryRecord {
  readonly schemaVersion: typeof RIG_STATUS_HISTORY_SCHEMA_VERSION;
  readonly recordedAt: number;
  readonly event: RigStatusHistoryEvent;
  readonly report: RigStatusReport;
}

/** Append-only JSONL sink; serialized writes preserve lifecycle order. */
export class RigStatusHistoryWriter implements RigStatusHistorySink {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private writeError: string | null = null;
  private directoryReady: Promise<void> | null = null;

  constructor(path: string) {
    const value = path.trim();
    if (value.length === 0) throw new Error("history path must not be empty");
    this.path = resolve(value);
  }

  get lastError(): string | null { return this.writeError; }

  record(event: RigStatusHistoryEvent, report: RigStatusReport): void {
    const record: RigStatusHistoryRecord = {
      schemaVersion: RIG_STATUS_HISTORY_SCHEMA_VERSION,
      recordedAt: Date.now(),
      event,
      report,
    };
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(async () => {
        if (this.directoryReady === null) {
          this.directoryReady = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
        }
        await this.directoryReady;
        await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error: unknown) => {
        this.writeError = error instanceof Error ? error.message : String(error);
      });
  }

  async close(): Promise<void> { await this.queue; }
}

const HISTORY_EVENTS: ReadonlySet<string> = new Set([
  "service_start", "snapshot", "fault", "reconnect", "service_stop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and validate the bounded tail of a versioned history file. */
export async function readRigStatusHistory(path: string, tail = 100): Promise<RigStatusHistoryRecord[]> {
  const value = path.trim();
  if (value.length === 0) throw new Error("history path must not be empty");
  if (!Number.isInteger(tail) || tail < 1 || tail > RIG_STATUS_HISTORY_MAX_TAIL) {
    throw new Error(`history tail must be an integer in [1, ${RIG_STATUS_HISTORY_MAX_TAIL}]`);
  }
  const text = await readFile(resolve(value), "utf8");
  if (Buffer.byteLength(text, "utf8") > RIG_STATUS_HISTORY_MAX_READ_BYTES) {
    throw new Error(`history file exceeds ${RIG_STATUS_HISTORY_MAX_READ_BYTES} bytes`);
  }
  const records: RigStatusHistoryRecord[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid history JSON at line ${index + 1}`);
    }
    if (!isRecord(parsed)
      || parsed.schemaVersion !== RIG_STATUS_HISTORY_SCHEMA_VERSION
      || typeof parsed.recordedAt !== "number"
      || typeof parsed.event !== "string"
      || !HISTORY_EVENTS.has(parsed.event)
      || !isRecord(parsed.report)
      || parsed.report.source !== "rig-statusd"
      || parsed.report.readOnly !== true) {
      throw new Error(`invalid history record at line ${index + 1}`);
    }
    records.push(parsed as unknown as RigStatusHistoryRecord);
  }
  return records.slice(-tail);
}
