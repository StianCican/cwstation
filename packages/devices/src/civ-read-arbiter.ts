// P2-014 A 注入式八查询统一仲裁（离线候选，不打开串口、不发射）。
//
// 设计依据：docs/design/P2-013-只读接入实施契约.md v3.1 与
// docs/tasks/P2-014-离线统一查询仲裁.md。一个实例独占调用方注入的 transport，
// 复用 civ.ts 的 CivFrameParser 与 03/04 解码、civ-context-read.ts 的六项纯编解码。
//
// 边界：
//  - 构造仅订阅 onData/onClose，不写请求、不启动轮询；start() 显式开代次并串行
//    完成首对 03/04、发布快照后才允许外部 read/refreshAll。
//  - 全局物理查询槽始终 1；外部操作容量 2（1 活动 1 等待），第三立即 busy。
//    状态对 03/04 连续，可在批次两项之间插入，但不允许另一外部操作插入中间。
//  - 超时/畸形/FA/FB/断线/写失败锁代次并有界关闭；不重连、不复用、不假称释放。
//  - 没有 reconnect/openFactory/维护 IPC：本会话不拥有开口流程，关闭后不可复活。
//  - view 的 source 固定 simulation，不是真实设备或稳定硬件身份证据；相对
//    performance.now() 的 monotonic 元数据只作内部判断，不从 view 泄露。
//  - 本模块不从 index.ts 导出，不接 serial/IPC/service/monitor/批准或 rig.sh。

import { randomUUID } from "node:crypto";
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
  CivError,
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
  type CivModeReading,
  type CivTransport,
} from "./civ.js";
import {
  decodeContextReadResponse,
  planContextRead,
  type ContextReadKind,
  type ContextReadReading,
} from "./civ-context-read.js";

// ── 固定候选参数（后续配置扩展另审议） ───────────────────────────────────

export const CIV_ARBITER_POLL_INTERVAL_MS = 1_000;
export const CIV_ARBITER_QUERY_TIMEOUT_MS = 2_000;
export const CIV_ARBITER_OPERATION_TIMEOUT_MS = 30_000;
export const CIV_ARBITER_CLOSE_TIMEOUT_MS = 2_000;
export const CIV_ARBITER_STATUS_TTL_MS = 3_000;
export const CIV_ARBITER_CONTEXT_TTL_MS = 6_000;

/** 六项背景轮转的规范顺序；read/refreshAll 只接受这六种 kind。 */
const CONTEXT_READ_ORDER: readonly ContextReadKind[] = Object.freeze<ContextReadKind[]>([
  "txFrequency",
  "txStatus",
  "splitEnabled",
  "ritEnabled",
  "xitEnabled",
  "breakIn",
]);

const CONTEXT_READ_KIND_SET: ReadonlySet<string> = new Set<string>(CONTEXT_READ_ORDER);

/** 会话阶段；error 是独立字段，不作为 phase 取值。 */
export type ContextReadPhase = "idle" | "reading" | "closing" | "locked" | "closed";

/** 单个样本的可信度：unknown=无样本，fresh=TTL 内，stale=失效。 */
export type ContextReadQuality = "unknown" | "fresh" | "stale";

/**
 * 在尚未写出任何查询前被取消：只移除排队/活动操作，不锁代次。
 * 已写出后取消属故障路径，使用 CivSessionError 锁代次。
 */
export class CivReadAbortedError extends CivError {
  constructor(message = "context read operation was aborted before any query was written") {
    super("aborted", message);
  }
}

/** 03/04 状态快照的只读值；非原子，不证明可发射或已授权。 */
export interface CivStatusReading {
  readonly frequencyHz: number;
  readonly mode: CivMode;
  readonly filter: CivFilter;
}

/** 状态快照视图；quality 与 ttlMs 供消费者进一步收紧。 */
export interface StatusSnapshot {
  readonly reading: CivStatusReading | null;
  /** 采样时刻 epoch 毫秒；无样本为 null。 */
  readonly sampledAt: number | null;
  readonly quality: ContextReadQuality;
  readonly ttlMs: 3000;
}

/**
 * 单个 context kind 的只读样本副本。字段名 sampledAt 采用 P2-013 §3/§4 的
 * 冻结契约（epoch 毫秒），observedAt 的 monotonic 值不导出。
 */
export interface ContextReadFieldView {
  readonly reading: ContextReadReading | null;
  readonly sampledAt: number | null;
  readonly quality: ContextReadQuality;
  readonly ttlMs: 6000;
}

/** arbiter.view 的只读结果；source 本轮固定 simulation。 */
export interface CivReadArbiterView {
  readonly source: "simulation";
  readonly phase: ContextReadPhase;
  readonly error: string | null;
  readonly closeConfirmed: boolean;
  readonly connectionGeneration: number;
  readonly serviceInstanceId: string;
  readonly status: StatusSnapshot;
  readonly fields: Readonly<Record<ContextReadKind, ContextReadFieldView>>;
}

