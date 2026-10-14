// P2-002a：Fake IPC 第一条闭环专项测试。
//
// 所有用例都通过真实子进程和真实 stdin/stdout 字节流；账本一律位于系统临时
// 目录并在结束时清理。故障注入只使用 Fake 服务显式的 --test-* 选项。
//
// 运行：node --import tsx --test tests/rig-control.test.ts

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeRigClient, FakeRigClientError } from "../packages/rig-control/src/client.js";
import { FakeRigService } from "../packages/rig-control/src/fake-service.js";
import {
  RIG_CONTROL_MAX_FRAME_BYTES,
  RIG_CONTROL_PROTOCOL_VERSION,
  validateResponse,
  type DeviceCapabilities,
  type HelloResult,
  type OperationResult,
  type RigControlResponse,
} from "../packages/rig-control/src/protocol.js";
import { civPlanHex, planCivCwMessage } from "../packages/devices/src/civ-tx-plan.js";

function findProjectRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
const BUILT = import.meta.url.endsWith(".js");
const APP = join(ROOT, BUILT ? "dist/apps/rig-faked.js" : "apps/rig-faked.ts");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cwstation-rig-control-"));
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

test("frequency context mismatch is rejected before intent", async () => {
  const h = await startHarness();
  try {
    await assert.rejects(h.client.send({ operationId: "wrong-freq", text: "CQ", frequencyHz: 7_000_000, stateGeneration: 0, expiresAt: Date.now() + 5_000 }), e => isCode(e, "conflict"));
    assert.equal(countType(h.dir, "intent"), 0);
  } finally { await closeHarness(h); }
});

