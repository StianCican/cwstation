// 版本 1/2 JSON 运行配置：独立于代码与数据库，必须由 CLI 显式 `--config <file>` 指定，
// 绝不自动搜索。只覆盖已存在的运行参数（endpoint/socket、db 路径与 daemon 的
// TTL/timeout/frame limit），不配置频率、批准或 blocked 状态，也不承载故障注入变量。
//
// 优先级（低 → 高）：内置默认值 < 配置文件 < 已有 CWSTATION_* 环境变量 < CLI 路径旗标。
// 配置文件内的相对“文件系统”路径以“配置文件所在目录”为基准解析；
// 命名管道名不是路径，绝不按配置目录解析，也绝不 resolve/realpath。
//
// 版本策略：
//  - version1 保持原样：`socketPath` 是 Unix 文件 socket 路径。
//  - version2 明确表达平台端点：`endpoint: { kind: "unix" | "pipe", ... }`；
//    为兼容仍接受 version2 的 `socketPath`（仅 unix 语义），但管道语义只由 `endpoint` 承载。
//  - 更未来版本明确拒绝；旧版 Linux 配置不改动即可使用。

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { baseDbPath, envDbOverride, type PathEnv } from "./paths.js";
import {
  defaultEndpoint,
  endpointAddress,
  parseEndpointAddress,
  validatePipeName,
  EndpointError,
  type Endpoint,
} from "./endpoint.js";

export const CONFIG_VERSION_LEGACY = 1 as const;
export const CONFIG_VERSION = 2 as const;
export const CONFIG_VERSIONS = [1, 2] as const;

export type ConfigErrorCode =
  | "config_not_found"
  | "config_invalid_json"
  | "config_future_version"
  | "config_unknown_field"
  | "config_invalid";

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** version2 的平台端点声明；解析后 path 为绝对路径，pipe name 已规范化。 */
export type StationEndpoint = Endpoint;

/** 版本 1/2 配置：version 必填，其余字段可选；未出现的字段使用下一层优先级。 */
export interface StationConfig {
  version: 1 | 2;
  /** version1 的 Unix socket 路径；version2 仍可作为 unix 便捷写法。 */
  socketPath?: string;
  /** version2 的显式平台端点（仅 version2 允许）。 */
  endpoint?: StationEndpoint;
  dbPath?: string;
  txTimeoutMs?: number;
  requestTimeoutMs?: number;
  proposalTtlMs?: number;
  approvalTtlMs?: number;
  maxFrameBytes?: number;
  fakeDurationMs?: number;
  shutdownTimeoutMs?: number;
  shutdownWatchdogMs?: number;
}

/** 数值字段的合法区间。整数；上限防止误配置；Fake duration 允许 0。 */
export const CONFIG_NUMBER_LIMITS: Record<string, { min: number; max: number }> = {
  txTimeoutMs: { min: 1, max: 600_000 },
  requestTimeoutMs: { min: 1, max: 600_000 },
  proposalTtlMs: { min: 1_000, max: 600_000 },
  approvalTtlMs: { min: 1_000, max: 600_000 },
  maxFrameBytes: { min: 256, max: 16 * 1024 * 1024 },
  fakeDurationMs: { min: 0, max: 600_000 },
  shutdownTimeoutMs: { min: 1, max: 60_000 },
  shutdownWatchdogMs: { min: 1, max: 600_000 },
};

const NUMBER_FIELDS = new Set<string>(Object.keys(CONFIG_NUMBER_LIMITS));
const V1_FIELDS = new Set<string>(["version", "socketPath", "dbPath", ...NUMBER_FIELDS]);
const V2_FIELDS = new Set<string>(["version", "socketPath", "endpoint", "dbPath", ...NUMBER_FIELDS]);
const ENDPOINT_KIND_FIELDS: Record<string, Set<string>> = {
  unix: new Set(["kind", "path"]),
  pipe: new Set(["kind", "name"]),
};

