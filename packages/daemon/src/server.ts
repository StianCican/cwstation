// 本地控制服务（Linux Unix socket / Windows 命名管道）：版本化 NDJSON 协议、
// 运行时校验、帧大小与请求超时限制。
// 安全边界：同一个 OS 用户（Linux 由 0600 文件模式承载；Windows 命名管道的实际
// 边界必须单独验证，doctor 如实报告，不得以“本地”推断为同用户）。
// CLI 调用只证明该用户发起了请求，不代表真实人类批准。

import { chmodSync, existsSync, renameSync } from "node:fs";
import { connect, createServer, Socket, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { WindowsBridge } from "./bridge.js";
import {
  PROTOCOL_VERSION,
  type ProposeParams,
  type RpcErrorCode,
  type RpcRequest,
  type RpcResponse,
} from "../../contracts/src/index.js";
import { ControllerError, type TxController } from "../../core/src/tx-controller.js";
import type { TxJournalStore } from "../../core/src/storage.js";
import { endpointAddress, type Endpoint } from "./endpoint.js";
import { LockedError } from "./lock.js";

export interface DaemonServerOptions {
  /** 已解析、已规范化的平台端点。命名管道绝不经过文件系统操作。 */
  endpoint: Endpoint;
  dbPath: string;
  controller: TxController;
  journal: TxJournalStore;
  /** 单个请求允许的最长处理时间；默认 10s。 */
  requestTimeoutMs?: number;
  /** NDJSON 单帧最大字节数；默认 64KiB。 */
  maxFrameBytes?: number;
  /** 是否启用 dev.state 故障注入命令；默认 false。 */
  enableDevCommands?: boolean;
  /** 当前是否只挂 FakeKeyer（未接真机）；默认 true，doctor 会如实报告。 */
  fakeOnly?: boolean;
  /**
   * 可选：在 propose/approve/transmit 之前 await 的只读设备状态刷新。
   * hook 失败、超过 requestTimeoutMs 或已接受停机时命令被拒绝，
   * 绝不产生迟到的批准或执行。
   */
  beforeDeviceCommand?: (() => Promise<void>) | undefined;
  /**
   * 可选：status/doctor 附带的只读设备视图 getter。
   * 未提供时响应结构不增加任何字段，保持旧客户端兼容。
   */
  deviceStatus?: (() => unknown) | undefined;
  /**
   * 收到 RPC `daemon.stop` 且响应已排队后触发的共享关闭路径。
   * 服务器只负责“停止接单 + 通知”，真正的有界取消/撤销/释放由 daemon 入口完成。
   */
  onStopRequested?: (reason: string) => void | Promise<void>;
  /** Run recovery after transport verification, before dispatching any connections. */
  onTransportReady?: () => void | Promise<void>;
}

class BadRequest extends Error {
  constructor(readonly rpcCode: RpcErrorCode, message: string) {
    super(message);
  }
}

/** 单个 RPC 操作的时间上下文，用于设备刷新后的迟到判定。 */
interface RequestContext {
  readonly startedAt: number;
  readonly cancelled: () => boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;

export class DaemonServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Duplex>();
  private bridge: WindowsBridge | undefined;
  private connectionsReady = false;
  private readonly waitingConnections = new Set<Duplex>();
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly enableDevCommands: boolean;
  private readonly fakeOnly: boolean;
  private readonly endpoint: Endpoint;
  /** 一旦接受停机（RPC 或进程信号），立即拒绝同一连接与新连接的一切其它工作。 */
  private stopAccepted = false;
  /** RPC 停机响应 flush 后触发的共享关闭原因；null 表示无待处理停机。 */
  private pendingStopReason: string | null = null;
  private stopTriggered = false;
  private stopTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private startedAt = new Date().toISOString();

  constructor(private readonly options: DaemonServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.enableDevCommands = options.enableDevCommands ?? false;
    this.fakeOnly = options.fakeOnly ?? true;
    this.endpoint = options.endpoint;
  }

  get listening(): boolean {
    return this.bridge?.running ?? this.server?.listening ?? false;
  }

  async start(): Promise<void> {
    if (this.endpoint.kind === "pipe") {
      this.bridge = new WindowsBridge("server", endpointAddress(this.endpoint),
        (socket) => this.acceptConnection(socket), () => {
          this.stopAccepted = true;
          void this.options.onStopRequested?.("transport_failure");
        });
      await this.bridge.ready;
      if (!this.bridge.running || this.stopAccepted) throw new Error("Windows transport failed during startup");
      await this.options.onTransportReady?.();
      if (!this.bridge.running || this.stopAccepted || this.closing) throw new Error("transport stopped during recovery");
      this.enableConnections();
      this.startedAt = new Date().toISOString();
      return;
    }
    // 只有 Unix socket 才可能残留文件；命名管道由内核对象持有，进程退出即消失。
    if (this.endpoint.kind === "unix") await this.clearStaleSocket();
    const server = createServer((socket) => this.acceptConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpointAddress(this.endpoint));
    });
    // Unix socket 必须是 0600：仅同一用户可连接。命名管道不做 chmod（也不该做）。
    if (this.endpoint.kind === "unix") chmodSync(this.endpoint.path, 0o600);
    await this.options.onTransportReady?.();
    if (!server.listening || this.stopAccepted || this.closing) throw new Error("transport stopped during recovery");
    this.enableConnections();
    this.startedAt = new Date().toISOString();
  }

  private async clearStaleSocket(): Promise<void> {
    if (this.endpoint.kind !== "unix") return;
    const path = this.endpoint.path;
    if (!existsSync(path)) return;
    const alive = await this.probe(path, 400);
    if (alive) {
      throw new LockedError(`socket ${path} is already served by a live daemon; refusing to start`);
    }
    // 已确认无监听者：原子移走陈旧 socket，保留证据而不是盲目 unlink。
    renameSync(path, `${path}.stale.${Date.now()}`);
  }

  private probe(path: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(path);
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
  }

  private acceptConnection(socket: Duplex): void {
    if (!this.connectionsReady) { this.waitingConnections.add(socket); return; }
    this.onConnection(socket);
  }

  private enableConnections(): void {
    this.connectionsReady = true;
    for (const socket of this.waitingConnections) if (!socket.destroyed) this.onConnection(socket);
    this.waitingConnections.clear();
  }

  private onConnection(socket: Duplex): void {
    // 拆除开始后不再接受新连接；仅“已接受停机但尚未拆除”的窗口仍允许连接，
    // 以便其它客户端拿到 blocked 或幂等的 daemon.stop 响应。
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    if (socket instanceof Socket) socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let frameFailed = false;

    const failFrame = (message: string): void => {
      if (frameFailed) return;
      frameFailed = true;
      this.send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        id: null,
        ok: false,
        error: { code: "invalid_request", message },
      });
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
      this.send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        id: null,
        ok: false,
        error: { code: "invalid_request", message: "malformed JSON frame" },
      });
      return;
    }

    let requestId: string | null = null;
    try {
      const request = this.validateRequest(parsed);
      requestId = request.id;

      const startedAt = performance.now();
      let responded = false;
      const timer = setTimeout(() => {
        if (responded) return;
        responded = true;
        this.send(socket, {
          protocolVersion: PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: { code: "request_timeout", message: `request exceeded ${this.requestTimeoutMs}ms` },
        });
      }, this.requestTimeoutMs);

      try {
        const result = await this.dispatch(request, {
          startedAt,
          cancelled: () => responded || socket.destroyed,
        });
        if (responded) return;
        responded = true;
        clearTimeout(timer);
        const flushingStop = request.method === "daemon.stop" && this.pendingStopReason !== null && !this.stopTriggered;
        this.send(
          socket,
          { protocolVersion: PROTOCOL_VERSION, id: request.id, ok: true, result },
          flushingStop ? () => this.triggerPendingStop() : undefined,
        );
      } catch (error) {
        if (responded) return;
        responded = true;
        clearTimeout(timer);
        this.send(socket, {
          protocolVersion: PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: toRpcError(error),
        });
      }
    } catch (error) {
      this.send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        id: requestId,
        ok: false,
        error: toRpcError(error),
      });
    }
  }

  private validateRequest(parsed: unknown): RpcRequest {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BadRequest("invalid_request", "request must be a JSON object");
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.protocolVersion !== "number") {
      throw new BadRequest("invalid_request", "protocolVersion must be a number");
    }
    if (typeof obj.id !== "string" || obj.id.length === 0 || obj.id.length > 128) {
      throw new BadRequest("invalid_request", "id must be a non-empty string (<=128 chars)");
    }
    if (typeof obj.method !== "string" || obj.method.length === 0 || obj.method.length > 64) {
      throw new BadRequest("invalid_request", "method must be a non-empty string (<=64 chars)");
    }
    const params = obj.params === undefined ? {} : obj.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new BadRequest("invalid_request", "params must be a JSON object");
    }
    if (obj.protocolVersion !== PROTOCOL_VERSION) {
      throw new BadRequest(
        "protocol_version",
        `protocol version ${obj.protocolVersion} is not supported (expected ${PROTOCOL_VERSION})`,
      );
    }
    return {
      protocolVersion: obj.protocolVersion,
      id: obj.id,
      method: obj.method,
      params: params as Record<string, unknown>,
    };
  }

  private async dispatch(request: RpcRequest, context: RequestContext): Promise<unknown> {
    // 停机入口自身保持幂等可用：接受停机后仍可重复确认，但不再执行其它工作。
    if (request.method === "daemon.stop") {
      if (Object.keys(request.params).length > 0) {
        throw new BadRequest("invalid_params", "daemon.stop takes no parameters");
      }
      const first = !this.stopAccepted;
      this.stopAccepted = true;
      if (first) {
        // 响应排入连接后（write 回调）再触发共享关闭路径；另有有限兜底，
        // 防止响应无法 flush 时 daemon 永远不关闭。幂等由 stopTriggered 保证。
        this.pendingStopReason = "rpc";
        this.stopTimer = setTimeout(() => this.triggerPendingStop(), 250);
      }
      return { accepted: true, alreadyStopping: !first, pid: process.pid, at: new Date().toISOString() };
    }
    if (this.stopAccepted) throw new ControllerError("blocked", "daemon is shutting down");
    const { controller, journal } = this.options;
    const params = request.params;

    switch (request.method) {
      case "ping":
        return { pong: true, pid: process.pid, startedAt: this.startedAt };
      case "status":
        return this.withDeviceStatus(controller.status());
      case "doctor":
        return this.doctor();
      case "propose": {
        await this.beforeDeviceCommand(context);
        const proposeParams: ProposeParams = { text: requireString(params, "text") };
        const ttlMs = optionalNumber(params, "ttlMs");
        const frequencyHz = optionalNumber(params, "frequencyHz");
        const mode = optionalMode(params, "mode");
        if (ttlMs !== undefined) proposeParams.ttlMs = ttlMs;
        if (frequencyHz !== undefined) proposeParams.frequencyHz = frequencyHz;
        if (mode !== undefined) proposeParams.mode = mode;
        return controller.propose(proposeParams);
      }
      case "approve":
        await this.beforeDeviceCommand(context);
        return controller.approve(requireString(params, "id"));
      case "transmit":
        await this.beforeDeviceCommand(context);
        return controller.transmit(requireString(params, "id"));
      case "abort":
        return controller.abort();
      case "audit":
        return journal.recent(optionalLimit(params, 20));
      case "proposals":
        return journal.listProposals(optionalLimit(params, 50));
      case "executions":
        return journal.listExecutions(optionalLimit(params, 50));
      case "unresolved":
        return {
          unknownReview: controller.unknownReview(),
          unresolved: controller.unresolvedUnknowns(),
          resolutions: journal.listResolutions(optionalLimit(params, 50)),
        };
      case "resolve-unknown": {
        if (!this.fakeOnly) throw new ControllerError("blocked", "unknown resolution is available only for the Fake backend");
        const proposalId = requireString(params, "proposalId");
        const operator = requireString(params, "operator");
        const note = requireString(params, "note");
        const confirmStopped = requireBoolean(params, "confirmStopped");
        return controller.resolveUnknown(proposalId, { operator, note, confirmStopped });
      }
      case "dev.state": {
        if (!this.enableDevCommands) {
          throw new BadRequest("unknown_method", "dev.state is disabled; start daemon with CWSTATION_ENABLE_DEV_COMMANDS=1");
        }
        const patch: { frequencyHz?: number; mode?: "CW"; backendConnected?: boolean } = {};
        const frequencyHz = optionalNumber(params, "frequencyHz");
        const mode = optionalMode(params, "mode");
        const backendConnected = optionalBoolean(params, "backendConnected");
        if (frequencyHz !== undefined) patch.frequencyHz = frequencyHz;
        if (mode !== undefined) patch.mode = mode;
        if (backendConnected !== undefined) patch.backendConnected = backendConnected;
        return controller.setState(patch, optionalString(params, "reason") ?? "dev-state-change");
      }
      default:
        throw new BadRequest("unknown_method", `unknown method: ${request.method}`);
    }
  }

  private doctor(): unknown {
    const { controller, journal, dbPath } = this.options;
    const status = controller.status();
    const recovery = controller.recovery();
    const unknownReview = controller.unknownReview();
    return this.withDeviceStatus({
      pid: process.pid,
      startedAt: this.startedAt,
      platform: process.platform,
      socketPath: endpointAddress(this.endpoint),
      endpoint: { kind: this.endpoint.kind, address: endpointAddress(this.endpoint) },
      endpointKind: this.endpoint.kind,
      endpointAccessBoundary: this.endpointAccessBoundary(),
      dbPath,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: journal.schemaVersion,
      station: status,
      recovering: recovery,
      blocked: status.blockedReason !== null,
      shutdownAccepted: this.stopAccepted,
      unknownReview,
      unknownReviewPolicy: {
        resolvableNow: unknownReview.eligibleToResolve,
        requiresRestartBeforeResolve: unknownReview.requiresRestart,
        persistenceFaultLatched: unknownReview.faultLatched,
        note:
          "Only unknowns that existed when startup recovery completed can be resolved; unknowns created after this daemon started require a restart first.",
      },
      securityModel: this.endpoint.kind === "unix"
        ? "same-os-user; CLI request does not prove human approval; no public TCP listener"
        : "same-os-user and SYSTEM via protected pipe bridge; CLI request does not prove human approval; no TCP listener",
      resolutionSecurityNote:
        "resolve-unknown records the operator's declaration only; it does not prove a real human or that a real device stopped. Fake-only phase.",
      listensOnTcp: false,
      fakeOnly: this.fakeOnly,
    });
  }

  /** 端点访问边界的如实描述：不得以“本地”推断为同用户。 */
  private endpointAccessBoundary(): {
    model: string;
    sameUserOnly: boolean;
    verification: string;
    detail: string;
    helperPid?: number | undefined;
    dacl?: unknown;
  } {
    if (this.endpoint.kind === "unix") {
      return {
        model: "unix-socket-mode-0600",
        sameUserOnly: true,
        verification: "enforced-by-filesystem-mode",
        detail: "Unix socket is chmod 0600; a parent directory created by the daemon is 0700.",
      };
    }
    return {
      model: "windows-protected-pipe-bridge",
      sameUserOnly: this.bridge?.info?.verified === true,
      verification: "creation-acl-readback-and-client-token",
      helperPid: this.bridge?.child.pid,
      dacl: this.bridge?.info?.dacl,
      detail:
        "Creation-time protected ACL allows current token user and SYSTEM, denies NETWORK; remote clients rejected. Client verifies server token and ACL on its actual handle. Administrators and same-user shell are trusted; real second-user/remote login tests are not performed.",
    };
  }

  /**
   * 在任何可能改变授权/发射的 RPC 之前刷新只读设备状态。
   * hook 完成后若已接受停机或超过 RPC 期限，必须拒绝，绝不继续批准/执行；
   * 核心自身仍会同步复核 cached 设备状态。
   */
  private async beforeDeviceCommand(context: RequestContext): Promise<void> {
    const hook = this.options.beforeDeviceCommand;
    if (hook !== undefined) {
      try {
        await hook();
      } catch (error) {
        throw new ControllerError(
          "blocked",
          `device state refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.stopAccepted || this.closing) {
      throw new ControllerError("blocked", "daemon is shutting down; device command refused");
    }
    if (context.cancelled() || performance.now() - context.startedAt >= this.requestTimeoutMs) {
      throw new ControllerError("blocked", "device state refresh exceeded the request deadline; command refused");
    }
  }

  /** status/doctor 可选附带只读设备视图；未配置 getter 时不增加字段。 */
  private withDeviceStatus(base: object): unknown {
    const getter = this.options.deviceStatus;
    if (getter === undefined) return base;
    let device: unknown;
    try {
      device = getter();
    } catch (error) {
      device = { error: error instanceof Error ? error.message : String(error) };
    }
    return { ...(base as Record<string, unknown>), device };
  }

  private send(socket: Duplex, response: RpcResponse, onFlushed?: () => void): void {
    if (socket.destroyed) {
      onFlushed?.();
      return;
    }
    try {
      socket.write(`${JSON.stringify(response)}\n`, () => onFlushed?.());
    } catch {
      socket.destroy();
      onFlushed?.();
    }
  }

  /** 触发一次共享关闭路径；响应已 flush 或 250ms 兜底到期时调用，绝不重复。 */
  private triggerPendingStop(): void {
    if (this.stopTriggered) return;
    this.stopTriggered = true;
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    const reason = this.pendingStopReason ?? "rpc";
    const onStop = this.options.onStopRequested;
    if (!onStop) return;
    void Promise.resolve()
      .then(() => onStop(reason))
      .catch(() => undefined);
  }

  /**
   * 停止接单并关闭所有连接。
   * 关键顺序：先标 closing 并停止监听，再取消控制器在途任务（可选回调），
   * 然后主动 destroy 长连接，最后有限等待 listener 关闭。
   * 绝不先 await server.close 再 destroy 连接：长连接会让 SIGTERM 永久挂起。
   */
  async stop(onClosing?: () => void | Promise<void>): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.stopAccepted = true;

    const server = this.server;
    this.server = undefined;
    const listenerClosed = server
      ? new Promise<void>((resolve) => {
          try {
            server.close(() => resolve());
          } catch {
            resolve();
          }
        })
      : Promise.resolve();

    // 先取消在途发射，避免关闭数据库时仍有键控 promise 在写状态。
    try {
      await onClosing?.();
    } catch {
      // 关闭回调失败不阻塞连接清理。
    }

    // 主动断开所有连接，否则 server.close 回调永不触发。
    for (const socket of this.sockets) socket.destroy();
    for (const socket of this.waitingConnections) socket.destroy();
    this.waitingConnections.clear();
    this.sockets.clear();
    await this.bridge?.stop();

    // listener 关闭有限等待；套接字已 destroy，通常立即返回。
    await Promise.race([listenerClosed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function toRpcError(error: unknown): { code: RpcErrorCode; message: string } {
  if (error instanceof ControllerError) return { code: error.code, message: error.message };
  if (error instanceof BadRequest) return { code: error.rpcCode, message: error.message };
  return { code: "internal", message: String(error) };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new BadRequest("invalid_params", `${key} must be a string`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BadRequest("invalid_params", `${key} must be a string`);
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequest("invalid_params", `${key} must be a finite number`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new BadRequest("invalid_params", `${key} must be a boolean`);
  return value;
}

function requireBoolean(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  if (typeof value !== "boolean") throw new BadRequest("invalid_params", `${key} must be a boolean`);
  return value;
}

function optionalMode(params: Record<string, unknown>, key: string): "CW" | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (value !== "CW") throw new BadRequest("invalid_params", `${key} must be "CW"`);
  return value;
}

function optionalLimit(params: Record<string, unknown>, fallback: number): number {
  const value = optionalNumber(params, "limit");
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new BadRequest("invalid_params", "limit must be an integer in [1, 1000]");
  }
  return value;
}