export interface CivReadArbiterOptions {
  /** 调用方注入的可信 transport；本会话独占，不得与其它会话共用。 */
  readonly transport: CivTransport;
}

// ── 内部状态 ──────────────────────────────────────────────────────────────

interface Sample<T> {
  readonly reading: T;
  /** 采样时刻 epoch 毫秒（仅用于墙钟回退/年龄收紧）。 */
  readonly sampledAt: number;
  /** 采样时刻 performance.now() 毫秒（TTL 基准，仅内部）。 */
  readonly observedAt: number;
  readonly generation: number;
  stale: boolean;
}

type QuerySpec =
  | { readonly kind: "statusFrequency" }
  | { readonly kind: "statusMode" }
  | { readonly kind: "context"; readonly contextKind: ContextReadKind };

interface PendingQuery {
  readonly id: number;
  readonly spec: QuerySpec;
  /** 期望的响应 command 字节（request[4]）。 */
  readonly command: number;
  /** 查询 deadline：注册 pending 后、write 前开始。 */
  readonly deadlineMono: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

type ExternalMode = "read" | "refreshAll";

interface ExternalOperation {
  readonly id: number;
  readonly mode: ExternalMode;
  /** 尚未写出的 context kind，保持规范顺序。 */
  readonly remaining: ContextReadKind[];
  readonly signal: AbortSignal | undefined;
  readonly deadlineMono: number;
  readonly promise: Promise<ContextReadReading | void>;
  readonly resolve: (value: ContextReadReading | void) => void;
  readonly reject: (error: Error) => void;
  /** 该操作是否已写出至少一项；决定取消/到期是移除还是锁代次。 */
  hasWritten: boolean;
  settled: boolean;
  lastReading: ContextReadReading | null;
  abortHandler: (() => void) | null;
}

type Step =
  | { readonly type: "statusPair" }
  | { readonly type: "externalContext"; readonly op: ExternalOperation; readonly kind: ContextReadKind }
  | { readonly type: "backgroundContext"; readonly kind: ContextReadKind };

interface QualityInputs {
  readonly monotonicNow: number;
  readonly wallNow: number;
  readonly wallValid: boolean;
  readonly terminal: boolean;
}

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

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function buildStatusRequest(command: number): Uint8Array {
  return Uint8Array.from([
    CIV_PREAMBLE,
    CIV_PREAMBLE,
    CIV_DEFAULT_RADIO_ADDRESS,
    CIV_DEFAULT_CONTROLLER_ADDRESS,
    command,
    CIV_EOM,
  ]);
}

/** 构造 reading 副本，避免调用方改写内部样本。 */
function copyReading(reading: ContextReadReading): ContextReadReading {
  switch (reading.kind) {
    case "txFrequency":
      return { kind: "txFrequency", frequencyHz: reading.frequencyHz };
    case "txStatus":
      return { kind: "txStatus", status: reading.status };
    case "splitEnabled":
      return { kind: "splitEnabled", enabled: reading.enabled };
    case "ritEnabled":
      return { kind: "ritEnabled", enabled: reading.enabled };
    case "xitEnabled":
      return { kind: "xitEnabled", enabled: reading.enabled };
    case "breakIn":
      return { kind: "breakIn", mode: reading.mode };
    default:
      throw new CivConfigError(
        `unknown context read kind: ${String((reading as { kind: unknown }).kind)}`,
      );
  }
}

function copyStatusReading(reading: CivStatusReading): CivStatusReading {
  return { frequencyHz: reading.frequencyHz, mode: reading.mode, filter: reading.filter };
}

/**
 * 注入式八查询统一仲裁。
 *
 * transport 是调用方提供的可信入口，不是权限隔离；状态与 context 都是非原子
 * 快照，不代表授权、发射完成或停止。故障后一律 locked，不恢复为可读。
 */
export class CivReadArbiter {
  private readonly transport: CivTransport;
  private readonly parser = new CivFrameParser();
  private readonly serviceInstanceId = randomUUID();
  private readonly contextSamples = new Map<ContextReadKind, Sample<ContextReadReading>>();

  private phase: ContextReadPhase = "idle";
  private error: string | null = null;
  private closeConfirmed = false;
  private connectionGeneration = 0;
  private generationInvalidated = false;
  private started = false;
  private detached = false;
  private detachFns: (() => void)[] = [];

  private pending: PendingQuery | null = null;
  private queryCounter = 0;
  private statusSample: Sample<CivStatusReading> | null = null;

  private externalCounter = 0;
  private activeExternal: ExternalOperation | null = null;
  private waitingExternal: ExternalOperation | null = null;

