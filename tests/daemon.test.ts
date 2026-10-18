import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, IS_WINDOWS, cliEntry, sleep, startDaemon, startDaemonExpectFailure, testEndpoint } from "./helpers.js";
import { DaemonClient, RpcError } from "../packages/daemon/src/client.js";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index.js";
import { DaemonServer } from "../packages/daemon/src/server.js";
import { endpointAddress } from "../packages/daemon/src/endpoint.js";
import { TxController } from "../packages/core/src/tx-controller.js";
import { FakeKeyer } from "../packages/core/src/keyer.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";

type Json = Record<string, unknown>;
type TestFn = (t: TestContext) => void | Promise<void>;

/** 所有 daemon 测试都必须有界，避免挂起进程拖住测试运行器。 */
const TEST_TIMEOUT_MS = 30_000;
function dtest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

async function request(socketPath: string, method: string, params: Json = {}): Promise<Json> {
  const client = await DaemonClient.connect(socketPath, { requestTimeoutMs: 20_000 });
  try {
    return (await client.request(method, params)) as Json;
  } finally {
    client.close();
  }
}

async function expectRpcError(promise: Promise<unknown>, code: string): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RpcError, `expected RpcError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected RpcError(${code}) but request succeeded`);
}

function rawRequest(socketPath: string, payload: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(data.trim());
    }, timeoutMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data.trim());
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (data.length > 0) resolve(data.trim());
      else reject(error);
    });
  });
}

