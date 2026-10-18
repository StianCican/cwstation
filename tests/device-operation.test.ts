import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { FakeOperationService, createFakeAdapter, within, type FakeAdapter } from "../packages/device-operation/src/fake-service.js";
import { initializeFakeFixture, openFakeFixture, type Journal } from "../packages/device-operation/src/fixture-journal.js";
import { CAPABILITIES_DIGEST, OperationError, deadline, digest, parseRequest, parseResponse,
  response, type InternalRequest, type Method, type Operation, type Response, type Values } from "../packages/device-operation/src/protocol.js";
import { OperationRelay, parseFakeMode } from "../apps/rig-operation-host.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryJournal(): Journal & { rows: Operation[]; beforeAppend?: (op: Operation) => Promise<void> } {
  const rows: Operation[] = [];
  const journal: Journal & { rows: Operation[]; beforeAppend?: (op: Operation) => Promise<void> } = {
    rows, operations: new Map(), hasCapacity: () => true,
    async append(op) { const snapshot = structuredClone(op); await journal.beforeAppend?.(snapshot); rows.push(snapshot); },
    async flush() {}, release() {},
  };
  return journal;
}
function harness(journal: Journal = memoryJournal(), adapter: FakeAdapter = createFakeAdapter(1), now = process.hrtime.bigint) {
  const service = new FakeOperationService(journal, adapter, now);
  let sequence = 0;
  const channelId = randomUUID(), hostId = randomUUID();
  const req = (method: Method, params: Record<string, unknown> = {}, ms = 30000): InternalRequest => ({
    deviceOperationVersion: 1, id: randomUUID(), sequence: ++sequence, method, params,
    deadlineNs: (now() + BigInt(ms) * 1000000n).toString(), remainingMs: ms,
    actor: method === "device.close" ? "host" : "operator", channelId: method === "device.close" ? hostId : channelId,
  });
  const call = (method: Method, params: Record<string, unknown> = {}, ms = 30000) => service.handle(req(method, params, ms));
  const value = async (method: Method, params: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const reply = await call(method, params); assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.result as Record<string, any>;
  };
  const approve = async () => {
    const { proposal } = await value("proposal.create", { text: "E" });
    const { context } = await value("context.refresh");
    const { approval } = await value("proposal.approve", { proposalId: proposal.proposalId, contextId: context.contextId });
    return { proposalId: proposal.proposalId as string, approvalId: approval.approvalId as string, operationId: randomUUID() };
  };
  return { service, journal, adapter, req, call, value, approve, channelId };
}

test("T01: external/internal exact envelopes, roles, deadlines and bounds", () => {
  const h = harness(); const internal = h.req("device.describe");
  assert.equal(parseRequest(internal, true).actor, "operator");
  assert.throws(() => parseRequest(internal, false), OperationError);
  const { actor, channelId, remainingMs, deadlineNs, ...external } = internal;
  assert.equal(parseRequest(external, false).method, "device.describe");
  assert.throws(() => parseRequest({ ...internal, actor: "ai" }, true));
  assert.throws(() => parseRequest({ ...internal, method: "proposal.create", params: { text: "E" }, actor: "host" }, true));
  assert.throws(() => parseRequest({ ...internal, method: "device.close" }, true));
  assert.throws(() => parseRequest({ ...external, params: { port: "COM17" } }, false));
  assert.throws(() => parseRequest({ ...external, id: "x".repeat(17000) }, false));
  assert.throws(() => parseRequest({ ...external, sequence: NaN }, false));
  assert.throws(() => parseRequest({ ...external, deviceOperationVersion: 2 }, false));
  const now = 5000000000n;
  assert.equal(deadline({ ...internal, deadlineNs: "5100000000", remainingMs: 30000 }, now), 5100000000n);
  assert.throws(() => deadline({ ...internal, deadlineNs: "4999999999" }, now), /timeout/);
});

