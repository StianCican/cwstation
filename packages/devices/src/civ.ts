// IC-7300 只读 CI-V 协议（离线实现，不打开串口、不发射）。
//
// 设计约束（见 docs/tasks/P1-004.md）：
//  - 窄接口：对外只暴露 readFrequency/readMode；不导出任意 CI-V 命令构造器。
//    真正的请求字节只在模块内部由 buildReadRequest 生成，读请求固定为
//    FE FE <radio> <controller> 03|04 FD。
//  - transport 由调用方注入（write/onData/onClose/close），是可信测试入口，
//    不是权限隔离，也不代表已授权发射。
//  - 流式 parser 处理噪声、拆包、多包、回显和重同步，缓存有固定上限。
//  - CI-V 没有事务 ID：超时、写失败、断连、无效期望回复都会关闭并锁死当前
//    会话，后续查询一律拒绝；不自动重试、不自动重连。
//  - 读取频率/模式是非原子快照，不代表 txBusy、授权或可发射。
//
// 官方依据：IC-7300 手册 19-2/19-3/19-9。频率为 5 字节低位在前的 BCD；
// 模式回复必须带过滤器 01/02/03；FA=NG、FB=OK（不是读取数据）；
// 00/01 是 transceive，不能当作 03/04 的回复。

export const CIV_PREAMBLE = 0xfe;
export const CIV_EOM = 0xfd;

/** IC-7300 默认 CI-V 地址；控制端（本机）默认地址。 */
export const CIV_DEFAULT_RADIO_ADDRESS = 0x94;
export const CIV_DEFAULT_CONTROLLER_ADDRESS = 0xe0;

/** Five-byte BCD capacity; device band limits are a separate concern. */
export const CIV_MAX_ENCODED_FREQUENCY_HZ = 9_999_999_999;

export const CIV_COMMAND_READ_FREQUENCY = 0x03;
export const CIV_COMMAND_READ_MODE = 0x04;
/** FA：NG（命令被拒绝）。 */
export const CIV_COMMAND_NG = 0xfa;
/** FB：OK，仅用于写类命令，绝不是读取数据。 */
export const CIV_COMMAND_OK = 0xfb;

export type CivMode = "LSB" | "USB" | "AM" | "CW" | "RTTY" | "FM" | "CW-R" | "RTTY-R";
export type CivFilter = 1 | 2 | 3;

const MODE_BY_CODE: ReadonlyMap<number, CivMode> = new Map<number, CivMode>([
  [0x00, "LSB"],
  [0x01, "USB"],
  [0x02, "AM"],
  [0x03, "CW"],
  [0x04, "RTTY"],
  [0x05, "FM"],
  [0x07, "CW-R"],
  [0x08, "RTTY-R"],
]);

const CODE_BY_MODE: Readonly<Record<CivMode, number>> = {
  LSB: 0x00,
  USB: 0x01,
  AM: 0x02,
  CW: 0x03,
  RTTY: 0x04,
  FM: 0x05,
  "CW-R": 0x07,
  "RTTY-R": 0x08,
};

const VALID_FILTERS: ReadonlySet<number> = new Set([1, 2, 3]);

// ── 错误类型 ────────────────────────────────────────────────────────────

export class CivError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 构造参数非法（地址、超时、帧缓存上限等）。 */
export class CivConfigError extends CivError {
  constructor(message: string) {
    super("config", message);
  }
}

/** 同一时刻只允许一个查询。 */
export class CivBusyError extends CivError {
  constructor(message = "a CI-V read is already in progress; only one query at a time is allowed") {
    super("busy", message);
  }
}

/** 会话已锁死或已关闭，后续查询被拒绝；需显式新建会话。 */
export class CivSessionError extends CivError {
  constructor(message: string) {
    super("session_locked", message);
  }
}

export class CivTimeoutError extends CivError {
  constructor(message: string) {
    super("timeout", message);
  }
}

/** 期望回复畸形、NG（FA）、意外 OK（FB）或其他协议错误。 */
export class CivProtocolError extends CivError {
  constructor(message: string) {
    super("protocol", message);
  }
}

