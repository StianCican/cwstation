// P1-007 最小只读电台状态核心。
//
// 设计边界（docs/tasks/P1-007-status-service.md）：
//  - 只读：复用 devices 的 CivReadOnlyClient，只发 03/04；不构造任何写命令。
//  - 单一持有：一个 RigStatusService 至多持有一个 transport / 一个在途查询。
//  - 显式连接：默认显式串口、19200、1 秒轮询；失败后不自动重连，只接受
//    客户端显式 reconnect。
//  - 端点：本地 NDJSON IPC；Unix socket 已实现，Windows 命名管道保留类型但
//    本轮不启用（受保护的管道桥接尚未审查）。绝不监听 TCP。
//  - 帧限制：单行 NDJSON 不得超过 64KiB，超限即报错并断开该连接。
//  - 只读边界：RPC 白名单仅 status/watch/reconnect，且不接受任何参数，
//    因此无法通过该端点写入频率、模式、PTT 或授权状态。
//
// 本模块在测试中完全使用注入的 mock transport / 临时端点，不打开真实串口。

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { connect, createServer, Socket, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { resolve } from "node:path";
import {
  CivReadOnlyClient,
  createSimulatedCivTransport,
  openSerialCivTransport,
  SERIAL_ALLOWED_BAUD_RATES,
  SERIAL_DEFAULT_BAUD_RATE,
  type CivFilter,
  type CivMode,
  type CivTransport,
} from "../../devices/src/index.js";
import { WindowsBridge } from "../../daemon/src/bridge.js";

/** 所有客户端都能识别的只读来源标记。 */
export const RIG_STATUS_SOURCE = "rig-statusd" as const;
/** NDJSON 单帧默认上限：64KiB。 */
export const RIG_STATUS_MAX_FRAME_BYTES = 64 * 1024;
export const RIG_STATUS_DEFAULT_POLL_INTERVAL_MS = 1_000;
export const RIG_STATUS_DEFAULT_QUERY_TIMEOUT_MS = 2_000;

/** owner 元数据声明的只读入口协议版本。 */
export const RIG_STATUS_PROTOCOL_VERSION = 1 as const;

/**
 * 只读入口声明的能力边界。当前切片只有读频/读模式为真；任何发送、停止或
 * PTT 能力均为假，且不提供完成/停止证据。simulation 沿用同一能力声明，
 * 不借用 Fake 的完成证据。
 */
export interface RigStatusCapabilities {
  readonly readFrequency: true;
  readonly readMode: true;
  readonly cwSend: false;
  readonly cwStop: false;
  readonly ptt: false;
  readonly completionEvidence: "unavailable";
  readonly stopEvidence: "unavailable";
}

/**
 * owner 元数据：标识当前服务实例及其连接代次。设备身份暂不声明为持久
 * 设备 ID；端口名不是硬件身份，因此这里不提供设备身份字段。
 */
export interface RigStatusOwnerMetadata {
  readonly protocolVersion: typeof RIG_STATUS_PROTOCOL_VERSION;
  /** 每次服务实例唯一；重启后变化。 */
  readonly serviceInstanceId: string;
  /** 仅在开始新连接尝试或当前会话失效/主动关闭时提升。 */
  readonly connectionGeneration: number;
  readonly capabilities: RigStatusCapabilities;
}

const RIG_STATUS_CAPABILITIES: RigStatusCapabilities = Object.freeze({
  readFrequency: true,
  readMode: true,
  cwSend: false,
  cwStop: false,
  ptt: false,
  completionEvidence: "unavailable",
  stopEvidence: "unavailable",
});

export type RigStatusPhase = "disconnected" | "connecting" | "ready" | "stale" | "fault";

export interface RigStatusSnapshot {
  readonly frequencyHz: number;
  readonly mode: CivMode;
  readonly filter: CivFilter;
  readonly snapshotTime: number;
}

/** 面向客户端的只读状态视图；source/readOnly 在每个响应中都重复出现。 */
export interface RigStatusReport {
  readonly source: typeof RIG_STATUS_SOURCE;
  readonly readOnly: true;
  /** 可选 owner 元数据；旧客户端可忽略。 */
  readonly owner?: RigStatusOwnerMetadata;
  readonly status: RigStatusPhase;
  readonly stale: boolean;
  readonly snapshotTime: number | null;
  readonly snapshot: RigStatusSnapshot | null;
  readonly error: string | null;
  readonly portPath: string | null;
  readonly baudRate: number | null;
  readonly simulation: boolean;
  readonly pollIntervalMs: number;
  readonly pollCount: number;
  readonly lastPollTime: number | null;
}

export type RigStatusHistoryEvent = "service_start" | "snapshot" | "fault" | "reconnect" | "service_stop";

export interface RigStatusHistorySink {
  record(event: RigStatusHistoryEvent, report: RigStatusReport): void | Promise<void>;
}

export type RigStatusErrorCode =
  | "config"
  | "stopped"
  | "endpoint_invalid"
  | "endpoint_unsupported"
  | "endpoint_in_use"
  | "invalid_request"
  | "invalid_params"
  | "unknown_method"
  | "internal";

export class RigStatusError extends Error {
  constructor(
    readonly code: RigStatusErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 端点类型 ──────────────────────────────────────────────────────────────
//
// 显式端点，永不使用 TCP 端口。Windows 管道名单独校验；地址解析保留
// `\\\\.\\pipe\\<name>` 前缀，与项目其它本地 IPC 语义一致。

export type RigStatusEndpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "pipe"; readonly name: string };

export const RIG_STATUS_LOCAL_PIPE_PREFIX = "\\\\.\\pipe\\";
export const RIG_STATUS_MAX_PIPE_NAME_LENGTH = 200;

function validateRigStatusPipeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new RigStatusError("endpoint_invalid", "named pipe name must not be empty");
  if (name.length > RIG_STATUS_MAX_PIPE_NAME_LENGTH) {
    throw new RigStatusError(
      "endpoint_invalid",
      `named pipe name exceeds ${RIG_STATUS_MAX_PIPE_NAME_LENGTH} characters`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new RigStatusError(
      "endpoint_invalid",
      `named pipe name contains unsupported characters: ${JSON.stringify(name)} (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
  if (name.includes("..")) {
    throw new RigStatusError("endpoint_invalid", `named pipe name must not contain "..": ${name}`);
  }
  return name;
}

/**
 * 解析显式端点地址。纯数字（TCP 端口）、URL 和远程/UNC 路径一律拒绝；
 * Windows 只接受 `\\.\pipe\<name>`，Unix 只接受文件系统路径。
 */
export function parseRigStatusEndpoint(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): RigStatusEndpoint {
  const value = raw.trim();
  if (value.length === 0) throw new RigStatusError("endpoint_invalid", "endpoint address must not be empty");
  if (/^\d+$/.test(value)) {
    throw new RigStatusError(
      "endpoint_invalid",
      "TCP port endpoints are not supported; use a Unix socket path or a local named pipe",
    );
  }
  if (value.includes("://")) {
    throw new RigStatusError("endpoint_invalid", `URL endpoints are not supported: ${JSON.stringify(value)}`);
  }
  const slashed = value.replace(/\//g, "\\");
  const localPipe = /^\\\\\.\\pipe\\/i.exec(slashed);
  if (localPipe !== null) {
    if (platform !== "win32") {
      throw new RigStatusError(
        "endpoint_unsupported",
        `Windows named pipes are not supported on ${platform}; use a Unix socket path instead`,
      );
    }
    return { kind: "pipe", name: validateRigStatusPipeName(slashed.slice(localPipe[0].length)) };
  }
  if (slashed.startsWith("\\\\")) {
    throw new RigStatusError(
      "endpoint_invalid",
      `remote or UNC endpoints are not supported (${JSON.stringify(value)}); only a local path or \\.\\pipe\\<name> is allowed`,
    );
  }
  if (platform === "win32") {
    throw new RigStatusError(
      "endpoint_invalid",
      `Unix socket file paths are not supported on Windows; use \\\\.\\pipe\\<name> (got ${JSON.stringify(value)})`,
    );
  }
  return { kind: "unix", path: resolve(value) };
}

/** 端点用于 listen/connect 的地址字符串。 */
export function rigStatusEndpointAddress(endpoint: RigStatusEndpoint): string {
  return endpoint.kind === "unix" ? endpoint.path : `${RIG_STATUS_LOCAL_PIPE_PREFIX}${endpoint.name}`;
}

// ── 只读状态服务 ──────────────────────────────────────────────────────────

export interface RigStatusTransportContext {
  readonly signal: AbortSignal;
  readonly portPath: string;
  readonly baudRate: number;
}

/** 注入点：返回一个只读 CI-V transport。测试用它替代真实串口。 */
export type RigStatusTransportFactory = (
  context: RigStatusTransportContext,
) => CivTransport | Promise<CivTransport>;

export interface RigStatusServiceOptions {
  /** 显式串口路径；使用 simulate/transportFactory 时可省略。 */
  portPath?: string;
  /** 串口波特率，默认 19200，必须是手册列出的 6 种之一。 */
  baudRate?: number;
  /** 轮询间隔，默认 1000ms。 */
  pollIntervalMs?: number;
  /** 单次 CI-V 查询超时，默认 2000ms。 */
  queryTimeoutMs?: number;
  /** 快照过期阈值，默认 max(3000, pollIntervalMs * 3)。 */
  staleAfterMs?: number;
  /** true 时使用离线模拟 transport；默认 false。 */
  simulate?: boolean;
  /** 注入 transport 工厂（测试用），优先于 simulate 与真实串口。 */
  transportFactory?: RigStatusTransportFactory;
  /** Optional append-only sink for versioned lifecycle and snapshot records. */
  historySink?: RigStatusHistorySink;
}

function assertIntegerInRange(name: string, value: number, min: number, max: number, code: RigStatusErrorCode): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RigStatusError(code, `${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
  return value;
}

interface ResolvedServiceOptions {
  readonly portPath: string;
  readonly baudRate: number;
  readonly pollIntervalMs: number;
  readonly queryTimeoutMs: number;
  readonly staleAfterMs: number;
  readonly simulate: boolean;
  readonly transportFactory: RigStatusTransportFactory | null;
  readonly historySink: RigStatusHistorySink | null;
}

function resolveServiceOptions(options: RigStatusServiceOptions): ResolvedServiceOptions {
  const simulate = options.simulate ?? false;
  const transportFactory = options.transportFactory ?? null;
  const portPath = (options.portPath ?? "").trim();
  if (transportFactory === null && !simulate && portPath.length === 0) {
    throw new RigStatusError(
      "config",
      "portPath is required unless simulate or transportFactory is provided",
    );
  }
  const baudRate = options.baudRate ?? SERIAL_DEFAULT_BAUD_RATE;
  if (!SERIAL_ALLOWED_BAUD_RATES.includes(baudRate)) {
    throw new RigStatusError(
      "config",
      `baudRate must be one of ${SERIAL_ALLOWED_BAUD_RATES.join(", ")}, got ${baudRate}`,
    );
  }
  const pollIntervalMs = assertIntegerInRange(
    "pollIntervalMs",
    options.pollIntervalMs ?? RIG_STATUS_DEFAULT_POLL_INTERVAL_MS,
    10,
    60_000,
    "config",
  );
  const queryTimeoutMs = assertIntegerInRange(
    "queryTimeoutMs",
    options.queryTimeoutMs ?? RIG_STATUS_DEFAULT_QUERY_TIMEOUT_MS,
    1,
    60_000,
    "config",
  );
  const staleAfterMs = assertIntegerInRange(
    "staleAfterMs",
    options.staleAfterMs ?? Math.max(3_000, pollIntervalMs * 3),
    1,
    3_600_000,
    "config",
  );
  return {
    portPath, baudRate, pollIntervalMs, queryTimeoutMs, staleAfterMs, simulate, transportFactory,
    historySink: options.historySink ?? null,
  };
}

/**
 * 只读状态服务：拥有一个 transport，按固定间隔读取频率/模式，向 IPC
 * 客户端暴露快照。任何查询失败都会关闭并锁死当前会话（由 CivReadOnlyClient
 * 保证），本服务不自动重连。
 */
export class RigStatusService {
  private readonly portPath: string;
  private readonly baudRate: number;
  private readonly pollIntervalMs: number;
  private readonly queryTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly simulate: boolean;
  private readonly transportFactory: RigStatusTransportFactory | null;
  private readonly historySink: RigStatusHistorySink | null;

  private phase: RigStatusPhase = "disconnected";
  private snapshot: RigStatusSnapshot | null = null;
  private lastError: string | null = null;
  private closeFailure: Error | null = null;
  private lastPollTime: number | null = null;
  private pollCount = 0;
  private readonly serviceInstanceId = randomUUID();
  private connectionGeneration = 0;

  private client: CivReadOnlyClient | null = null;
  private transport: CivTransport | null = null;
  private controller: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private stopped = false;
  private generation = 0;
  private startOperation: Promise<RigStatusReport> | null = null;
  private reconnectOperation: Promise<RigStatusReport> | null = null;

  constructor(options: RigStatusServiceOptions = {}) {
    const resolved = resolveServiceOptions(options);
    this.portPath = resolved.portPath;
    this.baudRate = resolved.baudRate;
    this.pollIntervalMs = resolved.pollIntervalMs;
    this.queryTimeoutMs = resolved.queryTimeoutMs;
    this.staleAfterMs = resolved.staleAfterMs;
    this.simulate = resolved.simulate;
    this.transportFactory = resolved.transportFactory;
    this.historySink = resolved.historySink;
  }

  private recordHistory(event: RigStatusHistoryEvent): void {
    const sink = this.historySink;
    if (sink === null) return;
    try {
      void Promise.resolve(sink.record(event, this.report)).catch(() => undefined);
    } catch {
      // History is diagnostic output; it must not alter the read-only session.
    }
  }

  /** 当前只读状态视图；不会触发任何 I/O。 */
  get report(): RigStatusReport {
    const snapshot = this.snapshot;
    const snapshotTime = snapshot === null ? null : snapshot.snapshotTime;
    const age = snapshotTime === null ? null : Date.now() - snapshotTime;
    const stale = snapshot === null || this.phase !== "ready" || (age !== null && age > this.staleAfterMs);
    const status: RigStatusPhase = this.phase === "ready" && stale ? "stale" : this.phase;
    return {
      source: RIG_STATUS_SOURCE,
      readOnly: true,
      owner: {
        protocolVersion: RIG_STATUS_PROTOCOL_VERSION,
        serviceInstanceId: this.serviceInstanceId,
        connectionGeneration: this.connectionGeneration,
        capabilities: RIG_STATUS_CAPABILITIES,
      },
      status,
      stale,
      snapshotTime,
      snapshot,
      error: this.lastError,
      portPath: this.portPath.length === 0 ? null : this.portPath,
      baudRate: this.simulate ? null : this.baudRate,
      simulation: this.simulate,
      pollIntervalMs: this.pollIntervalMs,
      pollCount: this.pollCount,
      lastPollTime: this.lastPollTime,
    };
  }

  /** status 与 watch 都返回即时快照；watch 供客户端短轮询。 */
  status(): RigStatusReport {
    return this.report;
  }

  watch(): RigStatusReport {
    return this.report;
  }

  /** 打开会话并完成首次读取；已连接时是幂等的。 */
  start(): Promise<RigStatusReport> {
    if (this.startOperation !== null) return this.startOperation;
    const operation = this.doStart();
    this.startOperation = operation;
    void operation
      .finally(() => {
        if (this.startOperation === operation) this.startOperation = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private async doStart(): Promise<RigStatusReport> {
    if (this.closeFailure !== null) throw this.closeFailure;
    this.stopped = false;
    this.recordHistory("service_start");
    if (this.client !== null || this.transport !== null) return this.report;
    await this.openSession();
    return this.report;
  }

  /**
   * 显式重连：关闭当前会话后重新打开一次。并发调用复用同一个操作。
   * 绝不自动触发。
   */
  reconnect(): Promise<RigStatusReport> {
    if (this.reconnectOperation !== null) return this.reconnectOperation;
    const operation = this.doReconnect();
    this.reconnectOperation = operation;
    void operation
      .finally(() => {
        if (this.reconnectOperation === operation) this.reconnectOperation = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private async doReconnect(): Promise<RigStatusReport> {
    if (this.closeFailure !== null) throw this.closeFailure;
    if (this.stopped) throw new RigStatusError("stopped", "RigStatusService is stopped");
    this.cancelPollTimer();
    this.controller?.abort();
    this.controller = null;
    await this.releaseSession();
    this.phase = "connecting";
    await this.openSession();
    this.recordHistory("reconnect");
    return this.report;
  }

  /** 停止服务：先关闭 transport，再清空会话；幂等。 */
  async stop(): Promise<void> {
    if (this.stopped) {
      if (this.closeFailure !== null) throw this.closeFailure;
      return;
    }
    this.stopped = true;
    this.cancelPollTimer();
    this.controller?.abort();
    this.controller = null;
    let closeError: unknown;
    let releaseFailed = false;
    try { await this.releaseSession(); }
    catch (error) { closeError = error; releaseFailed = true; }
    // A cancelled open must settle before the owner can confirm release.
    const pending = [this.startOperation, this.reconnectOperation].filter(
      (operation): operation is Promise<RigStatusReport> => operation !== null,
    );
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === "rejected" && !releaseFailed) {
        closeError = result.reason;
        releaseFailed = true;
      }
    }
    if (releaseFailed) throw closeError;
    if (this.closeFailure !== null) throw this.closeFailure;
    this.phase = "disconnected";
    this.recordHistory("service_stop");
  }

  // ── 内部：会话与轮询 ────────────────────────────────────────────────────

  private async createTransport(signal: AbortSignal): Promise<CivTransport> {
    const factory = this.transportFactory;
    if (factory !== null) {
      return await factory({ signal, portPath: this.portPath, baudRate: this.baudRate });
    }
    if (this.simulate) return createSimulatedCivTransport();
    return openSerialCivTransport({
      portPath: this.portPath,
      baudRate: this.baudRate,
      openTimeoutMs: this.queryTimeoutMs,
      operationTimeoutMs: this.queryTimeoutMs,
      closeTimeoutMs: this.queryTimeoutMs,
      signal,
    });
  }

  private async openSession(): Promise<void> {
    if (this.stopped) return;
    // 开始新连接尝试：提升对外连接代次（内部 generation 另用于异步结果丢弃）。
    this.connectionGeneration += 1;
    this.phase = "connecting";
    this.lastError = null;
    const controller = new AbortController();
    this.controller = controller;
    let transport: CivTransport;
    try {
      transport = await this.createTransport(controller.signal);
    } catch (error) {
      if (this.controller === controller) this.controller = null;
      if (this.stopped || controller.signal.aborted) return;
      this.lastError = errorMessage(error);
      this.phase = this.snapshot !== null ? "stale" : "fault";
      return;
    }
    if (this.stopped || controller.signal.aborted || this.controller !== controller) {
      try {
        await transport.close();
      } catch (error) {
        this.closeFailure = error instanceof Error ? error : new Error(String(error));
        this.lastError = `transport close could not be confirmed: ${errorMessage(error)}`;
        this.phase = this.snapshot === null ? "fault" : "stale";
        throw error;
      }
      return;
    }
    this.transport = transport;
    this.client = new CivReadOnlyClient({ transport, timeoutMs: this.queryTimeoutMs });
    this.generation += 1;
    await this.pollOnce();
    if (!this.stopped && this.client !== null && this.phaseIsReady()) this.scheduleNextPoll();
  }

  /** 用方法读取可变状态，避免控制流分析把 phase 窄化成 connecting。 */
  private phaseIsReady(): boolean {
    return this.phase === "ready";
  }

  private async pollOnce(): Promise<void> {
    const client = this.client;
    if (client === null || this.stopped) return;
    const generation = this.generation;
    try {
      const frequencyHz = await client.readFrequency();
      const reading = await client.readMode();
      if (generation !== this.generation || this.stopped) return;
      this.snapshot = {
        frequencyHz,
        mode: reading.mode,
        filter: reading.filter,
        snapshotTime: Date.now(),
      };
      this.phase = "ready";
      this.lastError = null;
      this.pollCount += 1;
      this.lastPollTime = this.snapshot.snapshotTime;
      this.recordHistory("snapshot");
    } catch (error) {
      // 主动停止/重连导致的取消不算故障。
      if (generation !== this.generation || this.stopped) return;
      this.lastError = errorMessage(error);
      this.phase = this.snapshot !== null ? "stale" : "fault";
      // releaseSession retains close failures in the report; keep timer callbacks settled.
      await this.releaseSession().catch(() => undefined);
      this.recordHistory("fault");
    }
  }

  private scheduleNextPoll(): void {
    this.cancelPollTimer();
    this.pollTimer = setTimeout(() => {
      void this.pollTick();
    }, this.pollIntervalMs);
  }

  private async pollTick(): Promise<void> {
    this.pollTimer = null;
    if (this.stopped || this.client === null) return;
    if (this.pollInFlight) {
      this.scheduleNextPoll();
      return;
    }
    this.pollInFlight = true;
    try {
      await this.pollOnce();
    } finally {
      this.pollInFlight = false;
    }
    if (!this.stopped && this.client !== null && this.phaseIsReady()) this.scheduleNextPoll();
  }

  private cancelPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 关闭并释放当前会话。先关 CivReadOnlyClient（清理 timer/listener 并中止
   * 在途查询），再关 transport；generation 递增使旧会话的异步结果失效。
   */
  private async releaseSession(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    const hadSession = client !== null || transport !== null;
    this.client = null;
    this.transport = null;
    this.generation += 1;
    // 当前会话失效/主动关闭才提升对外连接代次；无会话的重复关闭不提升。
    if (hadSession) this.connectionGeneration += 1;
    let closeError: Error | undefined;
    try {
      await client?.close();
    } catch (error) {
      closeError = error instanceof Error ? error : new Error(String(error));
    }
    try {
      await transport?.close();
    } catch (error) {
      if (closeError === undefined) closeError = error instanceof Error ? error : new Error(String(error));
    }
    if (closeError !== undefined) {
      this.closeFailure = closeError;
      this.lastError = `transport close could not be confirmed: ${closeError.message}`;
      this.phase = this.snapshot === null ? "fault" : "stale";
      throw closeError;
    }
  }
}

// ── NDJSON IPC server ─────────────────────────────────────────────────────

export interface RigStatusRpcError {
  readonly code: string;
  readonly message: string;
}

export interface RigStatusResponse {
  readonly source: typeof RIG_STATUS_SOURCE;
  readonly readOnly: true;
  readonly id: string | null;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: RigStatusRpcError;
}

interface RigStatusRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const RIG_STATUS_METHODS: ReadonlySet<string> = new Set(["status", "watch", "reconnect"]);

function validateRigStatusRequest(parsed: unknown): RigStatusRequest {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RigStatusError("invalid_request", "request must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "id" && key !== "method" && key !== "params") {
      throw new RigStatusError("invalid_request", `unsupported request field: ${key}`);
    }
  }
  if (typeof obj.id !== "string" || obj.id.length === 0 || obj.id.length > 128) {
    throw new RigStatusError("invalid_request", "id must be a non-empty string (<=128 chars)");
  }
  if (typeof obj.method !== "string" || obj.method.length === 0 || obj.method.length > 64) {
    throw new RigStatusError("invalid_request", "method must be a non-empty string (<=64 chars)");
  }
  const params = obj.params === undefined ? {} : obj.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new RigStatusError("invalid_request", "params must be a JSON object");
  }
  // 该端点只读：任何参数（包括控制字段）都被拒绝。
  if (Object.keys(params).length > 0) {
    throw new RigStatusError("invalid_params", "this read-only endpoint accepts no request parameters");
  }
  return { id: obj.id, method: obj.method, params: params as Record<string, unknown> };
}

export interface RigStatusIpcServerOptions {
  endpoint: RigStatusEndpoint;
  service: RigStatusService;
  /** NDJSON 单帧最大字节数；默认 64KiB。 */
  maxFrameBytes?: number;
}

/**
 * 本地只读 NDJSON 服务端：一行一个 JSON 请求，一行一个 JSON 响应。
 * 支持 Unix socket；Windows 命名管道类型已保留但本轮明确拒绝启动。
 */
export class RigStatusIpcServer {
  private readonly endpoint: RigStatusEndpoint;
  private readonly service: RigStatusService;
  private readonly maxFrameBytes: number;
  private readonly sockets = new Set<Duplex>();
  private server: Server | undefined;
  private bridge: WindowsBridge | undefined;

  constructor(options: RigStatusIpcServerOptions) {
    this.endpoint = options.endpoint;
    this.service = options.service;
    this.maxFrameBytes = options.maxFrameBytes ?? RIG_STATUS_MAX_FRAME_BYTES;
  }

  get listening(): boolean {
    return this.bridge?.running ?? this.server?.listening ?? false;
  }

  get address(): string {
    return rigStatusEndpointAddress(this.endpoint);
  }

  async start(): Promise<void> {
    if (this.server !== undefined || this.bridge !== undefined) return;
    if (this.endpoint.kind === "pipe") {
      const bridge = new WindowsBridge(
        "server",
        rigStatusEndpointAddress(this.endpoint),
        (socket) => this.acceptConnection(socket),
        () => {
          for (const client of this.sockets) client.destroy(new Error("Windows status pipe failed"));
        },
      );
      this.bridge = bridge;
      try {
        await bridge.ready;
      } catch (error) {
        this.bridge = undefined;
        await bridge.stop().catch(() => undefined);
        throw new RigStatusError("endpoint_unsupported", `Windows named pipe startup failed: ${errorMessage(error)}`);
      }
      return;
    }
    await this.clearStaleSocket();
    const server = createServer((socket) => this.acceptConnection(socket));
    this.server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(rigStatusEndpointAddress(this.endpoint));
    });
    // Unix socket 必须仅同一 OS 用户可连接；命名管道不做（也不该做）chmod。
    if (this.endpoint.kind === "unix") chmodSync(this.endpoint.path, 0o600);
  }

  /** 闭端点并断开所有客户端；不触碰 transport（由 service.stop 负责）。 */
  async stop(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge !== undefined) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await bridge.stop();
      return;
    }
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    const closed = new Promise<void>((resolveClose) => {
      try {
        server.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.race([
      closed,
      new Promise<void>((resolveRace) => {
        setTimeout(resolveRace, 2_000);
      }),
    ]);
    if (this.endpoint.kind === "unix") {
      try {
        unlinkSync(this.endpoint.path);
      } catch {
        // 端点文件已消失或不可删除；不影响关闭结论。
      }
    }
  }

  private async clearStaleSocket(): Promise<void> {
    if (this.endpoint.kind !== "unix") return;
    const path = this.endpoint.path;
    if (!existsSync(path)) return;
    const alive = await this.probe(path, 400);
    if (alive) {
      throw new RigStatusError("endpoint_in_use", `socket ${path} is already served by a live rig-statusd`);
    }
    // 已确认无监听者：原子移走陈旧 socket，保留证据而不是盲目 unlink。
    renameSync(path, `${path}.stale.${Date.now()}`);
  }

  private probe(path: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolveProbe) => {
      const socket = connect(path);
      const done = (result: boolean): void => {
        socket.destroy();
        resolveProbe(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
  }

  private acceptConnection(socket: Duplex): void {
    this.sockets.add(socket);
    if (socket instanceof Socket) socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let frameFailed = false;

    const failFrame = (message: string): void => {
      if (frameFailed) return;
      frameFailed = true;
      this.send(socket, this.errorResponse(null, "invalid_request", message));
      socket.end(() => socket.destroy());
    };

    socket.on("data", (chunk: Buffer) => {
      if (frameFailed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > this.maxFrameBytes && buffer.indexOf(0x0a) === -1) {
        failFrame(`frame exceeds ${this.maxFrameBytes} bytes`);
        return;
      }
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > this.maxFrameBytes) {
          failFrame(`frame exceeds ${this.maxFrameBytes} bytes`);
          return;
        }
        const text = line.toString("utf8").trim();
        if (text.length === 0) continue;
        void this.handleLine(socket, text);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async handleLine(socket: Duplex, text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.send(socket, this.errorResponse(null, "invalid_request", "malformed JSON frame"));
      return;
    }
    let id: string | null = null;
    try {
      const request = validateRigStatusRequest(parsed);
      id = request.id;
      const result = await this.dispatch(request);
      this.send(socket, { source: RIG_STATUS_SOURCE, readOnly: true, id, ok: true, result });
    } catch (error) {
      const code = error instanceof RigStatusError ? error.code : "internal";
      const message = errorMessage(error);
      this.send(socket, this.errorResponse(id, code, message));
    }
  }

  private async dispatch(request: RigStatusRequest): Promise<unknown> {
    switch (request.method) {
      case "status":
        return this.service.status();
      case "watch":
        return this.service.watch();
      case "reconnect":
        return await this.service.reconnect();
      default:
        throw new RigStatusError("unknown_method", `unknown method: ${request.method}`);
    }
  }

  private errorResponse(id: string | null, code: string, message: string): RigStatusResponse {
    return {
      source: RIG_STATUS_SOURCE,
      readOnly: true,
      id,
      ok: false,
      error: { code, message },
    };
  }

  private send(socket: Duplex, response: RigStatusResponse): void {
    if (socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      socket.destroy();
    }
  }
}

/** 供测试与未来 RPC 路由复用的方法白名单快照。 */
export function isRigStatusMethodAllowed(method: string): boolean {
  return RIG_STATUS_METHODS.has(method);
}