test("independent capability digest vector and strict result validation", async () => {
  const expected = [1, "cw-trial", "simulation", "unverified", ["displayFrequency", "displayMode", "txFrequency", "txStatus", "splitEnabled", "ritEnabled", "xitEnabled", "breakIn"],
    ["E", "TEST"], true, true, "simulation", "simulation", false];
  assert.equal(CAPABILITIES_DIGEST, createHash("sha256").update(JSON.stringify(expected)).digest("hex"));
  const h = harness(); const req = h.req("device.describe"); const result = await h.service.handle(req);
  parseResponse(result, req);
  const malformed = structuredClone(result) as any; malformed.result.capabilities.backend = "ic7300";
  assert.throws(() => parseResponse(malformed, req));
  const extra = structuredClone(result) as any; extra.result.extra = true;
  assert.throws(() => parseResponse(extra, req));
  assert.throws(() => parseResponse({ ...result, id: randomUUID() }, req));
  const { proposal } = await h.value("proposal.create", { text: "E" });
  const { context } = await h.value("context.refresh");
  const approved = await h.value("proposal.approve", { proposalId: proposal.proposalId, contextId: context.contextId });
  const expectedBinding = ["device-operation-v1", h.service.serviceInstanceId, 0, null, "unverified", CAPABILITIES_DIGEST,
    proposal.proposalId, createHash("sha256").update("E").digest("hex"),
    14250000, "CW", 2, 14250000, "RX", false, false, false, "SEMI"];
  assert.equal(approved.approval.bindingDigest, createHash("sha256").update(JSON.stringify(expectedBinding)).digest("hex"));
  await h.service.close();
});

test("refresh/approve/execute bind nine values and dispatch once", async () => {
  const h = harness(); const ids = await h.approve();
  const pending = h.value("cw.execute", ids);
  const preparedReplay = await h.value("cw.execute", ids);
  assert.equal(preparedReplay.operation.state, "prepared");
  const first = await pending;
  assert.equal(first.operation.state, "completed");
  assert.equal(first.operation.source, "simulation");
  assert.equal(first.operation.send.evidence, "simulationCompleted");
  const again = await h.value("cw.execute", ids);
  assert.deepEqual(again, first);
  assert.equal((h.adapter as ReturnType<typeof createFakeAdapter>).sends, 1);
  const conflict = await h.call("cw.execute", { ...ids, approvalId: randomUUID() });
  assert.equal(conflict.error?.code, "conflict");
  const freshId = await h.call("cw.execute", { ...ids, operationId: randomUUID() });
  assert.equal(freshId.error?.code, "expired");
  await h.service.close();
});

for (let field = 0; field < 9; field++) test(`context binding rejects changed field ${field}`, async () => {
  const adapter = createFakeAdapter(1); const original = adapter.read;
  let changed = false;
  adapter.read = async signal => {
    const values = await original(signal);
    if (changed) {
      const alternatives: Values = [14000000, "CW-R", 3, 14000000, "TX", true, true, true, "FULL"];
      (values as unknown[])[field] = alternatives[field];
    }
    return values;
  };
  const h = harness(memoryJournal(), adapter); const ids = await h.approve(); changed = true;
  const result = await h.value("cw.execute", ids);
  assert.equal(result.operation.state, "notDispatched"); assert.equal(adapter.sends, 0);
  await h.service.close();
});

test("preflight rejects unsafe mode without granting approval", async () => {
  const adapter = createFakeAdapter(1); const base = adapter.read;
  adapter.read = async signal => { const values = await base(signal); values[1] = "USB"; return values; };
  const h = harness(memoryJournal(), adapter);
  const { proposal } = await h.value("proposal.create", { text: "TEST" });
  const { context, preflight } = await h.value("context.refresh");
  assert.deepEqual(preflight, { eligible: false, failedChecks: ["mode"] });
  assert.equal((await h.call("proposal.approve", { proposalId: proposal.proposalId, contextId: context.contextId })).ok, false);
  assert.equal(adapter.sends, 0); await h.service.close();
});

