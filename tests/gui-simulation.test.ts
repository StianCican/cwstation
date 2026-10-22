import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuiSimulation } from "../apps/gui/simulation.js";
import { GuiStateAdapter } from "../apps/gui/ui-adapter.js";
import { runCwTrial } from "../apps/rig-cw-trial.js";
import { createCwTrialSimulatorTransport, CwTrialRecordStore } from "../packages/cw-trial/src/index.js";

function receive(adapter: GuiStateAdapter, sessionId = "rx-1"): void {
  adapter.beginReceive(sessionId);
  adapter.applyReceiveEvent(sessionId, { type: "chunk", text: "CQ TEST " });
  adapter.applyReceiveEvent(sessionId, { type: "reply", text: "B1AA DE B2BB K", turnId: "t1", revision: 1, validated: true, action: "reply" });
  adapter.applyReceiveEvent(sessionId, { type: "status", state: "completed" });
}
const request = { sessionId: "rx-1", turnId: "t1", revision: 1, text: "B1AA DE B2BB TNX K" };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gui-simulation-"));
  const adapter = new GuiStateAdapter(); receive(adapter);
  const transports: ReturnType<typeof createCwTrialSimulatorTransport>[] = [];
  const simulation = new GuiSimulation(adapter, directory, (argv, deps) => runCwTrial(argv, {
    ...deps, createTransport: async () => { const transport = createCwTrialSimulatorTransport(); transports.push(transport); return transport; },
  }));
  t.after(async () => { adapter.stop(); await simulation.task; await rm(directory, { recursive: true, force: true }); });
  return { adapter, simulation, transports, directory,
    bodies: () => transports.flatMap(transport => transport.requests.filter(bytes => bytes[4] === 0x17 && bytes[5] !== 0xff)),
  };
}
async function confirming(simulation: GuiSimulation): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (simulation.adapter.getState().simulation.phase === "confirming") return;
    if (simulation.adapter.getState().simulation.phase === "failed") throw new Error("preflight failed");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("human confirmation was never presented");
}

