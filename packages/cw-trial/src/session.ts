// P2-015 受控 CW 试验会话（注入式，不打开串口、不发射真实电台）。
//
// 边界：
//  - 一个实例独占注入 transport、一个 CivFrameParser、一个在途查询槽；不打开
//    串口、不提供任意字节构造器、不自动重试或重连。
//  - 预检固定八查询：显示 03/04 加六项上下文 1C03/1C00/0F/2101/2102/1647。
//  - 发送只接受固定报文 "E" / "TEST"；停止只接受 Command 17 的 FF。
//  - OK(0xFB) 只表示 ack_observed，绝不推断完成或停止；超时/写失败保持
//    unknown。一次会话最多发送一次，但仍可停止和关闭。
//  - 本模块不从 index 导出，不接 serial/IPC/service/rig.sh；真实串口由 app
//    通过 openCwTrialSerialTransport 注入。

import { createHash, randomUUID } from "node:crypto";
import {
  CIV_COMMAND_NG,
  CIV_COMMAND_OK,
  CIV_COMMAND_READ_FREQUENCY,
  CIV_COMMAND_READ_MODE,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_EOM,
  CIV_PREAMBLE,
  CivBusyError,
  CivConfigError,
  CivFrameParser,
  CivProtocolError,
  CivSessionError,
  CivTimeoutError,
  CivTransportError,
  decodeFrequencyBcd,
  decodeModeReading,
  type CivFilter,
  type CivFrame,
  type CivMode,
  type CivTransport,
} from "../../devices/src/civ.js";
import {
  decodeContextReadResponse,
  planContextRead,
  type BreakInMode,
  type ContextReadKind,
  type ContextReadReading,
} from "../../devices/src/civ-context-read.js";
import { planCivCwMessage, planCivCwStop } from "../../devices/src/civ-tx-plan.js";

export const CW_TRIAL_QUERY_TIMEOUT_MS = 2_000;
export const CW_TRIAL_CLOSE_TIMEOUT_MS = 2_000;

/** 唯一允许的两次真实短报文；"^" 连续键控不在其中。 */
export const CW_TRIAL_MESSAGES = Object.freeze(["E", "TEST"] as const);
export type CwTrialMessage = (typeof CW_TRIAL_MESSAGES)[number];