export class CivTransportError extends CivError {
  constructor(message: string) {
    super("transport", message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 帧与编解码 ──────────────────────────────────────────────────────────

export interface CivFrame {
  readonly to: number;
  readonly from: number;
  readonly command: number;
  readonly data: readonly number[];
}

/**
 * 把字节值编码为频率回复所需的 5 字节 BCD（低位在前）。
 * 这是数据编解码，不是命令构造器；只有 simulator 和测试使用。
 */
export function encodeFrequencyBcd(frequencyHz: number): number[] {
  if (!Number.isInteger(frequencyHz) || frequencyHz < 0 || frequencyHz > CIV_MAX_ENCODED_FREQUENCY_HZ) {
    throw new CivConfigError(
      `frequency ${frequencyHz} is outside the five-byte BCD range 0..${CIV_MAX_ENCODED_FREQUENCY_HZ} Hz`,
    );
  }
  const bytes: number[] = [];
  let remaining = frequencyHz;
  for (let index = 0; index < 5; index += 1) {
    const pair = remaining % 100;
    bytes.push(((Math.floor(pair / 10) << 4) | (pair % 10)) & 0xff);
    remaining = Math.floor(remaining / 100);
  }
  return bytes;
}

/**
 * 解析 5 字节低位在前的 BCD 频率，拒绝错误长度、非法 BCD 数字和
 * 超出五字节 BCD 编码范围的值；设备工作范围另行判断。
 */
export function decodeFrequencyBcd(data: readonly number[]): number {
  if (data.length !== 5) {
    throw new CivProtocolError(`frequency response must carry exactly 5 data bytes, got ${data.length}`);
  }
  let value = 0;
  let scale = 1;
  for (const byte of data) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new CivProtocolError("frequency data must contain byte values");
    }
    const high = (byte >> 4) & 0x0f;
    const low = byte & 0x0f;
    if (high > 9 || low > 9) {
      throw new CivProtocolError(`invalid BCD digit in frequency byte 0x${byte.toString(16).padStart(2, "0")}`);
    }
    value += (high * 10 + low) * scale;
    scale *= 100;
  }
  if (value > CIV_MAX_ENCODED_FREQUENCY_HZ) {
    throw new CivProtocolError(
      `frequency ${value} Hz exceeds the five-byte BCD range`,
    );
  }
  return value;
}

export function civModeFromCode(code: number): CivMode {
  const mode = MODE_BY_CODE.get(code);
  if (mode === undefined) {
    throw new CivProtocolError(`unknown IC-7300 mode code 0x${code.toString(16).padStart(2, "0")}`);
  }
  return mode;
}

export function civModeToCode(mode: CivMode): number {
  return CODE_BY_MODE[mode];
}

export interface CivModeReading {
  readonly mode: CivMode;
  readonly filter: CivFilter;
}

/** 解析模式回复：1 字节模式 + 1 字节过滤器（必须是 01/02/03）。 */
export function decodeModeReading(data: readonly number[]): CivModeReading {
  if (data.length !== 2) {
    throw new CivProtocolError(`mode response must carry exactly 2 data bytes, got ${data.length}`);
  }
  const mode = civModeFromCode(data[0] as number);
  const filter = data[1] as number;
  if (!VALID_FILTERS.has(filter)) {
    throw new CivProtocolError(`invalid CI-V filter code 0x${filter.toString(16).padStart(2, "0")}; expected 01, 02 or 03`);
  }
  return { mode, filter: filter as CivFilter };
}

// ── 流式帧 parser ───────────────────────────────────────────────────────

export interface CivFrameParserOptions {
  /** 单个帧（含前导与结束符）的最大字节数；超出即丢弃并重同步。 */
  maxFrameBytes?: number;
}

/**
 * 有界流式 parser：
 *  - 只在连续 FE FE 之后开始组帧，前面的噪声被丢弃；
 *  - 跨 chunk 组帧，一个 chunk 可含多帧；
 *  - 帧内再出现 FE 视为新的前导并重启（回显/重同步）；
 *  - 帧长超过 maxFrameBytes 即丢弃，缓存不会随大 chunk 持续增长。
 */
export class CivFrameParser {
  readonly maxFrameBytes: number;
  private buffer: number[] = [];

  constructor(options: CivFrameParserOptions = {}) {
    const max = options.maxFrameBytes ?? 32;
    if (!Number.isInteger(max) || max < 8 || max > 1024) {
      throw new CivConfigError(`maxFrameBytes must be an integer in [8, 1024], got ${max}`);
    }
    this.maxFrameBytes = max;
  }

  /** 当前缓存的未完成帧字节数（用于验证缓存有界）。 */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = [];
  }

