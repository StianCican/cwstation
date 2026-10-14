// P2-011 离线上下文读取会话（注入式，不打开串口、不发射）。
//
// 设计依据：docs/design/P2-011-离线上下文读取会话.md（v2）及
// docs/tasks/P2-011-离线会话与展示.md。复用 P2-009 的固定六种编解码与
// civ.ts 的 CivFrameParser/CivTransport；transport 由调用方注入，没有串口
// 工厂、默认设备、自动扫描、重试、重连或后台轮询。
//
// 边界：
//  - 一个实例独占注入 transport，至多一个总读取操作；read/refreshAll 竞争
//    立即 CivBusyError，无无界队列。不能与 CivReadOnlyClient 共用同一
//    transport；未来真实仲裁需另设计。
//  - 固定 radio=0x94、controller=0xe0；只识别 to=E0/from=94 的响应。
//  - CI-V 没有事务 ID：本地单调 id 只解决 JS 晚到回调，不解决物理帧归属。
//    view 不是原子快照，也不得用于批准或证明完成。
//  - 任何 parser/解码/写/超时/断线故障都会锁死会话并做有界关闭；不重发，
//    错误发生后不复活、不假称已释放。
//  - 本模块不从 index.ts 导出，不接入 serial/IPC/service/monitor 数据映射。

import {
  CIV_COMMAND_NG,
  CIV_COMMAND_OK,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_DEFAULT_RADIO_ADDRESS,
  CivBusyError,
  CivConfigError,
  CivFrameParser,
  CivProtocolError,
  CivSessionError,
  CivTimeoutError,
  CivTransportError,
  type CivFrame,
  type CivTransport,
} from "./civ.js";
import {
  decodeContextReadResponse,
  planContextRead,
  type ContextReadKind,
  type ContextReadPlan,
  type ContextReadReading,
} from "./civ-context-read.js";

/** 会话阶段；error 是独立字段，不作为 phase 取值。 */
export type ContextReadPhase = "idle" | "reading" | "closing" | "locked" | "closed";

/** 单个字段的可信度：unknown=无样本，fresh=TTL 内，stale=失效。 */
export type ContextReadQuality = "unknown" | "fresh" | "stale";

/** view 中单个 kind 的只读样本副本。 */
export interface ContextReadFieldView {
  readonly reading: ContextReadReading | null;
  /** 采样时刻 epoch 毫秒；无样本为 null。 */
  readonly sampledAt: number | null;
  readonly quality: ContextReadQuality;
}

/** session.view 的只读结果；本轮来源固定 simulation。 */
export interface ContextReadSessionView {
  readonly source: "simulation";
  readonly phase: ContextReadPhase;
  readonly error: string | null;
  readonly fields: Readonly<Record<ContextReadKind, ContextReadFieldView>>;
}

export interface CivContextReadSessionOptions {
  readonly transport: CivTransport;
  /** 单次查询期限（覆盖写挂起与等待回复），默认 2000，范围 1..60000 整数。 */
  readonly queryTimeoutMs?: number;
  /** transport.close 有界等待，默认 2000，范围 1..60000 整数。 */
  readonly closeTimeoutMs?: number;
  /** 样本 monotonic 有效期，默认 2000，范围 1..60000 整数。 */
  readonly ttlMs?: number;
}

/** 固定读取顺序；refreshAll 批次内部串行，不插入外部 read。 */
const CONTEXT_READ_ORDER: readonly ContextReadKind[] = Object.freeze([
  "txFrequency",
  "txStatus",
  "splitEnabled",
  "ritEnabled",
  "xitEnabled",
  "breakIn",
]);

const DEFAULT_TIMEOUT_MS = 2000;

interface ContextSample {
  readonly reading: ContextReadReading;
  /** 采样时刻 epoch 毫秒（墙钟；仅用于诊断与回退拒绝）。 */
  readonly sampledAt: number;
  /** 采样时刻 performance.now() 毫秒（TTL 基准）。 */
  readonly observedAt: number;
  readonly sessionId: number;
}

