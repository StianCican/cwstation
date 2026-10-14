// P2-002a：受控设备服务的版本化、有界、对象式 NDJSON 协议。
//
// 本模块只做纯函数式校验、签名和类型定义，不做任何 I/O，也绝不导入
// serialport 或真实串口工厂。它是 Fake 服务与测试/后续 RemoteKeyer 通道层
// 共用的唯一解析入口，保证“线上只有对象式 NDJSON、未知字段拒绝、无 raw 方法”。
//
// 设计基线：docs/design/P2-002-设备持有者与受控写入.md（v3）第 122-136 行。

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { StationMode } from "../../contracts/src/index.js";

/** 线上协议版本；与设计文档版本 v3 分开记录。 */
export const RIG_CONTROL_PROTOCOL_VERSION = 1 as const;

/** 单行 NDJSON 的字节上限（不含换行）。 */
export const RIG_CONTROL_MAX_FRAME_BYTES = 16 * 1024;
/** 单连接同时待处理请求上限；控制方法（stop/close）另保留控制槽。 */
export const RIG_CONTROL_MAX_PENDING_REQUESTS = 32;
/** 服务端允许的最大授权剩余期限：60 秒。 */
export const RIG_CONTROL_MAX_EXPIRES_MS = 60_000;
/** IC-7300 Command 17 的 30 字节上限，与 civ-tx-plan 一致。 */
export const RIG_CONTROL_MAX_MESSAGE_BYTES = 30;
/** 能力声明中的字符集版本。 */
export const RIG_CONTROL_CHARSET_VERSION = "ic7300-command17-v1";
/** 明确的能力来源标记：Fake 后端与模拟证据。 */
export const RIG_CONTROL_BACKEND_KIND = "fake";
export const RIG_CONTROL_EVIDENCE_SOURCE = "simulation";

export const RIG_CONTROL_SESSION_KEY_HEX_LENGTH = 64; // 32 bytes
export const RIG_CONTROL_NONCE_HEX_LENGTH = 32; // 16 bytes
export const RIG_CONTROL_SHA256_HEX_LENGTH = 64;
export const RIG_CONTROL_MAX_ID_LENGTH = 128;
export const RIG_CONTROL_MAX_DEVICE_ID_LENGTH = 64;

/** 允许的方法全集；没有 raw.write、没有任意命令号或十六进制参数入口。 */
export const RIG_CONTROL_METHODS = [
  "hello",
  "device.capabilities",
  "device.snapshot",
  "cw.send",
  "cw.stop",
  "operation.get",
  "device.close",
] as const;