for (const reason of ["revoke", "stop", "close", "ttl", "channelLost"] as const) test(`T04: fsync pending then ${reason} cannot revive send`, async () => {
  const journal = memoryJournal(), adapter = createFakeAdapter(1);
  let offset = 0n;
  const h = harness(journal, adapter, () => process.hrtime.bigint() + offset);
  const ids = await h.approve(); const entered = deferred<void>(), release = deferred<void>();
  if (reason === "ttl") { offset = 20000000000n; await h.value("context.refresh"); }
  let first = true;
  journal.beforeAppend = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const execution = h.call("cw.execute", ids); await entered.promise;
  let closing: Promise<unknown> | undefined;
  if (reason === "revoke") await h.call("proposal.revoke", { proposalId: ids.proposalId });
  if (reason === "stop") assert.equal((await h.call("cw.stop", { operationId: ids.operationId, stopId: randomUUID() })).error?.code, "unavailable");
  if (reason === "close") closing = h.service.close();
  if (reason === "ttl") offset = 31000000000n;
  if (reason === "channelLost") h.service.channelLost(h.channelId);
  release.resolve(); const reply = await execution;
  assert.equal((reply.result as any).operation.state, "unknown");
  assert.equal((reply.result as any).operation.unresolved, true);
  if (reason === "ttl") assert.equal((reply.result as any).operation.errorCode, "expired");
  assert.equal(adapter.sends, 0); assert.equal(adapter.stops, 0);
  assert.equal(journal.rows[0]?.state, "dispatching");
  offset = 0n;
  await closing; await h.service.close();
});

test("T05: invalidation after successful journal flush but before execute continuation prevents dispatch", async () => {
  const journal = memoryJournal(), adapter = createFakeAdapter(1), h = harness(journal, adapter);
  const ids = await h.approve(), append = journal.append.bind(journal);
  let once = true;
  journal.append = async operation => {
    await append(operation);
    if (once) { once = false; h.service.channelLost(h.channelId); }
  };
  const result = await h.value("cw.execute", ids);
  assert.equal(journal.rows[0]?.state, "dispatching");
  assert.equal(result.operation.state, "unknown"); assert.equal(adapter.sends, 0);
  await h.service.close();
});

test("stop preempts a pending simulation send and is idempotent", async () => {
  const adapter = createFakeAdapter(60000), h = harness(memoryJournal(), adapter);
  const ids = await h.approve(); const execution = h.call("cw.execute", ids);
  while (adapter.sends === 0) await delay(1);
  const stopId = randomUUID(); const stopped = await h.value("cw.stop", { operationId: ids.operationId, stopId });
  assert.equal(stopped.observation.evidence, "simulationStopped");
  assert.equal(stopped.operationState, "cancelled");
  assert.equal((await execution).ok, true);
  const replay = await h.value("cw.stop", { operationId: ids.operationId, stopId });
  assert.equal(replay.stopId, stopId);
  const newStop = await h.value("cw.stop", { operationId: ids.operationId, stopId: randomUUID() });
  assert.equal(newStop.alreadyAttempted, true); assert.equal(adapter.stops, 1);
  await h.service.close();
});

test("stop cancels active and waiting reads even when ordinary slots are occupied", async () => {
  const adapter = createFakeAdapter(60000), h = harness(memoryJournal(), adapter);
  const ids = await h.approve(); const execution = h.call("cw.execute", ids);
  while (adapter.sends === 0) await delay(1);
  // End the send request without reliable completion, leaving a live-connection unknown.
  const stop = await h.value("cw.stop", { operationId: ids.operationId, stopId: randomUUID() });
  assert.equal(stop.observation.evidence, "simulationStopped"); await execution;
  const entered = deferred<void>();
  adapter.read = async signal => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true })); };
  const reads = [h.call("context.refresh"), h.call("context.refresh")]; await entered.promise;
  assert.equal((await h.call("context.refresh")).error?.code, "busy");
  const stopped = await h.call("cw.stop", { operationId: ids.operationId, stopId: randomUUID() });
  assert.equal(stopped.ok, true);
  // Replay doesn't revoke reads; a new stop on an unattempted operation does.
  await h.call("cw.stop", { operationId: randomUUID(), stopId: randomUUID() });
  assert.equal((await reads[0]!).ok, false); assert.equal((await reads[1]!).ok, false);
  await h.service.close();
});