test("malformed and live locks remain intact; failed launch exits", async () => {
  const dir = tempDir();
  try {
    for (const lock of ["", "bad-json", JSON.stringify({ pid: process.pid })]) {
      writeFileSync(join(dir, "ledger.lock"), lock);
      await assert.rejects(FakeRigClient.start({ ledgerDir: dir }));
      assert.equal(readFileSync(join(dir, "ledger.lock"), "utf8"), lock);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("completed ledger survives restart; corruption and foreign device fail closed", async () => {
  const dir = tempDir();
  let client: FakeRigClient | undefined;
  try {
    client = await FakeRigClient.start({ ledgerDir: dir });
    await client.send({ operationId: "durable", text: "CQ", stateGeneration: 0, expiresAt: Date.now() + 5_000 });
    await client.close();
    const valid = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    client = await FakeRigClient.start({ ledgerDir: dir });
    assert.equal((await client.operationGet("durable")).state, "completed");
    await client.close();
    const records = valid.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const variants = [
      valid + JSON.stringify(records[0]) + "\n",
      valid + JSON.stringify(records[1]) + "\n",
      JSON.stringify({ ...records[0], deviceInstanceId: "other" }) + "\n",
      JSON.stringify({ ...records[0], contentSha256: "0".repeat(64) }) + "\n",
      JSON.stringify({ ...records[0], stateGeneration: -1 }) + "\n",
      JSON.stringify({ ...records[0], extra: true }) + "\n",
      valid + "{broken\n",
    ];
    for (const corrupt of variants) {
      writeFileSync(join(dir, "ledger.jsonl"), corrupt);
      client = await FakeRigClient.start({ ledgerDir: dir });
      assert.equal(client.capabilities?.blockedReason, "ledger_fault");
      await assert.rejects(client.send({ operationId: "new", text: "CQ", stateGeneration: 0, expiresAt: Date.now() + 5_000 }), e => isCode(e, "blocked"));
      assert.equal(readFileSync(join(dir, "ledger.jsonl"), "utf8"), corrupt);
      await client.close();
    }
  } finally { await client?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ledger append failure cannot report simulated execution", async () => {
  const dir = tempDir();
  let client: FakeRigClient | undefined;
  try {
    client = await FakeRigClient.start({ ledgerDir: dir, test: { ledgerWriteFailure: true } });
    await assert.rejects(client.send({ operationId: "full", text: "CQ", stateGeneration: 0, expiresAt: Date.now() + 5_000 }), e => isCode(e, "blocked"));
    assert.equal((await client.refreshCapabilities()).blockedReason, "ledger_fault");
    await assert.rejects(client.operationGet("full"), e => isCode(e, "not_found"));
  } finally { await client?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("runtime response validator rejects unknown fields and fabricated completion", () => {
  for (const raw of [null, [], { protocolVersion: 1, id: "1", ok: true, result: {} },
    { protocolVersion: 1, id: "1", ok: false, error: { code: "internal", message: "error", extra: true } }]) {
    assert.throws(() => validateResponse(raw, "cw.send"));
  }
});

test("malformed or oversized child response fails closed and startup cleans child", async () => {
  const dir = tempDir();
  try {
    for (const payload of ["null\n", "x".repeat(RIG_CONTROL_MAX_FRAME_BYTES + 1)]) {
      const entry = join(dir, "bad-service.cjs");
      const marker = join(dir, "exit-marker");
      writeFileSync(entry, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
process.stdin.once('data', () => process.stdout.write(${JSON.stringify(payload)}));
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();`);
      await assert.rejects(FakeRigClient.start({ ledgerDir: dir, entry }), e => isCode(e, "protocol"));
      const pid = Number(readFileSync(marker, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("historical frame is preserved when configured CI-V address changes", async () => {
  const dir = tempDir();
  let client: FakeRigClient | undefined;
  try {
    client = await FakeRigClient.start({ ledgerDir: dir, civAddress: 0x93 });
    const first = await client.send({ operationId: "address", text: "CQ", stateGeneration: 0, expiresAt: Date.now() + 5_000 });
    assert.equal(first.frameHex, civPlanHex(planCivCwMessage("CQ", { radioAddress: 0x93 })));
    await client.close();
    client = await FakeRigClient.start({ ledgerDir: dir, civAddress: 0x94 });
    assert.equal((await client.operationGet("address")).frameHex, first.frameHex);
  } finally { await client?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("channel loss increments permission generation and disables new sends", async () => {
  const dir = tempDir();
  const service = new FakeRigService({ ledgerDir: dir, deviceInstanceId: "fake-test" });
  const request = (method: string, params: Record<string, unknown>) => service.handleRequest({ protocolVersion: 1, id: "1", method, params });
  try {
    assert.equal((await request("hello", { sessionKey: "1".repeat(64), deviceInstanceId: "fake-test" })).ok, true);
    service.onChannelLost();
    assert.equal((await request("device.capabilities", {})).ok, false);
    assert.equal((await request("hello", { sessionKey: "2".repeat(64), deviceInstanceId: "fake-test" })).ok, true);
    const response = await request("device.capabilities", {});
    assert.equal((response.result as DeviceCapabilities).permissionGeneration, 1);
    const client = await FakeRigClient.start({ ledgerDir: join(dir, "separate"), deviceInstanceId: "fake-test" });
    try {
      const params = client.buildSendParams({ operationId: "lost", text: "CQ", stateGeneration: 0, permissionGeneration: 1, expiresAt: Date.now() + 5_000 }, { serviceInstanceId: service.serviceInstanceId });
      // A new hello never reopens the invalidated device session.
      const { computeCwSendToken } = await import("../packages/rig-control/src/protocol.js");
      const result = await request("cw.send", { ...params, token: computeCwSendToken("2".repeat(64), params) });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "blocked");
    } finally { await client.close(); }
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("oversized ledger is blocked without parsing or appending", async () => {
  const dir = tempDir();
  let client: FakeRigClient | undefined;
  try {
    writeFileSync(join(dir, "ledger.jsonl"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    client = await FakeRigClient.start({ ledgerDir: dir });
    assert.equal(client.capabilities?.blockedReason, "ledger_fault");
  } finally { await client?.close(); rmSync(dir, { recursive: true, force: true }); }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(15);
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof FakeRigClientError && error.code === code;
}

interface Harness {
  readonly dir: string;
  readonly client: FakeRigClient;
}

async function startHarness(
  overrides: Omit<Partial<Parameters<typeof FakeRigClient.start>[0]>, "ledgerDir"> = {},
  dir = tempDir(),
): Promise<Harness> {
  const client = await FakeRigClient.start({ ledgerDir: dir, ...overrides });
  return { dir, client };
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (harness !== undefined) await harness.client.close().catch(() => undefined);
  if (harness !== undefined) rmSync(harness.dir, { recursive: true, force: true });
}

/** 原始子进程连接：用于验证真实字节流、帧上限和不经客户端的拒绝路径。 */
class RawService {
  readonly child: ChildProcess;
  private readonly lines: string[] = [];
  private stderr = "";
  private buffer = "";

  constructor(ledgerDir: string, deviceId = "raw-device") {
    const args = BUILT ? [APP] : ["--import", "tsx", APP];
    this.child = spawn(process.execPath, [...args, "--ledger", ledgerDir, "--device-id", deviceId], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        this.lines.push(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  send(frame: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(text: string): void {
    this.child.stdin?.write(text);
  }

  async nextLine(timeoutMs = 3_000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (Date.now() - start > timeoutMs) throw new Error("raw response timed out");
      await sleep(10);
    }
  }

  async nextResponse(timeoutMs = 3_000): Promise<RigControlResponse> {
    const line = await this.nextLine(timeoutMs);
    return JSON.parse(line) as RigControlResponse;
  }

  get stderrText(): string {
    return this.stderr;
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  async waitExit(timeoutMs = 3_000): Promise<boolean> {
    const start = Date.now();
    while (!this.exited) {
      if (Date.now() - start > timeoutMs) return false;
      await sleep(10);
    }
    return true;
  }

  async end(): Promise<void> {
    this.child.stdin?.end();
    await this.waitExit();
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child.kill(signal);
  }
}

// ── 1. 正常完成、原帧与账本 ──────────────────────────────────────────────

test("正常完成：send 返回原帧、账本 intent+terminal、operation.get 一致", async () => {
  const harness = await startHarness();
  try {
    const { client, dir } = harness;
    const caps = client.capabilities;
    assert.ok(caps !== null);
    assert.equal(caps.backendKind, "fake");
    assert.equal(caps.evidenceSource, "simulation");
    assert.equal(caps.maxMessageBytes, 30);
    assert.equal(caps.charsetVersion, "ic7300-command17-v1");
    assert.equal(caps.reliableCompletionEvidence, true);
    assert.equal(caps.reliableStopEvidence, true);
    assert.equal(caps.blocked, false);
    assert.equal(caps.methods.includes("raw.write" as never), false);

    const snapshot = await client.snapshot();
    assert.equal(snapshot.mode, "CW");
    assert.equal(snapshot.frequencyHz, 14_000_000);
    assert.equal(snapshot.simulation, true);
    assert.equal(snapshot.connectionGeneration, caps.connectionGeneration);

    const expectedPlan = planCivCwMessage("CQ TEST", { radioAddress: caps.civAddress });
    const result = await client.send({
      operationId: "op-normal",
      text: "CQ TEST",
      stateGeneration: 0,
      expiresAt: Date.now() + 5_000,
    });
    assert.equal(result.state, "completed");
    assert.equal(result.outcome, "completed");
    assert.equal(result.evidence, "backend_completed");
    assert.equal(result.frameHex, civPlanHex(expectedPlan));
    assert.equal(result.frameBytes, expectedPlan.bytes.length);
    assert.equal(result.deviceInstanceId, caps.deviceInstanceId);

    const records = readLedger(dir);
    assert.equal(records.filter((record) => record.type === "intent").length, 1);
    assert.equal(records.filter((record) => record.type === "terminal").length, 1);

    const view = await client.operationGet("op-normal");
    assert.equal(view.state, "completed");
    assert.equal(view.frameHex, civPlanHex(expectedPlan));

    // 会话密钥从不出现在 stderr。
    assert.equal(client.stderrText.includes(client.sessionKey), false);
  } finally {
    await closeHarness(harness);
  }
});

// ── 2. 原始子进程字节流与信封拒绝 ────────────────────────────────────────

test("原始字节流：未握手 stop 拒绝、hello 不回显密钥、未知/错误信封拒绝", async () => {
  const dir = tempDir();
  const raw = new RawService(dir);
  const sessionKey = "ab".repeat(32);
  try {
    // 未 hello 的控制请求被拒绝。
    raw.send({ protocolVersion: 1, id: "s0", method: "cw.stop", params: { stopId: "stop-a", operationId: "op-a" } });
    const unauth = await raw.nextResponse();
    assert.equal(unauth.protocolVersion, RIG_CONTROL_PROTOCOL_VERSION);
    assert.equal(unauth.ok, false);
    assert.equal(unauth.error?.code, "unauthorized");

    raw.send({ protocolVersion: 1, id: "h1", method: "hello", params: { sessionKey, deviceInstanceId: "raw-device" } });
    const hello = await raw.nextResponse();
    assert.equal(hello.ok, true);
    const helloResult = hello.result as HelloResult;
    assert.equal(helloResult.deviceInstanceId, "raw-device");
    assert.equal(JSON.stringify(hello).includes(sessionKey), false);

    // 第二个 hello 被拒绝（唯一控制会话）。
    raw.send({ protocolVersion: 1, id: "h2", method: "hello", params: { sessionKey, deviceInstanceId: "raw-device" } });
    const secondHello = await raw.nextResponse();
    assert.equal(secondHello.ok, false);
    assert.equal(secondHello.error?.code, "conflict");

    raw.send({ protocolVersion: 1, id: "c1", method: "device.capabilities", params: {} });
    const caps = await raw.nextResponse();
    assert.equal(caps.ok, true);
    assert.equal((caps.result as DeviceCapabilities).backendKind, "fake");

    // 信封未知字段 / 错误协议版本 / 未知方法 / params 未知字段。
    raw.send({ protocolVersion: 1, id: "e1", method: "device.snapshot", params: {}, extra: true });
    assert.equal((await raw.nextResponse()).error?.code, "invalid_request");

    raw.send({ protocolVersion: 2, id: "e2", method: "device.snapshot", params: {} });
    assert.equal((await raw.nextResponse()).error?.code, "protocol_version");

    raw.send({ protocolVersion: 1, id: "e3", method: "raw.write", params: { bytes: "17" } });
    assert.equal((await raw.nextResponse()).error?.code, "unknown_method");

    raw.send({ protocolVersion: 1, id: "e4", method: "device.snapshot", params: { port: "COM17" } });
    assert.equal((await raw.nextResponse()).error?.code, "invalid_params");

    assert.equal(raw.stderrText.includes(sessionKey), false);
    await raw.end();
    assert.equal(await raw.waitExit(), true);
    assert.equal(raw.exited, true);
  } finally {
    raw.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. 同键防重复与冲突 ──────────────────────────────────────────────────

test("同键重放零副作用、换 nonce 不重执行、不同摘要冲突", async () => {
  const harness = await startHarness({ test: { delayMs: 300 } });
  try {
    const { client, dir } = harness;
    const expiresAt = Date.now() + 5_000;
    const firstParams = client.buildSendParams({ operationId: "op-dup", text: "PARIS", stateGeneration: 0, expiresAt });
    const replayParams = client.buildSendParams({ operationId: "op-dup", text: "PARIS", stateGeneration: 0, expiresAt });
    assert.notEqual(firstParams.nonce, replayParams.nonce, "重放必须使用不同的 nonce");

    const firstPromise = client.request<OperationResult>("cw.send", firstParams as unknown as Record<string, unknown>);
    await waitFor(() => countType(dir, "intent") === 1);
    const replay = await client.request<OperationResult>(
      "cw.send",
      replayParams as unknown as Record<string, unknown>,
    );
    assert.equal(replay.state, "running");
    assert.equal(replay.evidence, "intent_recorded");

    const first = await firstPromise;
    assert.equal(first.state, "completed");
    assert.equal(countType(dir, "intent"), 1);
    assert.equal(countType(dir, "terminal"), 1);

    // 同键不同摘要 -> 冲突，不产生新副作用。
    await assert.rejects(
      client.send({ operationId: "op-dup", text: "PARIS ", stateGeneration: 0, expiresAt }),
      (error: unknown) => isCode(error, "conflict"),
    );
    assert.equal(countType(dir, "intent"), 1);

    // 已终结的同键重放返回原终态，不重新执行。
    const terminalReplay = await client.send({ operationId: "op-dup", text: "PARIS", stateGeneration: 0, expiresAt });
    assert.equal(terminalReplay.state, "completed");
    assert.equal(countType(dir, "intent"), 1);
  } finally {
    await closeHarness(harness);
  }
});

// ── 4. stop：授权过期后停止、停发证据与重复 stopId ───────────────────────

test("stop 不受 send 授权过期限制，证据 stopped -> cancelled，重复 stopId 幂等/冲突", async () => {
  const harness = await startHarness({ test: { delayMs: 500, stopEvidence: "stopped" } });
  try {
    const { client, dir } = harness;
    const expiresAt = Date.now() + 120;
    const sendPromise = client.send({ operationId: "op-stop-exp", text: "TEST", stateGeneration: 0, expiresAt });
    await waitFor(() => countType(dir, "intent") === 1);
    await sleep(220); // 让 send 授权过期
    const stop = await client.stop({ stopId: "stop-1", operationId: "op-stop-exp" });
    assert.equal(stop.outcome, "cancelled");
    assert.equal(stop.evidence, "backend_stopped");
    const sendResult = await sendPromise;
    assert.equal(sendResult.state, "cancelled");

    // 相同 stopId 相同目标返回既有结果。
    const repeat = await client.stop({ stopId: "stop-1", operationId: "op-stop-exp" });
    assert.equal(repeat.outcome, "cancelled");
    assert.equal(repeat.evidence, "backend_stopped");

    // 相同 stopId 不同目标拒绝。
    await assert.rejects(
      client.stop({ stopId: "stop-1", operationId: "op-other" }),
      (error: unknown) => isCode(error, "conflict"),
    );

    // 迟到的后端完成不得覆盖 cancelled 终态。
    await sleep(400);
    const view = await client.operationGet("op-stop-exp");
    assert.equal(view.state, "cancelled");
    assert.equal(view.evidence, "backend_stopped");
    assert.equal(countType(dir, "terminal"), 1);
  } finally {
    await closeHarness(harness);
  }
});

test("已过期的 send 在 intent 前被拒绝", async () => {
  const harness = await startHarness({ test: { delayMs: 5 } });
  try {
    const { client, dir } = harness;
    await assert.rejects(
      client.send({ operationId: "op-expired", text: "TEST", stateGeneration: 0, expiresAt: Date.now() - 1_000 }),
      (error: unknown) => isCode(error, "expired"),
    );
    assert.equal(countType(dir, "intent"), 0);
    assert.equal(countType(dir, "terminal"), 0);
  } finally {
    await closeHarness(harness);
  }
});

test("stop 无可靠证据 -> unknown 并阻止新 send", async () => {
  const harness = await startHarness({ test: { delayMs: 500, stopEvidence: "none" } });
  try {
    const { client, dir } = harness;
    const sendPromise = client.send({
      operationId: "op-unknown",
      text: "TEST",
      stateGeneration: 0,
      expiresAt: Date.now() + 5_000,
    });
    await waitFor(() => countType(dir, "intent") === 1);
    const stop = await client.stop({ stopId: "stop-unknown", operationId: "op-unknown" });
    assert.equal(stop.outcome, "unknown");
    assert.equal(stop.evidence, "stop_insufficient");
    const sendResult = await sendPromise;
    assert.equal(sendResult.state, "unknown");

    const caps = await client.refreshCapabilities();
    assert.equal(caps.blocked, true);
    assert.equal(caps.reliableStopEvidence, false);
    assert.equal(caps.blockedReason, "unknown");
    await assert.rejects(
      client.send({ operationId: "op-after-unknown", text: "TEST", stateGeneration: 0, expiresAt: Date.now() + 5_000 }),
      (error: unknown) => isCode(error, "blocked"),
    );
    assert.equal(countType(dir, "intent"), 1);
  } finally {
    await closeHarness(harness);
  }
});

// ── 5. 客户端超时不自动重发 ──────────────────────────────────────────────

test("客户端超时只拒绝本请求，不自动重发", async () => {
  const harness = await startHarness({ requestTimeoutMs: 200, test: { hangSend: true } });
  try {
    const { client, dir } = harness;
    await assert.rejects(
      client.send({ operationId: "op-hang", text: "TEST", stateGeneration: 0, expiresAt: Date.now() + 5_000 }),
      (error: unknown) => isCode(error, "timeout"),
    );
    await sleep(400);
    assert.equal(countType(dir, "intent"), 1, "超时后不得自动重发");
    const view = await client.operationGet("op-hang");
    assert.equal(view.state, "running");
  } finally {
    await closeHarness(harness);
  }
});

// ── 6. 服务重启恢复 unknown ──────────────────────────────────────────────

test("服务重启把遗留 intent 恢复为 unknown，阻止新 send 且旧键不重发", async () => {
  const dir = tempDir();
  let clientA: FakeRigClient | undefined;
  let clientB: FakeRigClient | undefined;
  const expiresAt = Date.now() + 5_000;
  try {
    clientA = await FakeRigClient.start({ ledgerDir: dir, deviceInstanceId: "stable-device", test: { hangSend: true } });
    const capsA = clientA.capabilities;
    assert.ok(capsA !== null);
    const sendPromise = clientA
      .send({ operationId: "op-recover", text: "SOS", stateGeneration: 0, expiresAt })
      .catch(() => undefined);
    await waitFor(() => countType(dir, "intent") === 1);
    assert.equal(countType(dir, "terminal"), 0);

    // 模拟崩溃：直接 SIGKILL，不经过 EOF 优雅停止。
    clientA.kill("SIGKILL");
    assert.equal(await clientA.waitForExit(2_000), true);
    await clientA.close().catch(() => undefined);
    await sendPromise;
    clientA = undefined;

    clientB = await FakeRigClient.start({ ledgerDir: dir, deviceInstanceId: "stable-device" });
    const capsB = clientB.capabilities;
    assert.ok(capsB !== null);
    assert.equal(capsB.deviceInstanceId, "stable-device");
    assert.equal(capsB.deviceInstanceId, capsA.deviceInstanceId);
    assert.notEqual(capsB.serviceInstanceId, capsA.serviceInstanceId);
    assert.equal(capsB.blocked, true);
    assert.equal(capsB.blockedReason, "unknown");

    const recovered = await clientB.operationGet("op-recover");
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.evidence, "recovered_unfinished");

    await assert.rejects(
      clientB.send({ operationId: "op-new", text: "SOS", stateGeneration: 0, expiresAt: Date.now() + 5_000 }),
      (error: unknown) => isCode(error, "blocked"),
    );
    const terminalsAfterNew = countType(dir, "terminal");
    const replay = await clientB.send({ operationId: "op-recover", text: "SOS", stateGeneration: 0, expiresAt });
    assert.equal(replay.state, "unknown");
    assert.equal(countType(dir, "intent"), 1, "旧键不得重发");
    assert.equal(countType(dir, "terminal"), terminalsAfterNew, "重放不得追加终态");
  } finally {
    await closeHarness(clientA === undefined ? undefined : { dir, client: clientA });
    await closeHarness(clientB === undefined ? undefined : { dir, client: clientB });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7. 错误 token / 内容摘要 / 未知字段 ──────────────────────────────────

test("错误 token、错误 contentSha256、未知参数和未知方法均拒绝且无副作用", async () => {
  const harness = await startHarness({ test: { delayMs: 5 } });
  try {
    const { client, dir } = harness;
    const expiresAt = Date.now() + 5_000;
    const params = client.buildSendParams({ operationId: "op-token", text: "TEST", stateGeneration: 0, expiresAt });

    const badToken = { ...params, token: "0".repeat(64) };
    await assert.rejects(
      client.request("cw.send", badToken as unknown as Record<string, unknown>),
      (error: unknown) => isCode(error, "unauthorized"),
    );

    const badHash = client.buildSendParams(
      { operationId: "op-token", text: "TEST", stateGeneration: 0, expiresAt },
      { contentSha256: "1".repeat(64) },
    );
    await assert.rejects(
      client.request("cw.send", badHash as unknown as Record<string, unknown>),
      (error: unknown) => isCode(error, "invalid_params"),
    );

    const extraField = { ...params, extra: true };
    await assert.rejects(
      client.request("cw.send", extraField as unknown as Record<string, unknown>),
      (error: unknown) => isCode(error, "invalid_params"),
    );

    const rawCall = client.request.bind(client) as unknown as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    await assert.rejects(rawCall("raw.write", { bytes: "17" }), (error: unknown) => isCode(error, "unknown_method"));

    assert.equal(countType(dir, "intent"), 0);
  } finally {
    await closeHarness(harness);
  }
});

// ── 8. 字节帧上限 ────────────────────────────────────────────────────────

test("超过 16KiB 的行被有界拒绝并关闭通道", async () => {
  const dir = tempDir();
  const raw = new RawService(dir);
  try {
    raw.sendRaw(`${"a".repeat(RIG_CONTROL_MAX_FRAME_BYTES + 512)}\n`);
    const response = await raw.nextResponse();
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, "invalid_request");
    assert.match(response.error?.message ?? "", /16384/);
    assert.equal(await raw.waitExit(3_000), true);
    assert.equal(countType(dir, "intent"), 0);
  } finally {
    raw.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 9. device.close 与退出无残留 ─────────────────────────────────────────

test("device.close 拒绝新 send 但保留账本查询；close 后无子进程与锁残留", async () => {
  const harness = await startHarness({ test: { delayMs: 5 } });
  const dir = harness.dir;
  const client = harness.client;
  try {
    const first = await client.send({
      operationId: "op-close",
      text: "TEST",
      stateGeneration: 0,
      expiresAt: Date.now() + 5_000,
    });
    assert.equal(first.state, "completed");

    const closed = await client.closeDevice();
    assert.equal(closed.closed, true);
    await assert.rejects(
      client.send({ operationId: "op-close-2", text: "TEST", stateGeneration: 0, expiresAt: Date.now() + 5_000 }),
      (error: unknown) => isCode(error, "blocked"),
    );
    const view = await client.operationGet("op-close");
    assert.equal(view.state, "completed");

    const pid = client.pid;
    assert.ok(pid !== null);
    await client.close();
    assert.equal(await client.waitForExit(2_000), true);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "子进程必须已退出");
    assert.equal(existsSync(join(dir, "ledger.lock")), false, "账本锁必须已移除");
    await assert.rejects(
      client.request("device.snapshot", {}),
      (error: unknown) => isCode(error, "unavailable"),
    );
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
