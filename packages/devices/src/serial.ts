// IC-7300 CI-V 的真实串口 transport（P1-005；P2-015 增加受控 CW 试验策略）。
//
// 本模块把现成 serialport 库适配成 civ.ts 的窄 CivTransport：
//  - openSerialCivTransport 只允许 6 字节只读请求 FE FE 94 E0 03|04 FD；
//    任何其它字节（发码 0x17、停止 0xFF、PTT/SEND、写频率/模式等）在写
//    之前即被拒绝。
//  - openCwTrialSerialTransport 是独立命名的窄白名单：八条固定 94/E0 只读
//    请求，加且仅加 Command 17 的 E / TEST / FF 三条固定帧；必须显式
//    confirmKeyingOff:true。两个工厂共用同一段生命周期代码，但各自持有
//    不可变的授权策略，互不放宽。
//  - 串口必须显式指定；不枚举端口、不扫地址、不扫波特率。
//  - 波特率默认 19200，仅允许手册列出的 6 种；固定 8N1、无 rtscts/xon/xoff、
//    autoOpen=false、lock=true（平台是否真正独占由操作系统如实决定）。
//  - 打开后立即 set dtr=false/rts=false，再 flush 清残留输入，短暂稳定等待后
//    再次 flush，之后才允许查询。
//  - 所有 open/set/flush/write/drain/close 都有有界超时；错误、超时或断连都会
//    触发 onClose 并启动有界关闭。close 幂等；底层关闭失败/超时时不会谎报
//    已释放资源，登记与 error 监听保留到确认关闭为止。
//
// 重要限制：
//  - 打开串口的瞬间仍可能改变 DTR/RTS 电平，本模块只能尽快拉低，不能承诺
//    在开口瞬间消除控制线变化；CLI 必须显式 --confirm-keying-off。
//  - 同进程重复打开由本模块拒绝；跨进程独占依赖 OS 的 lock:true，不能用
//    数据库锁冒充设备独占。
//  - CI-V 没有事务 ID：新会话无法证明端口字节属于自己的请求，归属问题只
//    能靠唯一端口持有缓解。
//  - 原生 serialport 绑定按需动态加载，离线模拟（cwrig simulate）不因绑定
//    缺失而失败。
//
// 本模块只执行显式调用的只读串口操作，不读取数据库或 daemon。

import {
  CIV_COMMAND_READ_FREQUENCY,
  CIV_COMMAND_READ_MODE,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_EOM,
  CIV_PREAMBLE,
  CivError,
  type CivTransport,
} from "./civ.js";
import { isAllowedContextReadRequest } from "./civ-context-read.js";
import { CIV_COMMAND_SEND_CW, CIV_CW_STOP_BYTE } from "./civ-tx-plan.js";

/** 默认波特率；任务指定的 COM17 只读链路即 19200。 */
export const SERIAL_DEFAULT_BAUD_RATE = 19200;

/** 手册列出的 USB CI-V 波特率；不自动扫描、不接受表速率。 */
export const SERIAL_ALLOWED_BAUD_RATES: readonly number[] = Object.freeze([
  4800, 9600, 19200, 38400, 57600, 115200,
]);

// 唯一允许写入串口的固定字节：内部常量冻结后用于比较。刻意不依赖任何
// 运行时可变的导出结构，避免调用方改数组就"放行"任意 CI-V 命令。
const ALLOWED_READ_FREQUENCY = Object.freeze([
  CIV_PREAMBLE,
  CIV_PREAMBLE,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_COMMAND_READ_FREQUENCY,
  CIV_EOM,
] as const);

const ALLOWED_READ_MODE = Object.freeze([
  CIV_PREAMBLE,
  CIV_PREAMBLE,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_COMMAND_READ_MODE,
  CIV_EOM,
] as const);

/**
 * 只读白名单的冻结视图，仅供测试断言使用。isAllowedCivReadRequest 实际比较
 * 的是模块私有常量，因此即使该导出被篡改也不会扩大可写字节范围。
 */
export const ALLOWED_CIV_READ_REQUESTS: readonly (readonly number[])[] = Object.freeze([
  ALLOWED_READ_FREQUENCY,
  ALLOWED_READ_MODE,
]);