test("intent storage failure blocks new approvals and never sends", async () => {
  const journal = memoryJournal(), adapter = createFakeAdapter(1), h = harness(journal, adapter);
  const ids = await h.approve(); journal.beforeAppend = async () => { throw new Error("disk failure"); };
  const result = await h.value("cw.execute", ids);
  assert.equal(result.operation.state, "unknown"); assert.equal(result.operation.errorCode, "storageFault");
  assert.equal(adapter.sends, 0);
  assert.equal((await h.value("device.describe")).blockedReason, "storageFault");
  const close = await h.service.close(); assert.equal(close.recordsFlushed, false);
});

test("short execute deadline during intent fsync remains unknown with no late send", async () => {
  const journal = memoryJournal(), adapter = createFakeAdapter(1), h = harness(journal, adapter);
  const ids = await h.approve(), release = deferred<void>();
  journal.beforeAppend = () => release.promise;
  const result = await h.call("cw.execute", ids, 40);
  assert.equal((result.result as any).operation.state, "unknown");
  assert.equal((result.result as any).operation.errorCode, "storageFault");
  release.resolve(); await delay(5); assert.equal(adapter.sends, 0);
  await h.service.close();
});

test("stop proceeds after 500ms journal budget while a single writer is still hung", async () => {
  const adapter = createFakeAdapter(60000), journal = memoryJournal(), h = harness(journal, adapter);
  const ids = await h.approve(); const execution = h.call("cw.execute", ids);
  while (!adapter.sends) await delay(1);
  const release = deferred<void>(); let writes = 0;
  journal.beforeAppend = async () => { writes++; await release.promise; };
  const before = Date.now();
  const stopped = await h.value("cw.stop", { operationId: ids.operationId, stopId: randomUUID() });
  assert.ok(Date.now() - before < 2000);
  assert.equal(adapter.stops, 1); assert.equal(stopped.observation.evidence, "simulationStopped");
  assert.equal(stopped.operationState, "unknown"); assert.equal(writes, 1);
  assert.equal((await execution).ok, true);
  release.resolve(); await h.service.close();
});

test("channel loss while approve is reading cannot create a new permit", async () => {
  const adapter = createFakeAdapter(1), h = harness(memoryJournal(), adapter);
  const { proposal } = await h.value("proposal.create", { text: "E" });
  const { context } = await h.value("context.refresh");
  const base = adapter.read, entered = deferred<void>(), release = deferred<void>();
  adapter.read = async signal => { entered.resolve(); await release.promise; return base(signal); };
  const approving = h.call("proposal.approve", { proposalId: proposal.proposalId, contextId: context.contextId });
  await entered.promise; h.service.channelLost(h.channelId); release.resolve();
  assert.equal((await approving).ok, false); assert.equal(adapter.sends, 0);
  await h.service.close();
});

test("insufficient record reserve rejects approval before intent", async () => {
  const journal = memoryJournal(), h = harness(journal);
  const { proposal } = await h.value("proposal.create", { text: "E" });
  const { context } = await h.value("context.refresh");
  journal.hasCapacity = () => false;
  assert.equal((await h.call("proposal.approve", { proposalId: proposal.proposalId, contextId: context.contextId })).error?.code, "blocked");
  assert.equal(journal.rows.length, 0); await h.service.close();
});

test("unconfirmed adapter close retains the ownership lock despite flushed records", async () => {
  const journal = memoryJournal(), adapter = createFakeAdapter(1); let released = false;
  journal.release = () => { released = true; };
  adapter.close = async () => { throw new Error("close unavailable"); };
  const h = harness(journal, adapter); const result = await h.service.close();
  assert.equal(result.portReleased, false); assert.equal(result.recordsFlushed, true); assert.equal(released, false);
});

