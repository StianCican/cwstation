// V00-04-A desktop slice: verify the GUI boundary without starting Electron.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplyDispatchControl } from "../apps/reply-dispatch-control.js";
import { GUI_CHANNELS } from "../apps/gui/api.js";
import { handleGuiRequest } from "../apps/gui/ipc-handlers.js";
import { createPreloadApi, exposePreloadApi, PRELOAD_WORLD_KEY } from "../apps/gui/preload-api.js";
import { DEMO_GUI_SESSION, GuiStateAdapter } from "../apps/gui/ui-adapter.js";

test("GUI adapter uses the existing control and makes edit/manual/stop semantics observable", () => {
  const control = new ReplyDispatchControl();
  const adapter = new GuiStateAdapter(control, DEMO_GUI_SESSION);
  assert.equal(adapter.getState().mode, control.mode);
  assert.equal(adapter.getState().receivedText, DEMO_GUI_SESSION.receivedText);
  assert.equal(adapter.getState().proposal?.text, DEMO_GUI_SESSION.proposal?.text);

  const automatic = adapter.setMode("automatic");
  assert.equal(automatic.mode, "automatic");
  assert.equal(automatic.authorization, "armed");
  assert.equal(control.hasLease, true);

  const editing = adapter.beginEdit();
  assert.equal(editing.mode, "manual");
  assert.equal(editing.editing, true);
  assert.equal(control.hasLease, false);

  const stopped = adapter.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(control.signal.aborted, true);
  assert.deepEqual(adapter.setMode("automatic"), stopped);
  assert.deepEqual(adapter.beginEdit(), stopped);
  assert.deepEqual(adapter.revoke(), stopped);
});

test("GUI receive adapter projects the existing receive and reply events", () => {
  const adapter = new GuiStateAdapter(new ReplyDispatchControl());
  adapter.beginReceive("rx-1");
  adapter.applyReceiveEvent("rx-1", { type: "chunk", text: "CQ TEST " });
  adapter.applyReceiveEvent("rx-1", { type: "reply", text: "B1AA DE B2BB K", turnId: "t1", revision: 1, validated: true, action: "reply", replySource: "local_cq_template" });
  adapter.applyReceiveEvent("rx-1", { type: "status", state: "completed" });
  const state = adapter.getState();
  assert.equal(state.sessionId, "rx-1");
  assert.equal(state.receivedText, "CQ TEST ");
  assert.deepEqual(state.proposal, { source: "local-cq", text: "B1AA DE B2BB K", turnId: "t1", revision: 1 });
  assert.equal(state.receiveState, "completed");
});

test("GUI drops stale or no-reply proposals and revokes automatic authorization", () => {
  const adapter = new GuiStateAdapter(new ReplyDispatchControl());
  adapter.beginReceive("rx-1");
  adapter.applyReceiveEvent("rx-1", { type: "reply", text: "B1AA DE B2BB K", turnId: "t1", revision: 1, validated: true, action: "reply" });
  assert.equal(adapter.setMode("automatic").authorization, "armed");
  adapter.applyReceiveEvent("rx-1", { type: "reply", action: "no_reply" });
  assert.equal(adapter.getState().proposal, null);
  assert.equal(adapter.getState().authorization, "not-armed");
  adapter.applyReceiveEvent("old", { type: "reply", text: "stale", turnId: "old", revision: 1, validated: true, action: "reply" });
  assert.equal(adapter.getState().proposal, null);
});

test("IPC dispatcher is a closed typed command set", () => {
  const adapter = new GuiStateAdapter();
  assert.equal(handleGuiRequest(adapter, GUI_CHANNELS.getState).mode, "manual");
  assert.equal(handleGuiRequest(adapter, GUI_CHANNELS.setMode, "automatic").mode, "automatic");
  assert.throws(() => handleGuiRequest(adapter, GUI_CHANNELS.setMode, "auto"), /invalid gui mode/);
  assert.throws(() => handleGuiRequest(adapter, "cwstation:raw-send"), /unsupported gui channel/);
  assert.throws(() => handleGuiRequest(adapter, GUI_CHANNELS.stop, "raw command"), /unexpected gui payload/);
});

test("preload exposes only frozen typed controls and no Node capability", async () => {
  const calls: Array<readonly unknown[]> = [];
  const state = new GuiStateAdapter().getState();
  const api = createPreloadApi({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      return state;
    },
  });
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), ["beginEdit", "chooseFile", "confirmSimulation", "getState", "revoke", "setMode", "startReceive", "startSimulation", "stop"]);
  await api.setMode("automatic");
  await api.stop();
  await api.chooseFile("pcm");
  await api.startReceive({ ownCall: "B2BB", peerCall: "B1AA" });
  assert.deepEqual(calls, [
    [GUI_CHANNELS.setMode, "automatic"],
    [GUI_CHANNELS.stop],
    [GUI_CHANNELS.chooseFile, "pcm"],
    [GUI_CHANNELS.startReceive, { ownCall: "B2BB", peerCall: "B1AA" }],
  ]);
  assert.equal("process" in api, false);
  assert.equal("require" in api, false);

  let exposedName = "";
  let exposedApi: unknown;
  exposePreloadApi({
    exposeInMainWorld: (name, value) => { exposedName = name; exposedApi = value; },
  }, { invoke: async () => state });
  assert.equal(exposedName, PRELOAD_WORLD_KEY);
  assert.equal(Object.isFrozen(exposedApi), true);
});

test("renderer and preload sources cannot import device or receive capabilities", () => {
  const root = join(process.cwd(), "apps", "gui");
  const rendererFiles = ["renderer/App.tsx", "renderer/main.tsx", "renderer/styles.css"];
  const preloadSource = readFileSync(join(root, "preload.mts"), "utf8");
  assert.doesNotMatch(preloadSource, /serialport|packages[\\/]devices|packages[\\/]receive|child_process/);
  const mainSource = readFileSync(join(root, "main.ts"), "utf8");
  assert.match(mainSource, /runReceive\(argv/);
  assert.doesNotMatch(mainSource, /child_process|spawn\(/);
  for (const file of rendererFiles) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /serialport|packages[\\/]devices|packages[\\/]receive|child_process|ipcRenderer/);
  }
});