function bytesEqual(data: Uint8Array | readonly number[], expected: readonly number[]): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (data[index] !== expected[index]) return false;
  }
  return true;
}

/** 是否为白名单内的 6 字节只读 CI-V 请求。 */
export function isAllowedCivReadRequest(data: Uint8Array | readonly number[]): boolean {
  if (data.length !== 6) return false;
  if (data[4] === CIV_COMMAND_READ_FREQUENCY) return bytesEqual(data, ALLOWED_READ_FREQUENCY);
  if (data[4] === CIV_COMMAND_READ_MODE) return bytesEqual(data, ALLOWED_READ_MODE);
  return false;
}

// ── 写入授权策略（只读 / 受控 CW 试验） ──────────────────────────────────
//
// 每个 transport 在构造时绑定一份授权；策略真源是模块私有冻结字节表，
// 导出副本只供测试断言。两个工厂共用生命周期，但不共用授权，互不放宽。

interface SerialWriteAuthorization {
  readonly name: string;
  isAllowed(data: Uint8Array | readonly number[]): boolean;
  rejectionMessage(data: Uint8Array | readonly number[]): string;
}

const READ_ONLY_AUTHORIZATION: SerialWriteAuthorization = Object.freeze({
  name: "read-only",
  isAllowed: isAllowedCivReadRequest,
  rejectionMessage: (data: Uint8Array | readonly number[]): string =>
    `refusing to write non-whitelisted CI-V bytes (${hexBytes(data)}); only ` +
    "FE FE 94 E0 03 FD and FE FE 94 E0 04 FD are allowed",
});

function exactlyEquals(data: Uint8Array | readonly number[], expected: readonly number[]): boolean {
  return data.length === expected.length && bytesEqual(data, expected);
}

// Command 17 的三条固定帧：E=0x45，TEST=0x54 0x45 0x53 0x54，FF=停止。
// 不提供任意载荷；试验会话只能写出这里列出的确切字节。
const CW_TRIAL_WRITE_E = Object.freeze([
  CIV_PREAMBLE,
  CIV_PREAMBLE,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_COMMAND_SEND_CW,
  0x45,
  CIV_EOM,
] as const);

const CW_TRIAL_WRITE_TEST = Object.freeze([
  CIV_PREAMBLE,
  CIV_PREAMBLE,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_COMMAND_SEND_CW,
  0x54,
  0x45,
  0x53,
  0x54,
  CIV_EOM,
] as const);

const CW_TRIAL_WRITE_STOP = Object.freeze([
  CIV_PREAMBLE,
  CIV_PREAMBLE,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_COMMAND_SEND_CW,
  CIV_CW_STOP_BYTE,
  CIV_EOM,
] as const);

const CW_TRIAL_WRITE_WHITELIST: readonly (readonly number[])[] = Object.freeze([
  CW_TRIAL_WRITE_E,
  CW_TRIAL_WRITE_TEST,
  CW_TRIAL_WRITE_STOP,
]);

/** 受控试验写白名单的冻结副本，仅供测试断言；运行时比较使用私有常量。 */
export const ALLOWED_CW_TRIAL_WRITES: readonly (readonly number[])[] = Object.freeze(
  CW_TRIAL_WRITE_WHITELIST.map((bytes) => Object.freeze([...bytes])),
);

function isAllowedCwTrialWrite(data: Uint8Array | readonly number[]): boolean {
  if (isAllowedCivReadRequest(data)) return true;
  if (isAllowedContextReadRequest(data)) return true;
  for (const allowed of CW_TRIAL_WRITE_WHITELIST) {
    if (exactlyEquals(data, allowed)) return true;
  }
  return false;
}

const CW_TRIAL_AUTHORIZATION: SerialWriteAuthorization = Object.freeze({
  name: "cw-trial",
  isAllowed: isAllowedCwTrialWrite,
  rejectionMessage: (data: Uint8Array | readonly number[]): string =>
    `refusing to write non-whitelisted CW trial bytes (${hexBytes(data)}); allowed are only the eight ` +
    "fixed 94/E0 read requests and FE FE 94 E0 17 45 FD, FE FE 94 E0 17 54 45 53 54 FD (TEST) " +
    "or FE FE 94 E0 17 FF FD (stop)",
});

