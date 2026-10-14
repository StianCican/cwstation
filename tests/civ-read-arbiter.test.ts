// P2-015 stage 1: offline dynamic verification of the P2-014 eight-query arbiter.
//
// Every test injects an in-memory CivTransport. No serial port, simulator
// binding, IPC, database or transmitter is involved. Timing checks use the
// arbiter's fixed 2000 ms query timeout; quality checks drive the wall clock
// argument instead of sleeping through the status/context TTLs.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CivBusyError,
  CivSessionError,
  civModeToCode,
  encodeFrequencyBcd,
  type CivTransport,
} from "../packages/devices/src/civ.js";
import {
  CIV_ARBITER_CONTEXT_TTL_MS,
  CivReadAbortedError,
  CivReadArbiter,
} from "../packages/devices/src/civ-read-arbiter.js";
import type { ContextReadKind } from "../packages/devices/src/civ-context-read.js";

const FREQUENCY_HZ = 14_030_000;
const TX_FREQUENCY_HZ = 14_030_000;
const CONTEXT_KINDS: readonly ContextReadKind[] = [
  "txFrequency",
  "txStatus",
  "splitEnabled",
  "ritEnabled",
  "xitEnabled",
  "breakIn",
];

function replyFrame(command: number, data: readonly number[]): Uint8Array {
  return Uint8Array.from([0xfe, 0xfe, 0xe0, 0x94, command, ...data, 0xfd]);
}

/** Deterministic manual-based replies for all eight fixed 94/E0 queries. */
function replyFor(request: Uint8Array): Uint8Array | null {
  switch (request[4]) {
    case 0x03:
      return replyFrame(0x03, encodeFrequencyBcd(FREQUENCY_HZ));
    case 0x04:
      return replyFrame(0x04, [civModeToCode("CW"), 0x02]);
    case 0x1c:
      if (request[5] === 0x03) return replyFrame(0x1c, [0x03, ...encodeFrequencyBcd(TX_FREQUENCY_HZ)]);
      if (request[5] === 0x00) return replyFrame(0x1c, [0x00, 0x00]);
      return null;
    case 0x0f:
      return replyFrame(0x0f, [0x00]);
    case 0x21:
      return request[5] === 0x01 || request[5] === 0x02
        ? replyFrame(0x21, [request[5], 0x00])
        : null;
    case 0x16:
      return replyFrame(0x16, [0x47, 0x02]);
    default:
      return null;
  }
}

class FakeTransport implements CivTransport {
  readonly writes: Uint8Array[] = [];
  autoRespond = true;
  closed = false;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  write(bytes: Uint8Array): Promise<void> {
    const copy = Uint8Array.from(bytes);
    this.writes.push(copy);
    if (this.autoRespond) {
      const reply = replyFor(copy);
      if (reply !== null) this.emitData(reply);
    }
    return Promise.resolve();
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => listener());
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }

  emitData(chunk: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  emitClose(error?: Error): void {
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(error);
  }

  respondTo(index: number): void {
    const request = this.writes[index];
    assert.ok(request, `no request at index ${index}`);
    const reply = replyFor(request);
    if (reply !== null) this.emitData(reply);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(() => resolve()));

async function waitForLastCommand(transport: FakeTransport, command: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const last = transport.writes[transport.writes.length - 1];
    if (last !== undefined && last[4] === command) return;
    await tick();
  }
  assert.fail(`no 0x${command.toString(16)} write was observed`);
}

test("start completes the first 03/04 pair before publishing and before external reads", async () => {
  const transport = new FakeTransport();
  const arbiter = new CivReadArbiter({ transport });
  await assert.rejects(arbiter.read("breakIn"), CivSessionError);
  const snapshot = await arbiter.start();
  assert.deepEqual(snapshot.reading, { frequencyHz: FREQUENCY_HZ, mode: "CW", filter: 2 });
  assert.equal(snapshot.quality, "fresh");
  assert.equal(arbiter.generation, 1);
  assert.equal(transport.writes[0]?.[4], 0x03);
  assert.equal(transport.writes[1]?.[4], 0x04);
  await arbiter.close();
  assert.equal(arbiter.state, "closed");
});

test("external capacity is one active plus one waiting; a third is busy", async () => {
  const transport = new FakeTransport();
  const arbiter = new CivReadArbiter({ transport });
  await arbiter.start();
  // Hold the background query so the active external operation cannot be written.
  transport.autoRespond = false;
  const active = arbiter.read("breakIn");
  active.catch(() => undefined);
  const waiting = arbiter.refreshAll();
  waiting.catch(() => undefined);
  await assert.rejects(arbiter.read("ritEnabled"), CivBusyError);
  await arbiter.close();
  await assert.rejects(active, CivSessionError);
  await assert.rejects(waiting, CivSessionError);
});