test("GUI confirms edited final text through the original runner and retains original records", async t => {
  const f = await fixture(t);
  f.adapter.beginEdit();
  assert.equal(f.simulation.start(request).simulation.phase, "checking");
  assert.throws(() => f.simulation.start(request), /in progress/);
  await confirming(f.simulation);
  const view = f.adapter.getState().simulation;
  assert.equal(view.text, request.text);
  assert.equal(f.bodies().length, 0);
  assert.throws(() => f.simulation.confirm({ requestId: "old", text: view.text }), /exact/);
  assert.throws(() => f.simulation.confirm({ requestId: view.requestId, text: "WRONG" }), /exact/);
  f.simulation.confirm({ requestId: view.requestId, text: view.text });
  assert.throws(() => f.simulation.confirm({ requestId: view.requestId, text: view.text }), /exact/);
  await f.simulation.task;
  assert.equal(f.adapter.getState().simulation.phase, "completed");
  assert.equal(f.adapter.getState().simulation.exitCode, 0);
  assert.deepEqual(f.bodies().map(bytes => Buffer.from(bytes.slice(5, -1)).toString("ascii")), [request.text]);
  const store = await CwTrialRecordStore.open(f.directory);
  assert.deepEqual((await store.readAll()).map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
  assert.equal(await store.hasUnresolvedIntent(), true);
  assert.throws(() => f.simulation.start({ ...request, text: "DIFFERENT" }), /already had/);
  // A new proposal still uses the SAME store and must respect its unresolved intent.
  receive(f.adapter, "rx-2");
  f.simulation.start({ ...request, sessionId: "rx-2" });
  await f.simulation.task;
  assert.equal(f.adapter.getState().simulation.exitCode, 3);
  assert.equal(f.transports.length, 1);
  assert.equal(f.bodies().length, 1);
});

test("GUI stop cancels the pending confirmation and late confirmation cannot send", async t => {
  const f = await fixture(t);
  f.simulation.start(request); await confirming(f.simulation);
  const view = f.adapter.getState().simulation;
  f.adapter.stop();
  assert.throws(() => f.simulation.confirm({ requestId: view.requestId, text: view.text }), /exact/);
  await f.simulation.task;
  assert.equal(f.bodies().length, 0);
  assert.equal(f.transports[0]!.closed, true);
  assert.equal(f.adapter.getState().simulation.phase, "failed");
});

test("GUI generation changes invalidate a confirmation before dispatch", async t => {
  const f = await fixture(t);
  f.simulation.start(request); await confirming(f.simulation);
  const view = f.adapter.getState().simulation;
  f.adapter.beginEdit();
  f.simulation.confirm({ requestId: view.requestId, text: view.text });
  await f.simulation.task;
  assert.equal(f.bodies().length, 0);
  assert.equal(f.adapter.getState().simulation.phase, "failed");
});

test("GUI rejects invalid payload, missing proposal, running receive and stale identity", async t => {
  const f = await fixture(t);
  for (const bad of [null, { ...request, text: "lowercase" }, { ...request, text: "CQ ^" },
    { ...request, extra: true }, { ...request, revision: 2 }, { ...request, sessionId: "old" }]) {
    assert.throws(() => f.simulation.start(bad));
  }
  f.adapter.beginReceive("rx-1");
  assert.throws(() => f.simulation.start(request), /completed/);
  f.adapter.applyReceiveEvent("rx-1", { type: "status", state: "completed" });
  assert.throws(() => f.simulation.start(request), /completed/);
  assert.equal(f.transports.length, 0);
});

test("GUI automatic simulation uses shared control, skips human prompt and consumes once", async t => {
  const f = await fixture(t);
  f.adapter.setMode("automatic");
  assert.equal(f.simulation.startAutomaticIfReady().simulation.phase, "checking");
  await f.simulation.task;
  const state = f.adapter.getState();
  assert.equal(state.simulation.phase, "completed");
  assert.equal(state.simulation.exitCode, 0);
  assert.equal(state.authorization, "not-armed");
  assert.match(state.simulation.lines.join("\n"), /consumed once/);
  assert.deepEqual(f.bodies().map(bytes => Buffer.from(bytes.slice(5, -1)).toString("ascii")), ["B1AA DE B2BB K"]);
  f.simulation.startAutomaticIfReady();
  assert.equal(f.simulation.task, null);
  assert.equal(f.bodies().length, 1);
});

test("GUI manual mode and receive without current completed proposal never auto-dispatch", async t => {
  const f = await fixture(t);
  f.simulation.startAutomaticIfReady(); assert.equal(f.simulation.task, null);
  f.adapter.beginReceive("rx-running"); f.adapter.setMode("automatic");
  f.simulation.startAutomaticIfReady(); assert.equal(f.simulation.task, null);
  f.adapter.applyReceiveEvent("rx-running", { type: "status", state: "completed" });
  f.simulation.startAutomaticIfReady(); assert.equal(f.simulation.task, null);
  assert.equal(f.transports.length, 0);
});

for (const action of ["edit", "manual", "stop"] as const) test(`GUI ${action} revokes an automatic simulation before transport opens`, async t => {
  const f = await fixture(t);
  f.adapter.setMode("automatic"); f.simulation.startAutomaticIfReady();
  if (action === "edit") f.adapter.beginEdit();
  if (action === "manual") f.adapter.setMode("manual");
  if (action === "stop") f.adapter.stop();
  await f.simulation.task;
  assert.equal(f.bodies().length, 0);
  assert.equal(f.transports.length, 0);
  assert.equal(f.adapter.getState().simulation.phase, "failed");
});

test("GUI cannot route an edited draft into automatic dispatch", async t => {
  const f = await fixture(t);
  f.adapter.beginEdit(); f.adapter.setMode("automatic");
  assert.throws(() => f.adapter.simulationBinding(request, true), /selected mode/);
  f.adapter.beginEdit();
  f.simulation.startAutomaticIfReady();
  assert.equal(f.simulation.task, null);
});