const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 2_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_SETTLE_MS = 50;
const MAX_TIMEOUT_MS = 60_000;
const MAX_SETTLE_MS = 5_000;

// ── 错误类型（继承 CivError，便于 CLI 统一读取 code） ─────────────────────

export class SerialError extends CivError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** 构造/参数非法（端口、波特率、超时、稳定等待）。 */
export class SerialConfigError extends SerialError {
  constructor(message: string) {
    super("serial_config", message);
  }
}

/** 同进程内该端口已被本模块的其它 transport 占用。 */
export class SerialPortInUseError extends SerialError {
  constructor(message: string) {
    super("port_in_use", message);
  }
}

/** 打开串口失败（不存在、被其它进程占用、权限或超时）。 */
export class SerialPortOpenError extends SerialError {
  constructor(message: string) {
    super("port_open", message);
  }
}

/** set/flush/write/drain/close 等串口操作失败。 */
export class SerialOperationError extends SerialError {
  readonly operation: string;
  constructor(operation: string, message: string) {
    super("serial_operation", message);
    this.operation = operation;
  }
}

/** 串口操作超时。 */
export class SerialTimeoutError extends SerialError {
  readonly operation: string;
  constructor(operation: string, message: string) {
    super("serial_timeout", message);
    this.operation = operation;
  }
}

/** 调用方试图写入白名单之外的字节；写操作被拒绝且不会到达串口。 */
export class SerialWriteRejectedError extends SerialError {
  constructor(message: string) {
    super("write_rejected", message);
  }
}

// ── 可注入的窄串口接口 ────────────────────────────────────────────────────

export type SerialPortListener = (...args: any[]) => void;

export interface SerialControlOptions {
  readonly dtr: boolean;
  readonly rts: boolean;
}

export type SerialPortCallback = (error?: Error | null) => void;

/**
 * 生产路径使用的最小串口接口。真实 serialport.SerialPort 满足该形状；
 * 测试可注入 Fake，不需要 native 绑定，也不接触真实设备。
 */
export interface SerialPortLike {
  readonly isOpen: boolean;
  open(callback: SerialPortCallback): void;
  set(options: SerialControlOptions, callback: SerialPortCallback): void;
  flush(callback: SerialPortCallback): void;
  drain(callback: SerialPortCallback): void;
  write(data: Uint8Array, callback: SerialPortCallback): boolean;
  close(callback: SerialPortCallback): void;
  on(event: string, listener: SerialPortListener): unknown;
  off(event: string, listener: SerialPortListener): unknown;
}

/** 串口构造参数；固定 8N1、无流控、autoOpen=false、lock=true。 */
export interface SerialPortOpenSettings {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: 8;
  readonly stopBits: 1;
  readonly parity: "none";
  readonly rtscts: false;
  readonly xon: false;
  readonly xoff: false;
  readonly autoOpen: false;
  readonly lock: boolean;
}

/** 注入点：接收打开参数，返回（或异步返回）串口对象。 */
export type SerialPortFactory = (
  settings: SerialPortOpenSettings,
) => SerialPortLike | Promise<SerialPortLike>;

export interface OpenSerialCivTransportOptions {
  signal?: AbortSignal;
  /** 显式串口路径，例如 Windows `COM17` 或 Linux `/dev/ttyUSB0`。 */
  portPath: string;
  /** 波特率，默认 19200，必须是手册 6 种之一。 */
  baudRate?: number;
  /** 打开超时，默认 5000ms。 */
  openTimeoutMs?: number;
  /** set/flush/write/drain 超时，默认 2000ms。 */
  operationTimeoutMs?: number;
  /** 关闭超时，默认 2000ms。 */
  closeTimeoutMs?: number;
  /** 两次 flush 之间的有界稳定等待，默认 50ms。 */
  settleMs?: number;
  /** 测试注入的 Fake 串口工厂；生产路径省略即动态加载 serialport。 */
  portFactory?: SerialPortFactory;
}