  private backgroundIndex = 0;
  private nextStatusDue = 0;
  private contextOpportunityPending = false;
  /** 状态对进行中：03/04 之间让出事件循环，但不允许其它查询插入。 */
  private pairInProgress = false;

  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpScheduled = false;
  private closePromise: Promise<void> | null = null;
  private startPromise: Promise<StatusSnapshot> | null = null;

  constructor(options: CivReadArbiterOptions) {
    const source: unknown = options;
    if (typeof source !== "object" || source === null) {
      throw new CivConfigError("CivReadArbiter options must be an object");
    }
    this.transport = assertTransport((source as { readonly transport?: unknown }).transport);

    // 构造仅订阅；不写请求、不启动轮询、不开启代次。
    try {
      this.registerSubscription(this.transport.onData((chunk) => this.handleData(chunk)));
      this.registerSubscription(this.transport.onClose((error) => this.handleTransportClose(error)));
      if (this.isTerminal()) throw new CivTransportError("transport closed during listener registration");
    } catch (error) {
      this.detach();
      void this.beginClose(true, error instanceof Error ? error : new CivTransportError(String(error)))
        .catch(() => undefined);
      throw error;
    }
  }

  private registerSubscription(unsubscribe: () => void): void {
    if (typeof unsubscribe !== "function") throw new CivConfigError("transport must return an unsubscribe function");
    if (this.detached) unsubscribe();
    else this.detachFns.push(unsubscribe);
  }

  get state(): ContextReadPhase {
    return this.phase;
  }

  /** 当前对外连接代次；初代次 1，失效/主动关闭前只递增一次。 */
  get generation(): number {
    return this.connectionGeneration;
  }

  /**
   * 显式开始：开初代次 1、串行完成首对 03/04 后发布状态快照并允许外部读。
   * 幂等共享同一个 Promise；已锁死/关闭后拒绝。
   */
  start(): Promise<StatusSnapshot> {
    const unavailable = this.readableError();
    if (unavailable !== null) return Promise.reject(unavailable);
    if (this.startPromise !== null) return this.startPromise;
    // Publish the shared promise before an injected transport can respond/re-enter.
    const operation = Promise.resolve().then(() => this.doStart());
    this.startPromise = operation;
    void operation.catch(() => undefined);
    return operation;
  }

  /**
   * 读取单个 context kind。非法 kind/signal、未 start、busy、locked/closed/closing
   * 都在写入 transport 之前拒绝。已写出后取消或总 deadline 到期会锁代次。
   */
  async read(kind: ContextReadKind, signal?: AbortSignal): Promise<ContextReadReading> {
    const contextKind = this.assertKind(kind);
    this.assertSignal(signal);
    const operation = this.enqueueExternal("read", [contextKind], signal);
    const value = await operation.promise;
    if (value === undefined) {
      throw new CivSessionError("read operation completed without a context reading");
    }
    return value;
  }

  /**
   * 串行刷新六项固定 context。批次允许 03/04 在两项之间插入，但不允许另一
   * 外部操作插入；整个批次占用一个活动外部槽位，总 deadline 含排队时间。
   */
  async refreshAll(signal?: AbortSignal): Promise<void> {
    this.assertSignal(signal);
    const operation = this.enqueueExternal("refreshAll", [...CONTEXT_READ_ORDER], signal);
    await operation.promise;
  }

  /**
   * 返回只读副本。quality 综合活动代次、monotonic 年龄、墙钟回退与 terminal
   * 状态；locked/closing/closed 一律 stale（有样本）或 unknown。迟到数据不能复活。
   */
  view(nowWall?: number): CivReadArbiterView {
    const providedWall = nowWall !== undefined;
    const wallUsable = typeof nowWall === "number" && Number.isFinite(nowWall) && nowWall >= 0;
    const inputs: QualityInputs = {
      monotonicNow: performance.now(),
      wallNow: providedWall && wallUsable ? (nowWall as number) : Date.now(),
      wallValid: !providedWall || wallUsable,
      terminal: this.isTerminal(),
    };

    const fields = {} as Record<ContextReadKind, ContextReadFieldView>;
    for (const kind of CONTEXT_READ_ORDER) {
      const sample = this.contextSamples.get(kind);
      if (sample === undefined) {
        const emptyField: ContextReadFieldView = {
          reading: null,
          sampledAt: null,
          quality: "unknown",
          ttlMs: CIV_ARBITER_CONTEXT_TTL_MS,
        };
        fields[kind] = Object.freeze(emptyField);
        continue;
      }
      const field: ContextReadFieldView = {
        reading: copyReading(sample.reading),
        sampledAt: sample.sampledAt,
        quality: this.qualityOf(sample, CIV_ARBITER_CONTEXT_TTL_MS, inputs),
        ttlMs: CIV_ARBITER_CONTEXT_TTL_MS,
      };
      fields[kind] = Object.freeze(field);
    }

    const result: CivReadArbiterView = {
      source: "simulation",
      phase: this.phase,
      error: this.error,
      closeConfirmed: this.closeConfirmed,
      connectionGeneration: this.connectionGeneration,
      serviceInstanceId: this.serviceInstanceId,
      status: this.statusSnapshot(inputs),
      fields: Object.freeze(fields),
    };
    return Object.freeze(result);
  }

