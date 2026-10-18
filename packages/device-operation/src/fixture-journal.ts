// Temporary simulation fixtures only. This is NOT the production P2-016 ledger/import format.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireLock, type LockHandle } from "../../daemon/src/lock.js";
import { bounded, exact, OperationError, uuid, type Operation } from "./protocol.js";

export interface Journal {
  readonly operations: Map<string, Operation>;
  hasCapacity(): boolean;
  append(operation: Operation): Promise<void>;
  flush(): Promise<void>;
  release(): void;
}

export function validateOperation(value: unknown): asserts value is Operation {
  exact(value, ["operationId", "proposalId", "approvalId", "bindingDigest", "source", "state", "unresolved", "send", "stop", "errorCode"]);
  if (![value.operationId, value.proposalId, value.approvalId].every(uuid) || value.source !== "simulation" ||
    typeof value.bindingDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.bindingDigest) ||
    !["dispatching", "unknown", "completed", "cancelled", "notDispatched"].includes(value.state as string) ||
    value.unresolved !== ["dispatching", "unknown"].includes(value.state as string) ||
    !(value.errorCode === null || ["timeout", "expired", "staleContext", "storageFault", "unavailable", "blocked"].includes(value.errorCode as string)))
    throw new OperationError("blocked", "invalid simulation operation");
  const checkObservation = (raw: unknown): void => {
    exact(raw, ["requestDispatched", "ackObservation", "evidence"]);
    if (typeof raw.requestDispatched !== "boolean" || !["none", "ack_observed", "unattributed"].includes(raw.ackObservation as string) ||
      !["unavailable", "simulationCompleted", "simulationStopped"].includes(raw.evidence as string)) throw new OperationError("blocked");
    if (raw.evidence !== "unavailable" && raw.requestDispatched !== true) throw new OperationError("blocked");
  };
  checkObservation(value.send);
  if (value.stop !== null) {
    exact(value.stop, ["stopId", "operationId", "alreadyAttempted", "observation", "operationState"]);
    if (!uuid(value.stop.stopId) || value.stop.operationId !== value.operationId || typeof value.stop.alreadyAttempted !== "boolean" ||
      !["dispatching", "unknown", "completed", "cancelled"].includes(value.stop.operationState as string)) throw new OperationError("blocked");
    checkObservation(value.stop.observation);
  }
  const send = value.send as unknown as Operation["send"];
  const stop = value.stop as unknown as Operation["stop"];
  if ((value.state === "completed" && send.evidence !== "simulationCompleted") ||
    (value.state === "cancelled" && stop?.observation.evidence !== "simulationStopped") ||
    (value.state === "notDispatched" && send.requestDispatched)) throw new OperationError("blocked");
}

export async function initializeFakeFixture(root: string): Promise<void> {
  // mkdir is exclusive: never repair an existing fixture or touch a user ledger.
  await mkdir(root, { mode: 0o700 });
  const file = await open(join(root, "simulation-fixture.jsonl"), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ fakeFixtureVersion: 1, sequence: 1, event: "initialized", fixtureId: randomUUID(), operation: null }) + "\n");
    await file.sync();
  } finally { await file.close(); }
}