test("cancel before a write only removes; cancel after a write locks the generation", async () => {
  const before = new FakeTransport();
  const first = new CivReadArbiter({ transport: before });
  await first.start();
  before.autoRespond = false;
  const preController = new AbortController();
  const preCanceled = first.read("breakIn", preController.signal);
  preCanceled.catch(() => undefined);
  // Abort synchronously, before the scheduled pump can write the query.
  preController.abort();
  await assert.rejects(preCanceled, CivReadAbortedError);
  assert.equal(first.state, "reading");
  await first.close();

  const after = new FakeTransport();
  const second = new CivReadArbiter({ transport: after });
  await second.start();
  after.autoRespond = false;
  await tick();
  // Release the in-flight background query so the external read can be written.
  after.respondTo(after.writes.length - 1);
  const postController = new AbortController();
  const postCanceled = second.read("breakIn", postController.signal);
  postCanceled.catch(() => undefined);
  await waitForLastCommand(after, 0x16);
  postController.abort();
  await assert.rejects(postCanceled, CivSessionError);
  await second.close();
  assert.equal(second.state, "locked");
});

test("query timeout locks the generation and late frames cannot revive it", async () => {
  const transport = new FakeTransport();
  transport.autoRespond = false;
  const arbiter = new CivReadArbiter({ transport });
  // A query timeout rejects the in-flight query with the session error and
  // records the timeout itself; it never resolves the read as a success.
  await assert.rejects(arbiter.start(), CivSessionError);
  assert.equal(arbiter.state, "locked");
  assert.match(arbiter.view().error ?? "", /timed out/);
  const writesAtLock = transport.writes.length;
  // A late but structurally valid 03 reply arrives after the lock.
  transport.emitData(replyFrame(0x03, encodeFrequencyBcd(FREQUENCY_HZ)));
  assert.equal(transport.writes.length, writesAtLock);
  assert.equal(arbiter.state, "locked");
  assert.equal(arbiter.view().status.quality, "unknown");
  await arbiter.close();
});

test("view marks samples stale past TTL and on wall-clock regression", async () => {
  const transport = new FakeTransport();
  const arbiter = new CivReadArbiter({ transport });
  await arbiter.start();
  await arbiter.refreshAll();
  const fresh = arbiter.view();
  assert.equal(fresh.status.quality, "fresh");
  for (const kind of CONTEXT_KINDS) assert.equal(fresh.fields[kind].quality, "fresh", kind);
  const sampledAt = fresh.fields.breakIn.sampledAt;
  assert.ok(typeof sampledAt === "number");
  const stale = arbiter.view(sampledAt + CIV_ARBITER_CONTEXT_TTL_MS);
  for (const kind of CONTEXT_KINDS) assert.equal(stale.fields[kind].quality, "stale", kind);
  assert.equal(stale.status.quality, "stale");
  // Once a sample is stale it cannot be revived by an earlier wall clock.
  assert.equal(arbiter.view().fields.breakIn.quality, "stale");
  await arbiter.close();
});

test("transport close, FB and malformed replies each isolate the session", async () => {
  const closed = new FakeTransport();
  const viaClose = new CivReadArbiter({ transport: closed });
  await viaClose.start();
  closed.emitClose(new Error("usb removed"));
  await viaClose.close();
  assert.equal(viaClose.state, "locked");
  await assert.rejects(viaClose.read("breakIn"), CivSessionError);

  const fb = new FakeTransport();
  const viaFb = new CivReadArbiter({ transport: fb });
  await viaFb.start();
  fb.autoRespond = false;
  await tick();
  fb.emitData(Uint8Array.from([0xfe, 0xfe, 0xe0, 0x94, 0xfb, 0xfd]));
  await viaFb.close();
  assert.equal(viaFb.state, "locked");

  const malformed = new FakeTransport();
  const viaMalformed = new CivReadArbiter({ transport: malformed });
  await viaMalformed.start();
  malformed.autoRespond = false;
  await tick();
  // Matching txFrequency reply whose BCD payload carries an invalid nibble.
  malformed.emitData(replyFrame(0x1c, [0x03, 0x0a, 0x00, 0x00, 0x00, 0x00]));
  await viaMalformed.close();
  assert.equal(viaMalformed.state, "locked");
});