test("expired valid sequence is consumed and cannot be reused", async () => {
  const h = harness(); const req = h.req("device.status"); req.deadlineNs = "1";
  assert.equal((await h.service.handle(req)).error?.code, "timeout");
  assert.equal((await h.service.handle({ ...req, deadlineNs: (process.hrtime.bigint() + 1000000000n).toString() })).error?.code, "conflict");
  await h.service.close();
});

test("monotonic expired approval and stale status cannot gain freshness from wall time", async () => {
  let offset = 0n; const adapter = createFakeAdapter(1);
  const h = harness(memoryJournal(), adapter, () => process.hrtime.bigint() + offset);
  const ids = await h.approve(); offset = 3100000000n;
  const { context } = await h.value("device.status");
  assert.equal(context.fields.displayMode.quality, "stale");
  assert.equal(context.fields.txStatus.quality, "fresh");
  offset = 31000000000n;
  assert.equal((await h.value("cw.execute", ids)).operation.state, "notDispatched");
  assert.equal(adapter.sends, 0); offset = 0n; await h.service.close();
});

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cw-op-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fixture"); await initializeFakeFixture(path); return { root, path };
}

test("T02/T03: persisted unknown replay before approval lookup after restart", async t => {
  const { path } = await fixture(t); const journal = await openFakeFixture(path);
  const adapter = createFakeAdapter(1); adapter.send = async () => { throw new Error("ambiguous send"); };
  const h = harness(journal, adapter); const ids = await h.approve();
  assert.equal((await h.value("cw.execute", ids)).operation.state, "unknown");
  // Simulate the process boundary: flush/release without a software close/stop.
  await journal.flush(); journal.release();
  const nextJournal = await openFakeFixture(path), nextAdapter = createFakeAdapter(1), next = harness(nextJournal, nextAdapter);
  const before = await readFile(join(path, "simulation-fixture.jsonl"), "utf8");
  assert.equal((await next.value("cw.execute", ids)).operation.state, "unknown");
  assert.equal((await next.call("cw.execute", { ...ids, proposalId: randomUUID() })).error?.code, "conflict");
  assert.equal(await readFile(join(path, "simulation-fixture.jsonl"), "utf8"), before);
  assert.equal(nextAdapter.sends, 0);
  assert.equal((await next.call("cw.stop", { operationId: ids.operationId, stopId: randomUUID() })).error?.code, "staleContext");
  assert.equal(nextAdapter.stops, 0); await next.service.close();
});

test("T08: empty/truncated fixture and duplicate owner block; initialization never repairs", async t => {
  const { path } = await fixture(t);
  await assert.rejects(initializeFakeFixture(path));
  const owner = await openFakeFixture(path); await assert.rejects(openFakeFixture(path)); owner.release();
  const file = join(path, "simulation-fixture.jsonl");
  const valid = await readFile(file, "utf8");
  for (const broken of ["", "\n", valid.slice(0, -1), valid + valid, valid + "bad\n"]) {
    await writeFile(file, broken); await assert.rejects(openFakeFixture(path));
  }
});

test("fixture rejects hard link aliases and symlinks where platform permits", async t => {
  const { root, path } = await fixture(t); const file = join(path, "simulation-fixture.jsonl");
  await link(file, join(root, "hardlink")); await assert.rejects(openFakeFixture(path));
  await rm(join(root, "hardlink"));
  const alias = join(root, "alias");
  try { await symlink(path, alias, "dir"); }
  catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("symlink creation unavailable"); return; } throw error; }
  await assert.rejects(openFakeFixture(alias));
});