export interface SerialCivTransport extends CivTransport {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  readonly portPath: string;
  readonly baudRate: number;
  /** 仅在确认底层串口已关闭（登记释放、监听摘除）后为 true。 */
  readonly isClosed: boolean;
  /** 关闭/断连/操作失败时记录的错误；从未失败则为 undefined。 */
  readonly closeError: Error | undefined;
}

// ── 参数校验与默认工厂 ────────────────────────────────────────────────────

interface ResolvedOptions {
  readonly signal: AbortSignal | undefined;
  readonly portPath: string;
  readonly baudRate: number;
  readonly openTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly closeTimeoutMs: number;
  readonly settleMs: number;
  readonly portFactory: SerialPortFactory;
  readonly authorization: SerialWriteAuthorization;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertTimeout(name: string, value: number, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_TIMEOUT_MS) {
    throw new SerialConfigError(`${name} must be an integer in [1, ${MAX_TIMEOUT_MS}], got ${resolved}`);
  }
  return resolved;
}

function resolveOptions(
  options: OpenSerialCivTransportOptions,
  authorization: SerialWriteAuthorization,
): ResolvedOptions {
  if (typeof options.portPath !== "string" || options.portPath.trim().length === 0) {
    throw new SerialConfigError("portPath must be a non-empty explicit serial device path");
  }
  const baudRate = options.baudRate ?? SERIAL_DEFAULT_BAUD_RATE;
  if (!SERIAL_ALLOWED_BAUD_RATES.includes(baudRate)) {
    throw new SerialConfigError(
      `baudRate must be one of ${SERIAL_ALLOWED_BAUD_RATES.join(", ")}, got ${baudRate}`,
    );
  }
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > MAX_SETTLE_MS) {
    throw new SerialConfigError(`settleMs must be an integer in [0, ${MAX_SETTLE_MS}], got ${settleMs}`);
  }
  return {
    signal: options.signal,
    portPath: options.portPath,
    baudRate,
    openTimeoutMs: assertTimeout("openTimeoutMs", options.openTimeoutMs as number, DEFAULT_OPEN_TIMEOUT_MS),
    operationTimeoutMs: assertTimeout(
      "operationTimeoutMs",
      options.operationTimeoutMs as number,
      DEFAULT_OPERATION_TIMEOUT_MS,
    ),
    closeTimeoutMs: assertTimeout("closeTimeoutMs", options.closeTimeoutMs as number, DEFAULT_CLOSE_TIMEOUT_MS),
    settleMs,
    portFactory: options.portFactory ?? defaultSerialPortFactory,
    authorization,
  };
}

/** 生产路径：按需动态加载 serialport，避免捆绑/加载原生库失败拖垮 simulate。 */
async function defaultSerialPortFactory(settings: SerialPortOpenSettings): Promise<SerialPortLike> {
  let serialportModule: { SerialPort: new (options: SerialPortOpenSettings) => SerialPortLike };
  try {
    serialportModule = (await import("serialport")) as unknown as typeof serialportModule;
  } catch (error) {
    throw new SerialConfigError(`serialport native binding could not be loaded: ${errorMessage(error)}`);
  }
  const port = new serialportModule.SerialPort(settings);
  // Node streams can emit a deferred write error after the close event.
  // This native-object guard survives application listener cleanup and is GC-able.
  port.on("error", () => undefined);
  // 显式适配：串口只接受白名单内的 Uint8Array 请求。
  return {
    get isOpen() {
      return port.isOpen;
    },
    open: (callback) => port.open(callback),
    set: (options, callback) => port.set(options, callback),
    flush: (callback) => port.flush(callback),
    drain: (callback) => port.drain(callback),
    write: (data, callback) => port.write(data, callback),
    close: (callback) => port.close(callback),
    on: (event, listener) => port.on(event, listener),
    off: (event, listener) => port.off(event, listener),
  };
}

// ── 同进程端口占用登记（只防同进程重复，不冒充 OS 独占） ──────────────────

const registeredPortPaths = new Set<string>();