export async function openFakeFixture(root: string): Promise<Journal> {
  const canonical = await realpath(root);
  if (canonical !== resolve(root) || (await lstat(root)).isSymbolicLink()) throw new OperationError("blocked", "fixture path alias");
  const path = join(canonical, "simulation-fixture.jsonl");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024)
    throw new OperationError("blocked", "invalid fixture file");
  const lockPath = join(canonical, "fixture.lock");
  try {
    const existingLock = await lstat(lockPath);
    if (!existingLock.isFile() || existingLock.isSymbolicLink() || existingLock.nlink !== 1) throw new OperationError("blocked", "fixture lock alias");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock: LockHandle = acquireLock(lockPath, "device-operation-fake");
  try {
    const text = await readFile(path, "utf8");
    if (!text.endsWith("\n") || text === "\n") throw new OperationError("blocked", "empty or truncated fixture");
    const rows = text.slice(0, -1).split("\n");
    if (rows.length > 10000) throw new OperationError("blocked");
    const operations = new Map<string, Operation>();
    let fixtureId: string | undefined;
    for (let index = 0; index < rows.length; index++) {
      const line = rows[index]!;
      if (Buffer.byteLength(line) > 16384) throw new OperationError("blocked");
      const row: unknown = JSON.parse(line); bounded(row);
      exact(row, ["fakeFixtureVersion", "sequence", "event", "fixtureId", "operation"]);
      if (row.fakeFixtureVersion !== 1 || row.sequence !== index + 1 || !uuid(row.fixtureId) ||
        (fixtureId && fixtureId !== row.fixtureId)) throw new OperationError("blocked");
      fixtureId = row.fixtureId;
      if (index === 0) {
        if (row.event !== "initialized" || row.operation !== null) throw new OperationError("blocked");
      } else {
        if (row.event !== "operation") throw new OperationError("blocked");
        validateOperation(row.operation);
        const old = operations.get(row.operation.operationId);
        if (old && (old.proposalId !== row.operation.proposalId || old.approvalId !== row.operation.approvalId ||
          old.bindingDigest !== row.operation.bindingDigest)) throw new OperationError("blocked");
        if (old && (row.operation.state === "dispatching" || old.state === "notDispatched" ||
          (row.operation.state === "notDispatched") ||
          (old.send.requestDispatched && !row.operation.send.requestDispatched) ||
          (old.stop && old.stop.stopId !== row.operation.stop?.stopId))) throw new OperationError("blocked");
        const current = row.operation;
        if (current.stop && [...operations.values()].some(op => op.operationId !== current.operationId &&
          op.stop?.stopId === current.stop?.stopId)) throw new OperationError("blocked");
        if (!old && !["dispatching", "notDispatched"].includes(row.operation.state)) throw new OperationError("blocked");
        if (old && ["completed", "cancelled", "notDispatched"].includes(old.state) &&
          (old.state !== row.operation.state || JSON.stringify(old.send) !== JSON.stringify(row.operation.send))) throw new OperationError("blocked");
        operations.set(row.operation.operationId, row.operation);
      }
    }
    // Persisted dispatching is unresolved after restart, regardless of prior process memory.
    for (const operation of operations.values()) if (operation.state === "dispatching") operation.state = "unknown";
    let sequence = rows.length;
    let bytes = stat.size;
    let failed = false;
    let released = false;
    let tail = Promise.resolve();
    return {
      operations,
      hasCapacity() { return !released && !failed && sequence + 6 <= 10000 && bytes + 6 * 16384 <= 8 * 1024 * 1024; },
      append(operation) {
        if (released || failed || sequence + 1 > 10000)
          return Promise.reject(new OperationError("storageFault"));
        validateOperation(operation);
        const snapshot = structuredClone(operation);
        const line = JSON.stringify({ fakeFixtureVersion: 1, sequence: ++sequence, event: "operation", fixtureId, operation: snapshot }) + "\n";
        if (Buffer.byteLength(line) > 16384 || bytes + Buffer.byteLength(line) > 8 * 1024 * 1024) {
          failed = true; return Promise.reject(new OperationError("storageFault"));
        }
        bytes += Buffer.byteLength(line);
        const write = tail.then(async () => {
          if (failed) throw new OperationError("storageFault");
          const file = await open(path, "a");
          try { await file.writeFile(line); await file.sync(); }
          finally { await file.close(); }
        });
        tail = write.catch(() => { failed = true; });
        return write;
      },
      async flush() { await tail; if (failed) throw new OperationError("storageFault"); },
      release() { released = true; lock.release(); },
    };
  } catch (error) { lock.release(); throw error; }
}
