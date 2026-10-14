// Offline acceptance: real local IPC and temporary SQLite, synthetic reports only.
// Historical approvals are seeded through a separate unguarded test controller.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { FakeKeyer } from "../packages/core/src/keyer.js";
import { ControllerError, TxController } from "../packages/core/src/tx-controller.js";
import { WindowsBridge } from "../packages/daemon/src/bridge.js";
import { DaemonClient } from "../packages/daemon/src/client.js";
import { endpointAddress, type Endpoint } from "../packages/daemon/src/endpoint.js";
import { DaemonServer } from "../packages/daemon/src/server.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { ReadOnlyRejectingKeyer, ReadOnlyRigApprovalGate } from "../packages/rig-status/src/approval-gate.js";
import { rigStatusEndpointAddress, type RigStatusEndpoint } from "../packages/rig-status/src/service.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await sleep(10);
  }
}
function blocked(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, "blocked");
  return true;
}
function report() {
  const now = Date.now();
  return {
    source: "rig-statusd", readOnly: true, status: "ready", stale: false, simulation: true,
    snapshotTime: now,
    snapshot: { frequencyHz: 7_030_000, mode: "CW", filter: 2, snapshotTime: now },
    owner: {
      protocolVersion: 1, serviceInstanceId: "test-instance-a", connectionGeneration: 1,
      capabilities: {
        readFrequency: true, readMode: true, cwSend: false, cwStop: false, ptt: false,
        completionEvidence: "unavailable", stopEvidence: "unavailable",
      },
    },
    error: null, portPath: null, baudRate: null, pollIntervalMs: 1_000, pollCount: 0, lastPollTime: now,
  };
}
type Report = ReturnType<typeof report>;