function portKey(portPath: string): string {
  // Windows 的 COM 端口名不区分大小写；Linux 设备路径区分大小写。
  return process.platform === "win32" ? portPath.toLowerCase() : portPath;
}

function hexBytes(data: Uint8Array | readonly number[]): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/**
 * 有界稳定等待。刻意不 unref：等待本身是打开流程的一部分，unref 会让
 * 没有其它 handle 的进程（例如只跑 Fake 的测试）在定时器触发前退出，
 * 从而跳过必需的清理/超时结算。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── 串口 transport ────────────────────────────────────────────────────────

type SerialPhase = "opening" | "ready" | "closing" | "released";

class SerialTransport implements SerialCivTransport {
  readonly portPath: string;
  readonly baudRate: number;

  private readonly port: SerialPortLike;
  private readonly key: string;
  private readonly openTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly settleMs: number;
  private readonly authorization: SerialWriteAuthorization;

  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly pendingOperations = new Set<(error: Error) => void>();
  private readonly openLandWaiters = new Set<() => void>();

  private phase: SerialPhase = "opening";
  private failure: Error | undefined;
  private closeNotified = false;
  private closePromise: Promise<void> | null = null;
  private closeRequested = false;
  private openInFlight = false;
  private writesInFlight = 0;
  private bufferedData: Uint8Array[] = [];
  private pendingCloseSettle: ((error?: Error | null) => void) | null = null;
  private readonly signal: AbortSignal | undefined;
  private readonly handleAbort = (): void => {
    this.handleError(new SerialError("interrupted", "serial read interrupted"));
  };

  private readonly handleData = (chunk: Uint8Array): void => {
    if (this.phase !== "ready") return;
    const copy = Uint8Array.from(chunk);
    if (this.writesInFlight > 0) {
      // Deliver replies only after native write/drain succeed.
      if (this.bufferedData.reduce((size, data) => size + data.length, 0) + copy.length > 4096) {
        this.handleError(new SerialError("serial_overflow", "serial reply buffer exceeded 4096 bytes"));
      } else this.bufferedData.push(copy);
      return;
    }
    for (const listener of [...this.dataListeners]) {
      try {
        listener(copy);
      } catch {
        // 单个监听器异常不影响其它监听器或清理。
      }
    }
  };

  private readonly handleError = (error: Error): void => {
    if (this.failure === undefined) this.failure = error;
    for (const fail of [...this.pendingOperations]) fail(error);
    this.notifyClose(error);
    // 任何 error（含初始化阶段）都触发有界关闭；关闭失败仍保留登记与监听。
    void this.close().catch(() => undefined);
  };

  private readonly handleClose = (error?: Error | null): void => {
    if (error != null && this.failure === undefined) this.failure = error;
    this.openInFlight = false;
    this.settleOpenWaiters();
    const settle = this.pendingCloseSettle;
    this.pendingCloseSettle = null;
    settle?.(error ?? null);
    this.release();
    this.notifyClose(this.failure);
  };

  constructor(port: SerialPortLike, options: ResolvedOptions) {
    this.port = port;
    this.portPath = options.portPath;
    this.baudRate = options.baudRate;
    this.key = portKey(options.portPath);
    this.openTimeoutMs = options.openTimeoutMs;
    this.operationTimeoutMs = options.operationTimeoutMs;
    this.closeTimeoutMs = options.closeTimeoutMs;
    this.settleMs = options.settleMs;
    this.authorization = options.authorization;
    this.signal = options.signal;
    port.on("data", this.handleData);
    port.on("error", this.handleError);
    port.on("close", this.handleClose);
    this.signal?.addEventListener("abort", this.handleAbort, { once: true });
  }

  /** 只有确认底层关闭（登记释放）后才是 true；关闭失败时保持 false。 */
  get isClosed(): boolean {
    return this.phase === "released";
  }

  get closeError(): Error | undefined {
    return this.failure;
  }

  /** 打开 → 拉低 DTR/RTS → flush → 稳定等待 → 再 flush；全部有界。 */
  async initialize(): Promise<void> {
    if (this.signal?.aborted) throw new SerialError("interrupted", "serial read interrupted");
    await this.openPort();
    await this.call("set", this.operationTimeoutMs, (callback) => {
      this.port.set({ dtr: false, rts: false }, callback);
    });
    await this.call("flush", this.operationTimeoutMs, (callback) => this.port.flush(callback));
    if (this.settleMs > 0) await sleep(this.settleMs);
    await this.call("flush", this.operationTimeoutMs, (callback) => this.port.flush(callback));
    if (this.failure !== undefined || this.phase !== "opening") {
      throw this.failure ?? new SerialError("interrupted", "serial session closed during initialization");
    }
    this.phase = "ready";
  }

  private async openPort(): Promise<void> {
    this.openInFlight = true;
    try {
      await this.call("open", this.openTimeoutMs, (callback) => {
        try {
          this.port.open((error) => {
            this.openInFlight = false;
            this.settleOpenWaiters();
            if (error) {
              callback(error);
              return;
            }
            callback(null);
            // open 超时后才成功：登记与 error 监听仍保留，立即触发关闭，
            // 不把仍在打开的端口当成"已释放"。
            if (this.closeRequested) void this.close().catch(() => undefined);
          });
        } catch (error) {
          this.openInFlight = false;
          this.settleOpenWaiters();
          callback(error as Error);
        }
      });
    } catch (error) {
      if (error instanceof SerialTimeoutError) {
        // 保留登记/监听，由调用方触发的 close() 等到延迟 open 落地后再关闭。
        throw error;
      }
      throw new SerialPortOpenError(
        `failed to open serial port ${this.portPath} at ${this.baudRate} baud: ${errorMessage(error)}; ` +
          "the port may be held by another process or the OS-exclusive lock failed",
      );
    }
  }

  write(data: Uint8Array): Promise<void> {
    if (this.phase !== "ready" || this.failure !== undefined) {
      return Promise.reject(new SerialOperationError("write", "serial transport is not ready"));
    }
    if (!this.authorization.isAllowed(data)) {
      return Promise.reject(new SerialWriteRejectedError(this.authorization.rejectionMessage(data)));
    }
    // 复制后异步写入，调用方随后修改原缓冲区也不会改变实际发出的字节。
    const copy = Uint8Array.from(data);
    return this.writeAndDrain(copy);
  }

  private async writeAndDrain(data: Uint8Array): Promise<void> {
    this.writesInFlight++;
    try {
      await this.call("write", this.operationTimeoutMs, (callback) => {
        this.port.write(data, callback);
      });
      await this.call("drain", this.operationTimeoutMs, (callback) => this.port.drain(callback));
    } finally {
      this.writesInFlight--;
      if (this.writesInFlight === 0) {
        const buffered = this.bufferedData;
        this.bufferedData = [];
        for (const chunk of buffered) this.handleData(chunk);
      }
    }
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.closeNotified) {
      queueMicrotask(() => {
        try {
          listener(this.failure);
        } catch {
          // 已关闭状态下补发通知，忽略监听器异常。
        }
      });
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** 幂等关闭；失败可重试。只有确认关闭后才释放登记并解析。 */
  close(): Promise<void> {
    if (this.phase === "released") return Promise.resolve();
    if (this.closePromise === null) {
      const attempt = this.doClose();
      this.closePromise = attempt;
      attempt.catch(() => {
        if (this.closePromise === attempt) this.closePromise = null;
      });
    }
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closeRequested = true;
    this.phase = "closing";
    // 先停止投递数据，避免关闭过程中再触发解析。
    this.dataListeners.clear();
    this.bufferedData = [];

    // 已确认打开：直接关闭底层端口；失败则抛错且不释放登记/监听。
    if (this.port.isOpen) {
      const error = await this.closeUnderlyingPort();
      if (error !== undefined) throw error;
      return;
    }

    // 端口尚未确认打开，但 open 仍在进行：有界等待其落地后再关闭。
    // 绝不在此释放登记或摘除 error 监听，否则延迟成功的端口会无人接管。
    if (this.openInFlight) {
      const landed = await this.waitForOpenToLand(this.closeTimeoutMs);
      if (this.isClosed) return;
      if (!landed) {
        const error = new SerialTimeoutError(
          "close",
          `serial close could not be confirmed; open still pending after ${this.closeTimeoutMs} ms`,
        );
        if (this.failure === undefined) this.failure = error;
        throw error;
      }
      return this.doClose();
    }

    // 从未打开且没有在途 open：安全释放登记与监听。
    this.release();
  }

  /** 关闭底层端口；返回 undefined 表示已确认关闭，否则返回错误且不释放资源。 */
  private closeUnderlyingPort(): Promise<Error | undefined> {
    return new Promise<Error | undefined>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error | null, timedOut = false): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.pendingCloseSettle = null;
        if (timedOut) {
          const failure = new SerialTimeoutError(
            "close",
            `serial close timed out after ${this.closeTimeoutMs} ms; port close could not be confirmed`,
          );
          if (this.failure === undefined) this.failure = failure;
          this.notifyClose(failure);
          resolve(failure);
          return;
        }
        if (error) {
          const failure = new SerialOperationError(
            "close",
            `serial close failed: ${error.message}; port close could not be confirmed`,
          );
          if (this.failure === undefined) this.failure = failure;
          this.notifyClose(failure);
          resolve(failure);
          return;
        }
        // 确认关闭：此时才释放登记、摘除监听并通知关闭。
        this.release();
        this.notifyClose(this.failure);
        resolve(undefined);
      };
      this.pendingCloseSettle = (error?: Error | null) => finish(error, false);
      // 不 unref：关闭超时必须真正触发结算，而不是被进程提前退出跳过。
      timer = setTimeout(() => finish(null, true), this.closeTimeoutMs);
      try {
        this.port.close((error) => finish(error, false));
      } catch (error) {
        finish(error as Error, false);
      }
    });
  }

  /** 释放登记、结算挂起操作、摘除端口监听；幂等，只在确认关闭后调用。 */
  private release(): void {
    if (this.phase === "released") return;
    this.phase = "released";
    this.signal?.removeEventListener("abort", this.handleAbort);
    this.openInFlight = false;
    this.settleOpenWaiters();
    registeredPortPaths.delete(this.key);
    const pending = [...this.pendingOperations];
    this.pendingOperations.clear();
    for (const fail of pending) {
      try {
        fail(new SerialOperationError("close", "serial transport closed while an operation was pending"));
      } catch {
        // 结算函数自身的异常不影响清理。
      }
    }
    this.detachPortListeners();
  }

  private detachPortListeners(): void {
    try {
      this.port.off("data", this.handleData);
    } catch {
      // 摘除监听失败不阻止其余清理。
    }
    try {
      this.port.off("error", this.handleError);
    } catch {
      // 同上。
    }
    try {
      this.port.off("close", this.handleClose);
    } catch {
      // 同上。
    }
  }

  private notifyClose(error?: Error): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener(error);
      } catch {
        // 单个关闭监听器异常不影响清理。
      }
    }
  }

  private waitForOpenToLand(timeoutMs: number): Promise<boolean> {
    if (!this.openInFlight || this.phase === "released") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        this.openLandWaiters.delete(waiter);
        resolve(true);
      };
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.openLandWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.openLandWaiters.add(waiter);
    });
  }

  private settleOpenWaiters(): void {
    const waiters = [...this.openLandWaiters];
    this.openLandWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  /** 失败/超时统一失效：记录错误、通知 onClose，并启动有界关闭。 */
  private handleOperationFailure(error: Error): void {
    if (this.failure === undefined) this.failure = error;
    this.notifyClose(error);
    void this.close().catch(() => undefined);
  }

  /** 回调式串口操作的统一有界封装：成功、失败、超时都恰好结算一次。 */
  private call(
    operation: string,
    timeoutMs: number,
    start: (callback: SerialPortCallback) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.phase === "released" || this.phase === "closing") {
        reject(new SerialOperationError(operation, "serial transport is closed"));
        return;
      }
      if (this.failure !== undefined) {
        reject(this.failure);
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const failPending = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.pendingOperations.delete(failPending);
        reject(error);
      };
      const settle = (error?: Error | null, timedOut = false): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.pendingOperations.delete(failPending);
        if (timedOut) {
          const failure = new SerialTimeoutError(operation, `serial ${operation} timed out after ${timeoutMs} ms`);
          this.handleOperationFailure(failure);
          reject(failure);
        } else if (error) {
          const failure = new SerialOperationError(operation, `serial ${operation} failed: ${error.message}`);
          this.handleOperationFailure(failure);
          reject(failure);
        } else {
          resolve();
        }
      };
      // 不 unref：超时必须真正触发结算与失效关闭。
      timer = setTimeout(() => settle(null, true), timeoutMs);
      this.pendingOperations.add(failPending);
      try {
        start((error) => settle(error));
      } catch (error) {
        settle(error as Error);
      }
    });
  }
}