interface PendingQuery {
  readonly id: number;
  readonly kind: ContextReadKind;
  readonly resolve: (reading: ContextReadReading) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let sessionCounter = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function durationOption(value: unknown, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < 1 || resolved > 60_000) {
    throw new CivConfigError(`${label} must be an integer in [1, 60000], got ${String(resolved)}`);
  }
  return resolved;
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
      throw new CivConfigError(`unknown context read kind: ${String((reading as { kind: unknown }).kind)}`);
  }
}

/**
 * 注入式离线上下文读取会话。
 *
 * 传输层是调用方提供的可信入口，不是权限隔离；读取结果只是非原子快照，
 * 不代表授权、发射完成或停止。故障后一律 locked，不恢复为可读。
 */
export class CivContextReadSession {
  private readonly transport: CivTransport;
  private readonly queryTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly ttlMs: number;
  private readonly parser: CivFrameParser;
  private readonly sessionId: number;
  private readonly samples = new Map<ContextReadKind, ContextSample>();
  private pending: PendingQuery | null = null;
  private phase: ContextReadPhase = "idle";
  private error: string | null = null;
  private operationActive = false;
  private queryCounter = 0;
  private closePromise: Promise<void> | null = null;
  private dataUnsubscribe: (() => void) | null = null;
  private closeUnsubscribe: (() => void) | null = null;
  private detached = false;

  constructor(options: CivContextReadSessionOptions) {
    const source: unknown = options;
    if (typeof source !== "object" || source === null) {
      throw new CivConfigError("CivContextReadSession options must be an object");
    }
    const raw = source as {
      readonly transport?: unknown;
      readonly queryTimeoutMs?: unknown;
      readonly closeTimeoutMs?: unknown;
      readonly ttlMs?: unknown;
    };
    this.transport = assertTransport(raw.transport);
    this.queryTimeoutMs = durationOption(raw.queryTimeoutMs, DEFAULT_TIMEOUT_MS, "queryTimeoutMs");
    this.closeTimeoutMs = durationOption(raw.closeTimeoutMs, DEFAULT_TIMEOUT_MS, "closeTimeoutMs");
    this.ttlMs = durationOption(raw.ttlMs, DEFAULT_TIMEOUT_MS, "ttlMs");
    this.parser = new CivFrameParser();
    this.sessionId = (sessionCounter += 1);

    // 注册失败要清掉已注册订阅，再发起有界关闭并消费拒绝，最后抛原构造错误；
    // 不留下半实例，也不报告释放成功（调用方仍拥有 transport 诊断责任）。
    let dataUnsubscribe: (() => void) | null = null;
    try {
      dataUnsubscribe = this.transport.onData((chunk) => this.handleData(chunk));
      this.closeUnsubscribe = this.transport.onClose((error) => this.handleClose(error));
    } catch (error) {
      try {
        dataUnsubscribe?.();
      } catch {
        // 取消订阅失败不改变构造失败的事实。
      }
      this.dataUnsubscribe = null;
      this.closeUnsubscribe = null;
      void this.closeTransportBounded().catch(() => undefined);
      throw error;
    }
    this.dataUnsubscribe = dataUnsubscribe;
  }

  get state(): ContextReadPhase {
    return this.phase;
  }

  /**
   * 读取单个 kind。非法 kind、busy、locked/closed/closing 都在写入 transport
   * 之前拒绝；成功时记录样本并返回副本，失败（含批次失败）一律锁死会话。
   */
  async read(kind: ContextReadKind): Promise<ContextReadReading> {
    const plan = planContextRead(kind);
    const unavailable = this.readableError();
    if (unavailable !== null) throw unavailable;
    if (this.operationActive) throw new CivBusyError();
    this.operationActive = true;
    this.phase = "reading";
    try {
      return await this.queryKind(plan);
    } finally {
      if (this.phase === "reading") this.phase = "idle";
      this.operationActive = false;
    }
  }

  /**
   * 串行刷新六个固定字段。整个批次占用总操作锁，read 期间返回 CivBusyError；
   * 每一项写前重查 phase，close/locked 会中止剩余步骤；任一项失败即锁死会话，
   * 已成功样本保留供诊断但全部字段立即失效（view 按 locked 全标 stale）。
   */
  async refreshAll(): Promise<void> {
    const unavailable = this.readableError();
    if (unavailable !== null) throw unavailable;
    if (this.operationActive) throw new CivBusyError();
    this.operationActive = true;
    this.phase = "reading";
    try {
      for (const kind of CONTEXT_READ_ORDER) {
        if (this.phase !== "reading") throw this.unavailableError();
        await this.queryKind(planContextRead(kind));
      }
    } finally {
      if (this.phase === "reading") this.phase = "idle";
      this.operationActive = false;
    }
  }