dtest("existing connection cannot submit work while daemon is stopping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-stop-"));
  const dbPath = join(dir, "test.sqlite");
  const endpoint = testEndpoint(dir);
  const socketPath = endpointAddress(endpoint);
  const journal = new SqliteJournal(dbPath);
  const controller = new TxController(TxController.loadState(journal), new FakeKeyer(), journal);
  const server = new DaemonServer({ endpoint, dbPath, controller, journal });
  let release!: () => void;
  const closing = new Promise<void>((resolve) => { release = resolve; });
  let client: DaemonClient | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await server.start();
    client = await DaemonClient.connect(socketPath);
    await client.request("ping");
    stopping = server.stop(() => closing);
    await expectRpcError(client.request("propose", { text: "CQ" }), "blocked");
    assert.deepEqual(controller.status().proposalCounts, {});
  } finally {
    release();
    client?.close();
    await (stopping ?? server.stop());
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

dtest("daemon.stop is accepted once, then rejects other work and stays idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-rpcstop-"));
  const dbPath = join(dir, "test.sqlite");
  const endpoint = testEndpoint(dir);
  const socketPath = endpointAddress(endpoint);
  const journal = new SqliteJournal(dbPath);
  const controller = new TxController(TxController.loadState(journal), new FakeKeyer(), journal);
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = 0;
  const server = new DaemonServer({
    endpoint,
    dbPath,
    controller,
    journal,
    onStopRequested: async () => {
      requested += 1;
      await closing;
    },
  });
  let client: DaemonClient | undefined;
  try {
    await server.start();
    client = await DaemonClient.connect(socketPath);
    const first = (await client.request("daemon.stop", {})) as Json;
    assert.equal(first.accepted, true);
    assert.equal(first.alreadyStopping, false);

    // 同一连接立即被拒绝其它工作。
    await expectRpcError(client.request("propose", { text: "CQ" }), "blocked");
    assert.deepEqual(controller.status().proposalCounts, {});

    // 新连接：其它工作被拒绝，但重复停机请求幂等接受。
    await expectRpcError(request(socketPath, "status"), "blocked");
    const again = await request(socketPath, "daemon.stop", {});
    assert.equal(again.accepted, true);
    assert.equal(again.alreadyStopping, true);

    // 响应 flush 后应已触发一次共享关闭路径，且只触发一次。
    const deadline = Date.now() + 2_000;
    while (requested === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(requested, 1);
  } finally {
    release();
    client?.close();
    await server.stop();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

dtest("daemon.stop strictly rejects parameters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-rpcstop-params-"));
  const dbPath = join(dir, "test.sqlite");
  const endpoint = testEndpoint(dir);
  const socketPath = endpointAddress(endpoint);
  const journal = new SqliteJournal(dbPath);
  const controller = new TxController(TxController.loadState(journal), new FakeKeyer(), journal);
  const server = new DaemonServer({ endpoint, dbPath, controller, journal });
  let client: DaemonClient | undefined;
  try {
    await server.start();
    client = await DaemonClient.connect(socketPath);
    await expectRpcError(client.request("daemon.stop", { force: true }), "invalid_params");
    // 非法请求不得把服务器带入“已接受停机”状态。
    assert.equal((await client.request("ping") as Json).pong, true);
  } finally {
    client?.close();
    await server.stop();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

dtest("cwctl stop triggers the shared graceful shutdown and revokes approvals", async (t) => {
  const daemon = await startDaemon();
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  await request(daemon.socketPath, "approve", { id: proposal.id });

  const stop = spawnSync(process.execPath, [...cliEntry("cwctl"), "stop"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CWSTATION_SOCKET: daemon.socketPath },
  });
  const parsed = JSON.parse(stop.stdout.trim()) as Json;
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.equal(parsed.ok, true);
  assert.equal((parsed.result as Json).accepted, true);

  const code = await daemon.waitForExit(6_000);
  assert.equal(code, 0, "daemon must exit 0 after RPC stop");
  assert.match(daemon.stdout(), /daemon\.stopped/);
  assert.match(daemon.stdout(), /"signal":"rpc"/);

  // 重启同一数据库：开放授权必须已被撤销、提案已终止，且不会自动重发。
  const second = await startDaemon({ dir: daemon.dir, dbPath: daemon.dbPath, endpoint: daemon.endpoint });
  t.after(async () => {
    await second.stop();
    await daemon.stop();
  });
  const proposals = (await request(second.socketPath, "proposals")) as unknown as Json[];
  const stored = proposals.find((item) => item.id === proposal.id);
  assert.equal(stored?.status, "cancelled");
  const status = await request(second.socketPath, "status");
  assert.equal(status.keyedCount, 0);
  assert.deepEqual(status.approvalCounts, { active: 0, consumed: 0, revoked: 1 });
});

dtest("cross-process propose, approve and transmit through separate connections", async (t) => {
  const daemon = await startDaemon({ env: { CWSTATION_FAKE_DURATION_MS: "10" } });
  t.after(() => daemon.stop());

  const proposal = await request(daemon.socketPath, "propose", { text: "CQ TEST DE BD7XXX" });
  const approval = await request(daemon.socketPath, "approve", { id: proposal.id });
  const execution = await request(daemon.socketPath, "transmit", { id: proposal.id });

  assert.equal(proposal.status, "pending");
  assert.equal(approval.consumedAt, null);
  assert.equal(execution.status, "completed");
  const status = await request(daemon.socketPath, "status");
  assert.equal(status.keyedCount, 1);
  assert.deepEqual(status.executionCounts, { completed: 1 });
});

dtest("unapproved proposal is rejected and never keyed", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  await expectRpcError(request(daemon.socketPath, "transmit", { id: proposal.id }), "conflict");
  const status = await request(daemon.socketPath, "status");
  assert.equal(status.keyedCount, 0);
});

dtest("repeated transmit returns stored result and keys only once", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  await request(daemon.socketPath, "approve", { id: proposal.id });
  const first = await request(daemon.socketPath, "transmit", { id: proposal.id });
  const second = await request(daemon.socketPath, "transmit", { id: proposal.id });
  assert.deepEqual(second, first);
  const status = await request(daemon.socketPath, "status");
  assert.equal(status.keyedCount, 1);
});

dtest("concurrent transmit is rejected with busy", async (t) => {
  const daemon = await startDaemon({ env: { CWSTATION_FAKE_DURATION_MS: "5000", CWSTATION_TX_TIMEOUT_MS: "10000" } });
  t.after(() => daemon.stop());
  const a = await request(daemon.socketPath, "propose", { text: "CQ A" });
  const b = await request(daemon.socketPath, "propose", { text: "CQ B" });
  await request(daemon.socketPath, "approve", { id: a.id });
  await request(daemon.socketPath, "approve", { id: b.id });

  const client = await DaemonClient.connect(daemon.socketPath, { requestTimeoutMs: 20_000 });
  t.after(() => client.close());
  const pending = client.request("transmit", { id: a.id });
  await sleep(60);
  await expectRpcError(client.request("transmit", { id: b.id }), "busy");
  await client.request("abort");
  const result = (await pending) as Json;
  assert.equal(result.status, "cancelled");
});

