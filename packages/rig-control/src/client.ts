// P2-002a：Fake 设备服务的受监督客户端（测试与后续 RemoteKeyer 的通道层）。
//
// 该客户端只负责启动/监管 Fake 子进程、维护私有 stdin/stdout NDJSON 通道、
// 关联请求 id、处理关闭/错误/超时，并按 v3 规则为 cw.send 计算 HMAC token。
// 它不接触真实串口，也不是核心 Keyer：没有批准/互锁/审计，不能把本层当作
// 已接入 core 的 RemoteKeyer 验收。

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StationMode } from "../../contracts/src/index.js";
import { contentHash } from "../../core/src/tx-controller.js";
import {
  RIG_CONTROL_PROTOCOL_VERSION,
  RIG_CONTROL_MAX_FRAME_BYTES,
  RIG_CONTROL_MAX_PENDING_REQUESTS,
  isRigControlControlMethod,
  validateResponse,
  computeCwSendToken,
  encodeFrame,
  type CwSendParams,
  type DeviceCapabilities,
  type DeviceCloseResult,
  type DeviceSnapshot,
  type HelloResult,
  type OperationResult,
  type RigControlMethod,
  type RigControlResponse,
  type StopResult,
} from "./protocol.js";

export class FakeRigClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FakeRigClientError";
  }
}

export interface FakeRigTestOptions {
  /** 后端完成延迟（毫秒）。 */
  readonly delayMs?: number;
  /** 后端永不完成，用于超时测试。 */
  readonly hangSend?: boolean;
  /** stop 是否提供可靠停止证据。 */
  readonly stopEvidence?: "stopped" | "none";
  readonly ledgerWriteFailure?: boolean;
}

export interface FakeRigClientOptions {
  /** 显式账本目录；整个目录必须位于系统临时目录或受控位置。 */
  readonly ledgerDir: string;
  /** 稳定配置设备标识；默认 fake-ic7300-01。 */
  readonly deviceInstanceId?: string;
  /** 显式服务入口；未指定时优先源码 apps/rig-faked.ts，其次编译产物。 */
  readonly entry?: string;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly frequencyHz?: number;
  readonly civAddress?: number;
  readonly test?: FakeRigTestOptions;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SendInput {
  readonly operationId: string;
  readonly text: string;
  /** 核心 Proposal/Approval.stateGeneration，必须由调用方提供。 */
  readonly stateGeneration: number;
  /** 授权到期时间（epoch 毫秒）；服务端只接受剩余期限不超过 60 秒。 */
  readonly expiresAt: number;
  readonly frequencyHz?: number;
  readonly connectionGeneration?: number;
  readonly permissionGeneration?: number;
}

/** 仅用于边界测试的显式覆盖；正常 send 不应使用。 */
export interface SendOverrides {
  readonly token?: string;
  readonly contentSha256?: string;
  readonly nonce?: string;
  readonly serviceInstanceId?: string;
  readonly deviceInstanceId?: string;
}

export interface StopInput {
  readonly stopId: string;
  readonly operationId: string;
}

interface PendingRequest {
  readonly method: RigControlMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

function findProjectRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = findProjectRoot(MODULE_DIR);

function resolveDefaultEntry(): string {
  const source = join(PROJECT_ROOT, "apps", "rig-faked.ts");
  if (existsSync(source)) return source;
  return join(PROJECT_ROOT, "dist", "apps", "rig-faked.js");
}

function resolveIntegerOption(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new FakeRigClientError("invalid_options", `${name} must be an integer in [${min}, ${max}]`);
  }
  return resolved;
}

export class FakeRigClient {
  readonly deviceInstanceId: string;
  readonly sessionKey: string;
  readonly requestTimeoutMs: number;
  readonly closeTimeoutMs: number;

  private readonly ledgerDir: string;
  private readonly entry: string;
  private readonly frequencyHzOption: number | null;
  private readonly civAddressOption: number | undefined;
  private readonly test: FakeRigTestOptions;
  private readonly env: NodeJS.ProcessEnv;

