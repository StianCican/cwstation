// V00-04-A desktop slice: a pure UI adapter.
//
// The adapter owns no authorization of its own. Every mode/lease/stop read or
// write goes through one injected ReplyDispatchControl, which remains the only
// authorization state. It does not open a device, start a receive session,
// create a transport, send CW, or persist anything.

import { ReplyDispatchControl } from "../reply-dispatch-control.js";
import type {
  GuiAuthorization,
  GuiDisplayState,
  GuiMode,
  GuiProposalSource,
} from "./api.js";
import type { GuiSelectedFiles } from "./api.js";
import type { GuiSimulationRequest, GuiSimulationView } from "./api.js";
import type { CwTrialReplyBinding } from "../rig-cw-trial.js";

export interface GuiProposalSeed {
  readonly source: GuiProposalSource;
  readonly text: string;
  readonly turnId: string;
  readonly revision: number;
}

export interface GuiSessionSeed {
  readonly sessionId: string;
  readonly receivedText: string;
  readonly proposal: GuiProposalSeed | null;
}

/**
 * Injected demonstration data for this slice. It is deliberately static: no
 * audio, decoder, model, device, or network input exists behind it.
 */
export const DEMO_GUI_SESSION: GuiSessionSeed = Object.freeze({
  sessionId: "demo-session-1",
  receivedText: "CQ CQ CQ DE B1AA B1AA K",
  proposal: Object.freeze({
    source: "local-cq" as const,
    text: "B1AA DE B2BB K",
    turnId: "demo-session-1:turn-1",
    revision: 1,
  }),
});
const EMPTY_GUI_SESSION: GuiSessionSeed = Object.freeze({ sessionId: "not-started", receivedText: "", proposal: null });

const MANUAL_NOTICE = "Manual mode: every reply needs explicit confirmation.";
const EMPTY_FILES: GuiSelectedFiles = Object.freeze({ pcm: null, decoder: null, replyConfig: null, ffmpeg: null });

export class GuiStateAdapter {
  readonly #control: ReplyDispatchControl;
  #sessionId: string;
  #receivedText: string;
  #proposal: GuiProposalSeed | null;
  #editing = false;
  #notice: string = MANUAL_NOTICE;
  #receiveState: GuiDisplayState["receiveState"] = "idle";
  #inputMode: "pcm" | "audio" = "pcm";
  #audioPaused = false;
  #files: GuiSelectedFiles = EMPTY_FILES;
  #simulation: GuiSimulationView = Object.freeze({ phase: "idle", requestId: null, text: "", exitCode: null, lines: [] });

  constructor(
    control: ReplyDispatchControl = new ReplyDispatchControl(),
    seed: GuiSessionSeed = EMPTY_GUI_SESSION,
  ) {
    this.#control = control;
    this.#sessionId = seed.sessionId;
    this.#receivedText = seed.receivedText;
    this.#proposal = seed.proposal === null
      ? null
      : Object.freeze({
          source: seed.proposal.source,
          text: seed.proposal.text,
          turnId: seed.proposal.turnId,
          revision: seed.proposal.revision,
        });
  }

