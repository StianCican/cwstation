// P2-002b：RemoteKeyer 接入核心授权 + Fake IPC 的专项测试。
//
// 主矩阵通过真实 Fake 子进程（stdin/stdout NDJSON + 目录账本）、真实
// SqliteJournal 与真实 TxController 运行；只有显式“客户端方法替身”的响应
// 关联用例使用结构化替身，且不把替身当作跨进程证据。
//
// 运行：node --import tsx --test tests/remote-keyer.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Approval, Proposal, TxRequest } from "../packages/contracts/src/index.js";
import { TxController, contentHash } from "../packages/core/src/tx-controller.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { FakeRigClient, FakeRigClientError, type FakeRigTestOptions, type SendInput, type StopInput } from "../packages/rig-control/src/client.js";
import {
  RIG_CONTROL_CHARSET_VERSION,
  RIG_CONTROL_METHODS,
  type DeviceCapabilities,
  type DeviceSnapshot,
  type OperationResult,
  type StopResult,
} from "../packages/rig-control/src/protocol.js";
import { RemoteKeyer, type RemoteKeyerClient } from "../packages/rig-control/src/remote-keyer.js";

type TestFn = (t: TestContext) => void | Promise<void>;
/** 每个用例有界，防止挂起的 Fake 子进程拖死运行器。 */
const TEST_TIMEOUT_MS = 25_000;
function ctest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cwstation-remote-keyer-"));
}

function readLedger(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, "ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countType(dir: string, type: string): number {
  return readLedger(dir).filter((record) => record.type === type).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof FakeRigClientError && error.code === code;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error, `expected Error, got ${String(error)}`);
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

// ── 真实跨进程 + SQLite 夹具 ──────────────────────────────────────────────

interface Harness {
  readonly dir: string;
  readonly client: FakeRigClient | null;
  readonly keyerClient: RemoteKeyerClient;
  readonly keyer: RemoteKeyer;
  readonly journal: SqliteJournal;
  readonly controller: TxController;
}

interface HarnessOptions {
  readonly test?: FakeRigTestOptions;
  readonly frequencyHz?: number;
  readonly requestTimeoutMs?: number;
  readonly txTimeoutMs?: number;
  readonly proposalTtlMs?: number;
  readonly approvalTtlMs?: number;
  readonly generation?: number;
  readonly deviceInstanceId?: string;
  /** 注入结构化客户端替身时使用；此时不启动真实子进程。 */
  readonly stub?: RemoteKeyerClient;
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = tempDir();
  const frequencyHz = options.frequencyHz ?? 14_000_000;
  const journal = new SqliteJournal(join(dir, "core.sqlite"));
  if (options.generation !== undefined) {
    journal.saveState({
      frequencyHz,
      mode: "CW",
      generation: options.generation,
      blockedReason: null,
      storageFault: null,
    });
  }
  let client: FakeRigClient | null = null;
  let keyerClient: RemoteKeyerClient;
  if (options.stub !== undefined) {
    keyerClient = options.stub;
  } else {
    client = await FakeRigClient.start({
      ledgerDir: dir,
      frequencyHz,
      ...(options.deviceInstanceId === undefined ? {} : { deviceInstanceId: options.deviceInstanceId }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.test === undefined ? {} : { test: options.test }),
    });
    keyerClient = client;
  }
  const keyer = new RemoteKeyer({ client: keyerClient });
  const state = TxController.loadState(journal, { frequencyHz });
  const controller = new TxController(state, keyer, journal, {
    ...(options.txTimeoutMs === undefined ? {} : { txTimeoutMs: options.txTimeoutMs }),
    ...(options.proposalTtlMs === undefined ? {} : { proposalTtlMs: options.proposalTtlMs }),
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
  });
  return { dir, client, keyerClient, keyer, journal, controller };
}

async function disposeHarness(harness: Harness): Promise<void> {
  if (harness.client !== null) await harness.client.close().catch(() => undefined);
  try {
    harness.journal.close();
  } catch {
    // 已关闭或失败不影响测试结论。
  }
  rmSync(harness.dir, { recursive: true, force: true });
}

// ── 结构化客户端替身（仅用于响应关联与迟到结果） ────────────────────────

