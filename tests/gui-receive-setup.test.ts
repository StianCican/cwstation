import test from "node:test";
import assert from "node:assert/strict";
import { buildGuiReceiveArgs } from "../apps/gui/receive-setup.js";
import { parseReceiveArgs } from "../apps/rig-receive.js";
import { GuiStateAdapter } from "../apps/gui/ui-adapter.js";

const paths = new Map([["pcm", "/sample.pcm"], ["decoder", "/decoder"], ["reply-config", "/reply.json"], ["ffmpeg", "/ffmpeg"]]);
const calls = { ownCall: "B2BB", peerCall: "B1AA" };
const audio = { ...calls, inputMode: "audio", audioBackend: "pulse", audioDevice: "RDPSink.monitor" };

test("GUI keeps PCM requests compatible and uses the shared parser", () => {
  const setup = buildGuiReceiveArgs(calls, paths);
  assert.equal(setup.inputMode, "pcm");
  assert.ok(setup.argv.includes("--pcm-s16le"));
  assert.ok(!setup.argv.includes("--reply-continuous"));
  assert.doesNotThrow(() => parseReceiveArgs(setup.argv));
});

test("GUI live input uses the existing continuous receive route without dispatch flags", () => {
  for (const audioBackend of ["pulse", "dshow"]) {
    const setup = buildGuiReceiveArgs({ ...audio, audioBackend }, paths);
    assert.equal(setup.inputMode, "audio");
    assert.equal(setup.argv[setup.argv.indexOf("--audio-device") + 1], audio.audioDevice);
    assert.ok(setup.argv.includes("--reply-continuous"));
    assert.ok(!setup.argv.some(arg => /trial|auto|pcm-s16le/.test(arg)));
    assert.doesNotThrow(() => parseReceiveArgs(setup.argv));
  }
});

test("GUI rejects incomplete, mixed and extra receive options", () => {
  for (const payload of [null, [], {}, { ...audio, inputMode: "other" }, { ...audio, audioDevice: " " },
    { ...audio, audioBackend: "default" }, { ...calls, audioDevice: "default" },
    { ...audio, argv: ["--reply-auto"] }, { ...audio, ownCall: "--reply-auto" }]) {
    assert.throws(() => buildGuiReceiveArgs(payload, paths));
  }
  for (const role of ["ffmpeg", "decoder", "reply-config"]) {
    const missing = new Map(paths); missing.delete(role);
    assert.throws(() => buildGuiReceiveArgs(audio, missing));
  }
  const missingPcm = new Map(paths); missingPcm.delete("pcm");
  assert.throws(() => buildGuiReceiveArgs(calls, missingPcm));
});

test("live proposals remain editable across updates and dispatch binds only an active turn", () => {
  const adapter = new GuiStateAdapter();
  adapter.beginReceive("live", "audio");
  const reply = { type: "reply", text: "B1AA DE B2BB K", turnId: "t1", revision: 1, validated: true, action: "reply" };
  adapter.applyReceiveEvent("live", { type: "chunk", text: "CQ TEST " });
  adapter.applyReceiveEvent("live", reply);
  assert.equal(adapter.beginEdit().editing, true);
  adapter.applyReceiveEvent("live", { type: "chunk", text: "CQ AGAIN " });
  adapter.applyReceiveEvent("live", { ...reply, turnId: "t2" });
  assert.equal(adapter.getState().editing, true);
  assert.equal(adapter.getState().receivedText, "CQ TEST CQ AGAIN ");
  assert.equal(adapter.getState().proposal?.turnId, "t2");
  const request = { sessionId: "live", turnId: "t2", revision: 1, text: reply.text };
  const manual = adapter.simulationBinding(request);
  adapter.setMode("automatic");
  assert.equal(manual.isCurrent(), false);
  assert.equal(adapter.simulationBinding(request, true).isCurrent(), true);
  adapter.applyReceiveEvent("live", { type: "status", state: "completed" });
  assert.throws(() => adapter.simulationBinding({ sessionId: "live", turnId: "t2", revision: 1, text: reply.text }));
  assert.throws(() => adapter.simulationBinding({ sessionId: "live", turnId: "t2", revision: 1, text: reply.text }, true));
  assert.equal(adapter.stop().simulation.phase, "idle");
});
