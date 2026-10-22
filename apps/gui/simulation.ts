// Desktop confirmation bridge into the existing runner; no transport or send loop.
import { randomUUID } from "node:crypto";
import { runCwTrial } from "../rig-cw-trial.js";
import { planCivCwMessage } from "../../packages/devices/src/index.js";
import type { GuiDisplayState, GuiSimulationRequest } from "./api.js";
import type { GuiStateAdapter } from "./ui-adapter.js";
import type { ReceiveAudioControl } from "../rig-receive.js";

export class GuiSimulation {
  #task: Promise<void> | null = null;
  #confirm: ((text: string) => void) | null = null;
  #attemptedKey: string | null = null;

  constructor(readonly adapter: GuiStateAdapter, readonly recordDir = "logs/cw-trial",
    readonly runner: typeof runCwTrial = runCwTrial,
    readonly audioControl?: () => ReceiveAudioControl | null) {}

  get task(): Promise<void> | null { return this.#task; }

  start(payload: unknown): GuiDisplayState {
    return this.#start(payload, false);
  }

  startAutomaticIfReady(): GuiDisplayState {
    const state = this.adapter.getState();
    const ready = state.inputMode === "audio" ? state.receiveState === "running" && this.audioControl?.() != null : state.receiveState === "completed";
    if (this.#task !== null || !ready || state.mode !== "automatic" || state.stopped || state.editing
        || state.proposal === null || state.simulation.phase !== "idle") return state;
    return this.#start({ sessionId: state.sessionId, turnId: state.proposal.turnId,
      revision: state.proposal.revision, text: state.proposal.text }, true);
  }

  #start(payload: unknown, automatic: boolean): GuiDisplayState {
    if (this.#task !== null) throw new Error("simulation already in progress");
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid simulation request");
    const input = payload as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "revision,sessionId,text,turnId"
        || typeof input.text !== "string" || input.text.length === 0 || input.text.length > 30
        || /[a-z^]/.test(input.text) || typeof input.sessionId !== "string"
        || typeof input.turnId !== "string" || !Number.isInteger(input.revision)) throw new Error("invalid simulation request");
    planCivCwMessage(input.text);
    const request: GuiSimulationRequest = Object.freeze({ text: input.text, sessionId: input.sessionId,
      turnId: input.turnId, revision: input.revision as number });
    const binding = this.adapter.simulationBinding(request, automatic);
    const live = this.adapter.getState().inputMode === "audio";
    const audio = live ? this.audioControl?.() : null;
    if (live && !audio) throw new Error("live simulation requires active audio control");
    const key = JSON.stringify([binding.sessionId, binding.turnId, binding.revision]);
    if (this.#attemptedKey === key) throw new Error("this proposal already had a simulation attempt");
    this.#attemptedKey = key;
    const lines: string[] = [];
    const requestId = randomUUID();
    let paused = false;
    this.adapter.setSimulation({ phase: "checking", requestId: null, text: binding.text, exitCode: null, lines });
    const task = Promise.resolve().then(async () => {
      if (audio) { await audio.pause(); paused = true; }
      if (!binding.isCurrent()) throw new Error("reply changed or stopped before simulation");
      return this.runner(["--simulate", "--record-dir", this.recordDir], {
      signal: this.adapter.signal,
      replyProposal: binding,
      io: { isTTY: false, write: line => { lines.push(line); if (lines.length > 32) lines.shift(); },
        prompt: async () => { throw new Error("TTY prompt is not available in desktop simulation"); } },
      ...(automatic ? { replyDispatch: this.adapter.dispatchControl } : { confirmSimulatedReply: (text: string) => {
        if (!binding.isCurrent()) return Promise.resolve(null);
        this.adapter.setSimulation({ phase: "confirming", requestId, text, exitCode: null, lines });
        return new Promise<string>(resolve => { this.#confirm = resolve; });
      } }),
      });
    }).then(code => {
      this.adapter.setSimulation({ phase: code === 0 ? "completed" : "failed", requestId: null,
        text: binding.text, exitCode: code, lines });
    }, error => {
      lines.push(error instanceof Error ? error.message : String(error));
      this.adapter.setSimulation({ phase: "failed", requestId: null, text: binding.text, exitCode: 1, lines });
    }).finally(() => {
      this.#confirm?.(""); this.#confirm = null;
      if (paused && !this.adapter.signal.aborted) audio?.resume();
      if (this.#task === task) this.#task = null;
    });
    this.#task = task;
    return this.adapter.getState();
  }

  confirm(payload: unknown): GuiDisplayState {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid simulation confirmation");
    const input = payload as Record<string, unknown>;
    const view = this.adapter.getState().simulation;
    if (Object.keys(input).sort().join(",") !== "requestId,text"
        || typeof input.requestId !== "string" || typeof input.text !== "string"
        || this.adapter.signal.aborted || view.phase !== "confirming"
        || view.requestId !== input.requestId || input.text !== view.text || this.#confirm === null) {
      throw new Error("confirmation must match the current request and exact simulated text");
    }
    const resolve = this.#confirm;
    this.#confirm = null;
    this.adapter.setSimulation({ ...view, phase: "running", requestId: null });
    resolve(input.text);
    return this.adapter.getState();
  }
}
