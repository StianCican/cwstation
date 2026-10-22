// V00-04-A desktop slice: Electron host. The renderer receives only the
// typed display/control API; this process retains the single authorization
// object and never exposes raw device commands to the page.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_CHANNELS } from "./api.js";
import { handleGuiRequest } from "./ipc-handlers.js";
import { GuiStateAdapter } from "./ui-adapter.js";
import { runReceive, type ReceiveAudioControl } from "../rig-receive.js";
import { GuiSimulation } from "./simulation.js";
import { buildGuiReceiveArgs } from "./receive-setup.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const adapter = new GuiStateAdapter();
let audioControl: ReceiveAudioControl | null = null;
const simulation = new GuiSimulation(adapter, undefined, undefined, () => audioControl);
let windowInstance: BrowserWindow | null = null;
const selectedPaths = new Map<string, string>();
let receiveTask: Promise<number> | null = null;
let closingWindow = false;

function registerIpc(): void {
  for (const channel of Object.values(GUI_CHANNELS)) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      if (args.length > 1) throw new Error("unsupported gui payload");
      if (channel === GUI_CHANNELS.startSimulation) {
        if (args.length !== 1 || (receiveTask !== null && adapter.getState().inputMode !== "audio")) throw new Error("simulation requires a completed receive session or a live audio proposal");
        return simulation.start(args[0]);
      }
      if (channel === GUI_CHANNELS.confirmSimulation) {
        if (args.length !== 1) throw new Error("confirmation payload required");
        return simulation.confirm(args[0]);
      }
      if (channel === GUI_CHANNELS.chooseFile) {
        if (receiveTask !== null || simulation.task !== null) throw new Error("session operation is in progress");
        if (args.length !== 1 || !["pcm", "decoder", "reply-config", "ffmpeg"].includes(String(args[0]))) throw new Error("invalid file role");
        const role = args[0] as "pcm" | "decoder" | "reply-config" | "ffmpeg";
        const filters = role === "pcm" ? [{ name: "PCM audio", extensions: ["s16le", "pcm"] }]
          : role === "reply-config" ? [{ name: "Assistant config", extensions: ["json"] }]
          : process.platform === "win32" ? [{ name: "Executable", extensions: ["exe", "com"] }] : [];
        const result = await dialog.showOpenDialog(windowInstance!, { properties: ["openFile"], filters });
        if (!result.canceled && result.filePaths[0]) {
          selectedPaths.set(role, result.filePaths[0]);
          return adapter.setFile(role, path.basename(result.filePaths[0]));
        }
        return adapter.getState();
      }
      if (channel === GUI_CHANNELS.startReceive) {
        if (args.length !== 1 || args[0] === null || typeof args[0] !== "object") throw new Error("invalid receive setup");
        if (receiveTask !== null || simulation.task !== null) throw new Error("session operation is already running");
        const { argv, inputMode } = buildGuiReceiveArgs(args[0], selectedPaths);
        const sessionId = randomUUID();
        adapter.beginReceive(sessionId, inputMode);
        const task = runReceive(argv, {
          print: () => undefined,
          sessionId,
          signal: adapter.signal,
          onAudioControl: control => { audioControl = control; },
          onEvent: event => {
            adapter.applyReceiveEvent(sessionId, event);
            if (inputMode === "audio") simulation.startAutomaticIfReady();
          },
        });
        receiveTask = task;
        let receiveSucceeded = false;
        void task.then(code => {
          receiveSucceeded = code === 0;
          if (code !== 0) adapter.applyReceiveEvent(sessionId, {
            type: "error", code: "receive_failed", error: `Receive exited with code ${code}.`,
          });
        }, error => {
          adapter.applyReceiveEvent(sessionId, {
            type: "error", code: "internal", error: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => {
          if (receiveTask === task) receiveTask = null;
          if (receiveSucceeded) simulation.startAutomaticIfReady();
        });
        return adapter.getState();
      }
      if (channel === GUI_CHANNELS.setMode && args[0] === "automatic") {
        const state = adapter.getState();
        if (state.editing || simulation.task !== null || state.receiveState === "idle"
            || state.receiveState === "error" || state.receiveState === "stopped"
            || state.simulation.phase !== "idle") throw new Error("automatic simulation requires an unedited active receive session");
      }
      const state = handleGuiRequest(adapter, channel, args[0], args.length === 1);
      if (channel === GUI_CHANNELS.setMode) return simulation.startAutomaticIfReady();
      return state;
    });
  }
}

async function createWindow(): Promise<void> {
  windowInstance = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#10161b",
    webPreferences: {
      preload: path.join(directory, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  windowInstance.on("close", event => {
    if (closingWindow || (receiveTask === null && simulation.task === null)) return;
    event.preventDefault();
    const closing = windowInstance;
    if (closing === null) return;
    closingWindow = true;
    adapter.stop();
    const pending = Promise.allSettled([receiveTask, simulation.task]);
    void pending.then(() => undefined, () => undefined).finally(() => {
      if (windowInstance === closing && !closing.isDestroyed()) closing.close();
      closingWindow = false;
    });
  });
  windowInstance.once("ready-to-show", () => windowInstance?.show());
  windowInstance.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowInstance.webContents.on("will-navigate", event => event.preventDefault());
  await windowInstance.loadFile(path.join(directory, "../../gui/renderer/index.html"));
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch(error => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