  private child: ChildProcess | null = null;
  private readonly exitPromise: Promise<void>;
  private resolveExit: (() => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrChunks: string[] = [];
  private stderrLength = 0;
  private stdoutBuffer = "";
  private nextId = 1;
  private closed = false;
  private failure: Error | null = null;
  private readonly failureListeners = new Set<(error: Error) => void>();
  private closePromise: Promise<void> | null = null;
  private forcedClose = false;
  private capabilitiesCache: DeviceCapabilities | null = null;

  private constructor(options: FakeRigClientOptions) {
    this.ledgerDir = options.ledgerDir;
    this.deviceInstanceId = options.deviceInstanceId ?? "fake-ic7300-01";
    this.entry = options.entry ?? resolveDefaultEntry();
    this.requestTimeoutMs = resolveIntegerOption("requestTimeoutMs", options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 100, 60_000);
    this.closeTimeoutMs = resolveIntegerOption("closeTimeoutMs", options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 100, 60_000);
    this.frequencyHzOption = options.frequencyHz ?? null;
    this.civAddressOption = options.civAddress;
    this.test = options.test ?? {};
    this.env = options.env ?? process.env;
    this.sessionKey = randomBytes(32).toString("hex");
    this.exitPromise = new Promise<void>((resolveExit) => {
      this.resolveExit = resolveExit;
    });
  }

  static async start(options: FakeRigClientOptions): Promise<FakeRigClient> {
    const client = new FakeRigClient(options);
    try { await client.launch(); }
    catch (error) {
      await client.close();
      const diagnostics = client.stderrText.replaceAll(client.sessionKey, "[redacted]");
      const code = error instanceof FakeRigClientError ? error.code : "unavailable";
      throw new FakeRigClientError(code, `${error instanceof Error ? error.message : String(error)}; child diagnostics: ${diagnostics}`);
    }
    return client;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get connected(): boolean {
    return !this.closed && this.failure === null && this.child?.pid !== undefined &&
      this.child.exitCode === null && this.child.signalCode === null;
  }

  get closeReport(): { confirmed: boolean; forced: boolean; exitCode: number | null; signal: string | null } {
    const child = this.child;
    return { confirmed: this.closed && !this.forcedClose && this.failure === null && child?.exitCode === 0,
      forced: this.forcedClose, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null };
  }

  subscribeFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure !== null) {
      try { listener(this.failure); } catch { /* Keep notification consistent with failAll. */ }
    }
    return () => this.failureListeners.delete(listener);
  }

  /** 子进程 stderr 的有界副本；只用于诊断，绝不应包含会话密钥。 */
  get stderrText(): string {
    return this.stderrChunks.join("");
  }

  get capabilities(): DeviceCapabilities | null {
    return this.capabilitiesCache;
  }

  private buildArgs(): string[] {
    const entry = this.entry;
    const args: string[] = [];
    if (entry.endsWith(".ts")) args.push("--import", "tsx");
    args.push(entry, "--ledger", this.ledgerDir, "--device-id", this.deviceInstanceId);
    if (this.frequencyHzOption !== null) args.push("--frequency-hz", String(this.frequencyHzOption));
    if (this.civAddressOption !== undefined) args.push("--civ-address", String(this.civAddressOption));
    if (this.test.delayMs !== undefined) args.push("--test-delay-ms", String(this.test.delayMs));
    if (this.test.hangSend === true) args.push("--test-hang-send");
    if (this.test.ledgerWriteFailure === true) args.push("--test-ledger-write-failure");
    if (this.test.stopEvidence !== undefined) args.push("--test-stop-evidence", this.test.stopEvidence);
    return args;
  }

