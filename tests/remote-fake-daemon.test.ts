import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeRigClient } from "../packages/rig-control/src/client.js";
import { RemoteKeyer } from "../packages/rig-control/src/remote-keyer.js";
import { RemoteFakeSession } from "../packages/rig-control/src/fake-session.js";
import { TxController } from "../packages/core/src/tx-controller.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { DaemonClient } from "../packages/daemon/src/client.js";

const base = dirname(dirname(fileURLToPath(import.meta.url)));
const built = import.meta.url.endsWith(".js");
const entry = join(base, "apps", built ? "daemon.js" : "daemon.ts");
const fakeEntry = join(base, "apps", built ? "rig-faked.js" : "rig-faked.ts");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check: () => boolean, timeout = 8_000): Promise<void> {
  const end = performance.now() + timeout;
  while (!check()) { if (performance.now() > end) throw new Error("wait timed out"); await sleep(20); }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function endpoint(dir: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\rf-${randomUUID()}` : join(dir, "core.sock");
}
function ledger(dir: string): Array<{ type: string; operationId?: string }> {
  const file = join(dir, "ledger.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
async function launch(t: TestContext, existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "rfdaemon-"));
  const socket = endpoint(dir);
  const args = built ? [entry] : ["--import", "tsx", entry];
  args.push("--socket", socket, "--db", join(dir, "core.sqlite"), "--remote-fake-ledger", join(dir, "ledger"));
  const child = spawn(process.execPath, args, { cwd: built ? dirname(base) : base,
    env: { ...process.env, CWSTATION_ENABLE_DEV_COMMANDS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  let client: DaemonClient | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { await client?.request("daemon.stop"); await wait(() => child.exitCode !== null || child.signalCode !== null); }
      catch { child.kill("SIGKILL"); await wait(() => child.exitCode !== null || child.signalCode !== null); }
    }
    client?.close();
    if (!existingDir) rmSync(dir, { recursive: true, force: true });
  });
  await wait(() => { if (child.exitCode !== null) throw new Error(`daemon failed ${err}`); return out.includes('"event":"daemon.ready"'); });
  client = await DaemonClient.connect(socket);
  const c = client;
  return { dir, child, client: c, output: () => out, async stop() {
    await c.request("daemon.stop"); c.close(); await wait(() => child.exitCode !== null || child.signalCode !== null);
  } };
}
function rtest(name: string, fn: (t: TestContext) => Promise<void>): void { test(name, { timeout: 25_000 }, fn); }

rtest("explicit Remote Fake completes once, truthful metrics and clean child shutdown", async (t) => {
  const h = await launch(t);
  const doctor = await h.client.request("doctor") as { fakeOnly: boolean; device: { pid: number; backendKind: string } };
  assert.equal(doctor.fakeOnly, true);
  assert.equal(doctor.device.backendKind, "fake");
  const pid = doctor.device.pid;
  const initial = await h.client.request("status") as { keyedCount: unknown };
  assert.equal(initial.keyedCount, null);
  await assert.rejects(h.client.request("dev.state", { frequencyHz: 7_040_000 }));
  const bad = await h.client.request("propose", { text: "CQ😀" }) as { id: string };
  await assert.rejects(h.client.request("approve", { id: bad.id }));
  assert.equal(ledger(join(h.dir, "ledger")).filter((r) => r.type === "intent").length, 0);
  const p = await h.client.request("propose", { text: "CQ" }) as { id: string };
  await h.client.request("approve", { id: p.id });
  const first = await h.client.request("transmit", { id: p.id }) as { status: string };
  assert.equal(first.status, "completed");
  assert.deepEqual(await h.client.request("transmit", { id: p.id }), first);
  const status = await h.client.request("status") as { keyedCount: unknown; executionMetrics: Record<string, unknown> };
  assert.equal(status.keyedCount, null);
  assert.deepEqual(status.executionMetrics, { version: 1, source: "simulation", sendAttempts: 1,
    confirmedCompletions: 1, confirmedStops: 0, uncertainAttempts: 0 });
  assert.equal(ledger(join(h.dir, "ledger")).filter((r) => r.type === "intent").length, 1);
  await h.stop();
  assert.equal(h.child.exitCode, 0);
  assert.match(h.output(), /"confirmed":true/);
  await wait(() => !alive(pid));
});

rtest("child crash revokes approval and is never automatically restarted", async (t) => {
  const h = await launch(t);
  const p = await h.client.request("propose", { text: "CQ" }) as { id: string };
  await h.client.request("approve", { id: p.id });
  const doctor = await h.client.request("doctor") as { device: { pid: number } };
  process.kill(doctor.device.pid, "SIGKILL");
  await sleep(300);
  const status = await h.client.request("status") as { backendConnected: boolean; device: { pid: number; connected: boolean } };
  assert.equal(status.backendConnected, false);
  assert.equal(status.device.connected, false);
  assert.equal(status.device.pid, doctor.device.pid);
  await assert.rejects(h.client.request("transmit", { id: p.id }));
  const proposals = await h.client.request("proposals") as Array<{ id: string; status: string }>;
  assert.equal(proposals.find((r) => r.id === p.id)?.status, "cancelled");
  assert.equal(ledger(join(h.dir, "ledger")).filter((r) => r.type === "intent").length, 0);
  await h.stop();
  assert.equal(h.child.exitCode, 1, "lost child must not be reported as clean shutdown");
});

rtest("parent crash closes child by EOF; restarting the same ledger never replays", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rf-parent-"));
  t.after(() => {
    if (process.env.CWSTATION_PRESERVE_TEST_EVIDENCE !== "1") rmSync(dir, { recursive: true, force: true });
    else console.error(`parent-crash evidence preserved: ${dir}`);
  });
  const first = await launch(t, dir);
  const p = await first.client.request("propose", { text: "CQ" }) as { id: string };
  await first.client.request("approve", { id: p.id });
  await first.client.request("transmit", { id: p.id });
  const doctor = await first.client.request("doctor") as { device: { pid: number } };
  first.child.kill("SIGKILL");
  first.client.close();
  await wait(() => first.child.signalCode !== null || first.child.exitCode !== null);
  await wait(() => !alive(doctor.device.pid));
  const second = await launch(t, dir);
  const result = await second.client.request("transmit", { id: p.id }) as { status: string };
  assert.equal(result.status, "completed");
  assert.equal(ledger(join(dir, "ledger")).filter((r) => r.type === "intent").length, 1);
  await second.stop();
});

rtest("session timeout becomes unknown; device ledger keeps new approvals blocked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rf-unknown-"));
  const journal = new SqliteJournal(join(dir, "core.sqlite"));
  const client = await FakeRigClient.start({ ledgerDir: join(dir, "ledger"), entry: fakeEntry,
    frequencyHz: 7_030_000, test: { hangSend: true, stopEvidence: "none" } });
  const keyer = new RemoteKeyer({ client });
  let session!: RemoteFakeSession;
  const core = new TxController(TxController.loadState(journal, { backendConnected: false }), keyer, journal,
    { txTimeoutMs: 200, approvalGuard: (proposal) => session.checkApproval(proposal) });
  session = new RemoteFakeSession(core, client, keyer);
  t.after(async () => { await session.close(); await core.shutdown(); await client.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  core.recoverOnStartup();
  await session.start();
  const p = core.propose({ text: "CQ" });
  core.approve(p.id);
  assert.equal((await core.transmit(p.id)).status, "unknown");
  await sleep(250);
  await session.refresh();
  assert.ok(core.status().blockedReason);
  assert.equal(journal.getExecution(p.id)?.status, "unknown");
  const next = core.propose({ text: "CQ" });
  assert.throws(() => core.approve(next.id));
  assert.equal(journal.getApproval(next.id), undefined);
  assert.equal(keyer.sendRequestCount, 1);
  assert.equal(keyer.executionMetrics.confirmedCompletions, 0);
  assert.equal(keyer.executionMetrics.uncertainAttempts, 1);
});

rtest("device ledger unknown blocks a fresh core without a core unknown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rf-device-block-"));
  const ledgerDir = join(dir, "ledger");
  const firstJournal = new SqliteJournal(join(dir, "first.sqlite"));
  let firstClosed = false;
  let firstClient: FakeRigClient | undefined;
  let firstSession: RemoteFakeSession | undefined;
  let firstCore: TxController | undefined;
  t.after(async () => {
    if (firstClosed) return;
    try { await firstSession?.close(); await firstCore?.shutdown(); }
    finally { try { await firstClient?.close(); } finally { firstJournal.close(); } }
  });
  firstClient = await FakeRigClient.start({ ledgerDir, entry: fakeEntry,
    frequencyHz: 7_030_000, test: { hangSend: true, stopEvidence: "none" } });
  const firstKeyer = new RemoteKeyer({ client: firstClient });
  firstCore = new TxController(TxController.loadState(firstJournal, { backendConnected: false }), firstKeyer, firstJournal,
    { txTimeoutMs: 200, approvalGuard: (proposal) => firstSession!.checkApproval(proposal) });
  firstSession = new RemoteFakeSession(firstCore, firstClient, firstKeyer);
  firstCore.recoverOnStartup();
  await firstSession.start();
  const original = firstCore.propose({ text: "CQ" });
  firstCore.approve(original.id);
  assert.equal((await firstCore.transmit(original.id)).status, "unknown");
  assert.equal(firstJournal.getExecution(original.id)?.status, "unknown");
  await firstSession.close();
  await firstCore.shutdown();
  await firstClient.close();
  assert.equal(firstClient.closeReport.confirmed, true);
  firstClosed = true;
  firstJournal.close();
  const beforeRestart = readFileSync(join(ledgerDir, "ledger.jsonl"), "utf8");

  const secondJournal = new SqliteJournal(join(dir, "second.sqlite"));
  let secondClient: FakeRigClient | undefined;
  let secondSession: RemoteFakeSession | undefined;
  let secondCore: TxController | undefined;
  t.after(async () => {
    try { await secondSession?.close(); await secondCore?.shutdown(); }
    finally {
      try {
        await secondClient?.close();
        if (secondClient) assert.equal(secondClient.closeReport.confirmed, true);
      }
      finally { secondJournal.close(); rmSync(dir, { recursive: true, force: true }); }
    }
  });
  secondClient = await FakeRigClient.start({ ledgerDir, entry: fakeEntry, frequencyHz: 7_030_000 });
  const secondKeyer = new RemoteKeyer({ client: secondClient });
  secondCore = new TxController(TxController.loadState(secondJournal, { backendConnected: false }), secondKeyer, secondJournal,
    { approvalGuard: (proposal) => secondSession!.checkApproval(proposal) });
  secondSession = new RemoteFakeSession(secondCore, secondClient, secondKeyer);
  secondCore.recoverOnStartup();
  await secondSession.start();
  assert.equal(secondCore.status().blockedReason, null, "fresh core has no core unknown");
  assert.equal(secondCore.unknownReview().unresolvedUnknownCount, 0);
  assert.equal(secondCore.status().backendConnected, false, "device ledger block disconnects fresh core");
  const next = secondCore.propose({ text: "CQ" });
  assert.throws(() => secondCore!.approve(next.id), /device service is blocked/);
  assert.throws(() => secondCore!.resolveUnknown(original.id,
    { operator: "offline-test", note: "device remains blocked", confirmStopped: true }), /backend disconnected/);
  assert.equal(secondJournal.getApproval(next.id), undefined);
  assert.equal(secondKeyer.sendRequestCount, 0);
  assert.equal((await secondClient.operationGet(original.id)).state, "unknown");
  assert.equal(readFileSync(join(ledgerDir, "ledger.jsonl"), "utf8"), beforeRestart, "restart and refusal do not rewrite or replay terminal ledger");
});

rtest("Remote Fake and real read-only endpoint are mutually exclusive before starting children", async () => {
  const args = built ? [entry] : ["--import", "tsx", entry];
  args.push("--rig-endpoint", process.platform === "win32" ? "\\\\.\\pipe\\unused" : "/tmp/unused-rf.sock",
    "--remote-fake-ledger", "unused-ledger");
  const child = spawn(process.execPath, args, { cwd: built ? dirname(base) : base, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  await wait(() => child.exitCode !== null);
  assert.equal(child.exitCode, 2);
  assert.match(output, /mutually exclusive/);
});

for (const ending of ["child-crash", "reliable-stop"] as const) {
  rtest(`in-flight ${ending} preserves evidence and metrics`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "rf-active-"));
    const journal = new SqliteJournal(join(dir, "core.sqlite"));
    const client = await FakeRigClient.start({ ledgerDir: join(dir, "ledger"), entry: fakeEntry,
      frequencyHz: 7_030_000, test: { delayMs: 3_000 } });
    const keyer = new RemoteKeyer({ client });
    let session!: RemoteFakeSession;
    const core = new TxController(TxController.loadState(journal, { backendConnected: false }), keyer, journal,
      { approvalGuard: (proposal) => session.checkApproval(proposal) });
    session = new RemoteFakeSession(core, client, keyer);
    t.after(async () => { await session.close(); await core.shutdown(); await client.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
    core.recoverOnStartup();
    await session.start();
    const p = core.propose({ text: "CQ" });
    core.approve(p.id);
    const pending = core.transmit(p.id);
    await wait(() => ledger(join(dir, "ledger")).some((r) => r.type === "intent"));
    if (ending === "child-crash") client.kill();
    else core.abort();
    const result = await pending;
    assert.equal(result.status, ending === "child-crash" ? "unknown" : "cancelled");
    assert.equal(keyer.sendRequestCount, 1);
    assert.equal(keyer.executionMetrics.confirmedCompletions, 0);
    assert.equal(keyer.executionMetrics.confirmedStops, ending === "reliable-stop" ? 1 : 0);
    assert.equal(keyer.executionMetrics.uncertainAttempts, ending === "child-crash" ? 1 : 0);
    if (ending === "child-crash") {
      assert.equal(core.status().backendConnected, false);
      assert.ok(core.status().blockedReason);
    }
    assert.equal(ledger(join(dir, "ledger")).filter((r) => r.type === "intent").length, 1);
  });
}