dtest("abort is an independent request that preempts in-flight transmit", async (t) => {
  const daemon = await startDaemon({ env: { CWSTATION_FAKE_DURATION_MS: "500" } });
  t.after(() => daemon.stop());
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  await request(daemon.socketPath, "approve", { id: proposal.id });

  const client = await DaemonClient.connect(daemon.socketPath, { requestTimeoutMs: 20_000 });
  t.after(() => client.close());
  // Windows opens a bridge process per connection; establish it before the timed transmission.
  const abortClient = await DaemonClient.connect(daemon.socketPath, { requestTimeoutMs: 20_000 });
  t.after(() => abortClient.close());
  const pending = client.request("transmit", { id: proposal.id });
  await sleep(60);
  const abort = await abortClient.request("abort") as Json;
  assert.equal(abort.aborted, true);
  const result = (await pending) as Json;
  assert.equal(result.status, "cancelled");
});

dtest("proposal TTL is enforced across processes", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ", ttlMs: 1_000 });
  await sleep(1_150);
  await expectRpcError(request(daemon.socketPath, "approve", { id: proposal.id }), "expired");
});

dtest("station state change revokes approval before transmit", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  const approval = await request(daemon.socketPath, "approve", { id: proposal.id });
  assert.equal(approval.consumedAt, null);

  await request(daemon.socketPath, "dev.state", { frequencyHz: 7_040_000, reason: "test-retune" });
  await expectRpcError(request(daemon.socketPath, "transmit", { id: proposal.id }), "conflict");

  const proposals = await request(daemon.socketPath, "proposals");
  const stored = (proposals as unknown as Json[]).find((item) => item.id === proposal.id);
  assert.equal(stored?.status, "cancelled");
  const status = await request(daemon.socketPath, "status");
  assert.equal(status.keyedCount, 0);
});

dtest("invalid protocol input returns JSON errors and daemon stays alive", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  const malformed = JSON.parse(await rawRequest(daemon.socketPath, "not json\n")) as Json;
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error !== undefined, true);

  const wrongVersion = JSON.parse(
    await rawRequest(daemon.socketPath, `${JSON.stringify({ protocolVersion: 999, id: "1", method: "status", params: {} })}\n`),
  ) as Json;
  assert.equal((wrongVersion.error as Json).code, "protocol_version");

  const unknownMethod = JSON.parse(
    await rawRequest(
      daemon.socketPath,
      `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "2", method: "launch_missiles", params: {} })}\n`,
    ),
  ) as Json;
  assert.equal((unknownMethod.error as Json).code, "unknown_method");

  const badParams = JSON.parse(
    await rawRequest(
      daemon.socketPath,
      `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "3", method: "propose", params: { text: 42 } })}\n`,
    ),
  ) as Json;
  assert.equal((badParams.error as Json).code, "invalid_params");

  const oversized = await rawRequest(daemon.socketPath, `${"x".repeat(80_000)}\n`);
  const oversizedResponse = JSON.parse(oversized) as Json;
  assert.equal((oversizedResponse.error as Json).code, "invalid_request");

  const ping = await request(daemon.socketPath, "ping");
  assert.equal(ping.pong, true);
});

dtest("second daemon on the same socket/database is refused", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  const failure = await startDaemonExpectFailure(daemon.dir, { endpoint: daemon.endpoint });
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /live pid|lock|refusing/i);

  const ping = await request(daemon.socketPath, "ping");
  assert.equal(ping.pong, true);
});

