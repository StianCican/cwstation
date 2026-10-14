// P2-009 IC-7300 上下文读取离线编解码（纯函数，不打开串口、不发射）。
//
// 设计依据：docs/design/P2-009-上下文读取离线编解码.md、P2-008 手册调查
// （印刷页 19-3/19-7/19-9）。本模块只提供六种固定读请求的规划、私有精确
// 白名单和严格响应解码；不实现读取会话、仲裁、超时、重试或事务关联。
//
// 边界：
//  - 纯函数，零 I/O：不 import transport/serialport/fs/net，不读系统时间。
//  - 不从 index.ts 导出，也不注册进 serial.ts 的只读写白名单；现有 03/04
//    写门和 CivReadOnlyClient 不受影响。
//  - 固定 radio=0x94、controller=0xe0；请求 FE FE 94 E0 <body> FD。
//    响应只识别 to=E0/from=94。不同地址、回显、广播、FB/FA、不同 command
//    或合法但不同 subcommand 都返回 null；匹配 command 后前缀残缺、长度、
//    枚举或 BCD 非法，以及 CivFrame 结构非法，抛 CivProtocolError。null 不是
//    “默认 RX/false”，也不是当前事务已确认。
//  - 白名单真源是模块私有且冻结的字节表；planContextRead 返回独立副本，
//    调用方改写返回值不会扩大白名单。
//  - 读取结果只是解码值，不证明发射完成、停止、许可或队列状态。

import {
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_EOM,
  CIV_PREAMBLE,
  CivConfigError,
  CivProtocolError,
  decodeFrequencyBcd,
  type CivFrame,
} from "./civ.js";

/** 六种固定上下文读取种类。 */
export type ContextReadKind =
  | "txFrequency"
  | "txStatus"
  | "splitEnabled"
  | "ritEnabled"
  | "xitEnabled"
  | "breakIn";

/** 断连（break-in）模式；来自手册 16 47 的 00/01/02。 */
export type BreakInMode = "OFF" | "SEMI" | "FULL";

/** planContextRead 的结果：新字节副本，且固定不可执行。 */
export interface ContextReadPlan {
  readonly kind: ContextReadKind;
  readonly bytes: Uint8Array;
  readonly dryRun: true;
  readonly executable: false;
}

/** decodeContextReadResponse 的判别联合结果。 */
export type ContextReadReading =
  | { readonly kind: "txFrequency"; readonly frequencyHz: number }
  | { readonly kind: "txStatus"; readonly status: "RX" | "TX" }
  | { readonly kind: "splitEnabled"; readonly enabled: boolean }
  | { readonly kind: "ritEnabled"; readonly enabled: boolean }
  | { readonly kind: "xitEnabled"; readonly enabled: boolean }
  | { readonly kind: "breakIn"; readonly mode: BreakInMode };

interface ContextReadSpec {
  /** 响应 command 字节。 */
  readonly command: number;
  /** 响应子命令字节；无子命令时为 null。 */
  readonly subcommand: number | null;
  /** 命令前缀之后必须携带的数据字节数。 */
  readonly payloadLength: number;
  /** 精确的固定请求字节（私有白名单真源）。 */
  readonly request: readonly number[];
}

function buildRequest(command: number, subcommand: number | null): readonly number[] {
  const bytes: number[] = [
    CIV_PREAMBLE,
    CIV_PREAMBLE,
    CIV_DEFAULT_RADIO_ADDRESS,
    CIV_DEFAULT_CONTROLLER_ADDRESS,
    command,
  ];
  if (subcommand !== null) bytes.push(subcommand);
  bytes.push(CIV_EOM);
  return Object.freeze(bytes);
}

// 私有不可变真源：请求字节、响应 command/subcommand 与期望载荷长度。
const SPEC_BY_KIND: Readonly<Record<ContextReadKind, ContextReadSpec>> = Object.freeze({
  txFrequency: Object.freeze({
    command: 0x1c,
    subcommand: 0x03,
    payloadLength: 5,
    request: buildRequest(0x1c, 0x03),
  }),
  txStatus: Object.freeze({
    command: 0x1c,
    subcommand: 0x00,
    payloadLength: 1,
    request: buildRequest(0x1c, 0x00),
  }),
  splitEnabled: Object.freeze({
    command: 0x0f,
    subcommand: null,
    payloadLength: 1,
    request: buildRequest(0x0f, null),
  }),
  ritEnabled: Object.freeze({
    command: 0x21,
    subcommand: 0x01,
    payloadLength: 1,
    request: buildRequest(0x21, 0x01),
  }),
  xitEnabled: Object.freeze({
    command: 0x21,
    subcommand: 0x02,
    payloadLength: 1,
    request: buildRequest(0x21, 0x02),
  }),
  breakIn: Object.freeze({
    command: 0x16,
    subcommand: 0x47,
    payloadLength: 1,
    request: buildRequest(0x16, 0x47),
  }),
});

// 白名单比较只使用本数组（由私有 SPEC 派生），不依赖任何可被调用方改写的导出。
const ALLOWED_REQUESTS: readonly (readonly number[])[] = Object.freeze(
  Object.values(SPEC_BY_KIND).map((spec) => spec.request),
);

const MAX_CONTEXT_RESPONSE_DATA_BYTES = 32;

function isContextReadKind(value: unknown): value is ContextReadKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SPEC_BY_KIND, value);
}

function contextReadSpec(kind: ContextReadKind): ContextReadSpec {
  if (!isContextReadKind(kind)) {
    throw new CivConfigError(`unknown context read kind: ${String(kind)}`);
  }
  return SPEC_BY_KIND[kind];
}