const DAEMON_DEFAULTS = {
  txTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  proposalTtlMs: 60_000,
  approvalTtlMs: 60_000,
  maxFrameBytes: 64 * 1024,
  fakeDurationMs: 30,
  shutdownTimeoutMs: 3_000,
  shutdownWatchdogMs: 8_000,
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePathField(value: unknown, key: string, configDir: string): string {
  if (typeof value !== "string") throw new ConfigError("config_invalid", `config.${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ConfigError("config_invalid", `config.${key} must not be empty`);
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(configDir, trimmed);
}

/** 解析 version2 的 endpoint 对象；管道名不做任何路径解析。 */
function parseEndpointField(value: unknown, configDir: string, pathFieldUsed: boolean): StationEndpoint {
  if (pathFieldUsed) {
    throw new ConfigError("config_invalid", "config.endpoint and config.socketPath cannot both be set");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("config_invalid", "config.endpoint must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (kind !== "unix" && kind !== "pipe") {
    throw new ConfigError("config_invalid", 'config.endpoint.kind must be "unix" or "pipe"');
  }
  const allowed = ENDPOINT_KIND_FIELDS[kind] as Set<string>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new ConfigError("config_unknown_field", `unknown config.endpoint field: ${key}`);
  }
  if (kind === "unix") {
    return { kind: "unix", path: parsePathField(obj.path, "endpoint.path", configDir) };
  }
  const raw = obj.name;
  if (typeof raw !== "string") throw new ConfigError("config_invalid", "config.endpoint.name must be a string");
  try {
    return { kind: "pipe", name: validatePipeName(raw) };
  } catch (error) {
    if (error instanceof EndpointError) throw new ConfigError("config_invalid", error.message);
    throw error;
  }
}

/**
 * 读取并严格校验配置。任何未知字段、未来版本、空路径、错误类型或越界数字都拒绝。
 * 返回对象中的文件系统路径已按配置文件目录解析为绝对路径；管道名原样保留。
 */
export function loadConfigFile(configPath: string): StationConfig {
  const absolute = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new ConfigError("config_not_found", `cannot read config file ${absolute}: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError("config_invalid_json", `config file ${absolute} is not valid JSON: ${describe(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("config_invalid", "config must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (!("version" in obj)) throw new ConfigError("config_invalid", "config.version is required");
  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ConfigError("config_invalid", "config.version must be an integer");
  }
  if (version > CONFIG_VERSION) {
    throw new ConfigError("config_future_version", `config version ${version} is newer than supported ${CONFIG_VERSION}`);
  }
  if (version !== CONFIG_VERSION_LEGACY && version !== CONFIG_VERSION) {
    throw new ConfigError("config_invalid", `unsupported config version: ${version}`);
  }

  const allowed = version === CONFIG_VERSION_LEGACY ? V1_FIELDS : V2_FIELDS;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new ConfigError("config_unknown_field", `unknown config field: ${key}`);
  }

  const configDir = dirname(absolute);
  const config: StationConfig = { version: version === CONFIG_VERSION ? 2 : 1 };

  for (const [key, limits] of Object.entries(CONFIG_NUMBER_LIMITS)) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ConfigError("config_invalid", `config.${key} must be an integer`);
    }
    if (value < limits.min || value > limits.max) {
      throw new ConfigError("config_invalid", `config.${key} must be in [${limits.min}, ${limits.max}]`);
    }
    config[key as keyof StationConfig] = value as never;
  }

  if (obj.socketPath !== undefined) {
    config.socketPath = parsePathField(obj.socketPath, "socketPath", configDir);
  }
  if (obj.dbPath !== undefined) {
    config.dbPath = parsePathField(obj.dbPath, "dbPath", configDir);
  }
  if (version === CONFIG_VERSION && obj.endpoint !== undefined) {
    config.endpoint = parseEndpointField(obj.endpoint, configDir, config.socketPath !== undefined);
  }

  return config;
}

function envNumber(env: PathEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError("config_invalid", `environment ${name} must be a number`);
  return value;
}

/** 配置端点是否与当前平台兼容；不兼容时清晰拒绝而不是静默改写。 */
function assertPlatformEndpoint(endpoint: Endpoint, platform: NodeJS.Platform): Endpoint {
  if (endpoint.kind === "pipe" && platform !== "win32") {
    throw new EndpointError(
      "endpoint_pipe_on_unix",
      `config selects a Windows named pipe, but this platform is ${platform}; use a Unix socket endpoint instead`,
    );
  }
  if (endpoint.kind === "unix" && platform === "win32") {
    throw new EndpointError(
      "endpoint_unix_on_windows",
      "config selects a Unix socket path, but this platform is win32; use a version2 pipe endpoint instead",
    );
  }
  return endpoint;
}

/**
 * 解析本地控制端点：默认 < 配置 < 环境 < CLI。
 * cwctl 只用端点，但也必须完整校验配置文件本身（不要求 daemon 在运行）。
 */
export function resolveEndpoint(
  config: StationConfig | undefined,
  cliSocketPath?: string,
  env: PathEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Endpoint {
  if (cliSocketPath !== undefined) return parseEndpointAddress(cliSocketPath, platform);
  if (env.CWSTATION_SOCKET) return parseEndpointAddress(env.CWSTATION_SOCKET, platform);
  if (platform !== "win32" && env.CWSTATION_RUNTIME_DIR) {
    return { kind: "unix", path: join(resolve(env.CWSTATION_RUNTIME_DIR), "cwstation.sock") };
  }
  let endpoint = defaultEndpoint(platform, env);

  if (config?.endpoint) endpoint = assertPlatformEndpoint(config.endpoint, platform);
  else if (config?.socketPath) endpoint = assertPlatformEndpoint({ kind: "unix", path: config.socketPath }, platform);

  return endpoint;
}

/** 解析数据库路径：基础默认 < 配置 < 环境 < CLI。 */
export function resolveDbPath(
  config: StationConfig | undefined,
  cliDbPath?: string,
  env: PathEnv = process.env,
): string {
  let dbPath = baseDbPath();
  if (config?.dbPath) dbPath = config.dbPath;
  const envOverride = envDbOverride(env);
  if (envOverride) dbPath = envOverride;
  if (cliDbPath !== undefined) dbPath = resolve(cliDbPath);
  return dbPath;
}

export interface EffectiveDaemonConfig {
  /** 解析后的平台端点；daemon/CLI 用它连接或监听。 */
  endpoint: Endpoint;
  /** 端点的连接地址字符串，保留给既有调用方与 doctor 展示。 */
  socketPath: string;
  dbPath: string;
  txTimeoutMs: number;
  requestTimeoutMs: number;
  proposalTtlMs: number;
  approvalTtlMs: number;
  maxFrameBytes: number;
  fakeDurationMs: number;
  shutdownTimeoutMs: number;
  shutdownWatchdogMs: number;
}

/**
 * 解析 daemon 的完整运行参数。
 * requestTimeoutMs 保留原有安全约束：至少为 txTimeoutMs + 2000ms，
 * 以免请求超时早于键控超时。
 */
export function resolveDaemonConfig(
  config: StationConfig | undefined,
  overrides: { socketPath?: string; dbPath?: string } = {},
  env: PathEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EffectiveDaemonConfig {
  const txTimeoutMs = envNumber(env, "CWSTATION_TX_TIMEOUT_MS", config?.txTimeoutMs ?? DAEMON_DEFAULTS.txTimeoutMs);
  const requestTimeoutMs = Math.max(
    envNumber(env, "CWSTATION_REQUEST_TIMEOUT_MS", config?.requestTimeoutMs ?? DAEMON_DEFAULTS.requestTimeoutMs),
    txTimeoutMs + 2_000,
  );
  const endpoint = resolveEndpoint(config, overrides.socketPath, env, platform);
  return {
    endpoint,
    socketPath: endpointAddress(endpoint),
    dbPath: resolveDbPath(config, overrides.dbPath, env),
    txTimeoutMs,
    requestTimeoutMs,
    proposalTtlMs: envNumber(env, "CWSTATION_PROPOSAL_TTL_MS", config?.proposalTtlMs ?? DAEMON_DEFAULTS.proposalTtlMs),
    approvalTtlMs: envNumber(env, "CWSTATION_APPROVAL_TTL_MS", config?.approvalTtlMs ?? DAEMON_DEFAULTS.approvalTtlMs),
    maxFrameBytes: envNumber(env, "CWSTATION_MAX_FRAME_BYTES", config?.maxFrameBytes ?? DAEMON_DEFAULTS.maxFrameBytes),
    fakeDurationMs: envNumber(env, "CWSTATION_FAKE_DURATION_MS", config?.fakeDurationMs ?? DAEMON_DEFAULTS.fakeDurationMs),
    shutdownTimeoutMs: envNumber(
      env,
      "CWSTATION_SHUTDOWN_TIMEOUT_MS",
      config?.shutdownTimeoutMs ?? DAEMON_DEFAULTS.shutdownTimeoutMs,
    ),
    shutdownWatchdogMs: envNumber(
      env,
      "CWSTATION_SHUTDOWN_WATCHDOG_MS",
      config?.shutdownWatchdogMs ?? DAEMON_DEFAULTS.shutdownWatchdogMs,
    ),
  };
}