  push(chunk: Uint8Array | readonly number[]): CivFrame[] {
    const frames: CivFrame[] = [];
    for (const byte of chunk) {
      const value = byte & 0xff;
      if (this.buffer.length === 0) {
        if (value === CIV_PREAMBLE) this.buffer.push(value);
        continue;
      }
      if (this.buffer.length === 1) {
        if (value === CIV_PREAMBLE) this.buffer.push(value);
        else this.buffer = [];
        continue;
      }
      // 已处于 FE FE 之后。
      if (value === CIV_PREAMBLE) {
        this.buffer = this.buffer.length === 2 ? [CIV_PREAMBLE, CIV_PREAMBLE] : [CIV_PREAMBLE];
        continue;
      }
      this.buffer.push(value);
      if (this.buffer.length > this.maxFrameBytes) {
        this.buffer = [];
      } else if (value === CIV_EOM) {
        const frame = parseCompleteFrame(this.buffer);
        if (frame !== undefined) frames.push(frame);
        this.buffer = [];
      }
    }
    return frames;
  }
}

/** 解析以 FE FE 开头、以 FD 结尾的完整帧；结构不足时返回 undefined。 */
function parseCompleteFrame(buffer: readonly number[]): CivFrame | undefined {
  const body = buffer.slice(2, -1);
  if (body.length < 3) return undefined;
  return {
    to: body[0] as number,
    from: body[1] as number,
    command: body[2] as number,
    data: body.slice(3),
  };
}

/**
 * 读请求的固定字节。刻意不导出：包外无法据此拼装任意 CI-V 命令。
 */
function buildReadRequest(command: number, radio: number, controller: number): Uint8Array {
  return Uint8Array.from([CIV_PREAMBLE, CIV_PREAMBLE, radio, controller, command, CIV_EOM]);
}

// ── 只读会话 ────────────────────────────────────────────────────────────

/**
 * 注入式窄 transport。onData/onClose 返回取消订阅函数，便于会话关闭时
 * 精确清理 timer 与 listener。write 可同步抛出或返回 rejected Promise。
 */
export interface CivTransport {
  write(data: Uint8Array): void | Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): void | Promise<void>;
}

export interface CivReadOnlyClientOptions {
  transport: CivTransport;
  /** 电台地址，默认 0x94；必须是 0x01..0xdf 的显式地址。 */
  radioAddress?: number;
  /** 本机控制地址，默认 0xe0；必须是 0xe0..0xef。 */
  controllerAddress?: number;
  /** 单次查询超时，默认 1000ms。 */
  timeoutMs?: number;
  /** parser 单帧上限，默认 32。 */
  maxFrameBytes?: number;
}

export type CivClientState = "idle" | "busy" | "locked" | "closed";

interface PendingQuery {
  readonly command: number;
  readonly decode: (data: readonly number[]) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function assertRadioAddress(address: number): void {
  // 0x00 是广播地址；0xe0..0xff 是控制端地址，都不能当电台地址。
  if (!Number.isInteger(address) || address < 0x01 || address > 0xdf) {
    throw new CivConfigError(
      `radio address must be an explicit non-broadcast address in 0x01..0xdf, got 0x${address.toString(16)}`,
    );
  }
}

function assertControllerAddress(address: number): void {
  if (!Number.isInteger(address) || address < 0xe0 || address > 0xef) {
    throw new CivConfigError(
      `controller address must be in 0xe0..0xef, got 0x${address.toString(16)}`,
    );
  }
}

/**
 * IC-7300 只读 CI-V 会话。
 *
 * 只提供 readFrequency/readMode。传输层是注入的可信测试入口，不是权限隔离；
 * 读取结果只是非原子快照，不代表 txBusy、授权或可发射。
 */
export class CivReadOnlyClient {
  private readonly transport: CivTransport;
  private readonly radioAddress: number;
  private readonly controllerAddress: number;
  private readonly timeoutMs: number;
  private readonly parser: CivFrameParser;
  private pending: PendingQuery | null = null;
  private phase: CivClientState = "idle";
  private dataUnsubscribe: (() => void) | null = null;
  private closeUnsubscribe: (() => void) | null = null;
  private detached = false;

  constructor(options: CivReadOnlyClientOptions) {
    this.transport = options.transport;
    this.radioAddress = options.radioAddress ?? CIV_DEFAULT_RADIO_ADDRESS;
    this.controllerAddress = options.controllerAddress ?? CIV_DEFAULT_CONTROLLER_ADDRESS;
    assertRadioAddress(this.radioAddress);
    assertControllerAddress(this.controllerAddress);
    if (this.radioAddress === this.controllerAddress) {
      throw new CivConfigError("radio and controller addresses must differ");
    }
    const timeout = options.timeoutMs ?? 1000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new CivConfigError(`timeoutMs must be an integer in [1, 60000], got ${timeout}`);
    }
    this.timeoutMs = timeout;
    this.parser = new CivFrameParser(
      options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {},
    );
    this.dataUnsubscribe = this.transport.onData((chunk) => this.handleData(chunk));
    this.closeUnsubscribe = this.transport.onClose((error) => this.handleClose(error));
  }