function matchesRequest(bytes: Uint8Array | readonly number[], expected: readonly number[]): boolean {
  if (bytes.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(bytes, index)) return false;
    if (bytes[index] !== expected[index]) return false;
  }
  return true;
}

function readByte(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new CivProtocolError(`${label} must be an integer byte in 0x00..0xff`);
  }
  return value;
}

function decodeBooleanByte(byte: number, label: string): boolean {
  if (byte === 0x00) return false;
  if (byte === 0x01) return true;
  throw new CivProtocolError(
    `invalid ${label} value 0x${byte.toString(16).padStart(2, "0")}; expected 00 or 01`,
  );
}

function decodeBreakInMode(byte: number): BreakInMode {
  if (byte === 0x00) return "OFF";
  if (byte === 0x01) return "SEMI";
  if (byte === 0x02) return "FULL";
  throw new CivProtocolError(
    `invalid break-in value 0x${byte.toString(16).padStart(2, "0")}; expected 00 (OFF), 01 (SEMI) or 02 (FULL)`,
  );
}

interface NormalizedFrame {
  readonly to: number;
  readonly from: number;
  readonly command: number;
  readonly data: readonly number[];
}

function normalizeFrame(frame: CivFrame): NormalizedFrame {
  const raw: unknown = frame;
  if (typeof raw !== "object" || raw === null) {
    throw new CivProtocolError("CI-V frame must be an object with to/from/command/data");
  }
  const source = raw as {
    readonly to?: unknown;
    readonly from?: unknown;
    readonly command?: unknown;
    readonly data?: unknown;
  };
  const to = readByte(source.to, "frame.to");
  const from = readByte(source.from, "frame.from");
  const command = readByte(source.command, "frame.command");
  const rawData: unknown = source.data;
  if (!Array.isArray(rawData) && !(rawData instanceof Uint8Array)) {
    throw new CivProtocolError("CI-V frame data must be a dense array of byte values");
  }
  const dataBytes = rawData as Uint8Array | readonly number[];
  if (dataBytes.length > MAX_CONTEXT_RESPONSE_DATA_BYTES) {
    throw new CivProtocolError("CI-V context response data exceeds 32 bytes");
  }
  const data: number[] = [];
  for (let index = 0; index < dataBytes.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(dataBytes, index)) {
      throw new CivProtocolError("CI-V frame data must not contain missing byte entries");
    }
    data.push(readByte(dataBytes[index], `frame.data[${index}]`));
  }
  return { to, from, command, data };
}

/**
 * 构造六种固定读请求之一的离线规划。运行时再次校验 kind；
 * 非法 kind（含 JS 调用方传入的非法值）抛 CivConfigError。
 */
export function planContextRead(kind: ContextReadKind): ContextReadPlan {
  const spec = contextReadSpec(kind);
  return {
    kind,
    bytes: Uint8Array.from(spec.request),
    dryRun: true,
    executable: false,
  };
}

/**
 * 判断 bytes 是否精确等于六种固定读请求之一。仅用于离线判断，
 * 不注册进 serial.ts。非数组、非法字节、稀疏数组、长度不符一律返回 false。
 */
export function isAllowedContextReadRequest(bytes: unknown): boolean {
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return false;
  const candidate = bytes as Uint8Array | readonly number[];
  for (const allowed of ALLOWED_REQUESTS) {
    if (matchesRequest(candidate, allowed)) return true;
  }
  return false;
}

/**
 * 严格解码六种固定读请求的响应。
 *
 * 返回 null 表示这不是该 kind 的数据：地址不是 to=E0/from=94、回显/广播、
 * command 或 subcommand 不同、FB/FA。CivProtocolError 表示匹配 command
 * 之后前缀残缺、载荷长度、枚举或 BCD 非法，或 CivFrame 结构非法。
 * 运行时再次校验 kind；非法 kind 抛 CivConfigError。
 */
export function decodeContextReadResponse(
  kind: ContextReadKind,
  frame: CivFrame,
): ContextReadReading | null {
  const spec = contextReadSpec(kind);
  const normalized = normalizeFrame(frame);
  if (
    normalized.to !== CIV_DEFAULT_CONTROLLER_ADDRESS ||
    normalized.from !== CIV_DEFAULT_RADIO_ADDRESS
  ) {
    return null;
  }
  if (normalized.command !== spec.command) return null;

  const data = normalized.data;
  let payload: readonly number[];
  if (spec.subcommand === null) {
    payload = data;
  } else {
    if (data.length === 0) {
      throw new CivProtocolError(
        `context read ${kind} response is missing its 0x${spec.subcommand
          .toString(16)
          .padStart(2, "0")} subcommand`,
      );
    }
    if (data[0] !== spec.subcommand) return null;
    payload = data.slice(1);
  }
  if (payload.length !== spec.payloadLength) {
    throw new CivProtocolError(
      `context read ${kind} response must carry ${spec.payloadLength} payload byte(s), got ${payload.length}`,
    );
  }

  const value = payload[0] as number;
  switch (kind) {
    case "txFrequency":
      return { kind, frequencyHz: decodeFrequencyBcd(payload) };
    case "txStatus":
      return { kind, status: decodeBooleanByte(value, "transmit status") ? "TX" : "RX" };
    case "splitEnabled":
      return { kind, enabled: decodeBooleanByte(value, "split status") };
    case "ritEnabled":
      return { kind, enabled: decodeBooleanByte(value, "RIT status") };
    case "xitEnabled":
      return { kind, enabled: decodeBooleanByte(value, "XIT status") };
    case "breakIn":
      return { kind, mode: decodeBreakInMode(value) };
    default:
      throw new CivConfigError(`unknown context read kind: ${String(kind)}`);
  }
}
