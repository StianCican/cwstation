// V00-04-A desktop slice: the complete typed boundary between Electron's
// main/preload processes and the React renderer. The renderer receives only
// display state and the five session controls below; no device or transport
// capability crosses this boundary.

export const GUI_CHANNELS = Object.freeze({
  getState: "cwstation:gui:get-state",
  setMode: "cwstation:gui:set-mode",
  beginEdit: "cwstation:gui:begin-edit",
  revoke: "cwstation:gui:revoke",
  stop: "cwstation:gui:stop",
  chooseFile: "cwstation:gui:choose-file",
  startReceive: "cwstation:gui:start-receive",
  startSimulation: "cwstation:gui:start-simulation",
  confirmSimulation: "cwstation:gui:confirm-simulation",
} as const);

export type GuiFileRole = "pcm" | "decoder" | "reply-config" | "ffmpeg";
export interface GuiReceiveSetup {
  readonly ownCall: string;
  readonly peerCall: string;
  readonly inputMode?: "pcm" | "audio";
  readonly audioBackend?: "pulse" | "dshow";
  readonly audioDevice?: string;
}
export interface GuiSelectedFiles {
  readonly pcm: string | null;
  readonly decoder: string | null;
  readonly replyConfig: string | null;
  readonly ffmpeg: string | null;
}

export type GuiMode = "manual" | "automatic";

export type GuiProposalSource = "local-cq" | "ai";

/** Derived from ReplyDispatchControl; never a second authorization truth. */
export type GuiAuthorization = "manual" | "armed" | "not-armed";

export interface GuiProposalView {
  readonly source: GuiProposalSource;
  readonly text: string;
  readonly turnId: string;
  readonly revision: number;
}

export interface GuiSimulationRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly text: string;
}
export interface GuiSimulationConfirmation {
  readonly requestId: string;
  readonly text: string;
}
export interface GuiSimulationView {
  readonly phase: "idle" | "checking" | "confirming" | "running" | "completed" | "failed";
  readonly requestId: string | null;
  readonly text: string;
  readonly exitCode: number | null;
  readonly lines: readonly string[];
}

export interface GuiDisplayState {
  readonly sessionId: string;
  readonly receivedText: string;
  readonly proposal: GuiProposalView | null;
  readonly mode: GuiMode;
  readonly editing: boolean;
  readonly stopped: boolean;
  readonly authorization: GuiAuthorization;
  /** Display-only explanation of the last control action. */
  readonly notice: string;
  readonly generation: number;
  readonly receiveState: "idle" | "running" | "completed" | "stopped" | "error";
  readonly inputMode: "pcm" | "audio";
  readonly audioPaused: boolean;
  readonly files: GuiSelectedFiles;
  readonly simulation: GuiSimulationView;
}

export interface CwStationGuiApi {
  readonly getState: () => Promise<GuiDisplayState>;
  readonly setMode: (mode: GuiMode) => Promise<GuiDisplayState>;
  readonly beginEdit: () => Promise<GuiDisplayState>;
  readonly revoke: () => Promise<GuiDisplayState>;
  readonly stop: () => Promise<GuiDisplayState>;
  readonly chooseFile: (role: GuiFileRole) => Promise<GuiDisplayState>;
  readonly startReceive: (setup: GuiReceiveSetup) => Promise<GuiDisplayState>;
  readonly startSimulation: (request: GuiSimulationRequest) => Promise<GuiDisplayState>;
  readonly confirmSimulation: (confirmation: GuiSimulationConfirmation) => Promise<GuiDisplayState>;
}