test("relay correlates responses, rejects injection/replay and reserves stop/close slots", async () => {
  const sent: InternalRequest[] = [], relay = new OperationRelay(req => { sent.push(req); });
  const external = (sequence: number, method: Method = "device.status", params = {}) => ({ deviceOperationVersion: 1 as const, id: randomUUID(), sequence, method, params });
  const ordinary = [1, 2, 3, 4].map(n => relay.request(external(n)));
  assert.equal((await relay.request(external(5))).error?.code, "busy");
  assert.equal((await relay.request(external(5))).error?.code, "conflict");
  await assert.rejects(relay.request({ ...external(6), actor: "host" }));
  const stop = relay.request(external(7, "cw.stop", { operationId: randomUUID(), stopId: randomUUID() }));
  const close = relay.request(external(1, "device.close"), true);
  assert.equal(sent.length, 6); assert.equal(sent[0]?.actor, "operator"); assert.equal(sent[5]?.actor, "host");
  const pending = sent[0]!;
  relay.receive(response(pending, null, new OperationError("unavailable")));
  assert.equal((await ordinary[0]!).error?.code, "unavailable");
  relay.disconnect(); await Promise.all([...ordinary.slice(1), stop, close]);
});

test("relay refuses a successful response from a different service instance", async () => {
  const h = harness(); let internal!: InternalRequest;
  const relay = new OperationRelay(req => { internal = req; });
  relay.bindService(randomUUID());
  const pending = relay.request({ deviceOperationVersion: 1, id: randomUUID(), sequence: 1, method: "device.describe", params: {} });
  relay.receive(await h.service.handle(internal));
  assert.equal((await pending).error?.code, "unavailable"); await h.service.close();
});

test("inherited parent EOF closes the compiled Fake service and releases its fixture lock", async t => {
  const { path } = await fixture(t);
  const child = fork(resolve("dist/apps/rig-controld.js"), ["--operation-fake-fixture", path], {
    execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", message => { if ((message as { event?: string }).event === "ready") resolve(); });
    child.once("error", reject); child.once("exit", () => reject(new Error("early exit")));
  });
  try {
    await within(ready, process.hrtime.bigint() + 5000000000n);
    child.disconnect();
    assert.equal(await within(exited, process.hrtime.bigint() + 5000000000n), 0);
    const journal = await openFakeFixture(path); journal.release();
  } finally {
    if (child.exitCode === null) child.kill();
    await within(exited, process.hrtime.bigint() + 2000000000n).catch(() => undefined);
  }
});

function runNode(args: string[], timeout = 15000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("child timeout")); }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test("compiled host -> device child and interaction child completes explicit Fake demo", async t => {
  const result = await runNode([resolve("dist/apps/rig-launch.js"), "--mode", "cw-trial", "--simulate", "--demo", "E"]);
  assert.equal(result.code, 0, result.err);
  const rows = result.out.trim().split("\n").map(line => JSON.parse(line));
  const execution = rows.find(row => row.method === "cw.execute");
  assert.equal(execution.result.operation.state, "completed");
  assert.equal(execution.result.operation.source, "simulation");
  assert.equal(rows.at(-1).method, "operation.get");
  const info = JSON.parse(result.err.trim().split("\n")[0]!);
  assert.equal(info.backend, "simulation");
  const journal = await openFakeFixture(info.fixture); journal.release();
  t.after(() => rm(resolve(info.fixture, ".."), { recursive: true, force: true }));
});

test("new mode rejects real configuration and standalone interaction/service without IPC", async () => {
  assert.throws(() => parseFakeMode(["--mode", "cw-trial", "--port", "COM17"]));
  assert.throws(() => parseFakeMode(["--mode", "cw-trial", "--simulate", "--demo", "SOS"]));
  const invalid = await runNode([resolve("dist/apps/rig-launch.js"), "--mode", "cw-trial", "--port", "COM17"]);
  assert.equal(invalid.code, 2); assert.doesNotMatch(invalid.err, /"fixture"/);
  const standalone = await runNode([resolve("dist/apps/cw-operation.js"), "--demo", "E"]);
  assert.equal(standalone.code, 2);
  const service = await runNode([resolve("dist/apps/rig-controld.js"), "--operation-fake-fixture", "missing"]);
  assert.equal(service.code, 2);
});