  /**
   * 幂等关闭并共享 Promise。拒绝在途/排队操作、清 timer/listener、禁新 read；
   * transport.close 有 2000ms 有界等待。失败/挂起保持 locked+未确认。
   */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    if (this.phase === "closed") return Promise.resolve();
    return this.beginClose(false);
  }

  // ── 外部操作 ───────────────────────────────────────────────────────────

  private assertKind(kind: unknown): ContextReadKind {
    if (typeof kind !== "string" || !CONTEXT_READ_KIND_SET.has(kind)) {
      throw new CivConfigError(`unknown context read kind: ${String(kind)}`);
    }
    return kind as ContextReadKind;
  }

  private assertSignal(signal: unknown): void {
    if (signal === undefined) return;
    if (!isAbortSignal(signal)) {
      throw new CivConfigError("signal must be an AbortSignal");
    }
  }

  private readableError(): Error | null {
    switch (this.phase) {
      case "locked":
        return new CivSessionError("CI-V arbiter is locked after a fault; create a new session");
      case "closed":
        return new CivSessionError("CI-V arbiter is closed; create a new session");
      case "closing":
        return new CivSessionError("CI-V arbiter is closing");
      default:
        return null;
    }
  }

  private isTerminal(): boolean {
    return this.phase === "locked" || this.phase === "closed" || this.phase === "closing";
  }

  private enqueueExternal(
    mode: ExternalMode,
    kinds: readonly ContextReadKind[],
    signal: AbortSignal | undefined,
  ): ExternalOperation {
    const unavailable = this.readableError();
    if (unavailable !== null) throw unavailable;
    if (!this.started) {
      throw new CivSessionError("CI-V arbiter has not completed its first 03/04 pair");
    }
    if (signal !== undefined && signal.aborted) throw new CivReadAbortedError();
    if (this.activeExternal !== null && this.waitingExternal !== null) {
      throw new CivBusyError(
        "two external operations are already pending; at most one active and one waiting",
      );
    }

    const operation = this.createExternal(mode, kinds, signal);
    if (this.activeExternal === null) {
      this.activeExternal = operation;
      this.schedulePump();
    } else {
      this.waitingExternal = operation;
    }
    return operation;
  }

  private createExternal(
    mode: ExternalMode,
    kinds: readonly ContextReadKind[],
    signal: AbortSignal | undefined,
  ): ExternalOperation {
    let resolveFn: (value: ContextReadReading | void) => void = () => undefined;
    let rejectFn: (error: Error) => void = () => undefined;
    const promise = new Promise<ContextReadReading | void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const operation: ExternalOperation = {
      id: (this.externalCounter += 1),
      mode,
      remaining: [...kinds],
      signal,
      deadlineMono: performance.now() + CIV_ARBITER_OPERATION_TIMEOUT_MS,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      hasWritten: false,
      settled: false,
      lastReading: null,
      abortHandler: null,
    };
    // 调用方即使忽略返回 Promise 也不产生 unhandled rejection。
    void promise.catch(() => undefined);
    if (signal !== undefined) {
      const handler = (): void => this.handleExternalAbort(operation);
      operation.abortHandler = handler;
      signal.addEventListener("abort", handler, { once: true });
    }
    return operation;
  }

  private detachExternalAbort(operation: ExternalOperation): void {
    const handler = operation.abortHandler;
    if (handler === null || operation.signal === undefined) return;
    operation.abortHandler = null;
    try {
      operation.signal.removeEventListener("abort", handler);
    } catch {
      // 取消订阅失败不影响操作状态。
    }
  }

  private handleExternalAbort(operation: ExternalOperation): void {
    if (operation.settled || this.phase !== "reading") return;
    if (operation === this.activeExternal && operation.hasWritten) {
      this.lockSession(
        new CivReadAbortedError(
          "external operation cancelled after a query was written; connection generation locked",
        ),
      );
      return;
    }
    this.finishExternal(
      operation,
      undefined,
      new CivReadAbortedError("external operation cancelled before any query was written"),
    );
  }

  private finishExternal(
    operation: ExternalOperation,
    value: ContextReadReading | void,
    error: Error | null,
  ): void {
    if (operation.settled) return;
    operation.settled = true;
    this.detachExternalAbort(operation);
    if (this.activeExternal === operation) {
      this.activeExternal = null;
    } else if (this.waitingExternal === operation) {
      this.waitingExternal = null;
    }
    this.promoteWaiting();
    if (error !== null) operation.reject(error);
    else operation.resolve(value);
  }