class ReportSource {
  readonly sockets = new Set<Duplex>();
  readonly methods: string[] = [];
  provider: () => unknown = report;
  hold = false;
  private readonly replies: Array<() => void> = [];
  private server: Server | undefined;
  private bridge: WindowsBridge | undefined;
  constructor(readonly endpoint: RigStatusEndpoint) {}
  async start(): Promise<void> {
    if (this.endpoint.kind === "pipe") {
      this.bridge = new WindowsBridge("server", rigStatusEndpointAddress(this.endpoint),
        (socket) => this.accept(socket), () => undefined);
      await this.bridge.ready;
    } else {
      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(rigStatusEndpointAddress(this.endpoint), resolve);
      });
    }
  }
  private accept(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
        buffer = buffer.slice(newline + 1);
        this.methods.push(request.method);
        const reply = (): void => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ok: true, result: this.provider() })}\n`);
        };
        if (this.hold) this.replies.push(reply);
        else reply();
      }
    });
  }
  release(): void {
    this.hold = false;
    for (const reply of this.replies.splice(0)) reply();
  }
  disconnect(): void {
    for (const socket of this.sockets) socket.destroy();
  }
  async close(): Promise<void> {
    this.disconnect();
    await this.bridge?.stop();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

async function fixture(t: TestContext, pollIntervalMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), "cwg-"));
  const endpoint: RigStatusEndpoint = process.platform === "win32"
    ? { kind: "pipe", name: `cwg-${randomUUID()}` }
    : { kind: "unix", path: join(dir, "rig.sock") };
  const source = new ReportSource(endpoint);
  const journal = new SqliteJournal(join(dir, "core.sqlite"));
  const keyer = new ReadOnlyRejectingKeyer();
  let gate!: ReadOnlyRigApprovalGate;
  const controller = new TxController(TxController.loadState(journal, { backendConnected: false }), keyer, journal, {
    approvalGuard: (proposal) => gate.checkApproval(proposal),
  });
  gate = new ReadOnlyRigApprovalGate(controller, endpoint, { pollIntervalMs, requestTimeoutMs: 300 });
  t.after(async () => {
    await gate.close();
    await source.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await source.start();
  function seedApproval() {
    const seed = new TxController(TxController.loadState(journal, {
      frequencyHz: controller.status().frequencyHz,
    }), new FakeKeyer(), journal);
    const proposal = seed.propose({ text: "CQ" });
    seed.approve(proposal.id);
    return proposal;
  }
  return { dir, source, journal, keyer, controller, gate, seedApproval };
}
function gtest(name: string, fn: (t: TestContext) => Promise<void>): void {
  test(name, { timeout: 15_000 }, fn);
}

gtest("first same-frequency device observation revokes historical approval", async (t) => {
  const f = await fixture(t);
  const p = f.seedApproval();
  const generation = f.controller.status().generation;
  await f.gate.start();
  assert.equal(f.controller.status().generation, generation + 1);
  assert.ok(f.journal.getApproval(p.id)?.revokedAt);
  assert.equal(f.journal.getProposal(p.id)?.status, "cancelled");
  assert.equal(f.journal.loadState().generation, generation + 1);
});

const changes: Array<[string, (r: Report) => void]> = [
  ["frequency", (r) => { r.snapshot.frequencyHz += 1_000; }],
  ["actual USB mode", (r) => { r.snapshot.mode = "USB"; }],
  ["unknown actual mode", (r) => { r.snapshot.mode = "OTHER"; }],
  ["connection generation", (r) => { r.owner.connectionGeneration += 1; }],
  ["same-frequency service instance", (r) => { r.owner.serviceInstanceId = "test-instance-b"; }],
  ["filter", (r) => { r.snapshot.filter = 3; }],
  ["availability", (r) => { r.status = "fault"; }],
];
for (const [name, change] of changes) {
  gtest(`${name} change revokes approval exactly once and never keys`, async (t) => {
    const f = await fixture(t);
    await f.gate.start();
    const p = f.seedApproval();
    const before = f.controller.status().generation;
    f.source.provider = () => { const r = report(); change(r); return r; };
    await f.gate.refresh();
    assert.equal(f.controller.status().generation, before + 1);
    assert.ok(f.journal.getApproval(p.id)?.revokedAt);
    assert.equal(f.journal.getProposal(p.id)?.status, "cancelled");
    assert.equal(f.journal.loadState().frequencyHz, f.controller.status().frequencyHz);
    assert.equal(f.gate.view().deviceMode, (f.source.provider() as Report).snapshot.mode);
    assert.equal(f.controller.status().mode, "CW");
    await f.gate.refresh();
    assert.equal(f.controller.status().generation, before + 1);
    await assert.rejects(f.controller.transmit(p.id), blocked);
    assert.equal(f.journal.getExecution(p.id), undefined);
    assert.equal(f.keyer.keyedCount, 0);
    assert.ok(f.source.methods.every((method) => method === "watch"));
  });
}

gtest("stable background polls refresh timestamps beyond two seconds without generation churn", async (t) => {
  const f = await fixture(t, 100);
  await f.gate.start();
  const p = f.seedApproval();
  const before = f.controller.status().generation;
  const first = f.gate.view().snapshotTime as number;
  await sleep(2_300);
  assert.ok((f.gate.view().snapshotTime as number) > first + 1_800);
  assert.equal(f.gate.view().fresh, true);
  assert.equal(f.controller.status().generation, before);
  assert.equal(f.journal.getApproval(p.id)?.revokedAt, null);
  assert.equal(f.gate.view().approvable, false);
  assert.throws(() => f.controller.approve(p.id), blocked);
});

const invalidReports: Array<[string, () => unknown]> = [
  ["missing owner", () => ({ ...report(), owner: undefined })],
  ["send capability", () => { const r = report(); r.owner.capabilities.cwSend = true; return r; }],
  ["negative connection generation", () => { const r = report(); r.owner.connectionGeneration = -1; return r; }],
  ["unsafe connection generation", () => { const r = report(); r.owner.connectionGeneration = Number.MAX_SAFE_INTEGER + 1; return r; }],
  ["expired timestamp", () => { const r = report(); r.snapshotTime -= 2_500; r.snapshot.snapshotTime = r.snapshotTime; return r; }],
  ["future timestamp", () => { const r = report(); r.snapshotTime += 1_000; r.snapshot.snapshotTime = r.snapshotTime; return r; }],
  ["inconsistent timestamps", () => ({ ...report(), snapshotTime: 0 })],
  ["non-read-only source", () => ({ ...report(), readOnly: false })],
  ["invalid filter", () => { const r = report(); r.snapshot.filter = 4; return r; }],
];
for (const [name, provider] of invalidReports) {
  gtest(`${name} fails closed, revokes once, and recovery cannot restore approval`, async (t) => {
    const f = await fixture(t);
    await f.gate.start();
    const p = f.seedApproval();
    const before = f.controller.status().generation;
    f.source.provider = provider;
    await f.gate.refresh();
    assert.equal(f.controller.status().backendConnected, false);
    assert.equal(f.controller.status().generation, before + 1);
    assert.ok(f.gate.view().error);
    assert.ok(f.journal.getApproval(p.id)?.revokedAt);
    assert.throws(() => f.controller.approve(p.id), blocked);
    await f.gate.refresh();
    assert.equal(f.controller.status().generation, before + 1);
    f.source.provider = report;
    await f.gate.refresh();
    assert.equal(f.controller.status().generation, before + 2);
    assert.equal(f.controller.status().backendConnected, true);
    assert.ok(f.journal.getApproval(p.id)?.revokedAt);
    assert.equal(f.journal.getExecution(p.id), undefined);
  });
}

gtest("CW and simulation reports cannot create or consume an approval", async (t) => {
  const f = await fixture(t);
  await f.gate.start();
  const p = f.controller.propose({ text: "CQ" });
  assert.throws(() => f.controller.approve(p.id), blocked);
  assert.equal(f.journal.getApproval(p.id), undefined);
  const old = f.seedApproval();
  assert.throws(() => f.controller.approve(old.id), blocked);
  await assert.rejects(f.controller.transmit(old.id), blocked);
  assert.equal(f.journal.getApproval(old.id)?.consumedAt, null);
  assert.equal(f.journal.getExecution(old.id), undefined);
  assert.equal(f.keyer.keyedCount, 0);
});

gtest("concurrent refresh merges; close discards an in-flight reply and never reconnects", async (t) => {
  const f = await fixture(t);
  await f.gate.start();
  const before = f.controller.status().generation;
  const count = f.source.methods.length;
  f.source.hold = true;
  f.source.provider = () => { const r = report(); r.snapshot.frequencyHz += 1_000; return r; };
  const a = f.gate.refresh();
  const b = f.gate.refresh();
  assert.equal(a, b);
  await waitFor(() => f.source.methods.length === count + 1);
  await f.gate.close();
  f.source.release();
  await Promise.all([a, b, f.gate.refresh(), f.gate.start()]);
  assert.equal(f.controller.status().generation, before);
  assert.equal(f.gate.attached, false);
  assert.equal(f.source.methods.length, count + 1);
});

gtest("IPC timeout and new connection revoke old authorization without serial reconnect", async (t) => {
  const f = await fixture(t);
  await f.gate.start();
  const p = f.seedApproval();
  f.source.hold = true;
  await f.gate.refresh();
  assert.equal(f.controller.status().backendConnected, false);
  assert.ok(f.journal.getApproval(p.id)?.revokedAt);
  const before = f.controller.status().generation;
  f.source.release();
  f.source.provider = () => { const r = report(); r.owner.serviceInstanceId = "after-restart"; return r; };
  await f.gate.refresh();
  assert.equal(f.gate.view().serviceInstanceId, "after-restart");
  assert.equal(f.controller.status().generation, before + 1);
  assert.ok(f.source.methods.every((method) => method === "watch"));
});

gtest("persistence failure clears gate state and recovery preserves the core fault latch", async (t) => {
  const f = await fixture(t);
  await f.gate.start();
  const before = f.controller.status();
  const save = f.journal.saveState.bind(f.journal);
  f.journal.saveState = () => { throw new Error("injected state write failure"); };
  f.source.provider = () => { const r = report(); r.snapshot.frequencyHz += 1_000; return r; };
  await f.gate.refresh();
  assert.equal(f.gate.view().stateReadyForCwContext, false);
  assert.ok(f.gate.view().error);
  assert.equal(f.controller.status().frequencyHz, before.frequencyHz);
  assert.equal(f.controller.status().generation, before.generation);
  assert.ok(f.controller.status().blockedReason);
  f.journal.saveState = save;
  await f.gate.refresh();
  assert.ok(f.controller.status().blockedReason);
  const p = f.controller.propose({ text: "CQ" });
  await assert.rejects(f.controller.transmit(p.id), blocked);
  assert.equal(f.journal.getExecution(p.id), undefined);
});

gtest("device recovery preserves an existing unknown execution and block", async (t) => {
  const f = await fixture(t);
  const seed = new TxController(TxController.loadState(f.journal), new FakeKeyer({ fault: "test fault", durationMs: 1 }), f.journal);
  const p = seed.propose({ text: "CQ" });
  seed.approve(p.id);
  assert.equal((await seed.transmit(p.id)).status, "unknown");
  // Reconstruct as startup would, preserving the persisted unknown block.
  const guarded = new TxController(TxController.loadState(f.journal, { backendConnected: false }), f.keyer, f.journal);
  guarded.recoverOnStartup();
  const gate = new ReadOnlyRigApprovalGate(guarded, f.source.endpoint);
  try {
    await gate.start();
    assert.ok(guarded.status().blockedReason);
    assert.equal(f.journal.getExecution(p.id)?.status, "unknown");
    f.source.provider = () => { const r = report(); r.owner.serviceInstanceId = "recovered"; return r; };
    await gate.refresh();
    assert.ok(guarded.status().blockedReason);
    assert.equal(f.journal.getExecution(p.id)?.status, "unknown");
    assert.equal(f.keyer.keyedCount, 0);
  } finally {
    await gate.close();
  }
});

gtest("explicit daemon CLI uses the existing read-only IPC and refuses approval", async (t) => {
  const f = await fixture(t);
  const base = dirname(dirname(fileURLToPath(import.meta.url)));
  const built = import.meta.url.endsWith(".js");
  const endpoint: Endpoint = process.platform === "win32"
    ? { kind: "pipe", name: `cwg-app-${randomUUID()}` }
    : { kind: "unix", path: join(f.dir, "app.sock") };
  const dbPath = join(f.dir, "app.sqlite");
  const args = built ? [join(base, "apps/daemon.js")] : ["--import", "tsx", join(base, "apps/daemon.ts")];
  args.push("--socket", endpointAddress(endpoint), "--db", dbPath,
    "--rig-endpoint", rigStatusEndpointAddress(f.source.endpoint));
  const child = spawn(process.execPath, args, {
    cwd: built ? dirname(base) : base,
    env: { ...process.env, CWSTATION_ENABLE_DEV_COMMANDS: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  let client: DaemonClient | undefined;
  try {
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`daemon exited: ${errors}`);
      return output.includes('"event":"daemon.ready"');
    });
    client = await DaemonClient.connect(endpointAddress(endpoint));
    const doctor = await client.request("doctor") as { fakeOnly: boolean; device: { approvable: boolean } };
    assert.equal(doctor.fakeOnly, false);
    assert.equal(doctor.device.approvable, false);
    await assert.rejects(client.request("dev.state", { frequencyHz: 7_040_000 }),
      (error: unknown) => (error as { code?: string }).code === "unknown_method");
    const p = await client.request("propose", { text: "CQ" }) as { id: string };
    await assert.rejects(client.request("approve", { id: p.id }), blocked);
    await assert.rejects(client.request("transmit", { id: p.id }), blocked);
    const status = await client.request("status") as { keyedCount: number; executionCounts: object };
    assert.equal(status.keyedCount, 0);
    assert.deepEqual(status.executionCounts, {});
    await client.request("daemon.stop");
    client.close();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.exitCode, 0, errors);
    assert.ok(f.source.methods.every((method) => method === "watch"));
    // Closing core daemon must leave the independently owned status source alive.
    await f.gate.start();
    assert.equal(f.gate.view().fresh, true);
    const persisted = new SqliteJournal(dbPath);
    try {
      assert.equal(persisted.getApproval(p.id), undefined);
      assert.equal(persisted.getExecution(p.id), undefined);
    } finally {
      persisted.close();
    }
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    }
  }
});

gtest("core guard rechecks existing approval and execution, but preserves terminal idempotency", async (t) => {
  const f = await fixture(t);
  let deny = false;
  let checks = 0;
  const keyer = new FakeKeyer({ durationMs: 1 });
  const core = new TxController(TxController.loadState(f.journal), keyer, f.journal, {
    approvalGuard: () => { checks += 1; if (deny) throw new ControllerError("blocked", "denied"); },
  });
  const p = core.propose({ text: "CQ" });
  core.approve(p.id);
  deny = true;
  assert.throws(() => core.approve(p.id), blocked);
  await assert.rejects(core.transmit(p.id), blocked);
  assert.equal(f.journal.getExecution(p.id), undefined);
  assert.equal(f.journal.getApproval(p.id)?.consumedAt, null);
  deny = false;
  const result = await core.transmit(p.id);
  const checked = checks;
  deny = true;
  assert.deepEqual(await core.transmit(p.id), result);
  assert.equal(checks, checked);
  assert.equal(keyer.keyedCount, 1);
});

for (const ending of ["timeout", "disconnect", "stop"] as const) {
  for (const method of ["propose", "approve", "transmit"] as const) {
    gtest(`RPC ${method} cannot run after ${ending} during refresh`, async (t) => {
      const f = await fixture(t);
      // This isolated Fake controller makes late side effects observable without a rejecting device guard.
      const keyer = new FakeKeyer({ durationMs: 1 });
      const core = new TxController(TxController.loadState(f.journal), keyer, f.journal);
      const p = core.propose({ text: "CQ" });
      if (method === "transmit") core.approve(p.id);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let entered = false;
      const endpoint: Endpoint = process.platform === "win32"
        ? { kind: "pipe", name: `cwg-rpc-${randomUUID()}` }
        : { kind: "unix", path: join(f.dir, "core.sock") };
      const server = new DaemonServer({ endpoint, dbPath: join(f.dir, "core.sqlite"), controller: core,
        journal: f.journal, requestTimeoutMs: 150, beforeDeviceCommand: async () => { entered = true; await pending; } });
      await server.start();
      const client = await DaemonClient.connect(endpointAddress(endpoint), { requestTimeoutMs: 3_000 });
      try {
        const result = client.request(method, method === "propose" ? { text: "LATE" } : { id: p.id })
          .then(() => "unexpected-success", (error: unknown) => error);
        await waitFor(() => entered);
        if (ending === "timeout") {
          const error = await result;
          assert.equal((error as { code?: string }).code, "request_timeout");
        } else if (ending === "disconnect") {
          client.close();
          await result;
          await sleep(50);
        } else {
          await client.request("daemon.stop");
        }
        release();
        const outcome = await result;
        assert.notEqual(outcome, "unexpected-success");
        await sleep(100);
        assert.equal(f.journal.listProposals().length, 1);
        assert.equal(f.journal.getApproval(p.id)?.consumedAt ?? null, null);
        if (method !== "transmit") assert.equal(f.journal.getApproval(p.id), undefined);
        assert.equal(f.journal.getExecution(p.id), undefined);
        assert.equal(keyer.keyedCount, 0);
      } finally {
        release();
        client.close();
        await server.stop();
      }
    });
  }
}