function makeCaps(
  deviceInstanceId: string,
  serviceInstanceId: string,
  overrides: Partial<DeviceCapabilities> = {},
): DeviceCapabilities {
  return {
    protocolVersion: 1,
    backendKind: "fake",
    evidenceSource: "simulation",
    model: "IC-7300",
    civAddress: 0x94,
    deviceInstanceId,
    serviceInstanceId,
    maxMessageBytes: 30,
    charsetVersion: RIG_CONTROL_CHARSET_VERSION,
    reliableCompletionEvidence: true,
    reliableStopEvidence: true,
    connectionGeneration: 0,
    permissionGeneration: 0,
    stateGeneration: 0,
    blocked: false,
    blockedReason: null,
    methods: [...RIG_CONTROL_METHODS],
    ...overrides,
  };
}

function makeSnapshot(
  deviceInstanceId: string,
  serviceInstanceId: string,
  overrides: Partial<DeviceSnapshot> = {},
): DeviceSnapshot {
  return {
    deviceInstanceId,
    serviceInstanceId,
    frequencyHz: 14_000_000,
    mode: "CW",
    snapshotTime: Date.now(),
    simulation: true,
    connectionGeneration: 0,
    permissionGeneration: 0,
    stateGeneration: 0,
    ...overrides,
  };
}

function completedResult(input: SendInput, deviceInstanceId: string, serviceInstanceId: string): OperationResult {
  const frequencyHz = input.frequencyHz ?? 14_000_000;
  return {
    operationId: input.operationId,
    deviceInstanceId,
    serviceInstanceId,
    state: "completed",
    outcome: "completed",
    evidence: "backend_completed",
    text: input.text,
    contentSha256: contentHash(input.text, frequencyHz, "CW"),
    frequencyHz,
    mode: "CW",
    connectionGeneration: input.connectionGeneration ?? 0,
    permissionGeneration: input.permissionGeneration ?? 0,
    stateGeneration: input.stateGeneration,
    frameHex: null,
    frameBytes: null,
    at: Date.now(),
  };
}

interface StubOptions {
  readonly deviceInstanceId?: string;
  readonly serviceInstanceId?: string;
  readonly caps?: Partial<DeviceCapabilities>;
  readonly snapshot?: Partial<DeviceSnapshot>;
  readonly send?: (input: SendInput) => Promise<OperationResult>;
  readonly stop?: (input: StopInput) => Promise<StopResult>;
}

function makeStubClient(options: StubOptions = {}): RemoteKeyerClient {
  const deviceInstanceId = options.deviceInstanceId ?? "stub-device";
  const serviceInstanceId = options.serviceInstanceId ?? "stub-service";
  return {
    deviceInstanceId,
    refreshCapabilities: async () => makeCaps(deviceInstanceId, serviceInstanceId, options.caps),
    snapshot: async () => makeSnapshot(deviceInstanceId, serviceInstanceId, options.snapshot),
    send: async (input) =>
      options.send !== undefined
        ? options.send(input)
        : completedResult(input, deviceInstanceId, serviceInstanceId),
    stop: async (input) =>
      options.stop !== undefined
        ? options.stop(input)
        : {
            stopId: input.stopId,
            operationId: input.operationId,
            outcome: "unknown",
            evidence: "stop_insufficient",
            at: Date.now(),
            permissionGeneration: 1,
          },
  };
}

function makeRequest(
  overrides: {
    readonly id?: string;
    readonly text?: string;
    readonly frequencyHz?: number;
    readonly stateGeneration?: number;
    readonly expiresAtMs?: number;
  } = {},
): TxRequest {
  const id = overrides.id ?? "prop-1";
  const text = overrides.text ?? "CQ TEST";
  const frequencyHz = overrides.frequencyHz ?? 14_000_000;
  const stateGeneration = overrides.stateGeneration ?? 0;
  const now = Date.now();
  const expiresAt = overrides.expiresAtMs ?? now + 30_000;
  const proposal: Proposal = {
    id,
    contractVersion: 1,
    text,
    frequencyHz,
    mode: "CW",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    stateGeneration,
    status: "approved",
    contentSha256: contentHash(text, frequencyHz, "CW"),
  };
  const approval: Approval = {
    proposalId: id,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    contentSha256: proposal.contentSha256,
    frequencyHz,
    mode: "CW",
    stateGeneration,
    consumedAt: null,
    revokedAt: null,
    revokedReason: null,
  };
  return { proposal, approval, timeoutMs: 2_000 };
}