  get state(): CivClientState {
    return this.phase;
  }

  /** 读取当前频率（Hz）。非原子快照，不证明可发射或已授权。 */
  readFrequency(): Promise<number> {
    return this.query(CIV_COMMAND_READ_FREQUENCY, decodeFrequencyBcd);
  }

  /** 读取当前模式与过滤器。非原子快照，不证明可发射或已授权。 */
  readMode(): Promise<CivModeReading> {
    return this.query(CIV_COMMAND_READ_MODE, decodeModeReading);
  }

  /**
   * 关闭会话并中止在途查询。幂等；关闭后会话不可复用。
   * 清理 timer 与 transport listener，再关闭 transport。
   */
  async close(): Promise<void> {
    if (this.phase === "closed") return;
    const pending = this.pending;
    this.pending = null;
    this.phase = "closed";
    this.detach();
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(new CivSessionError("CI-V session closed before the read completed"));
    }
    try {
      await this.transport.close();
    } catch {
      // 清理路径上的关闭失败不掩盖原始结果。
    }
  }

  private query<T>(command: number, decode: (data: readonly number[]) => T): Promise<T> {
    if (this.phase === "closed") {
      return Promise.reject(new CivSessionError("CI-V session is closed; create a new session"));
    }
    if (this.phase === "locked") {
      return Promise.reject(new CivSessionError("CI-V session is locked after a failed read; create a new session"));
    }
    if (this.phase === "busy") {
      return Promise.reject(new CivBusyError());
    }

    this.phase = "busy";
    this.parser.reset();
    const request = buildReadRequest(command, this.radioAddress, this.controllerAddress);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failSession(
          new CivTimeoutError(`CI-V read 0x${command.toString(16).padStart(2, "0")} timed out after ${this.timeoutMs} ms`),
        );
      }, this.timeoutMs);
      this.pending = {
        command,
        decode,
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      };

      let result: void | Promise<void>;
      try {
        result = this.transport.write(request);
      } catch (error) {
        this.failSession(new CivTransportError(`CI-V write failed: ${errorMessage(error)}`));
        return;
      }
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error: unknown) => {
          this.failSession(new CivTransportError(`CI-V write failed: ${errorMessage(error)}`));
        });
      }
    });
  }

  /** 会话是否已终止（锁定或关闭）；用方法避免控制流分析把可变状态窄化。 */
  private isTerminated(): boolean {
    return this.phase === "locked" || this.phase === "closed";
  }

  private handleData(chunk: Uint8Array): void {
    if (this.isTerminated()) return;
    let frames: CivFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.failSession(new CivProtocolError(`CI-V frame parsing failed: ${errorMessage(error)}`));
      return;
    }
    for (const frame of frames) {
      if (this.isTerminated()) return;
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: CivFrame): void {
    const pending = this.pending;
    if (pending === null) return; // 无在途查询：未请求的数据一律忽略。
    // 只接受目标=控制端、来源=电台的帧；回显（反向）与其他地址被忽略。
    if (frame.to !== this.controllerAddress || frame.from !== this.radioAddress) return;
    if (frame.command === CIV_COMMAND_NG) {
      this.failSession(new CivProtocolError("radio replied NG (0xfa) to a read request"));
      return;
    }
    if (frame.command === CIV_COMMAND_OK) {
      this.failSession(new CivProtocolError("unexpected OK (0xfb); OK is not a read response"));
      return;
    }
    if (frame.command !== pending.command) return; // transceive 或其他命令：忽略。
    let decoded: unknown;
    try {
      decoded = pending.decode(frame.data);
    } catch (error) {
      this.failSession(error instanceof Error ? error : new CivProtocolError(String(error)));
      return;
    }
    this.completeSession(decoded);
  }

  private completeSession(value: unknown): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    clearTimeout(pending.timer);
    this.phase = "idle";
    pending.resolve(value);
  }

  private handleClose(error?: Error): void {
    if (this.phase === "closed") return;
    const detail = error !== undefined ? errorMessage(error) : "transport closed";
    this.failSession(new CivTransportError(`CI-V transport closed: ${detail}`));
  }

  /**
   * 锁死会话：拒绝在途查询、清理 timer/listener 并关闭 transport。
   * 之后所有查询都返回 CivSessionError，不重试也不重连。
   */
  private failSession(error: Error): void {
    if (this.phase === "closed" || this.phase === "locked") return;
    const pending = this.pending;
    this.pending = null;
    this.phase = "locked";
    this.detach();
    try {
      void Promise.resolve(this.transport.close()).catch(() => undefined);
    } catch {
      // 同步关闭失败同样被忽略。
    }
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
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