  get signal(): AbortSignal { return this.#control.signal; }
  get dispatchControl(): ReplyDispatchControl { return this.#control; }

  getState(): GuiDisplayState {
    const mode = this.#control.mode;
    const stopped = this.#control.signal.aborted;
    const authorization: GuiAuthorization = mode === "manual"
      ? "manual"
      : this.#control.hasLease ? "armed" : "not-armed";
    return Object.freeze({
      sessionId: this.#sessionId,
      receivedText: this.#receivedText,
      proposal: this.#proposal === null
        ? null
        : Object.freeze({ ...this.#proposal }),
      mode,
      editing: this.#editing,
      stopped,
      authorization,
      notice: this.#notice,
      generation: this.#control.generation,
      receiveState: this.#receiveState,
      inputMode: this.#inputMode,
      audioPaused: this.#audioPaused,
      files: this.#files,
      simulation: this.#simulation,
    });
  }

  setSimulation(view: GuiSimulationView): void {
    this.#simulation = Object.freeze({ ...view, lines: Object.freeze([...view.lines]) });
  }

  simulationBinding(request: GuiSimulationRequest, automatic = false): CwTrialReplyBinding {
    const proposal = this.#proposal;
    const mode = automatic ? "automatic" : "manual";
    const ready = this.#inputMode === "audio" ? this.#receiveState === "running" : this.#receiveState === "completed";
    if (!ready || this.signal.aborted || this.#control.mode !== mode
        || proposal === null || request.sessionId !== this.#sessionId
        || request.turnId !== proposal.turnId || request.revision !== proposal.revision
        || (automatic && (this.#editing || request.text !== proposal.text))) {
      throw new Error("simulation requires the current completed receive proposal in the selected mode");
    }
    const generation = this.#control.generation;
    return Object.freeze({ text: request.text, sessionId: this.#sessionId,
      turnId: proposal.turnId, revision: proposal.revision,
      isCurrent: () => !this.signal.aborted && this.#proposal === proposal
        && this.#sessionId === request.sessionId && (this.#inputMode === "audio" ? this.#receiveState === "running" : this.#receiveState === "completed")
        && this.#control.mode === mode && this.#control.generation === generation,
    });
  }

  setFile(role: "pcm" | "decoder" | "reply-config" | "ffmpeg", name: string): GuiDisplayState {
    this.#files = Object.freeze({ ...this.#files,
      ...(role === "pcm" ? { pcm: name } : {}),
      ...(role === "decoder" ? { decoder: name } : {}),
      ...(role === "reply-config" ? { replyConfig: name } : {}),
      ...(role === "ffmpeg" ? { ffmpeg: name } : {}),
    });
    return this.getState();
  }

  beginReceive(sessionId: string, inputMode: "pcm" | "audio" = "pcm"): GuiDisplayState {
    if (this.#control.signal.aborted) throw new Error("session is stopped; restart the app to receive again");
    this.#control.revoke();
    this.#control.requireManual();
    this.#receiveState = "running";
    this.#inputMode = inputMode;
    this.#audioPaused = false;
    this.#editing = false;
    this.#notice = inputMode === "audio" ? "Listening to live audio; no transmission is enabled."
      : "Receiving PCM; decoder and reply model are running in the existing receive session.";
    this.#sessionId = sessionId;
    this.#receivedText = "";
    this.#proposal = null;
    this.#simulation = Object.freeze({ phase: "idle", requestId: null, text: "", exitCode: null, lines: [] });
    return this.getState();
  }

  applyReceiveEvent(sessionId: string, event: unknown): GuiDisplayState {
    if (sessionId !== this.#sessionId || this.#receiveState !== "running") return this.getState();
    if (event === null || typeof event !== "object") return this.getState();
    const item = event as Record<string, unknown>;
    if (item.type === "chunk" && typeof item.text === "string") {
      if (this.#control.hasLease) this.#control.revoke();
      this.#proposal = null;
      this.#notice = "New receive text invalidated the previous reply proposal.";
      this.#receivedText += item.text;
    }
    if (item.type === "reply") {
      if (item.validated === true && item.action === "reply"
          && typeof item.text === "string" && item.text.length > 0 && typeof item.turnId === "string") {
        if (this.#control.hasLease) this.#control.revoke();
        this.#proposal = Object.freeze({
          source: item.replySource === "local_cq_template" ? "local-cq" : "ai",
          text: item.text,
          turnId: item.turnId,
          revision: typeof item.revision === "number" ? item.revision : 1,
        });
        if (["completed", "failed"].includes(this.#simulation.phase)) {
          this.#simulation = Object.freeze({ phase: "idle", requestId: null, text: "", exitCode: null, lines: [] });
        }
        this.#notice = "Validated reply proposal; no transmission was performed.";
        if (this.#control.mode === "automatic" && !this.#editing) this.#armCurrentProposal();
      } else {
        if (this.#control.hasLease) this.#control.revoke();
        this.#proposal = null;
        this.#notice = item.action === "no_reply" ? "No reply was proposed for the latest receive context."
          : "The latest receive event did not produce a dispatchable reply.";
      }
    }
    if (item.type === "invalidated") {
      if (this.#control.hasLease) this.#control.revoke();
      this.#proposal = null;
      this.#notice = "The previous reply proposal was invalidated by new receive context.";
    }
    if (item.type === "status" && typeof item.state === "string") {
      if (item.state === "paused") this.#audioPaused = true;
      if (["resumed", "completed", "stopped"].includes(item.state)) this.#audioPaused = false;
      if (item.state === "completed" || item.state === "stopped") this.#receiveState = item.state;
      if (item.state === "started") this.#receiveState = "running";
    }
    if (item.type === "error") {
      this.#audioPaused = false;
      if (this.#control.hasLease) this.#control.revoke();
      this.#receiveState = item.code === "aborted" ? "stopped" : "error";
      this.#notice = typeof item.error === "string" ? item.error : "Receive failed.";
    }
    return this.getState();
  }

  setMode(mode: GuiMode): GuiDisplayState {
    if (mode !== "manual" && mode !== "automatic") {
      throw new Error(`invalid gui mode: ${String(mode)}`);
    }
    if (this.#control.signal.aborted) return this.getState();
    if (mode === "automatic") {
      this.#control.enableAutomatic();
      this.#editing = false;
      this.#armCurrentProposal();
    } else {
      this.#control.requireManual();
      this.#editing = false;
      this.#notice = MANUAL_NOTICE;
    }
    return this.getState();
  }

  /** Editing is always manual; any automatic lease is revoked first. */
  beginEdit(): GuiDisplayState {
    if (this.#control.signal.aborted) return this.getState();
    this.#control.beginEdit();
    this.#editing = true;
    this.#notice = "Editing paused automatic dispatch; this session is manual. "
      + "The edited text is not sent by this demo slice.";
    return this.getState();
  }

  revoke(): GuiDisplayState {
    if (this.#control.signal.aborted) return this.getState();
    this.#control.revoke();
    this.#notice = "Automatic dispatch eligibility revoked for the current proposal.";
    return this.getState();
  }

  /** Stop is terminal for this session; later controls do not change state. */
  stop(): GuiDisplayState {
    if (this.#control.signal.aborted) return this.getState();
    this.#control.stop();
    this.#editing = false;
    this.#notice = "Stopped. This session is terminal; restart the app for a new session.";
    return this.getState();
  }

  #armCurrentProposal(): void {
    const proposal = this.#proposal;
    if (proposal === null) {
      this.#notice = "Automatic mode is on, but no reply proposal is available.";
      return;
    }
    const authorization = this.#control.authorize({
      text: proposal.text,
      sessionId: this.#sessionId,
      turnId: proposal.turnId,
      revision: proposal.revision,
    }, () => !this.#control.signal.aborted && !this.#editing);
    this.#notice = authorization.authorized
      ? `Automatic dispatch armed for the current ${proposal.source} proposal.`
      : `Automatic mode is on, but this proposal cannot be dispatched (${authorization.reason}).`;
  }
}