  private promoteWaiting(): void {
    const next = this.waitingExternal;
    if (next === null || this.activeExternal !== null) return;
    this.waitingExternal = null;
    this.activeExternal = next;
    this.schedulePump();
  }

  private failAllExternal(error: Error): void {
    for (const operation of [this.activeExternal, this.waitingExternal]) {
      if (operation === null || operation.settled) continue;
      operation.settled = true;
      this.detachExternalAbort(operation);
      operation.reject(error);
    }
    this.activeExternal = null;
    this.waitingExternal = null;
  }

  // ── 调度 ──────────────────────────────────────────────────────────────

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    if (this.pending !== null || this.pairInProgress) return;
    if (this.phase !== "reading") return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      if (this.pending !== null || this.pairInProgress || this.phase !== "reading") return;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.phase !== "reading") return;
    const step = this.chooseStep();
    if (step === null) {
      this.armTimer();
      return;
    }
    try {
      await this.executeStep(step);
    } catch (error) {
      // 未归类的执行异常一律按故障锁代次，避免外部操作悬挂；已锁/正在关闭
      // 的路径不会重复处理。
      if (this.phase === "reading") {
        this.lockSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      }
    }
    if (this.phase === "reading") this.schedulePump();
    else this.armTimer();
  }

  private chooseStep(): Step | null {
    if (this.pairInProgress) return null;
    const now = performance.now();
    this.expireExternalDeadlines(now);
    if (this.phase !== "reading") return null;

    const due = now >= this.nextStatusDue;
    if (due && !this.contextOpportunityPending) {
      this.contextOpportunityPending = false;
      return { type: "statusPair" };
    }

    const active = this.activeExternal;
    if (active !== null && active.remaining.length > 0) {
      const kind = active.remaining[0];
      if (kind === undefined) return null;
      this.contextOpportunityPending = false;
      return { type: "externalContext", op: active, kind };
    }

    if (this.contextOpportunityPending && this.activeExternal === null && this.waitingExternal === null) {
      const kind = CONTEXT_READ_ORDER[this.backgroundIndex % CONTEXT_READ_ORDER.length];
      if (kind === undefined) return null;
      this.contextOpportunityPending = false;
      return { type: "backgroundContext", kind };
    }

    if (due) {
      this.contextOpportunityPending = false;
      return { type: "statusPair" };
    }
    return null;
  }

  private async executeStep(step: Step): Promise<void> {
    switch (step.type) {
      case "statusPair":
        await this.runStatusPair();
        return;
      case "externalContext":
        await this.runExternalContextStep(step.op, step.kind);
        return;
      case "backgroundContext":
        await this.runBackgroundContextStep(step.kind);
        return;
    }
  }

  /** 首对及后续状态对：连续 03 再 04，中间让出事件循环但不插入 context。 */
  private async runStatusPair(): Promise<void> {
    this.nextStatusDue = performance.now() + CIV_ARBITER_POLL_INTERVAL_MS;
    this.pairInProgress = true;
    try {
      const frequencyHz = await this.performQuery<number>({ kind: "statusFrequency" });
      if (this.phase !== "reading") return;
      await this.yieldToEventLoop();
      if (this.phase !== "reading") return;
      const modeReading = await this.performQuery<CivModeReading>({ kind: "statusMode" });
      if (this.phase !== "reading") return;
      this.statusSample = {
        reading: { frequencyHz, mode: modeReading.mode, filter: modeReading.filter },
        sampledAt: Date.now(),
        observedAt: performance.now(),
        generation: this.connectionGeneration,
        stale: false,
      };
      // 状态对完成后即使已到期也先给一项 context 机会，避免饥饿。
      this.contextOpportunityPending = true;
    } finally {
      this.pairInProgress = false;
    }
  }

  /** 让出事件循环，确保每条下一查询不构成无界 microtask 循环。 */
  private yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  }

  private async runExternalContextStep(
    operation: ExternalOperation,
    kind: ContextReadKind,
  ): Promise<void> {
    if (!this.enforceExternalDeadline(operation)) return;
    operation.hasWritten = true;
    const reading = await this.performQuery<ContextReadReading>({
      kind: "context",
      contextKind: kind,
    });
    if (this.phase !== "reading" || operation.settled) return;
    // 结果提交前重核总操作 deadline。
    if (!this.enforceExternalDeadline(operation)) return;
    this.recordContextSample(reading);
    operation.remaining.shift();
    if (operation.mode === "read") operation.lastReading = reading;
    if (operation.remaining.length === 0) {
      if (operation.mode === "read") {
        this.finishExternal(operation, operation.lastReading ?? undefined, null);
      } else {
        this.finishExternal(operation, undefined, null);
      }
    }
  }

  private async runBackgroundContextStep(kind: ContextReadKind): Promise<void> {
    const reading = await this.performQuery<ContextReadReading>({
      kind: "context",
      contextKind: kind,
    });
    if (this.phase !== "reading") return;
    this.recordContextSample(reading);
    this.backgroundIndex = (this.backgroundIndex + 1) % CONTEXT_READ_ORDER.length;
  }

  /**
   * 总操作 deadline 检查。未写出只移除；已写出即锁代次，不假称取消完成。
   * 返回 true 表示操作仍可继续。
   */
  private enforceExternalDeadline(operation: ExternalOperation): boolean {
    if (operation.settled) return false;
    if (performance.now() < operation.deadlineMono) return true;
    if (operation.hasWritten) {
      this.lockSession(
        new CivTimeoutError(
          "external operation exceeded its total deadline after a query was written; connection generation locked",
        ),
      );
    } else {
      this.finishExternal(
        operation,
        undefined,
        new CivTimeoutError("external operation exceeded its total deadline before any query was written"),
      );
    }
    return false;
  }

  private expireExternalDeadlines(now: number): void {
    for (const operation of [this.activeExternal, this.waitingExternal]) {
      if (operation === null || operation.settled) continue;
      if (now < operation.deadlineMono) continue;
      if (operation.hasWritten) {
        this.lockSession(
          new CivTimeoutError(
            "external operation exceeded its total deadline after a query was written; connection generation locked",
          ),
        );
        return;
      }
      this.finishExternal(
        operation,
        undefined,
        new CivTimeoutError("external operation exceeded its total deadline before any query was written"),
      );
    }
  }

  /** 单一唤醒 timer：无工作时只保留一项，timer 只负责唤醒调度/deadline 复核。 */
  private armTimer(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.phase !== "reading") return;
    // 状态对让出事件循环的窗口内没有 pending：由 setImmediate 续跑，不挂 timer。
    if (this.pairInProgress && this.pending === null) return;
    let due: number | null = null;
    if (this.pending !== null) due = this.pending.deadlineMono;
    for (const operation of [this.activeExternal, this.waitingExternal]) {
      if (operation !== null && !operation.settled) {
        if (due === null || operation.deadlineMono < due) due = operation.deadlineMono;
      }
    }
    if (due === null) due = this.nextStatusDue;
    const delay = Math.max(0, Math.ceil(due - performance.now()));
    this.wakeTimer = setTimeout(() => this.onWake(), delay);
  }

  private disarmTimer(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  private onWake(): void {
    this.wakeTimer = null;
    if (this.phase !== "reading") return;
    const now = performance.now();
    this.expireExternalDeadlines(now);
    if (this.phase !== "reading") return;
    const pending = this.pending;
    if (pending !== null) {
      if (now >= pending.deadlineMono) {
        this.failPendingTimeout(pending);
        return;
      }
      this.armTimer();
      return;
    }
    this.schedulePump();
  }

  // ── 物理查询 ──────────────────────────────────────────────────────────

  private resolveRequest(spec: QuerySpec): { readonly request: Uint8Array; readonly command: number } {
    switch (spec.kind) {
      case "statusFrequency":
        return {
          request: buildStatusRequest(CIV_COMMAND_READ_FREQUENCY),
          command: CIV_COMMAND_READ_FREQUENCY,
        };
      case "statusMode":
        return {
          request: buildStatusRequest(CIV_COMMAND_READ_MODE),
          command: CIV_COMMAND_READ_MODE,
        };
      case "context": {
        const plan = planContextRead(spec.contextKind);
        // plan 的固定布局：FE FE 94 E0 <command> [subcommand] FD。
        const command = plan.bytes[4];
        if (command === undefined) {
          throw new CivConfigError(`context read ${spec.contextKind} plan is missing its command byte`);
        }
        return { request: plan.bytes, command };
      }
    }
  }

  private performQuery<T>(spec: QuerySpec): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.expireExternalDeadlines(performance.now());
      if (this.phase !== "reading") {
        reject(this.unavailableError());
        return;
      }
      const id = (this.queryCounter += 1);
      const resolved = this.resolveRequest(spec);
      const deadlineMono = performance.now() + CIV_ARBITER_QUERY_TIMEOUT_MS;
      this.parser.reset();
      // 先注册 pending/timer，再 write：transport 可同步回调 onData（同步回复）。
      this.pending = {
        id,
        spec,
        command: resolved.command,
        deadlineMono,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.armTimer();

      if (performance.now() >= deadlineMono) {
        this.failPendingTimeout(this.pending);
        return;
      }

      let result: void | Promise<void>;
      try {
        result = this.transport.write(resolved.request);
      } catch (error) {
        this.failPendingWrite(id, error);
        return;
      }
      if (isThenable(result)) {
        void Promise.resolve(result).catch((error: unknown) => {
          this.failPendingWrite(id, error);
        });
      }
    });
  }

  private unavailableError(): Error {
    const unavailable = this.readableError();
    return unavailable ?? new CivSessionError("CI-V arbiter is not readable");
  }

  /** 写失败只作用于同 id 的待处理请求；已 settled 旧请求不锁新查询。 */
  private failPendingWrite(id: number, error: unknown): void {
    const pending = this.pending;
    if (pending === null || pending.id !== id) return;
    this.lockSession(new CivTransportError(`CI-V read write failed: ${errorMessage(error)}`));
  }

  private failPendingTimeout(pending: PendingQuery): void {
    if (this.pending !== pending) return;
    this.lockSession(
      new CivTimeoutError(`CI-V query timed out after ${CIV_ARBITER_QUERY_TIMEOUT_MS} ms`),
    );
  }

  private handleData(chunk: Uint8Array): void {
    if (this.phase !== "reading") return;
    let frames: CivFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.lockSession(new CivProtocolError(`CI-V frame parsing failed: ${errorMessage(error)}`));
      return;
    }
    for (const frame of frames) {
      if (this.phase !== "reading") return;
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: CivFrame): void {
    const pending = this.pending;
    if (pending === null) return;
    // 只接受目标=控制端、来源=电台；回显/广播/其他地址一律忽略。
    if (frame.to !== CIV_DEFAULT_CONTROLLER_ADDRESS || frame.from !== CIV_DEFAULT_RADIO_ADDRESS) {
      return;
    }
    // 有效电台地址的 NG(0xfa)/OK(0xfb) 不是读取数据：锁代次，不静默成功。
    if (frame.command === CIV_COMMAND_NG || frame.command === CIV_COMMAND_OK) {
      this.lockSession(
        new CivProtocolError(
          `radio replied 0x${frame.command.toString(16)}; not a data response`,
        ),
      );
      return;
    }
    if (frame.command !== pending.command) return;
    // 收帧时重核查询 deadline；迟到帧不接收为成功。
    if (performance.now() >= pending.deadlineMono) {
      this.failPendingTimeout(pending);
      return;
    }
    let value: number | CivModeReading | ContextReadReading | null;
    try {
      value = this.decodeFrame(pending.spec, frame);
    } catch (error) {
      this.lockSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      return;
    }
    if (value === null) return; // 合法但不同 subcommand：不是本查询的数据。
    this.completeQuery(pending, value);
  }

  private decodeFrame(
    spec: QuerySpec,
    frame: CivFrame,
  ): number | CivModeReading | ContextReadReading | null {
    switch (spec.kind) {
      case "statusFrequency":
        return decodeFrequencyBcd(frame.data);
      case "statusMode":
        return decodeModeReading(frame.data);
      case "context":
        return decodeContextReadResponse(spec.contextKind, frame);
    }
  }

  private completeQuery(pending: PendingQuery, value: unknown): void {
    if (this.pending !== pending) return;
    if (performance.now() >= pending.deadlineMono) {
      this.failPendingTimeout(pending);
      return;
    }
    this.pending = null;
    // 清掉查询 deadline 唤醒，按新状态重挂唯一 timer。
    this.armTimer();
    pending.resolve(value);
  }

  private recordContextSample(reading: ContextReadReading): void {
    this.contextSamples.set(reading.kind, {
      reading: copyReading(reading),
      sampledAt: Date.now(),
      observedAt: performance.now(),
      generation: this.connectionGeneration,
      stale: false,
    });
  }

  // ── 故障、关闭与视图 ──────────────────────────────────────────────────

  private handleTransportClose(error?: Error): void {
    if (this.isTerminal()) return;
    const detail = error !== undefined ? errorMessage(error) : "transport closed";
    this.lockSession(new CivTransportError(`CI-V transport closed: ${detail}`));
  }

  /** 现有代次失效时只递增一次，保证历史样本携原代次并全部失效。 */
  private invalidateGeneration(): void {
    if (this.generationInvalidated) return;
    if (this.connectionGeneration >= Number.MAX_SAFE_INTEGER) {
      this.recordError("connection generation reached MAX_SAFE_INTEGER; service restart required");
      this.generationInvalidated = true;
      return;
    }
    this.connectionGeneration += 1;
    this.generationInvalidated = true;
  }

  /**
   * 锁死当前代次并进入同一有界关闭流程。拒绝在途/排队操作、清 timer/listener，
   * 却不恢复为可读；close 结果只反映 transport 释放是否确认。
   */
  private lockSession(error: Error): void {
    if (this.isTerminal()) return;
    this.phase = "locked";
    this.recordError(errorMessage(error));
    this.invalidateGeneration();
    this.rejectPending(new CivSessionError("CI-V arbiter locked after a fault; in-flight query aborted"));
    this.failAllExternal(new CivSessionError("CI-V arbiter is locked; external operation aborted"));
    this.detach();
    this.disarmTimer();
    void this.beginClose(true, error).catch(() => undefined);
  }

  private beginClose(isFault: boolean, faultError?: Error): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    if (isFault) {
      this.phase = "locked";
      if (faultError !== undefined) this.recordError(errorMessage(faultError));
    } else if (this.phase !== "locked" && this.phase !== "closed") {
      this.phase = "closing";
    }
    // 主动关闭也递增一次；lockSession 已递增时保持幂等。
    this.invalidateGeneration();
    this.rejectPending(
      new CivSessionError(
        isFault
          ? "CI-V arbiter locked after a fault"
          : "CI-V arbiter is closing; in-flight query aborted",
      ),
    );
    this.failAllExternal(
      new CivSessionError(isFault ? "CI-V arbiter is locked" : "CI-V arbiter is closing"),
    );
    this.detach();
    this.disarmTimer();

    // Cache the close promise before transport.close can synchronously re-enter.
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

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return;
    pending.reject(error);
  }

  private recordError(message: string): void {
    if (this.error === null || this.error.length === 0) this.error = message;
    else if (!this.error.includes(message)) this.error = `${this.error}; ${message}`;
  }

  /** 有界 transport.close：同步 throw、异步 reject 与挂起都在期限内显式报告。 */
  private closeTransportBounded(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const deadlineMono = performance.now() + CIV_ARBITER_CLOSE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new CivTimeoutError(`context arbiter transport close timed out after ${CIV_ARBITER_CLOSE_TIMEOUT_MS} ms`),
        );
      }, CIV_ARBITER_CLOSE_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (performance.now() >= deadlineMono) {
          reject(new CivTimeoutError("transport close completed after its deadline; release not confirmed in time"));
        } else if (error === undefined) resolve();
        else reject(error);
      };
      let result: void | Promise<void>;
      try {
        result = this.transport.close();
      } catch (error) {
        finish(new CivTransportError(`context arbiter transport close failed: ${errorMessage(error)}`));
        return;
      }
      if (isThenable(result)) {
        Promise.resolve(result).then(
          () => finish(),
          (error: unknown) =>
            finish(new CivTransportError(`context arbiter transport close failed: ${errorMessage(error)}`)),
        );
      } else {
        finish();
      }
    });
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    const fns = this.detachFns;
    this.detachFns = [];
    for (const unsubscribe of fns) {
      try {
        unsubscribe();
      } catch {
        // 取消订阅失败不影响会话状态。
      }
    }
  }

  private qualityOf<T>(sample: Sample<T>, ttlMs: number, inputs: QualityInputs): ContextReadQuality {
    const monotonicAge = inputs.monotonicNow - sample.observedAt;
    const wallAge = inputs.wallNow - sample.sampledAt;
    if (inputs.terminal || sample.generation !== this.connectionGeneration || !inputs.wallValid
      || !(monotonicAge >= 0 && monotonicAge < ttlMs) || !(wallAge >= 0 && wallAge < ttlMs)) {
      sample.stale = true;
    }
    return sample.stale ? "stale" : "fresh";
  }

  private statusSnapshot(inputs: QualityInputs): StatusSnapshot {
    const sample = this.statusSample;
    if (sample === null) {
      const emptyStatus: StatusSnapshot = {
        reading: null,
        sampledAt: null,
        quality: "unknown",
        ttlMs: CIV_ARBITER_STATUS_TTL_MS,
      };
      return Object.freeze(emptyStatus);
    }
    const snapshot: StatusSnapshot = {
      reading: copyStatusReading(sample.reading),
      sampledAt: sample.sampledAt,
      quality: this.qualityOf(sample, CIV_ARBITER_STATUS_TTL_MS, inputs),
      ttlMs: CIV_ARBITER_STATUS_TTL_MS,
    };
    return Object.freeze(snapshot);
  }

  private async doStart(): Promise<StatusSnapshot> {
    const unavailable = this.readableError();
    if (unavailable !== null) throw unavailable;
    this.connectionGeneration = 1;
    this.generationInvalidated = false;
    this.phase = "reading";
    this.started = false;
    this.nextStatusDue = performance.now() + CIV_ARBITER_POLL_INTERVAL_MS;
    try {
      await this.runStatusPair();
      if (this.isTerminal() || this.statusSample === null) throw this.unavailableError();
    } catch (error) {
      if (!this.isTerminal()) {
        this.lockSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      }
      throw error;
    }
    this.started = true;
    this.schedulePump();
    return this.statusSnapshot({
      monotonicNow: performance.now(),
      wallNow: Date.now(),
      wallValid: true,
      terminal: this.isTerminal(),
    });
  }
}