ctest("adapter deadline includes hung preflight and prevents late dispatch", async () => {
  let sends = 0;
  const stub = makeStubClient({ send: async input => { sends += 1; return completedResult(input, "stub-device", "stub-service"); } });
  stub.refreshCapabilities = () => new Promise(resolve => setTimeout(() => resolve(makeCaps("stub-device", "stub-service")), 150));
  const started = Date.now();
  const result = await new RemoteKeyer({ client: stub }).transmit({ ...makeRequest(), timeoutMs: 50 }, new AbortController().signal);
  assert.equal(result.outcome, "unknown");
  assert.ok(Date.now() - started < 130);
  await sleep(180);
  assert.equal(sends, 0);
});

ctest("send failure attempts one stop; successful stop never rewrites unknown", async () => {
  for (const sync of [false, true]) {
    let stops = 0;
    const stub = makeStubClient({ stop: async input => {
      stops += 1;
      return { ...input, outcome: "cancelled", evidence: "backend_stopped", at: Date.now(), permissionGeneration: 1 };
    } });
    stub.send = () => { if (sync) throw new Error("write failed"); return Promise.reject(new Error("timeout")); };
    const result = await new RemoteKeyer({ client: stub }).transmit(makeRequest(), new AbortController().signal);
    assert.equal(result.outcome, "unknown");
    assert.equal(stops, 1);
  }
});

ctest("adapter timeout does not wait another full interval for hung stop", async () => {
  let stops = 0;
  const stub = makeStubClient({ send: () => new Promise(() => undefined), stop: () => { stops += 1; return new Promise(() => undefined); } });
  const started = Date.now();
  const result = await new RemoteKeyer({ client: stub }).transmit({ ...makeRequest(), timeoutMs: 60 }, new AbortController().signal);
  assert.equal(result.outcome, "unknown");
  assert.equal(stops, 1);
  assert.ok(Date.now() - started < 140);
});

ctest("completion racing abort and synchronous stop exception remain unknown", async () => {
  const abort = new AbortController();
  let stops = 0;
  const stub = makeStubClient({ send: async input => { abort.abort(); return completedResult(input, "stub-device", "stub-service"); } });
  stub.stop = () => { stops += 1; throw new Error("stop disconnected"); };
  const result = await new RemoteKeyer({ client: stub }).transmit(makeRequest(), abort.signal);
  assert.equal(result.outcome, "unknown");
  assert.equal(stops, 1);
});

ctest("stale future malformed snapshots and unreliable fabricated cancellation are rejected", async () => {
  for (const snapshot of [{ snapshotTime: Date.now() - 5_000 }, { snapshotTime: Date.now() + 60_000 }, { snapshotTime: Number.NaN }]) {
    let sends = 0;
    const stub = makeStubClient({ snapshot, send: async input => { sends += 1; return completedResult(input, "stub-device", "stub-service"); } });
    assert.equal((await new RemoteKeyer({ client: stub }).transmit(makeRequest(), new AbortController().signal)).outcome, "unknown");
    assert.equal(sends, 0);
  }
  const stub = makeStubClient({ caps: { reliableStopEvidence: false }, send: async input => ({ ...completedResult(input, "stub-device", "stub-service"), state: "cancelled", outcome: "cancelled", evidence: "backend_stopped" }) });
  assert.equal((await new RemoteKeyer({ client: stub }).transmit(makeRequest(), new AbortController().signal)).outcome, "unknown");
});

ctest("snapshot tolerates at most 20ms cross-process clock resolution skew", async () => {
  const now = Date.now();
  for (const [offset, outcome] of [[20, "completed"], [21, "unknown"]] as const) {
    let sends = 0;
    const stub = makeStubClient({ snapshot: { snapshotTime: now + offset }, send: async input => { sends += 1; return completedResult(input, "stub-device", "stub-service"); } });
    const keyer = new RemoteKeyer({ client: stub, now: () => now });
    assert.equal((await keyer.transmit(makeRequest(), new AbortController().signal)).outcome, outcome);
    assert.equal(sends, outcome === "completed" ? 1 : 0);
  }
});