  private async launch(): Promise<void> {
    const child = spawn(process.execPath, this.buildArgs(), {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows job teardown would kill the child during EOF cleanup. Keep the
      // process referenced and supervised, but let private-pipe EOF close it.
      detached: process.platform === "win32",
      env: this.env,
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    child.on("error", (error) => {
      this.failAll(new FakeRigClientError("unavailable", `fake service failed to start: ${error.message}`));
      this.resolveExit?.();
    });
    child.stdin?.on("error", () => this.failAll(new FakeRigClientError("unavailable", "stdin failed")));
    child.on("exit", (code, signal) => {
      this.failAll(
        new FakeRigClientError(
          "unavailable",
          `fake service exited (code=${code === null ? "null" : code}, signal=${signal === null ? "null" : signal})`,
        ),
      );
      this.resolveExit?.();
    });

    const hello = await this.request<HelloResult>("hello", {
      sessionKey: this.sessionKey,
      deviceInstanceId: this.deviceInstanceId,
    }, DEFAULT_TIMEOUT_MS);
    if (hello.deviceInstanceId !== this.deviceInstanceId) {
      throw new FakeRigClientError("unauthorized", "hello returned an unexpected deviceInstanceId");
    }
    this.capabilitiesCache = await this.request<DeviceCapabilities>("device.capabilities", {});
    if (this.capabilitiesCache.deviceInstanceId !== hello.deviceInstanceId || this.capabilitiesCache.serviceInstanceId !== hello.serviceInstanceId) throw new FakeRigClientError("protocol", "capabilities identity mismatch");
  }

  private onStderr(chunk: string): void {
    const maxLength = 8_192;
    if (this.stderrLength >= maxLength) return;
    const slice = chunk.slice(0, maxLength - this.stderrLength);
    this.stderrChunks.push(slice);
    this.stderrLength += slice.length;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.stdoutBuffer) > RIG_CONTROL_MAX_FRAME_BYTES) this.protocolFault();
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > RIG_CONTROL_MAX_FRAME_BYTES) { this.protocolFault(); return; }
      if (line.length === 0) continue;
      this.handleResponseLine(line);
    }
  }

  private handleResponseLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.protocolFault();
      return;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof (raw as { id?: unknown }).id !== "string") { this.protocolFault(); return; }
    const id = (raw as { id: string }).id;
    const pending = this.pending.get(id);
    if (pending === undefined) return; // 迟到回复：不覆盖已确定的失败。
    let response: RigControlResponse;
    try { response = validateResponse(raw, pending.method); }
    catch { this.protocolFault(); return; }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new FakeRigClientError(response.error?.code ?? "internal", response.error?.message ?? "request failed"),
      );
    }
  }

  private protocolFault(): void {
    this.stdoutBuffer = "";
    this.failAll(new FakeRigClientError("protocol", "invalid or oversized service response"));
    this.kill();
  }

  private failAll(error: Error): void {
    if (!this.closed && this.failure === null) {
      this.failure = error;
      for (const listener of this.failureListeners) {
        try { listener(error); } catch { /* A subscriber cannot prevent pending RPC rejection. */ }
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** 发送一次版本化请求；超时只拒绝本请求，绝不自动重发。 */
  request<T = unknown>(method: RigControlMethod, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed || this.failure !== null) {
      return Promise.reject(new FakeRigClientError("unavailable", "client is closed"));
    }
    const child = this.child;
    const stdin = child?.stdin;
    if (child === null || stdin === null || stdin === undefined || stdin.destroyed) {
      return Promise.reject(new FakeRigClientError("unavailable", "fake service stdin is not available"));
    }
    const id = String(this.nextId);
    const control = isRigControlControlMethod(method);
    const count = [...this.pending.values()].filter(p => isRigControlControlMethod(p.method) === control).length;
    if (count >= (control ? 1 : RIG_CONTROL_MAX_PENDING_REQUESTS)) return Promise.reject(new FakeRigClientError("busy", "pending request limit exceeded"));
    const frame = encodeFrame({ protocolVersion: RIG_CONTROL_PROTOCOL_VERSION, id, method, params });
    if (Buffer.byteLength(frame) - 1 > RIG_CONTROL_MAX_FRAME_BYTES) return Promise.reject(new FakeRigClientError("invalid_params", "request frame too large"));
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FakeRigClientError("timeout", `${method} exceeded ${this.requestTimeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        stdin.write(frame);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new FakeRigClientError("unavailable", error instanceof Error ? error.message : String(error)));
      }
    });
  }

  // ── 类型化方法 ──────────────────────────────────────────────────────────

  refreshCapabilities(): Promise<DeviceCapabilities> {
    return this.request<DeviceCapabilities>("device.capabilities", {}).then((caps) => {
      this.capabilitiesCache = caps;
      return caps;
    });
  }

  snapshot(): Promise<DeviceSnapshot> {
    return this.request<DeviceSnapshot>("device.snapshot", {});
  }

  /**
   * 生成 cw.send 参数并计算 token。业务字段（operationId/text/generations/
   * expiresAt）由调用方提供；overrides 仅供边界测试。
   */
  buildSendParams(input: SendInput, overrides: SendOverrides = {}): CwSendParams {
    const caps = this.capabilitiesCache;
    const frequencyHz = input.frequencyHz ?? this.frequencyHzOption ?? 14_000_000;
    const mode: StationMode = "CW";
    const contentSha256 = overrides.contentSha256 ?? contentHash(input.text, frequencyHz, mode);
    const nonce = overrides.nonce ?? randomBytes(16).toString("hex");
    const draft: CwSendParams = {
      operationId: input.operationId,
      deviceInstanceId: overrides.deviceInstanceId ?? this.deviceInstanceId,
      serviceInstanceId: overrides.serviceInstanceId ?? caps?.serviceInstanceId ?? "",
      text: input.text,
      contentSha256,
      frequencyHz,
      mode,
      connectionGeneration: input.connectionGeneration ?? caps?.connectionGeneration ?? 0,
      permissionGeneration: input.permissionGeneration ?? caps?.permissionGeneration ?? 0,
      stateGeneration: input.stateGeneration,
      expiresAt: input.expiresAt,
      nonce,
      token: overrides.token ?? "",
    };
    const token = overrides.token ?? computeCwSendToken(this.sessionKey, draft);
    return { ...draft, token };
  }

  send(input: SendInput, overrides: SendOverrides = {}): Promise<OperationResult> {
    return this.request<OperationResult>(
      "cw.send",
      this.buildSendParams(input, overrides) as unknown as Record<string, unknown>,
    );
  }

  /** 停止只使用已握手会话；不携带也不检查 send token/期限。 */
  stop(input: StopInput): Promise<StopResult> {
    return this.request<StopResult>("cw.stop", { stopId: input.stopId, operationId: input.operationId });
  }

  operationGet(operationId: string): Promise<OperationResult> {
    return this.request<OperationResult>("operation.get", { operationId });
  }

  closeDevice(): Promise<DeviceCloseResult> {
    return this.request<DeviceCloseResult>("device.close", {});
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /** 供监督者模拟崩溃/强制终止；正常路径应使用 close()。 */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    try {
      this.child?.kill(signal);
    } catch {
      // 进程可能已退出。
    }
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (child === null) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolveWait) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolveWait(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolveWait(true);
      };
      child.once("exit", onExit);
    });
  }

  /**
   * 有界关闭：结束私有 stdin（子服务 EOF 后刷盘并退出），有界等待；超时
   * 则终止子进程。幂等。不自动重连或重放。
   */
  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    if (this.closed) {
      await this.waitForExit(this.closeTimeoutMs);
      return;
    }
    this.closed = true;
    this.failAll(new FakeRigClientError("closed", "client is closed"));
    try {
      this.child?.stdin?.end();
    } catch {
      // stdin 可能已关闭。
    }
    const exited = await this.waitForExit(this.closeTimeoutMs);
    if (!exited) {
      this.forcedClose = true;
      this.kill("SIGKILL");
      await this.waitForExit(2_000);
    }
    if (!(await this.waitForExit(100))) throw new FakeRigClientError("unavailable", "fake service did not exit within close deadline");
  }
}