dtest("crash during execution is recovered as unknown and blocks further keying", async (t) => {
  const first = await startDaemon({ env: { CWSTATION_FAKE_DURATION_MS: "3000" } });
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  t.after(async () => {
    await second?.stop();
    await first.stop();
  });

  const proposal = await request(first.socketPath, "propose", { text: "CQ" });
  await request(first.socketPath, "approve", { id: proposal.id });

  const client = await DaemonClient.connect(first.socketPath, { requestTimeoutMs: 20_000 });
  const pending = client.request("transmit", { id: proposal.id }).catch(() => undefined);
  await sleep(150);
  first.kill(); // SIGKILL：模拟崩溃
  assert.equal(await first.waitForTermination(3_000), true, "SIGKILLed daemon must exit");
  client.close();
  await Promise.race([pending, sleep(2_000)]);

  // 复用同一临时目录重启：验证陈旧 socket/锁被检查后接管，并执行恢复。
  second = await startDaemon({ dir: first.dir });

  const status = await request(second.socketPath, "status");
  assert.ok(status.blockedReason, "unknown execution must block further transmit");
  assert.equal((status.executionCounts as Json).unknown, 1);

  const executions = (await request(second.socketPath, "executions")) as unknown as Json[];
  assert.equal(executions[0]?.status, "unknown");
  assert.equal(executions[0]?.proposalId, proposal.id);

  const next = await request(second.socketPath, "propose", { text: "CQ AGAIN" });
  await request(second.socketPath, "approve", { id: next.id });
  await expectRpcError(request(second.socketPath, "transmit", { id: next.id }), "blocked");
  assert.equal((await request(second.socketPath, "status")).keyedCount, 0);
});

dtest("long-lived connection does not block graceful shutdown", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  // 保持一个从不发帧的长连接；旧实现会在此 await server.close 而挂死。
  const lingering = connect(daemon.socketPath);
  await new Promise<void>((resolve, reject) => {
    lingering.once("connect", () => resolve());
    lingering.once("error", reject);
  });

  let code: number | null;
  if (IS_WINDOWS) {
    // Windows 的 SIGTERM 是强制结束，不能用来验证优雅关闭；用 RPC daemon.stop 走同一路径。
    await request(daemon.socketPath, "daemon.stop", {});
    code = await daemon.waitForExit(6_000);
  } else {
    daemon.proc.kill("SIGTERM");
    code = await daemon.waitForExit(6_000);
  }
  const stoppedDeadline = Date.now() + 1_000;
  while (Date.now() < stoppedDeadline && !/daemon\.stopped/.test(daemon.stdout())) await sleep(20);
  lingering.destroy();
  assert.equal(code, 0, "daemon must exit 0 on graceful shutdown even with an open connection");
  assert.match(daemon.stdout(), /daemon\.stopped/);
});

dtest("frequency change updates station truth, revokes approval and aborts in-flight", async (t) => {
  const daemon = await startDaemon({ env: { CWSTATION_FAKE_DURATION_MS: "3000" } });
  t.after(() => daemon.stop());

  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  await request(daemon.socketPath, "approve", { id: proposal.id });

  const client = await DaemonClient.connect(daemon.socketPath, { requestTimeoutMs: 20_000 });
  const pending = client.request("transmit", { id: proposal.id });
  await sleep(80);
  const state = await request(daemon.socketPath, "dev.state", { frequencyHz: 7_040_000, reason: "test-retune" });
  assert.equal(state.frequencyHz, 7_040_000);

  const result = (await pending) as Json;
  client.close();
  assert.equal(result.status, "unknown", "frequency change must not let in-flight tx continue");

  // 新提案必须绑定新频率。
  const fresh = await request(daemon.socketPath, "propose", { text: "CQ NEW" });
  assert.equal(fresh.frequencyHz, 7_040_000);
  assert.equal((await request(daemon.socketPath, "status")).frequencyHz, 7_040_000);

  // 本次是期望内的 unknown：解除阻塞仅为让 daemon 停止测试干净，测试断言已完成。
});

dtest("daemon creates the database parent directory before locking", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "cwstation-nested-"));
  const dbPath = join(base, "nested", "deep", "cw.sqlite");
  const daemon = await startDaemon({ dir: base, dbPath });
  t.after(() => daemon.stop());
  assert.equal(existsSync(dbPath), true);
  assert.equal((await request(daemon.socketPath, "status")).schemaVersion, 4);
});

