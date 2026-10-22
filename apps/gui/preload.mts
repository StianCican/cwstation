// V00-04-A desktop slice: Electron preload. This file runs unsandboxed as ESM
// (required for .mjs preloads) but exposes only the frozen five-method API;
// contextIsolation remains enabled and nodeIntegration is disabled.

import { contextBridge, ipcRenderer } from "electron";
import { exposePreloadApi } from "./preload-api.js";

exposePreloadApi(contextBridge, {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
