import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReceive, type ReceiveAudioControl } from "../apps/rig-receive.js";
import { AudioReceiveError, type AudioReceiveOptions } from "../packages/receive/src/index.js";
import { GuiStateAdapter } from "../apps/gui/ui-adapter.js";
import { GuiSimulation } from "../apps/gui/simulation.js";
import { runCwTrial } from "../apps/rig-cw-trial.js";

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(); }
  throw new Error("condition timed out");
}
const reply = { type: "reply", text: "B1AA DE B2BB K", turnId: "t1", revision: 1, validated: true, action: "reply" };
const request = { sessionId: "live", turnId: "t1", revision: 1, text: reply.text };

test("shared live receive confirms cleanup before pause and preserves reply turns after resume", async t => {
  const directory = await mkdtemp(join(tmpdir(), "live-receive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "mock.json");
  await writeFile(config, JSON.stringify({ version: 1, provider: "mock", model: "mock-model" }));
  const parent = new AbortController();
  let control: ReceiveAudioControl | null = null;
  const events: Array<Record<string, unknown>> = [];
  const cycles: AudioReceiveOptions[] = [];
  let release: (() => void) | undefined;
  const task = runReceive(["--decoder", "/decoder", "--ffmpeg", "/ffmpeg", "--audio-backend", "pulse", "--audio-device", "monitor", "--timeout-ms", "10000",
    "--reply-config", config, "--own-call", "B2BB", "--peer-call", "B1AA", "--reply-continuous", "--reply-idle-ms", "1000"], {
    signal: parent.signal, sessionId: "live", print: () => undefined,
    onAudioControl: value => { control = value; }, onEvent: value => { events.push(value as Record<string, unknown>); },
    runAudio: options => {
      cycles.push(options);
      return new Promise((_, reject) => options.signal!.addEventListener("abort", () => {
        release = () => reject(new AudioReceiveError("aborted", "cleaned", { cleanupConfirmed: true }));
        if (cycles.length > 1) release();
      }, { once: true }));
    },
  });
  t.after(async () => { parent.abort(); release?.(); await task; });
  await until(() => control !== null);
  cycles[0]!.onChunk({ source: "multimon-ng", readOnly: true, sessionId: "live", seq: 1, text: "CQ TEST ", receivedAt: new Date().toISOString() });
  await until(() => events.some(e => e.type === "reply"));
  let paused = false;
  const pause = control!.pause().then(() => { paused = true; });
  await tick(); assert.equal(paused, false); assert.equal(cycles.length, 1);
  release!(); await pause;
  assert.ok(events.some(e => e.state === "paused"));
  control!.resume(); await until(() => cycles.length === 2);
  assert.ok(cycles[1]!.timeoutMs! < cycles[0]!.timeoutMs!);
  cycles[1]!.onChunk({ source: "multimon-ng", readOnly: true, sessionId: "live", seq: 1, text: "CQ AGAIN ", receivedAt: new Date().toISOString() });
  await until(() => events.filter(e => e.type === "reply").length === 2);
  const replies = events.filter(e => e.type === "reply");
  assert.notEqual(replies[0]!.turnId, replies[1]!.turnId);
  parent.abort(); assert.equal(await task, 0); assert.equal(control, null);
});

for (const outcome of ["stop-paused", "timeout-paused", "cleanup-failure"] as const) {
  test(`audio pause ${outcome} never restarts capture`, async () => {
    const parent = new AbortController();
    let control: ReceiveAudioControl | null = null;
    let starts = 0;
    const events: Array<Record<string, unknown>> = [];
    const task = runReceive(["--decoder", "/decoder", "--ffmpeg", "/ffmpeg", "--audio-backend", "pulse", "--audio-device", "monitor", "--timeout-ms", "100"], {
      signal: parent.signal, print: () => undefined,
      onEvent: value => { events.push(value as Record<string, unknown>); }, onAudioControl: value => { control = value; },
      runAudio: options => { starts++; return new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(new AudioReceiveError("aborted", "cleanup", { cleanupConfirmed: outcome !== "cleanup-failure" })), { once: true })); },
    });
    await until(() => control !== null);
    const saved = control!;
    if (outcome === "cleanup-failure") await assert.rejects(saved.pause(), /cleanup/);
    else { await saved.pause(); if (outcome === "stop-paused") parent.abort(); }
    assert.equal(await task, outcome === "stop-paused" ? 0 : 1);
    saved.resume(); await tick(); assert.equal(starts, 1); assert.equal(control, null);
    assert.ok(events.some(e => outcome === "stop-paused" ? e.state === "stopped" : e.type === "error"));
  });
}

for (const action of ["manual", "automatic", "stop", "edit", "new-text", "cleanup-failure"] as const) {
  test(`live bridge ${action}: one existing runner, pause ordering and cancellation`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "live-bridge-"));
    const adapter = new GuiStateAdapter(); adapter.beginReceive("live", "audio");
    adapter.applyReceiveEvent("live", reply);
    let cleaned = false, resumes = 0, starts = 0;
    let release: (() => void) | undefined;
    const audio: ReceiveAudioControl = {
      pause: () => new Promise<void>((resolve, reject) => { release = () => {
        if (action === "cleanup-failure") reject(new Error("unconfirmed cleanup"));
        else { cleaned = true; resolve(); }
      }; }),
      resume: () => { resumes++; },
    };
    const simulation = new GuiSimulation(adapter, directory, (argv, deps) => {
      assert.equal(cleaned, true); starts++;
      return runCwTrial(argv, deps);
    }, () => audio);
    t.after(async () => { adapter.stop(); release?.(); await simulation.task; await rm(directory, { recursive: true, force: true }); });
    if (action === "manual") adapter.beginEdit();
    else adapter.setMode("automatic");
    if (action === "manual") simulation.start(request); else simulation.startAutomaticIfReady();
    await until(() => release !== undefined);
    assert.equal(starts, 0);
    assert.throws(() => simulation.start(request), /in progress/);
    if (action === "stop") adapter.stop();
    if (action === "edit") adapter.beginEdit();
    if (action === "new-text") adapter.applyReceiveEvent("live", { type: "chunk", text: "NEW " });
    release!();
    if (action === "manual") {
      await until(() => adapter.getState().simulation.phase === "confirming");
      const view = adapter.getState().simulation;
      simulation.confirm({ requestId: view.requestId, text: view.text });
    }
    await simulation.task;
    const success = action === "manual" || action === "automatic";
    assert.equal(starts, success ? 1 : 0);
    assert.equal(adapter.getState().simulation.phase, success ? "completed" : "failed");
    assert.equal(resumes, action === "stop" || action === "cleanup-failure" ? 0 : 1);
    if (success) {
      assert.equal(adapter.getState().simulation.exitCode, 0);
      assert.equal(adapter.getState().receiveState, "running");
      assert.throws(() => simulation.start(request), /already had|selected mode/);
    }
  });
}
