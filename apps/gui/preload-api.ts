// V00-04-A desktop slice: the pure preload factory, separated from Electron so
// its exposed surface can be tested with a fake IPC renderer. The returned
// object is frozen and contains no Node, Electron, or transport handle.

import {
  GUI_CHANNELS,
  type CwStationGuiApi,
  type GuiDisplayState,
  type GuiMode,
  type GuiFileRole,
  type GuiReceiveSetup,
  type GuiSimulationRequest,
  type GuiSimulationConfirmation,
} from "./api.js";

export const PRELOAD_WORLD_KEY = "cwstation";

export interface PreloadIpc {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export interface PreloadContextBridge {
  exposeInMainWorld(key: string, api: unknown): void;
}

export function createPreloadApi(ipc: PreloadIpc): CwStationGuiApi {
  const request = async (channel: string, ...args: readonly unknown[]): Promise<GuiDisplayState> => {
    return await ipc.invoke(channel, ...args) as GuiDisplayState;
  };
  return Object.freeze({
    getState: (): Promise<GuiDisplayState> => request(GUI_CHANNELS.getState),
    setMode: (mode: GuiMode): Promise<GuiDisplayState> => request(GUI_CHANNELS.setMode, mode),
    beginEdit: (): Promise<GuiDisplayState> => request(GUI_CHANNELS.beginEdit),
    revoke: (): Promise<GuiDisplayState> => request(GUI_CHANNELS.revoke),
    stop: (): Promise<GuiDisplayState> => request(GUI_CHANNELS.stop),
    chooseFile: (role: GuiFileRole): Promise<GuiDisplayState> => request(GUI_CHANNELS.chooseFile, role),
    startReceive: (setup: GuiReceiveSetup): Promise<GuiDisplayState> => request(GUI_CHANNELS.startReceive, setup),
    startSimulation: (payload: GuiSimulationRequest): Promise<GuiDisplayState> => request(GUI_CHANNELS.startSimulation, payload),
    confirmSimulation: (payload: GuiSimulationConfirmation): Promise<GuiDisplayState> => request(GUI_CHANNELS.confirmSimulation, payload),
  });
}

export function exposePreloadApi(
  bridge: PreloadContextBridge,
  ipc: PreloadIpc,
): CwStationGuiApi {
  const api = createPreloadApi(ipc);
  bridge.exposeInMainWorld(PRELOAD_WORLD_KEY, api);
  return api;
}
