// AI-001 v1：配置与 StationState 快照的严格校验，以及有界文件读取。
//
// 校验原则：拒绝未知字段、拒绝未来版本、拒绝布尔冒充数值、拒绝非有限数字，
// 并在读取前限制文件大小。端点在联网前完成 scheme/凭据/query/fragment 检查。

import { readFileSync, statSync } from "node:fs";
import {
  ASSISTANT_CONFIG_VERSION,
  ASSISTANT_LIMITS,
  ASSISTANT_PROVIDERS,
  AssistantError,
  isPlainObject,
  type AssistantConfig,
  type AssistantProvider,
  type StationStateSnapshot,
} from "./contracts.js";

function fail(code: string, message: string): never {
  throw new AssistantError(code, message);
}

const CONFIG_FIELDS = new Set([
  "version",
  "provider",
  "endpoint",
  "model",
  "apiKeyEnv",
  "timeoutMs",
  "maxOutputTokens",
]);

const STATE_FIELDS = new Set([
  "frequencyHz",
  "mode",
  "txBusy",
  "backendConnected",
  "generation",
  "blockedReason",
]);

function requireOwn(obj: Record<string, unknown>, field: string, code: string): void {
  if (!Object.prototype.hasOwnProperty.call(obj, field)) {
    fail(code, `missing required field: ${field}`);
  }
}

function requireString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") fail("invalid_config", `${field} must be a string`);
  if (value.length === 0) fail("invalid_config", `${field} must not be empty`);
  if (value.length > maxChars) fail("invalid_config", `${field} exceeds ${maxChars} characters`);
  return value;
}

function requireNullableString(value: unknown, field: string, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, maxChars);
}

function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail("invalid_config", `${field} must be an integer (booleans are not numbers)`);
  }
  if (value < min || value > max) fail("invalid_config", `${field} must be in [${min}, ${max}]`);
  return value;
}

/**
 * 校验一个“完整请求 URL”。HTTPS 任意主机；HTTP 只允许本机回环主机。
 * 明确拒绝：非 http/https scheme、用户名/密码、query、fragment。
 */
export function validateEndpointUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail("invalid_endpoint", "endpoint must be a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("invalid_endpoint", "endpoint scheme must be https or http");
  }
  if (url.username !== "" || url.password !== "") {
    fail("invalid_endpoint", "endpoint must not embed user/password credentials");
  }
  if (url.search !== "") fail("invalid_endpoint", "endpoint must not contain a query string");
  if (url.hash !== "") fail("invalid_endpoint", "endpoint must not contain a fragment");
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      fail("insecure_endpoint", "http endpoint is only allowed for localhost/127.0.0.1/[::1]");
    }
  }
  return endpoint;
}

function requireProvider(value: unknown): AssistantProvider {
  if (typeof value !== "string" || !(ASSISTANT_PROVIDERS as readonly string[]).includes(value)) {
    fail("invalid_config", `provider must be one of ${ASSISTANT_PROVIDERS.join("/")}`);
  }
  return value as AssistantProvider;
}

function requireEnvName(value: unknown): string {
  const name = requireString(value, "apiKeyEnv", ASSISTANT_LIMITS.API_KEY_ENV_MAX_CHARS);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    fail("invalid_config", "apiKeyEnv must be a valid environment variable name");
  }
  return name;
}

/** 严格校验配置对象，返回规范化后的 AssistantConfig。 */
export function parseAssistantConfig(value: unknown): AssistantConfig {
  if (!isPlainObject(value)) fail("invalid_config", "config must be a JSON object");
  const obj = value;

  for (const key of Object.keys(obj)) {
    if (!CONFIG_FIELDS.has(key)) fail("unknown_config_field", `config has unknown field: ${key}`);
  }

  requireOwn(obj, "version", "invalid_config");
  const version = requireIntegerInRange(obj.version, "version", 0, Number.MAX_SAFE_INTEGER);
  if (version !== ASSISTANT_CONFIG_VERSION) {
    fail("invalid_config", `unsupported config version ${version}`);
  }

  requireOwn(obj, "provider", "invalid_config");
  const provider = requireProvider(obj.provider);

  const endpoint = requireNullableString(obj.endpoint, "endpoint", 2_048);
  const model = requireNullableString(obj.model, "model", ASSISTANT_LIMITS.MODEL_MAX_CHARS);
  const apiKeyEnv = requireNullableString(obj.apiKeyEnv, "apiKeyEnv", ASSISTANT_LIMITS.API_KEY_ENV_MAX_CHARS);
  const normalizedEnv = apiKeyEnv === null ? null : requireEnvName(apiKeyEnv);

  const timeoutMs = Object.prototype.hasOwnProperty.call(obj, "timeoutMs")
    ? requireIntegerInRange(obj.timeoutMs, "timeoutMs", ASSISTANT_LIMITS.TIMEOUT_MS_MIN, ASSISTANT_LIMITS.TIMEOUT_MS_MAX)
    : ASSISTANT_LIMITS.TIMEOUT_MS_DEFAULT;
  const maxOutputTokens = Object.prototype.hasOwnProperty.call(obj, "maxOutputTokens")
    ? requireIntegerInRange(
        obj.maxOutputTokens,
        "maxOutputTokens",
        ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS_MIN,
        ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS_MAX,
      )
    : ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS_DEFAULT;

  if (provider === "chat-completions") {
    if (endpoint === null) fail("invalid_config", "endpoint is required for provider chat-completions");
    if (model === null) fail("invalid_config", "model is required for provider chat-completions");
    validateEndpointUrl(endpoint);
  } else if (endpoint !== null) {
    // mock/disabled 不使用端点；若提供也必须是合法 URL，避免掩盖配置错误。
    validateEndpointUrl(endpoint);
  }

  return {
    version: ASSISTANT_CONFIG_VERSION,
    provider,
    endpoint,
    model,
    apiKeyEnv: normalizedEnv,
    timeoutMs,
    maxOutputTokens,
  };
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_state", `${field} must be a finite number`);
  }
  return value;
}

function requireStateInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail("invalid_state", `${field} must be an integer`);
  }
  if (value < min || value > max) fail("invalid_state", `${field} must be in [${min}, ${max}]`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail("invalid_state", `${field} must be a boolean`);
  return value;
}

/** 严格校验 StationState 快照，返回与核心字段集一致的只读副本。 */
export function parseStationState(value: unknown): StationStateSnapshot {
  if (!isPlainObject(value)) fail("invalid_state", "state must be a JSON object");
  const obj = value;

  for (const key of Object.keys(obj)) {
    if (!STATE_FIELDS.has(key)) fail("unknown_state_field", `state has unknown field: ${key}`);
  }
  for (const field of STATE_FIELDS) requireOwn(obj, field, "invalid_state");

  const frequencyHz = requireFiniteNumber(obj.frequencyHz, "frequencyHz");
  if (frequencyHz < 0 || frequencyHz > ASSISTANT_LIMITS.FREQUENCY_HZ_MAX) {
    fail("invalid_state", `frequencyHz must be in [0, ${ASSISTANT_LIMITS.FREQUENCY_HZ_MAX}]`);
  }

  if (obj.mode !== "CW") fail("invalid_state", 'mode must be "CW"');

  const txBusy = requireBoolean(obj.txBusy, "txBusy");
  const backendConnected = requireBoolean(obj.backendConnected, "backendConnected");

  const generation = requireStateInteger(obj.generation, "generation", 0, ASSISTANT_LIMITS.GENERATION_MAX);

  let blockedReason: string | null;
  if (obj.blockedReason === null) {
    blockedReason = null;
  } else if (typeof obj.blockedReason === "string") {
    if (obj.blockedReason.length === 0) fail("invalid_state", "blockedReason must be null or a non-empty string");
    if (obj.blockedReason.length > ASSISTANT_LIMITS.BLOCKED_REASON_MAX_CHARS) {
      fail("invalid_state", `blockedReason exceeds ${ASSISTANT_LIMITS.BLOCKED_REASON_MAX_CHARS} characters`);
    }
    blockedReason = obj.blockedReason;
  } else {
    fail("invalid_state", "blockedReason must be null or a string");
  }

  return { frequencyHz, mode: "CW", txBusy, backendConnected, generation, blockedReason };
}

function readBoundedUtf8File(filePath: string, maxBytes: number, notFoundCode: string, tooLargeCode: string): string {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    fail(notFoundCode, "file does not exist or is not readable");
  }
  if (!stats.isFile()) fail(notFoundCode, "path is not a regular file");
  if (stats.size > maxBytes) fail(tooLargeCode, `file exceeds ${maxBytes} bytes`);
  let raw: Buffer;
  try {
    raw = readFileSync(filePath);
  } catch {
    fail(notFoundCode, "file does not exist or is not readable");
  }
  if (raw.byteLength > maxBytes) fail(tooLargeCode, `file exceeds ${maxBytes} bytes`);
  // 容忍 UTF-8 BOM，其余交给 JSON.parse。
  const text = raw.byteLength >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    ? raw.subarray(3).toString("utf8")
    : raw.toString("utf8");
  if (text.trim().length === 0) fail(notFoundCode === "config_not_found" ? "invalid_config" : "invalid_state", "file is empty");
  return text;
}

function parseJson(text: string, invalidCode: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail(invalidCode, "file is not valid JSON");
  }
}

/** 读取并严格校验配置文件；错误码区分不存在/超限/非法。 */
export function loadAssistantConfig(filePath: string): AssistantConfig {
  const text = readBoundedUtf8File(
    filePath,
    ASSISTANT_LIMITS.CONFIG_FILE_MAX_BYTES,
    "config_not_found",
    "config_too_large",
  );
  return parseAssistantConfig(parseJson(text, "invalid_config"));
}

/** 读取并严格校验 StationState 快照文件；错误码区分不存在/超限/非法。 */
export function loadStationState(filePath: string): StationStateSnapshot {
  const text = readBoundedUtf8File(
    filePath,
    ASSISTANT_LIMITS.STATE_FILE_MAX_BYTES,
    "state_not_found",
    "state_too_large",
  );
  return parseStationState(parseJson(text, "invalid_state"));
}