// ── 工厂 ──────────────────────────────────────────────────────────────────

async function openResolvedTransport(resolved: ResolvedOptions): Promise<SerialCivTransport> {
  const key = portKey(resolved.portPath);
  if (registeredPortPaths.has(key)) {
    throw new SerialPortInUseError(
      `serial port ${resolved.portPath} is already held by this process; ` +
        "close the existing transport before opening it again",
    );
  }
  // 先登记再 await，避免同一进程内并发打开同一端口绕过检查。
  registeredPortPaths.add(key);

  const settings: SerialPortOpenSettings = {
    path: resolved.portPath,
    baudRate: resolved.baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    xon: false,
    xoff: false,
    autoOpen: false,
    lock: true,
  };

  let port: SerialPortLike;
  try {
    port = await resolved.portFactory(settings);
  } catch (error) {
    registeredPortPaths.delete(key);
    throw error instanceof CivError
      ? error
      : new SerialPortOpenError(`failed to construct serial port ${resolved.portPath}: ${errorMessage(error)}`);
  }

  const transport = new SerialTransport(port, resolved);
  try {
    await transport.initialize();
  } catch (error) {
    // 有界关闭；close 失败也不掩盖原始打开错误，登记/监听会保留到确认关闭。
    try {
      await transport.close();
    } catch (cleanupError) {
      throw new SerialError(error instanceof CivError ? error.code : "port_open",
        `${errorMessage(error)}; cleanup: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
  return transport;
}

/**
 * 打开一个只读 CI-V 串口 transport（白名单仅 03/04）。
 *
 * 打开成功只说明端口已打开且控制线已拉低，不代表链路、电台状态或可发射。
 * 失败会释放登记与监听；不会重试、不枚举端口、不扫描地址/波特率。
 */
export async function openSerialCivTransport(
  options: OpenSerialCivTransportOptions,
): Promise<SerialCivTransport> {
  return openResolvedTransport(resolveOptions(options, READ_ONLY_AUTHORIZATION));
}

/**
 * openCwTrialSerialTransport 的调用参数：在只读串口参数之上强制要求显式的
 * keying-off 确认；该确认只表示调用方声明键控映射已关闭，不证明电台状态。
 */
export interface OpenCwTrialSerialTransportOptions extends OpenSerialCivTransportOptions {
  readonly confirmKeyingOff: boolean;
}

/**
 * 打开一个受控 CW 试验串口 transport。
 *
 * 写白名单独立且固定：八条 94/E0 只读请求，加 Command 17 的 E / TEST / FF
 * 三条固定帧；没有任意载荷、PTT、设置或分块入口。必须显式
 * confirmKeyingOff:true。其余生命周期复用 openSerialCivTransport。
 */
export async function openCwTrialSerialTransport(
  options: OpenCwTrialSerialTransportOptions,
): Promise<SerialCivTransport> {
  const source: unknown = options;
  if (
    typeof source !== "object" ||
    source === null ||
    (source as { readonly confirmKeyingOff?: unknown }).confirmKeyingOff !== true
  ) {
    throw new SerialConfigError(
      "openCwTrialSerialTransport requires confirmKeyingOff=true (USB SEND/CW/RTTY mappings must be OFF)",
    );
  }
  return openResolvedTransport(resolveOptions(options, CW_TRIAL_AUTHORIZATION));
}