ctest("state change before transmit revokes pending approval with zero device intent", async () => {
  const h = await startHarness();
  try {
    const p = h.controller.propose({ text: "CQ" });
    h.controller.approve(p.id);
    h.controller.setState({ frequencyHz: 7_000_000 }, "retune");
    await rejectsWithCode(h.controller.transmit(p.id), "conflict");
    assert.ok(h.journal.getApproval(p.id)?.revokedAt);
    assert.equal(countType(h.dir, "intent"), 0);
  } finally { await disposeHarness(h); }
});

ctest("accepted core generation is restored from the ledger after service restart", async () => {
  const dir = tempDir();
  let client: FakeRigClient | undefined;
  try {
    client = await FakeRigClient.start({ ledgerDir: dir });
    await client.send({ operationId: "generation-5", text: "CQ", stateGeneration: 5, expiresAt: Date.now() + 5_000 });
    await client.close();
    client = await FakeRigClient.start({ ledgerDir: dir });
    assert.equal(client.capabilities?.stateGeneration, 5);
    await rejectsWithCode(client.send({ operationId: "old-generation", text: "CQ", stateGeneration: 4, expiresAt: Date.now() + 5_000 }), "conflict");
    assert.equal(countType(dir, "intent"), 1);
  } finally { await client?.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 1. 授权前置：未批准不产生 intent ─────────────────────────────────────

ctest("未批准提案 transmit 被拒绝且账本零 intent", async () => {
  const harness = await startHarness();
  try {
    const proposal = harness.controller.propose({ text: "CQ TEST" });
    await rejectsWithCode(harness.controller.transmit(proposal.id), "conflict");
    assert.equal(countType(harness.dir, "intent"), 0);
    assert.equal(harness.keyer.sendRequestCount, 0);
  } finally {
    await disposeHarness(harness);
  }
});

// ── 2. 批准完成一次；同 ID 返回旧结果 ───────────────────────────────────

ctest("批准后完成一次，同 ID 重复返回旧结果且不重复键控", async () => {
  const harness = await startHarness();
  try {
    const proposal = harness.controller.propose({ text: "CQ TEST DE BD7XXX" });
    harness.controller.approve(proposal.id);
    const first = await harness.controller.transmit(proposal.id);
    assert.equal(first.status, "completed");
    assert.match(first.detail ?? "", /^simulation:fake backend_completed/);
    assert.equal(harness.keyer.sendRequestCount, 1);

    const second = await harness.controller.transmit(proposal.id);
    assert.equal(second.status, "completed");
    assert.equal(harness.keyer.sendRequestCount, 1, "同 ID 不得再次派发");
    assert.equal(countType(harness.dir, "intent"), 1);
    assert.equal(countType(harness.dir, "terminal"), 1);
  } finally {
    await disposeHarness(harness);
  }
});

// ── 3. 操作员 abort：可靠停止 -> cancelled ──────────────────────────────

ctest("操作员 abort 触发一次 stop，可靠停止证据映射 cancelled", async () => {
  const harness = await startHarness({ test: { delayMs: 500 } });
  try {
    const proposal = harness.controller.propose({ text: "PARIS" });
    harness.controller.approve(proposal.id);
    const pending = harness.controller.transmit(proposal.id);
    await waitFor(() => countType(harness.dir, "intent") === 1);
    const aborted = harness.controller.abort();
    assert.equal(aborted.aborted, true);
    const execution = await pending;
    assert.equal(execution.status, "cancelled");
    // 控制器在操作员 abort 路径上固定 detail="operator abort"；停止证据以设备账本为准。
    assert.equal(countType(harness.dir, "stop"), 1, "abort 只发一次 stop");
    assert.equal(countType(harness.dir, "terminal"), 1);
    const terminal = readLedger(harness.dir).find((record) => record.type === "terminal");
    assert.equal(terminal?.outcome, "cancelled");
    assert.equal(terminal?.evidence, "backend_stopped");
  } finally {
    await disposeHarness(harness);
  }
});

// ── 4. 无停止证据：unknown 并禁发 ───────────────────────────────────────

ctest("无可靠停止证据时 abort -> unknown 且服务禁发新 send", async () => {
  const harness = await startHarness({ test: { delayMs: 500, stopEvidence: "none" } });
  try {
    const proposal = harness.controller.propose({ text: "PARIS" });
    harness.controller.approve(proposal.id);
    const pending = harness.controller.transmit(proposal.id);
    await waitFor(() => countType(harness.dir, "intent") === 1);
    harness.controller.abort();
    const execution = await pending;
    assert.equal(execution.status, "unknown");
    assert.match(execution.detail ?? "", /stop/);

    const caps = await harness.client!.refreshCapabilities();
    assert.equal(caps.reliableStopEvidence, false);
    assert.equal(caps.blockedReason, "unknown");

    const second = harness.controller.propose({ text: "PARIS" });
    harness.controller.approve(second.id);
    await rejectsWithCode(harness.controller.transmit(second.id), "blocked");
    assert.equal(countType(harness.dir, "intent"), 1);
  } finally {
    await disposeHarness(harness);
  }
});

// ── 5. 核心超时 unknown 落盘；迟到结果/查询不清除 ───────────────────────

ctest("核心超时 unknown 落盘，迟到停止结果与 operation.get 不清除", async () => {
  const harness = await startHarness({
    test: { hangSend: true },
    txTimeoutMs: 400,
    requestTimeoutMs: 800,
  });
  try {
    const proposal = harness.controller.propose({ text: "SOS" });
    harness.controller.approve(proposal.id);
    const execution = await harness.controller.transmit(proposal.id);
    assert.equal(execution.status, "unknown");
    assert.equal(harness.journal.getExecution(proposal.id)?.status, "unknown");

    // 超时的适配器仍尝试一次 stop；其后续结果只落设备账本，不覆写核心 unknown。
    await waitFor(() => countType(harness.dir, "terminal") === 1);
    const view = await harness.client!.operationGet(proposal.id);
    assert.ok(view.state === "cancelled" || view.state === "unknown");
    await sleep(200);
    assert.equal(harness.journal.getExecution(proposal.id)?.status, "unknown");
    assert.ok(harness.controller.status().blockedReason !== null);
    assert.equal(countType(harness.dir, "intent"), 1);
  } finally {
    await disposeHarness(harness);
  }
});

ctest("迟到 backend_completed 不覆写核心已落盘 unknown（客户端替身）", async () => {
  const stub = makeStubClient({
    send: (input) =>
      new Promise((resolve) => setTimeout(() => resolve(completedResult(input, "stub-device", "stub-service")), 300)),
  });
  const harness = await startHarness({ stub, txTimeoutMs: 80 });
  try {
    const proposal = harness.controller.propose({ text: "LATE" });
    harness.controller.approve(proposal.id);
    const execution = await harness.controller.transmit(proposal.id);
    assert.equal(execution.status, "unknown");
    await sleep(400);
    assert.equal(harness.journal.getExecution(proposal.id)?.status, "unknown");
  } finally {
    await disposeHarness(harness);
  }
});

// ── 6. 状态变化撤销旧批准，在途 unknown ────────────────────────────────

ctest("状态变化撤销旧批准并把在途发射判为 unknown", async () => {
  const harness = await startHarness({ test: { delayMs: 600 } });
  try {
    const proposal = harness.controller.propose({ text: "PARIS" });
    harness.controller.approve(proposal.id);
    const pending = harness.controller.transmit(proposal.id);
    await waitFor(() => countType(harness.dir, "intent") === 1);
    harness.controller.setState({ frequencyHz: 7_000_000 }, "cat-retune");
    const execution = await pending;
    assert.equal(execution.status, "unknown");
    assert.equal(harness.journal.getProposal(proposal.id)?.status, "consumed");
    assert.ok(harness.journal.getApproval(proposal.id)?.revokedAt);
    assert.equal(countType(harness.dir, "stop"), 1);
  } finally {
    await disposeHarness(harness);
  }
});

// ── 7. 设备崩溃 unknown；恢复零重发 ────────────────────────────────────

ctest("设备崩溃 unknown，服务恢复为 unknown 且旧键零重发", async () => {
  const dir = tempDir();
  const journal = new SqliteJournal(join(dir, "core.sqlite"));
  let client: FakeRigClient | undefined;
  let restarted: FakeRigClient | undefined;
  try {
    client = await FakeRigClient.start({
      ledgerDir: dir,
      deviceInstanceId: "stable-device",
      frequencyHz: 14_000_000,
      requestTimeoutMs: 500,
      test: { hangSend: true },
    });
    const keyer = new RemoteKeyer({ client });
    const controller = new TxController(TxController.loadState(journal, { frequencyHz: 14_000_000 }), keyer, journal, {
      txTimeoutMs: 4_000,
    });
    const proposal = controller.propose({ text: "SOS" });
    controller.approve(proposal.id);
    const pending = controller.transmit(proposal.id);
    await waitFor(() => countType(dir, "intent") === 1);

    client.kill("SIGKILL");
    assert.equal(await client.waitForExit(2_000), true);
    const execution = await pending;
    assert.equal(execution.status, "unknown");
    assert.equal(journal.getExecution(proposal.id)?.status, "unknown");
    await client.close().catch(() => undefined);
    client = undefined;

    restarted = await FakeRigClient.start({
      ledgerDir: dir,
      deviceInstanceId: "stable-device",
      frequencyHz: 14_000_000,
    });
    assert.equal(restarted.capabilities?.blockedReason, "unknown");
    const recovered = await restarted.operationGet(proposal.id);
    assert.equal(recovered.state, "unknown");
    await rejectsWithCode(
      restarted.send({ operationId: "new-op", text: "SOS", stateGeneration: 0, expiresAt: Date.now() + 5_000 }),
      "blocked",
    );
    assert.equal(countType(dir, "intent"), 1, "崩溃恢复后不得重发旧键或新操作");
  } finally {
    await client?.close().catch(() => undefined);
    await restarted?.close().catch(() => undefined);
    try {
      journal.close();
    } catch {
      // 忽略。
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8. 非零核心 generation 可完成；回退拒绝 ────────────────────────────

ctest("非零核心 generation 可完成，设备拒绝更旧的核心代次", async () => {
  const harness = await startHarness({ generation: 5 });
  try {
    assert.equal(harness.controller.status().generation, 5);
    const proposal = harness.controller.propose({ text: "CQ TEST" });
    harness.controller.approve(proposal.id);
    const execution = await harness.controller.transmit(proposal.id);
    assert.equal(execution.status, "completed", execution.detail ?? "missing detail");
    assert.equal((await harness.client!.refreshCapabilities()).stateGeneration, 5);

    await rejectsWithCode(
      harness.client!.send({ operationId: "older-op", text: "CQ TEST", stateGeneration: 4, expiresAt: Date.now() + 5_000 }),
      "conflict",
    );
    assert.equal(countType(harness.dir, "intent"), 1, "回退操作必须在 intent 前拒绝");
  } finally {
    await disposeHarness(harness);
  }
});

// ── 9. 响应关联/上下文不一致 -> unknown（客户端替身） ──────────────────

ctest("响应 operationId/设备/服务/内容/上下文不一致一律 unknown（替身）", async () => {
  const base = makeRequest();
  const cases: Array<{ readonly name: string; readonly mutate: (result: OperationResult) => OperationResult }> = [
    { name: "operationId", mutate: (r) => ({ ...r, operationId: "other-op" }) },
    { name: "deviceInstanceId", mutate: (r) => ({ ...r, deviceInstanceId: "other-device" }) },
    { name: "serviceInstanceId", mutate: (r) => ({ ...r, serviceInstanceId: "other-service" }) },
    { name: "text", mutate: (r) => ({ ...r, text: `${r.text} ` }) },
    { name: "contentSha256", mutate: (r) => ({ ...r, contentSha256: "0".repeat(64) }) },
    { name: "frequencyHz", mutate: (r) => ({ ...r, frequencyHz: r.frequencyHz + 1 }) },
    { name: "connectionGeneration", mutate: (r) => ({ ...r, connectionGeneration: r.connectionGeneration + 1 }) },
    { name: "permissionGeneration", mutate: (r) => ({ ...r, permissionGeneration: r.permissionGeneration + 1 }) },
    { name: "stateGeneration", mutate: (r) => ({ ...r, stateGeneration: r.stateGeneration + 1 }) },
  ];
  for (const item of cases) {
    const stub = makeStubClient({
      send: async (input) => item.mutate(completedResult(input, "stub-device", "stub-service")),
    });
    const keyer = new RemoteKeyer({ client: stub });
    const result = await keyer.transmit(base, new AbortController().signal);
    assert.equal(result.outcome, "unknown", `case ${item.name}`);
    assert.match(result.detail ?? "", /rejected/, `case ${item.name}`);
  }
});

ctest("停止响应目标不符时 abort 映射 unknown（替身）", async () => {
  let markDispatched: () => void = () => undefined;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const stub = makeStubClient({
    send: () => {
      markDispatched();
      return new Promise<OperationResult>(() => undefined);
    },
    stop: async (input) => ({
      stopId: input.stopId,
      operationId: "other-op",
      outcome: "cancelled",
      evidence: "backend_stopped",
      at: Date.now(),
      permissionGeneration: 1,
    }),
  });
  const controller = new AbortController();
  const keyer = new RemoteKeyer({ client: stub });
  const request: TxRequest = { ...makeRequest(), timeoutMs: 300 };
  const pending = keyer.transmit(request, controller.signal);
  await dispatched;
  controller.abort();
  const result = await pending;
  assert.equal(result.outcome, "unknown");
});

// ── 10. 预检/初始 abort 零 intent ──────────────────────────────────────

ctest("预检阶段 abort 不派发 send，账本零 intent", async () => {
  const harness = await startHarness();
  try {
    const proposal = harness.controller.propose({ text: "CQ TEST" });
    harness.controller.approve(proposal.id);
    const pending = harness.controller.transmit(proposal.id);
    // transmit 已经同步进入预检并注册 abort 监听器；此时 abort 应阻止 send。
    harness.controller.abort();
    const execution = await pending;
    assert.equal(execution.status, "unknown");
    assert.match(execution.detail ?? "", /preflight/);
    assert.equal(countType(harness.dir, "intent"), 0);
    assert.equal(harness.keyer.sendRequestCount, 0);
  } finally {
    await disposeHarness(harness);
  }
});

ctest("初始已 abort 返回 unknown 且零 intent（替身不派发）", async () => {
  const harness = await startHarness();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await harness.keyer.transmit(makeRequest(), controller.signal);
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail ?? "", /before preflight/);
    assert.equal(countType(harness.dir, "intent"), 0);
  } finally {
    await disposeHarness(harness);
  }
});

// ── 11. 预检期限/字符/长度拒绝：零 intent ──────────────────────────────

ctest("过期授权、超过 60 秒与非法字符均在 intent 前拒绝", async () => {
  const cases: Array<{ readonly name: string; readonly request: TxRequest }> = [
    { name: "expired", request: makeRequest({ expiresAtMs: Date.now() - 1_000 }) },
    { name: "over-60s", request: makeRequest({ expiresAtMs: Date.now() + 120_000 }) },
    { name: "charset", request: makeRequest({ text: "CQ~" }) },
  ];
  for (const item of cases) {
    const harness = await startHarness();
    try {
      const result = await harness.keyer.transmit(item.request, new AbortController().signal);
      assert.equal(result.outcome, "unknown", `case ${item.name}`);
      assert.equal(countType(harness.dir, "intent"), 0, `case ${item.name}`);
    } finally {
      await disposeHarness(harness);
    }
  }
});

ctest("批准与提案不一致在 intent 前拒绝", async () => {
  const harness = await startHarness();
  try {
    const request = makeRequest();
    const mismatched: TxRequest = {
      ...request,
      approval: { ...request.approval, contentSha256: "1".repeat(64) },
    };
    const result = await harness.keyer.transmit(mismatched, new AbortController().signal);
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail ?? "", /approval content hash mismatch/);
    assert.equal(countType(harness.dir, "intent"), 0);
  } finally {
    await disposeHarness(harness);
  }
});