  /**
   * 返回只读视图副本。TTL 以 performance.now() 计算；nowWall（epoch 毫秒）
   * 只增加墙钟年龄/回退拒绝条件，不能延长 monotonic TTL。locked/closed/closing
   * 一律 stale（有历史样本）或 unknown；迟到数据不会复活字段。
   */
  view(nowWall?: number): ContextReadSessionView {
    const monotonicNow = performance.now();
    const provided = nowWall !== undefined;
    const wallUsable = typeof nowWall === "number" && Number.isFinite(nowWall) && nowWall >= 0;
    const wallValid = !provided || wallUsable;
    const wallNow =
      provided && typeof nowWall === "number" && Number.isFinite(nowWall) && nowWall >= 0
        ? nowWall
        : Date.now();
    const terminal = this.phase === "locked" || this.phase === "closed" || this.phase === "closing";
    const fields = {} as Record<ContextReadKind, ContextReadFieldView>;
    for (const kind of CONTEXT_READ_ORDER) {
      const sample = this.samples.get(kind);
      if (sample === undefined) {
        fields[kind] = { reading: null, sampledAt: null, quality: "unknown" };
        continue;
      }
      let quality: ContextReadQuality = "fresh";
      if (terminal) {
        quality = "stale";
      } else {
        const monotonicAge = monotonicNow - sample.observedAt;
        const wallAge = wallNow - sample.sampledAt;
        if (!(monotonicAge >= 0 && monotonicAge < this.ttlMs)) quality = "stale";
        else if (!wallValid) quality = "stale";
        else if (wallAge < 0 || !(wallAge < this.ttlMs)) quality = "stale";
      }
      fields[kind] = { reading: copyReading(sample.reading), sampledAt: sample.sampledAt, quality };
    }
    return { source: "simulation", phase: this.phase, error: this.error, fields };
  }

  /**
   * 幂等关闭并共享正在关闭的 Promise。拒绝在途查询、清 timer/listener、禁新
   * read；transport.close 有 closeTimeout 有界等待。确认后 phase=closed；
   * 拒绝/挂起时 phase=locked 且 error 显式保留，绝不谎称已释放。
   */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    if (this.phase === "closed") return Promise.resolve();
    return this.beginClose(false);
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────

  private readableError(): Error | null {
    if (this.phase === "locked") return new CivSessionError("context read session is locked; create a new session");
    if (this.phase === "closed") return new CivSessionError("context read session is closed; create a new session");
    if (this.phase === "closing") return new CivSessionError("context read session is closing");
    return null;
  }

  private unavailableError(): Error {
    if (this.phase === "closing") return new CivSessionError("context read session is closing");
    if (this.phase === "closed") return new CivSessionError("context read session is closed; create a new session");
    return new CivSessionError("context read session is locked; create a new session");
  }

  private queryKind(plan: ContextReadPlan): Promise<ContextReadReading> {
    return new Promise<ContextReadReading>((resolve, reject) => {
      if (this.phase !== "reading") {
        reject(this.unavailableError());
        return;
      }
      const kind = plan.kind;
      this.parser.reset();
      const id = (this.queryCounter += 1);
      // 先注册 pending/timer 再 write：transport 可同步回调 onData（同步响应）。
      const timer = setTimeout(() => {
        const pending = this.pending;
        if (pending === null || pending.id !== id) return;
        this.failSession(new CivTimeoutError(`context read ${kind} timed out after ${this.queryTimeoutMs} ms`));
      }, this.queryTimeoutMs);
      this.pending = { id, kind, resolve, reject, timer };

      let result: void | Promise<void> = undefined;
      try {
        result = this.transport.write(plan.bytes);
      } catch (error) {
        this.handleWriteFailure(id, error);
        return;
      }
      if (isThenable(result)) {
        void Promise.resolve(result).catch((error: unknown) => {
          this.handleWriteFailure(id, error);
        });
      }
    });
  }