dtest("daemon does not chmod a pre-existing socket parent directory", async (t) => {
  if (IS_WINDOWS) {
    t.skip("Unix socket file modes are not applicable to Windows named pipes");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "cwstation-mode-"));
  const socketDir = join(base, "public");
  mkdirSync(socketDir, { recursive: true, mode: 0o755 });
  chmodSync(socketDir, 0o755);
  const before = statSync(socketDir).mode & 0o777;
  const daemon = await startDaemon({ dir: base, socketPath: join(socketDir, "cw.sock") });
  t.after(() => daemon.stop());
  const after = statSync(socketDir).mode & 0o777;
  assert.equal(after, before, "existing socket parent mode must be preserved");
  assert.equal(statSync(daemon.socketPath).mode & 0o777, 0o600);
});

dtest("doctor reports fakeOnly=true for the FakeKeyer daemon", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const doctor = await request(daemon.socketPath, "doctor");
  assert.equal(doctor.fakeOnly, true);
});

dtest("doctor reports endpoint kind, platform and a truthful access boundary", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const doctor = await request(daemon.socketPath, "doctor");
  assert.equal(doctor.listensOnTcp, false);
  assert.equal(doctor.schemaVersion, 4);
  assert.equal(doctor.platform, process.platform);
  assert.match(String(doctor.securityModel), /same-os-user/);
  const boundary = doctor.endpointAccessBoundary as Json;
  assert.equal(doctor.endpointKind, daemon.endpoint.kind);
  assert.equal((doctor.endpoint as Json).kind, daemon.endpoint.kind);
  if (daemon.endpoint.kind === "unix") {
    assert.equal(boundary.sameUserOnly, true);
    assert.match(String(boundary.model), /unix-socket-mode-0600/);
  } else {
    // Windows requires verified creation-time ACL rather than the default DACL.
    assert.equal(boundary.sameUserOnly, true);
    assert.match(String(boundary.model), /windows-protected-pipe-bridge/);
  }
});

dtest("Unix socket is 0600", async (t) => {
  if (IS_WINDOWS) {
    t.skip("Unix socket file modes are not applicable to Windows named pipes");
    return;
  }
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const mode = statSync(daemon.socketPath).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(existsSync(`${daemon.socketPath}.lock`), true, "socket lock file exists alongside the socket");
});

dtest("CLI returns semantic exit codes and pure JSON", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  const runCli = (args: string[], socketPath = daemon.socketPath): { status: number | null; stdout: string } => {
    const result = spawnSync(process.execPath, [...cliEntry("cwctl"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CWSTATION_SOCKET: socketPath },
    });
    return { status: result.status, stdout: result.stdout.trim() };
  };

  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  const unapproved = runCli(["transmit", String(proposal.id)]);
  assert.equal(unapproved.status, 4);
  const unapprovedJson = JSON.parse(unapproved.stdout) as Json;
  assert.equal(unapprovedJson.ok, false);

  const missing = runCli(["approve", "does-not-exist"]);
  assert.equal(missing.status, 3);

  const ok = runCli(["status"]);
  assert.equal(ok.status, 0);
  assert.equal((JSON.parse(ok.stdout) as Json).ok, true);

  const unavailable = runCli(["status"], IS_WINDOWS ? "\\\\.\\pipe\\cwstation-missing-cli-test" : join(daemon.dir, "missing.sock"));
  assert.equal(unavailable.status, 5);

  const usage = runCli(["propose"]);
  assert.equal(usage.status, 2);
});

dtest("demo is explicitly marked fake-only", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const result = await request(daemon.socketPath, "ping");
  assert.equal(result.pong, true);

  const demo = spawnSync(process.execPath, [...cliEntry("cwctl"), "demo", "CQ DEMO"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CWSTATION_SOCKET: daemon.socketPath },
  });
  assert.equal(demo.status, 0);
  const parsed = JSON.parse(demo.stdout.trim()) as Json;
  assert.equal((parsed.result as Json).fakeOnly, true);
  assert.match(String((parsed.result as Json).warning), /FAKE-ONLY/);
});