const CONTEXT_ORDER: readonly ContextReadKind[] = Object.freeze<ContextReadKind[]>([
  "txFrequency",
  "txStatus",
  "splitEnabled",
  "ritEnabled",
  "xitEnabled",
  "breakIn",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function assertTransport(transport: unknown): CivTransport {
  if (typeof transport !== "object" || transport === null) {
    throw new CivConfigError("transport must be an object implementing write/onData/onClose/close");
  }
  const candidate = transport as {
    readonly write?: unknown;
    readonly onData?: unknown;
    readonly onClose?: unknown;
    readonly close?: unknown;
  };
  if (
    typeof candidate.write !== "function" ||
    typeof candidate.onData !== "function" ||
    typeof candidate.onClose !== "function" ||
    typeof candidate.close !== "function"
  ) {
    throw new CivConfigError("transport must be an object implementing write/onData/onClose/close");
  }
  return transport as CivTransport;
}

function statusRequest(command: number): Uint8Array {
  return Uint8Array.from([
    CIV_PREAMBLE,
    CIV_PREAMBLE,
    CIV_DEFAULT_RADIO_ADDRESS,
    CIV_DEFAULT_CONTROLLER_ADDRESS,
    command,
    CIV_EOM,
  ]);
}

// ── 八查询上下文与预检 ────────────────────────────────────────────────────

/** 一次预检读取的完整设备上下文；所有值都是非原子快照。 */
export interface CwTrialContext {
  readonly displayFrequencyHz: number;
  readonly displayMode: CivMode;
  readonly displayFilter: CivFilter;
  readonly txFrequencyHz: number;
  readonly txStatus: "RX" | "TX";
  readonly splitEnabled: boolean;
  readonly ritEnabled: boolean;
  readonly xitEnabled: boolean;
  readonly breakIn: BreakInMode;
}

export interface CwTrialCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CwTrialPreflight {
  readonly context: CwTrialContext;
  readonly checks: readonly CwTrialCheck[];
  readonly ok: boolean;
}

/**
 * 判断上下文是否满足一次受控试验的前置条件。失败原因全部列出，调用方不得
 * 以“默认 RX/OFF”填补缺失值；这里只接受完整读取到的八个字段。
 */
export function evaluateCwTrialPreflight(context: CwTrialContext): CwTrialPreflight {
  const checks: CwTrialCheck[] = [
    {
      id: "mode",
      ok: context.displayMode === "CW" || context.displayMode === "CW-R",
      detail: `display mode must be CW or CW-R, got ${context.displayMode}`,
    },
    {
      id: "rx",
      ok: context.txStatus === "RX",
      detail: `radio must report RX before a trial, got ${context.txStatus}`,
    },
    {
      id: "tx-frequency",
      ok: context.txFrequencyHz === context.displayFrequencyHz,
      detail:
        `TX frequency ${context.txFrequencyHz} Hz must equal display frequency ` +
        `${context.displayFrequencyHz} Hz`,
    },
    {
      id: "split",
      ok: context.splitEnabled === false,
      detail: `Split must be OFF, got ${context.splitEnabled ? "ON" : "OFF"}`,
    },
    {
      id: "rit",
      ok: context.ritEnabled === false,
      detail: `RIT must be OFF, got ${context.ritEnabled ? "ON" : "OFF"}`,
    },
    {
      id: "xit",
      ok: context.xitEnabled === false,
      detail: `XIT must be OFF, got ${context.xitEnabled ? "ON" : "OFF"}`,
    },
    {
      id: "break-in",
      ok: context.breakIn !== "OFF",
      detail: `Break-in must be SEMI or FULL, got ${context.breakIn}`,
    },
  ];
  return { context, checks, ok: checks.every((check) => check.ok) };
}

export function cwTrialContextEquals(left: CwTrialContext, right: CwTrialContext): boolean {
  return (
    left.displayFrequencyHz === right.displayFrequencyHz &&
    left.displayMode === right.displayMode &&
    left.displayFilter === right.displayFilter &&
    left.txFrequencyHz === right.txFrequencyHz &&
    left.txStatus === right.txStatus &&
    left.splitEnabled === right.splitEnabled &&
    left.ritEnabled === right.ritEnabled &&
    left.xitEnabled === right.xitEnabled &&
    left.breakIn === right.breakIn
  );
}

export interface CwTrialApprovalInput {
  readonly message: string;
  readonly context: CwTrialContext;
  readonly sessionInstanceId: string;
}

/**
 * 把进程实例、连接会话、报文与完整上下文绑成一个 SHA256 指纹。确认只对该
 * 指纹有效；确认后重读若任一字段变化，指纹随之变化并撤销确认。
 */
export function computeCwTrialContextFingerprint(input: CwTrialApprovalInput): string {
  const context = input.context;
  const canonical = JSON.stringify([
    "cw-trial-v1",
    input.sessionInstanceId,
    input.message,
    context.displayFrequencyHz,
    context.displayMode,
    context.displayFilter,
    context.txFrequencyHz,
    context.txStatus,
    context.splitEnabled,
    context.ritEnabled,
    context.xitEnabled,
    context.breakIn,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── 发送/停止结果 ─────────────────────────────────────────────────────────

/**
 * 发送结果语义。ack_observed 只说明收到 FB，不表示报文已发出或已完成；
 * write_failed 与 timeout 都保持 unknown，禁止据此自动重发。
 */
export type CwTrialSendOutcome =
  | "ack_observed"
  | "rejected_ng"
  | "write_failed"
  | "timeout";

export interface CwTrialSendResult {
  readonly message: string;
  readonly outcome: CwTrialSendOutcome;
  readonly ackObserved: boolean;
  readonly detail: string;
}

export type CwTrialStopOutcome =
  | "ack_observed"
  | "rejected_ng"
  | "write_failed"
  | "timeout"
  | "unavailable";

export interface CwTrialStopResult {
  readonly outcome: CwTrialStopOutcome;
  readonly ackObserved: boolean;
  readonly detail: string;
}

export type CwTrialPhase = "idle" | "reading" | "sent" | "closing" | "locked" | "closed";

export interface CwTrialSessionView {
  readonly sessionInstanceId: string;
  readonly phase: CwTrialPhase;
  readonly error: string | null;
  readonly messageAttempted: boolean;
  readonly stopAttempted: boolean;
  readonly closeConfirmed: boolean;
  readonly context: CwTrialContext | null;
}

export interface CwTrialSessionOptions {
  readonly transport: CivTransport;
  /** 单次查询超时，默认 2000ms；范围 1..60000。 */
  readonly queryTimeoutMs?: number;
  /** transport.close 有界等待，默认 2000ms；范围 1..60000。 */
  readonly closeTimeoutMs?: number;
}

interface PendingQuery {
  readonly id: number;
  readonly mode: "read" | "ack";
  readonly command: number;
  readonly label: string;
  readonly decode: (frame: CivFrame) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type AckOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "ng" }
  | { readonly kind: "ack_timeout" }
  | { readonly kind: "write_failed"; readonly detail: string };

function durationOption(value: unknown, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < 1 || resolved > 60_000) {
    throw new CivConfigError(`${label} must be an integer in [1, 60000], got ${String(resolved)}`);
  }
  return resolved;
}

function requireReading<K extends ContextReadKind>(
  readings: ReadonlyMap<ContextReadKind, ContextReadReading>,
  kind: K,
): Extract<ContextReadReading, { kind: K }> {
  const reading = readings.get(kind);
  if (reading === undefined || reading.kind !== kind) {
    throw new CivProtocolError(`CW trial context read ${kind} returned no reading`);
  }
  return reading as Extract<ContextReadReading, { kind: K }>;
}

/**
 * 注入式受控 CW 试验会话。一个实例只有一个 transport、parser 和在途槽；
 * 故障后一律 locked，不恢复为可读、不自动重发。
 */
export class CwTrialSession {
  readonly sessionInstanceId = randomUUID();

  private readonly transport: CivTransport;
  private readonly queryTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly parser = new CivFrameParser();
  private readonly dataUnsubscribe: (() => void) | null;
  private readonly closeUnsubscribe: (() => void) | null;

  private phase: CwTrialPhase = "idle";
  private error: string | null = null;
  private closeConfirmed = false;
  private contextRead = false;
  private messageAttempted = false;
  private stopAttempted = false;
  private context: CwTrialContext | null = null;
  private pending: PendingQuery | null = null;
  private queryCounter = 0;
  private closePromise: Promise<void> | null = null;
  private detached = false;

  constructor(options: CwTrialSessionOptions) {
    const source: unknown = options;
    if (typeof source !== "object" || source === null) {
      throw new CivConfigError("CwTrialSession options must be an object");
    }
    const raw = source as {
      readonly transport?: unknown;
      readonly queryTimeoutMs?: unknown;
      readonly closeTimeoutMs?: unknown;
    };
    this.transport = assertTransport(raw.transport);
    this.queryTimeoutMs = durationOption(raw.queryTimeoutMs, CW_TRIAL_QUERY_TIMEOUT_MS, "queryTimeoutMs");
    this.closeTimeoutMs = durationOption(raw.closeTimeoutMs, CW_TRIAL_CLOSE_TIMEOUT_MS, "closeTimeoutMs");
    this.dataUnsubscribe = this.transport.onData((chunk) => this.handleData(chunk));
    this.closeUnsubscribe = this.transport.onClose((error) => this.handleClose(error));
  }

  get state(): CwTrialPhase {
    return this.phase;
  }

  /**
   * 串行读取显示 03/04 与六项上下文，共八条固定查询。任何超时/畸形/断线都
   * 锁死会话；同一实例在发送后不再允许读取。
   */
  async readContext(): Promise<CwTrialContext> {
    if (this.phase === "sent") throw new CivSessionError("CW trial session already sent its one message");
    const unavailable = this.readableError();
    if (unavailable !== null) throw unavailable;
    if (this.pending !== null) throw new CivBusyError("CW trial session already has a query in flight");
    this.phase = "reading";
    try {
      const frequencyHz = await this.performRead(
        "display frequency",
        statusRequest(CIV_COMMAND_READ_FREQUENCY),
        CIV_COMMAND_READ_FREQUENCY,
        (frame) => decodeFrequencyBcd(frame.data),
      );
      const mode = await this.performRead(
        "display mode",
        statusRequest(CIV_COMMAND_READ_MODE),
        CIV_COMMAND_READ_MODE,
        (frame) => decodeModeReading(frame.data),
      );
      const readings = new Map<ContextReadKind, ContextReadReading>();
      for (const kind of CONTEXT_ORDER) {
        const plan = planContextRead(kind);
        const command = plan.bytes[4];
        if (command === undefined) throw new CivConfigError(`context read ${kind} is missing its command byte`);
        const reading = await this.performRead(
          `context ${kind}`,
          Uint8Array.from(plan.bytes),
          command,
          (frame) => decodeContextReadResponse(kind, frame),
        );
        readings.set(kind, reading);
      }
      const txFrequency = requireReading(readings, "txFrequency");
      const txStatus = requireReading(readings, "txStatus");
      const split = requireReading(readings, "splitEnabled");
      const rit = requireReading(readings, "ritEnabled");
      const xit = requireReading(readings, "xitEnabled");
      const breakIn = requireReading(readings, "breakIn");
      const context: CwTrialContext = {
        displayFrequencyHz: frequencyHz,
        displayMode: mode.mode,
        displayFilter: mode.filter,
        txFrequencyHz: txFrequency.frequencyHz,
        txStatus: txStatus.status,
        splitEnabled: split.enabled,
        ritEnabled: rit.enabled,
        xitEnabled: xit.enabled,
        breakIn: breakIn.mode,
      };
      this.context = context;
      this.contextRead = true;
      return context;
    } catch (error) {
      if (!this.isTerminal()) {
        this.failSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      }
      throw error;
    } finally {
      if (this.phase === "reading") this.phase = "idle";
    }
  }

  /**
   * 写出一次固定短报文并等待 FB/FA。只允许在成功读取上下文后调用一次；
   * 返回的 outcome 永不声称报文已完成。
   */
  async sendMessage(message: string): Promise<CwTrialSendResult> {
    if (this.messageAttempted || this.phase === "sent") {
      throw new CivSessionError("CW trial session already attempted its one message; only stop and exit remain");
    }
    const unavailable = this.readableError();
    if (unavailable !== null) {
      return { message, outcome: "write_failed", ackObserved: false, detail: unavailable.message };
    }
    if (!this.contextRead) {
      throw new CivSessionError("CW trial message requires a completed eight-query context read");
    }
    const plan = planCivCwMessage(message);
    this.messageAttempted = true;
    this.phase = "sent";
    const ack = await this.performAck("command 17 message", Uint8Array.from(plan.bytes));
    if (ack.kind === "ok") {
      return {
        message,
        outcome: "ack_observed",
        ackObserved: true,
        detail: "radio replied OK (0xfb); this is an acknowledgement only, not proof of completion",
      };
    }
    if (ack.kind === "ng") {
      return { message, outcome: "rejected_ng", ackObserved: false, detail: "radio replied NG (0xfa)" };
    }
    if (ack.kind === "write_failed") {
      return { message, outcome: "write_failed", ackObserved: false, detail: ack.detail };
    }
    return {
      message,
      outcome: "timeout",
      ackObserved: false,
      detail: `no acknowledgement within ${this.queryTimeoutMs} ms; completion is unknown`,
    };
  }

  /**
   * 写出固定的 Command 17 FF 停止帧。停止不需要发送批准，但只作用于本会话；
   * 写失败或超时一律保持 unknown，绝不声称已停止。
   */
  async sendStop(): Promise<CwTrialStopResult> {
    if (this.phase === "closed") {
      return { outcome: "unavailable", ackObserved: false, detail: "CW trial session is already closed" };
    }
    if (this.pending !== null) {
      return { outcome: "unavailable", ackObserved: false, detail: "CW trial session has a query in flight" };
    }
    this.stopAttempted = true;
    const plan = planCivCwStop();
    const ack = await this.performAck("command 17 stop", Uint8Array.from(plan.bytes));
    if (ack.kind === "ok") {
      return {
        outcome: "ack_observed",
        ackObserved: true,
        detail: "radio replied OK (0xfb) to the stop frame; this is not proof that keying stopped",
      };
    }
    if (ack.kind === "ng") {
      return { outcome: "rejected_ng", ackObserved: false, detail: "radio replied NG (0xfa) to the stop frame" };
    }
    if (ack.kind === "write_failed") {
      return { outcome: "write_failed", ackObserved: false, detail: ack.detail };
    }
    return {
      outcome: "timeout",
      ackObserved: false,
      detail: `no stop acknowledgement within ${this.queryTimeoutMs} ms; stop is unknown`,
    };
  }

  view(): CwTrialSessionView {
    return {
      sessionInstanceId: this.sessionInstanceId,
      phase: this.phase,
      error: this.error,
      messageAttempted: this.messageAttempted,
      stopAttempted: this.stopAttempted,
      closeConfirmed: this.closeConfirmed,
      context: this.context === null ? null : { ...this.context },
    };
  }

  /** 幂等关闭；只有 transport.close 确认后才 phase=closed。 */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    if (this.phase === "closed") return Promise.resolve();
    return this.beginClose(false);
  }

  // ── 查询实现 ─────────────────────────────────────────────────────────

  private readableError(): Error | null {
    if (this.phase === "locked") return new CivSessionError("CW trial session is locked; create a new session");
    if (this.phase === "closed") return new CivSessionError("CW trial session is closed; create a new session");
    if (this.phase === "closing") return new CivSessionError("CW trial session is closing");
    return null;
  }

  private isTerminal(): boolean {
    return this.phase === "locked" || this.phase === "closed" || this.phase === "closing";
  }

  private performRead<T>(
    label: string,
    request: Uint8Array,
    command: number,
    decode: (frame: CivFrame) => T | null,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const unavailable = this.readableError();
      if (unavailable !== null) {
        reject(unavailable);
        return;
      }
      if (this.pending !== null) {
        reject(new CivBusyError("CW trial session already has a query in flight"));
        return;
      }
      const id = (this.queryCounter += 1);
      const timer = setTimeout(() => {
        const pending = this.pending;
        if (pending === null || pending.id !== id) return;
        this.failSession(new CivTimeoutError(`CW trial ${label} timed out after ${this.queryTimeoutMs} ms`));
      }, this.queryTimeoutMs);
      this.pending = {
        id,
        mode: "read",
        command,
        label,
        decode: decode as (frame: CivFrame) => unknown,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      this.writeRequest(request, id);
    });
  }

  private performAck(label: string, request: Uint8Array): Promise<AckOutcome> {
    return new Promise<AckOutcome>((resolve, reject) => {
      if (this.phase === "closed") {
        reject(new CivSessionError("CW trial session is closed"));
        return;
      }
      if (this.pending !== null) {
        reject(new CivBusyError("CW trial session already has a query in flight"));
        return;
      }
      const id = (this.queryCounter += 1);
      const timer = setTimeout(() => {
        const pending = this.pending;
        if (pending === null || pending.id !== id) return;
        this.pending = null;
        resolve({ kind: "ack_timeout" });
      }, this.queryTimeoutMs);
      this.pending = {
        id,
        mode: "ack",
        command: 0,
        label,
        decode: (frame) => frame.command,
        resolve: (value) => resolve(value as AckOutcome),
        reject,
        timer,
      };
      this.writeRequest(request, id);
    });
  }

  private writeRequest(request: Uint8Array, id: number): void {
    let result: void | Promise<void>;
    try {
      result = this.transport.write(request);
    } catch (error) {
      this.handleWriteFailure(id, error);
      return;
    }
    if (isThenable(result)) {
      void Promise.resolve(result).catch((error: unknown) => this.handleWriteFailure(id, error));
    }
  }

  private handleWriteFailure(id: number, error: unknown): void {
    const pending = this.pending;
    if (pending === null || pending.id !== id) return;
    const failure = new CivTransportError(`CW trial write failed: ${errorMessage(error)}`);
    if (pending.mode === "ack") {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve({ kind: "write_failed", detail: failure.message });
      this.failSession(failure);
      return;
    }
    this.failSession(failure);
  }

  private handleData(chunk: Uint8Array): void {
    if (this.phase === "closed" || this.phase === "closing") return;
    let frames: CivFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.failSession(new CivProtocolError(`CW trial frame parsing failed: ${errorMessage(error)}`));
      return;
    }
    for (const frame of frames) {
      if (this.state === "closed" || this.state === "closing") return;
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: CivFrame): void {
    const pending = this.pending;
    if (pending === null) return;
    // 只接受目标=控制端、来源=电台；回显/广播/其他地址一律忽略。
    if (frame.to !== CIV_DEFAULT_CONTROLLER_ADDRESS || frame.from !== CIV_DEFAULT_RADIO_ADDRESS) return;
    if (pending.mode === "ack") {
      if (frame.command === CIV_COMMAND_OK) this.settlePending(pending, { kind: "ok" });
      else if (frame.command === CIV_COMMAND_NG) this.settlePending(pending, { kind: "ng" });
      return;
    }
    // 有效电台地址的 NG/OK 不是读取数据：锁会话，不静默成功。
    if (frame.command === CIV_COMMAND_NG || frame.command === CIV_COMMAND_OK) {
      this.failSession(
        new CivProtocolError(
          `radio replied 0x${frame.command.toString(16)} to a trial read; not a data response`,
        ),
      );
      return;
    }
    if (frame.command !== pending.command) return;
    let value: unknown;
    try {
      value = pending.decode(frame);
    } catch (error) {
      this.failSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      return;
    }
    if (value === null) return; // 不同 subcommand：不是本查询的数据。
    this.settlePending(pending, value);
  }

  private settlePending(pending: PendingQuery, value: unknown): void {
    if (this.pending !== pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private handleClose(error?: Error): void {
    if (this.isTerminal()) return;
    const detail = error !== undefined ? errorMessage(error) : "transport closed";
    this.failSession(new CivTransportError(`CW trial transport closed: ${detail}`));
  }

  private failSession(error: Error): void {
    if (this.isTerminal()) return;
    this.phase = "locked";
    this.recordError(errorMessage(error));
    this.rejectPending(error);
    this.detach();
    void this.beginClose(true).catch(() => undefined);
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private recordError(message: string): void {
    if (this.error === null || this.error.length === 0) this.error = message;
    else if (!this.error.includes(message)) this.error = `${this.error}; ${message}`;
  }

  private beginClose(isFault: boolean, faultError?: Error): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    if (isFault) {
      this.phase = "locked";
      if (faultError !== undefined) this.recordError(errorMessage(faultError));
    } else if (this.phase !== "locked" && this.phase !== "closed") {
      this.phase = "closing";
    }
    this.rejectPending(
      new CivSessionError(
        isFault ? "CW trial session locked after a fault" : "CW trial session is closing; in-flight query aborted",
      ),
    );
    this.detach();
    const run = Promise.resolve().then(() => this.closeTransportBounded()).then(
      () => {
        this.closeConfirmed = true;
        if (!isFault && this.phase === "closing") this.phase = "closed";
      },
      (error: unknown) => {
        this.closeConfirmed = false;
        if (this.phase !== "closed") this.phase = "locked";
        this.recordError(errorMessage(error));
        throw error;
      },
    );
    this.closePromise = run;
    void run.catch(() => undefined);
    return run;
  }

  private closeTransportBounded(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CivTimeoutError(`CW trial transport close timed out after ${this.closeTimeoutMs} ms`));
      }, this.closeTimeoutMs);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      let result: void | Promise<void>;
      try {
        result = this.transport.close();
      } catch (error) {
        finish(new CivTransportError(`CW trial transport close failed: ${errorMessage(error)}`));
        return;
      }
      if (isThenable(result)) {
        Promise.resolve(result).then(
          () => finish(),
          (error: unknown) =>
            finish(new CivTransportError(`CW trial transport close failed: ${errorMessage(error)}`)),
        );
      } else {
        finish();
      }
    });
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    const dataUnsubscribe = this.dataUnsubscribe;
    const closeUnsubscribe = this.closeUnsubscribe;
    try {
      dataUnsubscribe?.();
    } catch {
      // 取消订阅失败不影响会话状态。
    }
    try {
      closeUnsubscribe?.();
    } catch {
      // 同上。
    }
  }
}