  /** 写失败只作用于同 id 的待处理请求；已 settled 旧请求只消费不锁新查询。 */
  private handleWriteFailure(id: number, error: unknown): void {
    const pending = this.pending;
    if (pending === null || pending.id !== id) return;
    this.failSession(new CivTransportError(`context read write failed: ${errorMessage(error)}`));
  }

  private handleData(chunk: Uint8Array): void {
    if (this.phase !== "reading") return;
    let frames: CivFrame[] = [];
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.failSession(new CivProtocolError(`context read frame parsing failed: ${errorMessage(error)}`));
      return;
    }
    for (const frame of frames) {
      if (this.phase !== "reading") return;
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: CivFrame): void {
    const pending = this.pending;
    if (pending === null || this.phase !== "reading") return;
    // 只接受目标=控制端、来源=电台；回显/广播/其他地址一律忽略。
    if (frame.to !== CIV_DEFAULT_CONTROLLER_ADDRESS || frame.from !== CIV_DEFAULT_RADIO_ADDRESS) return;
    // 有效电台地址的 NG(0xfa)/OK(0xfb) 不是读取数据：锁会话，不静默成功。
    if (frame.command === CIV_COMMAND_NG || frame.command === CIV_COMMAND_OK) {
      this.failSession(
        new CivProtocolError(
          `radio replied 0x${frame.command.toString(16)} to context read ${pending.kind}; not a data response`,
        ),
      );
      return;
    }
    let decoded: ContextReadReading | null = null;
    try {
      decoded = decodeContextReadResponse(pending.kind, frame);
    } catch (error) {
      this.failSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      return;
    }
    if (decoded === null) return; // 不同 command/subcommand：不是本查询的数据。
    this.completeQuery(pending.id, decoded);
  }

  private completeQuery(id: number, reading: ContextReadReading): void {
    const pending = this.pending;
    if (pending === null || pending.id !== id) return;
    this.pending = null;
    clearTimeout(pending.timer);
    this.samples.set(reading.kind, {
      reading: copyReading(reading),
      sampledAt: Date.now(),
      observedAt: performance.now(),
      sessionId: this.sessionId,
    });
    pending.resolve(reading);
  }

  private handleClose(error?: Error): void {
    if (this.phase === "locked" || this.phase === "closed" || this.phase === "closing") return;
    const detail = error !== undefined ? errorMessage(error) : "transport closed";
    this.failSession(new CivTransportError(`context read transport closed: ${detail}`));
  }

  /**
   * 锁死会话并进入同一有界关闭流程。显示 locked 且全部数据失效；成功清理也
   * 不恢复为可读。关闭拒绝由这里消费，避免 unhandled。
   */
  private failSession(error: Error): void {
    if (this.phase === "locked" || this.phase === "closed" || this.phase === "closing") return;
    this.phase = "locked";
    this.rejectPending(error);
    this.detach();
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
    this.rejectPending(
      new CivSessionError(
        isFault
          ? "context read session locked after a fault"
          : "context read session is closing; in-flight read aborted",
      ),
    );
    this.detach();
    const run = this.closeTransportBounded().then(
      () => {
        if (!isFault && this.phase === "closing") this.phase = "closed";
      },
      (error: unknown) => {
        if (this.phase !== "closed") this.phase = "locked";
        this.recordError(errorMessage(error));
        throw error;
      },
    );
    this.closePromise = run;
    return run;
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

  /** 有界 transport.close：同步 throw、异步 reject 与挂起都在期限内显式报告。 */
  private closeTransportBounded(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CivTimeoutError(`context session transport close timed out after ${this.closeTimeoutMs} ms`));
      }, this.closeTimeoutMs);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      let result: void | Promise<void> = undefined;
      try {
        result = this.transport.close();
      } catch (error) {
        finish(new CivTransportError(`context session transport close failed: ${errorMessage(error)}`));
        return;
      }
      if (isThenable(result)) {
        Promise.resolve(result).then(
          () => finish(),
          (error: unknown) =>
            finish(new CivTransportError(`context session transport close failed: ${errorMessage(error)}`)),
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
    this.dataUnsubscribe = null;
    this.closeUnsubscribe = null;
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
