// V00-04-A desktop slice: dispatches display/session controls. Host-only file
// selection and receive startup are handled in main.ts. Unknown requests fail closed.

import { GUI_CHANNELS, type GuiDisplayState } from "./api.js";
import type { GuiStateAdapter } from "./ui-adapter.js";

function rejectPayload(hasPayload: boolean): void {
  if (hasPayload) throw new Error("unexpected gui payload");
}

export function handleGuiRequest(
  adapter: GuiStateAdapter,
  channel: string,
  payload?: unknown,
  hasPayload = payload !== undefined,
): GuiDisplayState {
  switch (channel) {
    case GUI_CHANNELS.getState:
      rejectPayload(hasPayload);
      return adapter.getState();
    case GUI_CHANNELS.setMode:
      if (payload !== "manual" && payload !== "automatic") {
        throw new Error("invalid gui mode");
      }
      return adapter.setMode(payload);
    case GUI_CHANNELS.beginEdit:
      rejectPayload(hasPayload);
      return adapter.beginEdit();
    case GUI_CHANNELS.revoke:
      rejectPayload(hasPayload);
      return adapter.revoke();
    case GUI_CHANNELS.stop:
      rejectPayload(hasPayload);
      return adapter.stop();
    default:
      throw new Error("unsupported gui channel");
  }
}