export type RigControlMethod = (typeof RIG_CONTROL_METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set<string>(RIG_CONTROL_METHODS);

export function isRigControlMethod(value: string): value is RigControlMethod {
  return METHOD_SET.has(value);
}

/** stop/close 属于控制槽：普通队列满时仍必须可处理。 */
export function isRigControlControlMethod(value: string): boolean {
  return value === "cw.stop" || value === "device.close";
}

export type RigControlErrorCode =
  | "invalid_request"
  | "invalid_params"
  | "protocol_version"
  | "unknown_method"
  | "unauthorized"
  | "conflict"
  | "not_found"
  | "busy"
  | "blocked"
  | "expired"
  | "unavailable"
  | "internal";

export class RigControlError extends Error {
  constructor(
    readonly code: RigControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RigControlError";
  }
}

// ── 请求 / 响应信封 ───────────────────────────────────────────────────────

export interface RigControlRequest {
  readonly protocolVersion: typeof RIG_CONTROL_PROTOCOL_VERSION;
  readonly id: string;
  readonly method: RigControlMethod;
  readonly params: Record<string, unknown>;
}

export interface RigControlErrorPayload {
  readonly code: RigControlErrorCode;
  readonly message: string;
}

export interface RigControlResponse {
  readonly protocolVersion: typeof RIG_CONTROL_PROTOCOL_VERSION;
  readonly id: string | null;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: RigControlErrorPayload;
}

// ── 方法参数（精确字段，未知字段拒绝） ─────────────────────────────────────

export interface HelloParams {
  readonly sessionKey: string;
  readonly deviceInstanceId: string;
}

export interface CwSendParams {
  readonly operationId: string;
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
  readonly text: string;
  readonly contentSha256: string;
  readonly frequencyHz: number;
  readonly mode: StationMode;
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly token: string;
}

export interface CwStopParams {
  readonly stopId: string;
  readonly operationId: string;
}

export interface OperationGetParams {
  readonly operationId: string;
}

// ── 方法结果 ──────────────────────────────────────────────────────────────

export interface HelloResult {
  readonly protocolVersion: typeof RIG_CONTROL_PROTOCOL_VERSION;
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
}

export interface DeviceCapabilities {
  readonly protocolVersion: typeof RIG_CONTROL_PROTOCOL_VERSION;
  readonly backendKind: typeof RIG_CONTROL_BACKEND_KIND;
  readonly evidenceSource: typeof RIG_CONTROL_EVIDENCE_SOURCE;
  readonly model: string;
  readonly civAddress: number;
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
  readonly maxMessageBytes: number;
  readonly charsetVersion: string;
  readonly reliableCompletionEvidence: boolean;
  readonly reliableStopEvidence: boolean;
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
  readonly blocked: boolean;
  readonly blockedReason: string | null;
  readonly methods: readonly RigControlMethod[];
}

export interface DeviceSnapshot {
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
  readonly frequencyHz: number;
  readonly mode: StationMode;
  readonly snapshotTime: number;
  readonly simulation: true;
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
}

export type OperationState = "running" | "completed" | "cancelled" | "unknown";

/**
 * 单个业务操作的统一视图。查询与 send 复用同一形状，避免两套语义。
 * running 时 outcome/evidence 表示“已登记但未终结”，不构成完成或停止证明。
 */
export interface OperationResult {
  readonly operationId: string;
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
  readonly state: OperationState;
  readonly outcome: OperationState | null;
  readonly evidence: string;
  readonly text: string;
  readonly contentSha256: string;
  readonly frequencyHz: number;
  readonly mode: StationMode;
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
  readonly frameHex: string | null;
  readonly frameBytes: number | null;
  readonly at: number;
}

export interface StopResult {
  readonly stopId: string;
  readonly operationId: string;
  readonly outcome: "cancelled" | "unknown";
  readonly evidence: string;
  readonly at: number;
  readonly permissionGeneration: number;
}

export interface DeviceCloseResult {
  readonly closed: true;
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
  readonly blockedReason: string | null;
}

// ── 基础校验工具 ──────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
  code: RigControlErrorCode,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new RigControlError(code, `${context} has unsupported field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!(key in obj)) {
      throw new RigControlError(code, `${context} is missing field: ${key}`);
    }
  }
}

function assertString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new RigControlError("invalid_params", `${name} must be a string of ${min}..${max} characters`);
  }
  return value;
}

function assertInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RigControlError("invalid_params", `${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function assertHex(value: unknown, name: string, hexLength: number): string {
  if (typeof value !== "string" || value.length !== hexLength || !/^[0-9a-f]+$/.test(value)) {
    throw new RigControlError("invalid_params", `${name} must be ${hexLength} lowercase hex characters`);
  }
  return value;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function assertSafeId(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !SAFE_ID_PATTERN.test(value)) {
    throw new RigControlError(
      "invalid_params",
      `${name} must be 1..${max} characters from A-Z a-z 0-9 . _ : -`,
    );
  }
  return value;
}

/** 尽力从任意输入中取出合法 id，供错误响应回传关联；非法则返回 null。 */
export function extractRequestId(parsed: unknown): string | null {
  if (!isPlainObject(parsed)) return null;
  const id = parsed.id;
  if (typeof id === "string" && id.length > 0 && id.length <= RIG_CONTROL_MAX_ID_LENGTH) return id;
  return null;
}

export function validateRequest(parsed: unknown): RigControlRequest {
  if (!isPlainObject(parsed)) {
    throw new RigControlError("invalid_request", "request must be a JSON object");
  }
  assertExactKeys(
    parsed,
    ["protocolVersion", "id", "method", "params"],
    "request",
    "invalid_request",
  );
  if (parsed.protocolVersion !== RIG_CONTROL_PROTOCOL_VERSION) {
    throw new RigControlError("protocol_version", "unsupported protocolVersion");
  }
  const id = assertString(parsed.id, "id", 1, RIG_CONTROL_MAX_ID_LENGTH);
  const method = assertString(parsed.method, "method", 1, 64);
  if (!isRigControlMethod(method)) {
    throw new RigControlError("unknown_method", `unknown method: ${method}`);
  }
  if (!isPlainObject(parsed.params)) {
    throw new RigControlError("invalid_request", "params must be a JSON object");
  }
  return { protocolVersion: RIG_CONTROL_PROTOCOL_VERSION, id, method, params: parsed.params };
}

// ── 各方法参数校验 ────────────────────────────────────────────────────────

export function validateHelloParams(params: Record<string, unknown>): HelloParams {
  assertExactKeys(params, ["sessionKey", "deviceInstanceId"], "hello params", "invalid_params");
  return {
    sessionKey: assertHex(params.sessionKey, "sessionKey", RIG_CONTROL_SESSION_KEY_HEX_LENGTH),
    deviceInstanceId: assertSafeId(
      params.deviceInstanceId,
      "deviceInstanceId",
      RIG_CONTROL_MAX_DEVICE_ID_LENGTH,
    ),
  };
}

export function validateCwSendParams(params: Record<string, unknown>): CwSendParams {
  const allowed = [
    "operationId",
    "deviceInstanceId",
    "serviceInstanceId",
    "text",
    "contentSha256",
    "frequencyHz",
    "mode",
    "connectionGeneration",
    "permissionGeneration",
    "stateGeneration",
    "expiresAt",
    "nonce",
    "token",
  ] as const;
  assertExactKeys(params, allowed, "cw.send params", "invalid_params");
  if (params.mode !== "CW") {
    throw new RigControlError("invalid_params", "mode must be CW");
  }
  return {
    operationId: assertSafeId(params.operationId, "operationId", RIG_CONTROL_MAX_ID_LENGTH),
    deviceInstanceId: assertSafeId(
      params.deviceInstanceId,
      "deviceInstanceId",
      RIG_CONTROL_MAX_DEVICE_ID_LENGTH,
    ),
    serviceInstanceId: assertSafeId(
      params.serviceInstanceId,
      "serviceInstanceId",
      RIG_CONTROL_MAX_DEVICE_ID_LENGTH,
    ),
    text: assertString(params.text, "text", 1, RIG_CONTROL_MAX_FRAME_BYTES),
    contentSha256: assertHex(params.contentSha256, "contentSha256", RIG_CONTROL_SHA256_HEX_LENGTH),
    frequencyHz: assertInteger(params.frequencyHz, "frequencyHz", 1, 100_000_000),
    mode: "CW",
    connectionGeneration: assertInteger(
      params.connectionGeneration,
      "connectionGeneration",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    permissionGeneration: assertInteger(
      params.permissionGeneration,
      "permissionGeneration",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    stateGeneration: assertInteger(params.stateGeneration, "stateGeneration", 0, Number.MAX_SAFE_INTEGER),
    expiresAt: assertInteger(params.expiresAt, "expiresAt", 0, Number.MAX_SAFE_INTEGER),
    nonce: assertHex(params.nonce, "nonce", RIG_CONTROL_NONCE_HEX_LENGTH),
    token: assertHex(params.token, "token", RIG_CONTROL_SHA256_HEX_LENGTH),
  };
}

export function validateCwStopParams(params: Record<string, unknown>): CwStopParams {
  assertExactKeys(params, ["stopId", "operationId"], "cw.stop params", "invalid_params");
  return {
    stopId: assertSafeId(params.stopId, "stopId", RIG_CONTROL_MAX_ID_LENGTH),
    operationId: assertSafeId(params.operationId, "operationId", RIG_CONTROL_MAX_ID_LENGTH),
  };
}

export function validateOperationGetParams(params: Record<string, unknown>): OperationGetParams {
  assertExactKeys(params, ["operationId"], "operation.get params", "invalid_params");
  return { operationId: assertSafeId(params.operationId, "operationId", RIG_CONTROL_MAX_ID_LENGTH) };
}

export function validateEmptyParams(params: Record<string, unknown>, method: string): void {
  assertExactKeys(params, [], `${method} params`, "invalid_params");
}

// ── 签名与摘要 ────────────────────────────────────────────────────────────

/**
 * v3 固定的 HMAC 输入序列。这是唯一被签名的字段序列，线上仍是对象式 JSON。
 */
export function cwSendSigningInput(p: CwSendParams): string {
  return JSON.stringify([
    RIG_CONTROL_PROTOCOL_VERSION,
    "cw.send",
    p.operationId,
    p.deviceInstanceId,
    p.serviceInstanceId,
    p.contentSha256,
    p.frequencyHz,
    p.mode,
    p.connectionGeneration,
    p.permissionGeneration,
    p.stateGeneration,
    p.expiresAt,
    p.nonce,
  ]);
}

export function computeCwSendToken(sessionKeyHex: string, p: CwSendParams): string {
  return createHmac("sha256", Buffer.from(sessionKeyHex, "hex"))
    .update(cwSendSigningInput(p), "utf8")
    .digest("hex");
}

export function verifyCwSendToken(sessionKeyHex: string, p: CwSendParams, token: string): boolean {
  const expected = computeCwSendToken(sessionKeyHex, p);
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(token, "hex");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

/**
 * 业务去重摘要：绑定 operationId 之外的全部内容与上下文，但不含 nonce/token。
 * 同键同摘要视为重放（零副作用）；同键不同摘要拒绝冲突。
 */
export function cwSendRequestDigest(p: CwSendParams): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        p.operationId,
        p.deviceInstanceId,
        p.text,
        p.contentSha256,
        p.frequencyHz,
        p.mode,
        p.connectionGeneration,
        p.permissionGeneration,
        p.stateGeneration,
        p.expiresAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

/** 协议帧编码：单行 JSON + 换行。 */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Validate the response envelope and the selected method's result at runtime. */
export function validateResponse(raw: unknown, method: RigControlMethod): RigControlResponse {
  if (!isPlainObject(raw) || raw.protocolVersion !== 1 || typeof raw.id !== "string" || typeof raw.ok !== "boolean") {
    throw new RigControlError("invalid_request", "invalid response envelope");
  }
  assertExactKeys(raw, raw.ok ? ["protocolVersion", "id", "ok", "result"] : ["protocolVersion", "id", "ok", "error"], "response", "invalid_request");
  if (!raw.ok) {
    if (!isPlainObject(raw.error)) throw new RigControlError("invalid_request", "invalid error response");
    assertExactKeys(raw.error, ["code", "message"], "error", "invalid_request");
    assertString(raw.error.code, "code", 1, 64);
    assertString(raw.error.message, "message", 1, 1024);
    return raw as unknown as RigControlResponse;
  }
  const r = raw.result;
  if (!isPlainObject(r)) throw new RigControlError("invalid_request", "result must be an object");
  const generations = ["connectionGeneration", "permissionGeneration", "stateGeneration"];
  const identities = ["deviceInstanceId", "serviceInstanceId"];
  const schemas: Record<RigControlMethod, readonly string[]> = {
    hello: ["protocolVersion", ...identities],
    "device.capabilities": ["protocolVersion", "backendKind", "evidenceSource", "model", "civAddress", ...identities, "maxMessageBytes", "charsetVersion", "reliableCompletionEvidence", "reliableStopEvidence", ...generations, "blocked", "blockedReason", "methods"],
    "device.snapshot": [...identities, "frequencyHz", "mode", "snapshotTime", "simulation", ...generations],
    "cw.send": ["operationId", ...identities, "state", "outcome", "evidence", "text", "contentSha256", "frequencyHz", "mode", ...generations, "frameHex", "frameBytes", "at"],
    "operation.get": ["operationId", ...identities, "state", "outcome", "evidence", "text", "contentSha256", "frequencyHz", "mode", ...generations, "frameHex", "frameBytes", "at"],
    "cw.stop": ["stopId", "operationId", "outcome", "evidence", "at", "permissionGeneration"],
    "device.close": ["closed", ...generations, "blockedReason"],
  };
  assertExactKeys(r, schemas[method], "result", "invalid_request");
  const integerFields = [...generations, "frequencyHz", "snapshotTime", "at", "civAddress", "maxMessageBytes", "protocolVersion"];
  const booleanFields = ["reliableCompletionEvidence", "reliableStopEvidence", "blocked", "simulation", "closed"];
  for (const [key, value] of Object.entries(r)) {
    if (integerFields.includes(key)) assertInteger(value, key, 0, Number.MAX_SAFE_INTEGER);
    else if (booleanFields.includes(key)) {
      if (typeof value !== "boolean") throw new RigControlError("invalid_request", `invalid ${key}`);
    } else if (key === "methods") {
      if (!Array.isArray(value) || value.length > RIG_CONTROL_METHODS.length || value.some(m => typeof m !== "string" || !isRigControlMethod(m))) throw new RigControlError("invalid_request", "invalid methods");
    } else if (["blockedReason", "outcome", "frameHex", "frameBytes"].includes(key) && value === null) continue;
    else if (key === "frameBytes") assertInteger(value, key, 1, 36);
    else assertString(value, key, 1, 1024);
  }
  if (("protocolVersion" in r && r.protocolVersion !== 1) || ("mode" in r && r.mode !== "CW") ||
      ("backendKind" in r && r.backendKind !== "fake") || ("evidenceSource" in r && r.evidenceSource !== "simulation") ||
      ("simulation" in r && r.simulation !== true) || ("closed" in r && r.closed !== true)) throw new RigControlError("invalid_request", "unexpected result semantics");
  if ("outcome" in r && r.outcome !== null && !["completed", "cancelled", "unknown"].includes(r.outcome as string)) throw new RigControlError("invalid_request", "invalid outcome");
  if ("state" in r && (!["running", "completed", "cancelled", "unknown"].includes(r.state as string) || r.outcome !== (r.state === "running" ? null : r.state))) throw new RigControlError("invalid_request", "inconsistent operation state");
  if ((r.state === "completed" && r.evidence !== "backend_completed") ||
      ((r.state === "cancelled" || r.outcome === "cancelled") && r.evidence !== "backend_stopped" && r.evidence !== "already_cancelled") ||
      (method === "cw.stop" && r.outcome === "completed")) throw new RigControlError("invalid_request", "invalid completion or stop evidence");
  for (const key of identities) if (key in r) assertSafeId(r[key], key, RIG_CONTROL_MAX_DEVICE_ID_LENGTH);
  if ("contentSha256" in r) assertHex(r.contentSha256, "contentSha256", 64);
  if (typeof r.frameHex === "string" && (!/^[0-9a-f]{2}(?: [0-9a-f]{2})*$/.test(r.frameHex) || r.frameHex.split(" ").length !== r.frameBytes)) throw new RigControlError("invalid_request", "invalid frame evidence");
  return raw as unknown as RigControlResponse;
}
