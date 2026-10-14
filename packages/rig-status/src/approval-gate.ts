// P2-003c 只读设备批准门禁：把 rig-statusd 的只读状态映射到核心 StationState，
// 并在每次批准/发射前同步复核设备能力，固定拒绝任何真实发送。
//
// 边界：
//  - 只经由 RigStatusClient 的 status/watch 读取；绝不调用 reconnect，也绝不打开串口。
//  - 断线后的“重连”仅指重新连接公开只读 IPC 以取得新服务状态，不是设备串口重连，
//    也不是设备的自动重启。
//  - 即使设备状态 ready 且真实模式为 CW，也只读能力仍拒绝发送；
//    simulation=true 不授予 send。
//  - close 之后不再应用晚到结果，也不再重建连接。
//  - 核心 mode 始终是操作契约 CW；真实设备 mode 只作为设备观测保存在 view 中。

import type { Proposal, TxRequest, TxResult } from "../../contracts/src/index.js";
import type { Keyer } from "../../core/src/keyer.js";
import { ControllerError, type TxController } from "../../core/src/tx-controller.js";
import { planCivCwMessage } from "../../devices/src/index.js";
import { RigStatusClient } from "./client.js";
import {
  rigStatusEndpointAddress,
  type RigStatusCapabilities,
  type RigStatusEndpoint,
  type RigStatusPhase,
} from "./service.js";

/** 与 rig-statusd 固定只读声明一致的能力常量；绝不声明发送或停止证据。 */
const READ_ONLY_CAPABILITIES: RigStatusCapabilities = Object.freeze({
  readFrequency: true,
  readMode: true,
  cwSend: false,
  cwStop: false,
  ptt: false,
  completionEvidence: "unavailable",
  stopEvidence: "unavailable",
});

/** 快照过期门槛：超过 2 秒一律禁批准并映射失联。 */
const STALE_AFTER_MS = 2_000;
/** 允许的同机采样时钟容差：未来超过 20ms 视为非法。 */
const FUTURE_TOLERANCE_MS = 20;
const MAX_INSTANCE_ID_LENGTH = 128;
const MAX_MODE_LENGTH = 32;
const VALID_PHASES: ReadonlySet<string> = new Set(["disconnected", "connecting", "ready", "stale", "fault"]);

/** 通过运行时校验的只读设备上下文。 */
interface DeviceContext {
  readonly serviceInstanceId: string;
  readonly connectionGeneration: number;
  readonly frequencyHz: number;
  /** 真实设备观测到的模式；核心操作契约 mode 始终为 CW。 */
  readonly deviceMode: string;
  readonly filter: 1 | 2 | 3;
  readonly phase: RigStatusPhase;
  readonly stale: boolean;
  readonly simulation: boolean;
  readonly snapshotTime: number;
  readonly capabilities: RigStatusCapabilities;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string (<=${maxLength} chars)`);
  }
  return value;
}

function expectTrue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`${label} must be true`);
  return true;
}

function expectFalse(value: unknown, label: string): false {
  if (value !== false) throw new Error(`${label} must be false for a read-only source`);
  return false;
}

function expectUnavailable(value: unknown, label: string): "unavailable" {
  if (value !== "unavailable") throw new Error(`${label} must be "unavailable"`);
  return "unavailable";
}

function parseCapabilities(raw: unknown): RigStatusCapabilities {
  const caps = asRecord(raw, "owner.capabilities");
  return {
    readFrequency: expectTrue(caps.readFrequency, "capabilities.readFrequency"),
    readMode: expectTrue(caps.readMode, "capabilities.readMode"),
    cwSend: expectFalse(caps.cwSend, "capabilities.cwSend"),
    cwStop: expectFalse(caps.cwStop, "capabilities.cwStop"),
    ptt: expectFalse(caps.ptt, "capabilities.ptt"),
    completionEvidence: expectUnavailable(caps.completionEvidence, "capabilities.completionEvidence"),
    stopEvidence: expectUnavailable(caps.stopEvidence, "capabilities.stopEvidence"),
  };
}

/**
 * 运行时校验原始 report。旧服务无 owner、非法响应、过期 >2s 或未来 >20ms
 * 都会抛出；调用方据此禁批准并映射失联。未知模式保留为设备观测字段。
 */
function parseDeviceContext(raw: unknown, now: number): DeviceContext {
  const report = asRecord(raw, "rig-status report");
  if (report.source !== "rig-statusd") throw new Error(`unexpected source: ${String(report.source)}`);
  if (report.readOnly !== true) throw new Error("readOnly must be true");
  const status = expectString(report.status, "status", MAX_MODE_LENGTH);
  if (!VALID_PHASES.has(status)) throw new Error(`unsupported status: ${status}`);
  if (typeof report.stale !== "boolean") throw new Error("stale must be a boolean");
  if (typeof report.simulation !== "boolean") throw new Error("simulation must be a boolean");

  const owner = asRecord(report.owner, "owner");
  if (owner.protocolVersion !== 1) {
    throw new Error(`owner protocolVersion must be 1, got ${String(owner.protocolVersion)}`);
  }
  const serviceInstanceId = expectString(owner.serviceInstanceId, "owner.serviceInstanceId", MAX_INSTANCE_ID_LENGTH);
  const connectionGeneration = owner.connectionGeneration;
  if (
    typeof connectionGeneration !== "number" ||
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration < 0
  ) {
    throw new Error("owner.connectionGeneration must be a safe nonnegative integer");
  }
  const capabilities = parseCapabilities(owner.capabilities);

  const snapshot = asRecord(report.snapshot, "snapshot");
  const frequencyHz = snapshot.frequencyHz;
  if (typeof frequencyHz !== "number" || !Number.isSafeInteger(frequencyHz) || frequencyHz <= 0) {
    throw new Error("snapshot.frequencyHz must be a positive integer");
  }
  const deviceMode = expectString(snapshot.mode, "snapshot.mode", MAX_MODE_LENGTH);
  const filter = snapshot.filter;
  if (filter !== 1 && filter !== 2 && filter !== 3) {
    throw new Error("snapshot.filter must be 1, 2 or 3");
  }
  const snapshotTime = snapshot.snapshotTime;
  if (typeof snapshotTime !== "number" || !Number.isFinite(snapshotTime)) {
    throw new Error("snapshot.snapshotTime must be a finite number");
  }
  if (report.snapshotTime !== snapshotTime) {
    throw new Error("report.snapshotTime must match snapshot.snapshotTime");
  }
  const age = now - snapshotTime;
  if (age > STALE_AFTER_MS) throw new Error(`snapshot is stale by ${age}ms (limit ${STALE_AFTER_MS}ms)`);
  if (age < -FUTURE_TOLERANCE_MS) {
    throw new Error(`snapshot is ${-age}ms in the future (tolerance ${FUTURE_TOLERANCE_MS}ms)`);
  }

  return {
    serviceInstanceId,
    connectionGeneration,
    frequencyHz,
    deviceMode,
    filter,
    phase: status as RigStatusPhase,
    stale: report.stale,
    simulation: report.simulation,
    snapshotTime,
    capabilities,
  };
}

function capabilitiesKey(capabilities: RigStatusCapabilities): string {
  return [
    capabilities.readFrequency,
    capabilities.readMode,
    capabilities.cwSend,
    capabilities.cwStop,
    capabilities.ptt,
    capabilities.completionEvidence,
    capabilities.stopEvidence,
  ].join("|");
}

/**
 * 已持久化上下文指纹。包含身份/代次/频率/真实模式/可用状态/能力；
 * 不含 pollCount 与采样时刻，因此正常轮询不会反复提升 generation。
 */
function fingerprintOf(context: DeviceContext): string {
  return [
    context.serviceInstanceId,
    context.connectionGeneration,
    context.frequencyHz,
    context.deviceMode,
    context.filter,
    context.phase,
    context.stale,
    context.simulation,
    capabilitiesKey(context.capabilities),
  ].join("\u0000");
}

/** ready、新鲜且真实模式为 CW 时，状态方可作为 CW 上下文使用（仍不授予写能力）。 */
function isApprovable(context: DeviceContext, now: number): boolean {
  if (context.phase !== "ready" || context.stale) return false;
  if (context.deviceMode !== "CW") return false;
  const age = now - context.snapshotTime;
  return age >= -FUTURE_TOLERANCE_MS && age <= STALE_AFTER_MS;
}

export interface ReadOnlyRigApprovalGateOptions {
  /** 后台轮询间隔；默认 1000ms。 */
  pollIntervalMs?: number;
  /** 单次 IPC 连接/请求期限；默认 2000ms。 */
  requestTimeoutMs?: number;
}

/**
 * 只读设备批准门禁。宿主调用 start/refresh/close/checkApproval/view；
 * checkApproval 直接作为 TxController 的同步 approvalGuard。
 */
export class ReadOnlyRigApprovalGate {
  private readonly endpointAddress: string;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;

  private client: RigStatusClient | null = null;
  private context: DeviceContext | null = null;
  private failureReason: string | null = null;
  private lastFingerprint: string | null = null;
  private closed = false;
  private started = false;
  /** close 时递增；晚到的异步结果据此丢弃，绝不重建连接。 */
  private epoch = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly controller: TxController,
    private readonly endpoint: RigStatusEndpoint,
    options: ReadOnlyRigApprovalGateOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.endpointAddress = rigStatusEndpointAddress(endpoint);
  }

  get attached(): boolean {
    return this.started && !this.closed;
  }

  /** 启动后台只读轮询；重复调用幂等。首次刷新失败不抛出，只记录故障。 */
  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    await this.refresh();
    this.scheduleNextPoll();
  }

  /** 一次合并的只读刷新；并发调用复用同一 promise，不排队。 */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.refreshPromise;
    if (existing !== null) return existing;
    const epoch = this.epoch;
    const operation = this.doRefresh(epoch);
    this.refreshPromise = operation;
    void operation
      .finally(() => {
        if (this.refreshPromise === operation) this.refreshPromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  /** 关闭门禁：停止轮询、断开只读 IPC，晚到结果不再应用。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const pending = this.refreshPromise;
    this.dropClient();
    if (pending !== null) {
      try {
        await pending;
      } catch {
        // 刷新路径自身不抛出；这里只保证晚到结果被 epoch 丢弃。
      }
    }
  }

  /**
   * 同步批准前检查：作为 TxController 的 approvalGuard。
   * 报告必须新鲜且 ready、真实模式为 CW、频率匹配提案；随后固定拒绝只读发送。
   */
  checkApproval(proposal: Readonly<Proposal>): void {
    if (this.closed) throw new ControllerError("blocked", "read-only device approval gate is closed");
    const context = this.context;
    if (this.failureReason !== null || context === null) {
      throw new ControllerError(
        "blocked",
        `device state unavailable: ${this.failureReason ?? "no valid read-only report yet"}`,
      );
    }
    const now = Date.now();
    const ageMs = now - context.snapshotTime;
    if (context.phase !== "ready" || context.stale || ageMs < -FUTURE_TOLERANCE_MS || ageMs > STALE_AFTER_MS) {
      throw new ControllerError(
        "blocked",
        `device is not ready for CW (status=${context.phase}, stale=${String(context.stale)}, ageMs=${ageMs})`,
      );
    }
    if (context.deviceMode !== "CW") {
      throw new ControllerError(
        "blocked",
        `device mode is ${context.deviceMode}, not CW; core mode is only the operator contract`,
      );
    }
    if (context.frequencyHz !== proposal.frequencyHz) {
      throw new ControllerError(
        "blocked",
        `device frequency ${context.frequencyHz}Hz does not match proposal ${proposal.frequencyHz}Hz`,
      );
    }
    // 用既有 civ-tx-plan 复核提案文本（不复制字符表）；合法也仍然只读拒绝。
    try {
      planCivCwMessage(proposal.text);
    } catch (error) {
      throw new ControllerError("blocked", `proposal text is not a valid IC-7300 CW plan: ${errorMessage(error)}`);
    }
    // 固定拒绝：只读设备永不授予 send；simulation=true 也不授予。
    throw new ControllerError(
      "blocked",
      "rig-statusd is read-only (cwSend/cwStop/ptt=false); transmission is refused",
    );
  }

  /** 只读设备视图：真实设备模式、只读能力、错误与新鲜度；核心 mode 另标为契约。 */
  view(): Record<string, unknown> {
    const context = this.context;
    const now = Date.now();
    const ageMs = context === null ? null : now - context.snapshotTime;
    const fresh = context !== null && ageMs !== null && ageMs >= -FUTURE_TOLERANCE_MS && ageMs <= STALE_AFTER_MS;
    return {
      attached: this.started && !this.closed,
      endpoint: this.endpointAddress,
      readOnly: true,
      capabilities: READ_ONLY_CAPABILITIES,
      // 真实设备观测模式；核心操作契约 mode 恒为 CW，二者不得混淆。
      deviceMode: context === null ? null : context.deviceMode,
      deviceModeIsObservation: true,
      contractMode: "CW",
      status: context === null ? (this.failureReason === null ? "connecting" : "unavailable") : context.phase,
      stale: context === null ? null : context.stale,
      fresh,
      stateReadyForCwContext: !this.closed && context !== null && isApprovable(context, now),
      approvable: false,
      linkConnected: this.client !== null,
      frequencyHz: context === null ? null : context.frequencyHz,
      snapshotTime: context === null ? null : context.snapshotTime,
      ageMs,
      simulation: context === null ? null : context.simulation,
      serviceInstanceId: context?.serviceInstanceId ?? null,
      connectionGeneration: context?.connectionGeneration ?? null,
      filter: context?.filter ?? null,
      error: this.failureReason,
    };
  }

  private async doRefresh(epoch: number): Promise<void> {
    if (this.closed || epoch !== this.epoch) return;
    let client = this.client;
    try {
      if (client === null) {
        client = await RigStatusClient.connect(this.endpoint, this.requestTimeoutMs);
        if (this.closed || epoch !== this.epoch) {
          client.close();
          return;
        }
        this.client = client;
      }
      const report = await client.request("watch");
      if (this.closed || epoch !== this.epoch) return;
      this.applyReport(report);
    } catch (error) {
      if (this.closed || epoch !== this.epoch) return;
      // 有界的 IPC 重连：丢弃失效客户端，由下一次刷新（≤1s 后）重新连接；
      // 这不是设备串口重连，也不是服务自动重启。
      this.dropClient();
      this.applyFailure(errorMessage(error));
    }
  }

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    if (client !== null) {
      try {
        client.close();
      } catch {
        // 忽略关闭错误：门禁只需保证不再使用该连接。
      }
    }
  }

  private applyReport(report: unknown): void {
    if (this.closed) return;
    let context: DeviceContext;
    try {
      context = parseDeviceContext(report, Date.now());
    } catch (error) {
      this.applyFailure(`invalid read-only report: ${errorMessage(error)}`);
      return;
    }
    this.failureReason = null;
    this.applyContext(context);
  }

  /**
   * 将校验通过的上下文写入核心：频率通过 setState 持久化；身份/代次/真实模式/
   * 可用变化在没有提升 generation 时显式 invalidate(reason, true) 撤销旧批准。
   * 相同指纹不提升 generation，也不恢复任何旧批准。
   */
  private applyContext(context: DeviceContext): void {
    if (this.closed) return;
    const fingerprint = fingerprintOf(context);
    if (fingerprint === this.lastFingerprint) {
      this.context = context;
      return;
    }
    const previous = this.context;
    const identityChanged =
      previous !== null &&
      (previous.serviceInstanceId !== context.serviceInstanceId ||
        previous.connectionGeneration !== context.connectionGeneration ||
        previous.deviceMode !== context.deviceMode ||
        previous.phase !== context.phase ||
        previous.stale !== context.stale ||
        previous.simulation !== context.simulation ||
        capabilitiesKey(previous.capabilities) !== capabilitiesKey(context.capabilities));
    const approvable = isApprovable(context, Date.now());
    const reason = identityChanged ? "rig-status:identity-change" : "rig-status:state-change";
    try {
      const generationBefore = this.controller.status().generation;
      this.controller.setState(
        { frequencyHz: context.frequencyHz, backendConnected: approvable },
        reason,
      );
      if (this.controller.status().generation === generationBefore) {
        this.controller.invalidate(reason, true);
      }
      this.context = context;
      this.lastFingerprint = fingerprint;
    } catch (error) {
      // 设备上下文无法持久化：清空可批准缓存；核心故障闩锁保留，绝不当作成功。
      this.clearApprovable(`failed to persist device context: ${errorMessage(error)}`);
    }
  }

  /** IPC 故障/状态过期：映射 backendConnected=false 并撤销；同一故障不重复刷代次。 */
  private applyFailure(reason: string): void {
    if (this.closed) return;
    this.failureReason = reason;
    if (this.lastFingerprint === null) return; // 已处于失联映射，避免无穷代次。
    try {
      const generationBefore = this.controller.status().generation;
      this.controller.setState({ backendConnected: false }, "rig-status:disconnected");
      if (this.controller.status().generation === generationBefore) {
        this.controller.invalidate("rig-status:disconnected", true);
      }
      this.context = null;
      this.lastFingerprint = null;
    } catch (error) {
      this.clearApprovable(`failed to persist device disconnection: ${errorMessage(error)}`);
    }
  }

  private clearApprovable(reason: string): void {
    this.failureReason = reason;
    this.context = null;
    this.lastFingerprint = null;
  }

  private scheduleNextPoll(): void {
    if (this.closed || !this.started) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh().catch(() => undefined);
      this.scheduleNextPoll();
    }, this.pollIntervalMs);
  }
}

/**
 * 只读拒绝键控器：真实只读设备永远不能执行发送。正常路径由 approvalGuard
 * 在写入 intent 前拒绝；本类只是最后一道保险，绝不接触设备，keyedCount 恒为 0。
 */
export class ReadOnlyRejectingKeyer implements Keyer {
  readonly keyedCount = 0;

  async transmit(request: TxRequest): Promise<TxResult> {
    throw new ControllerError(
      "blocked",
      `read-only rig cannot transmit proposal ${request.proposal.id}; no device command was sent`,
    );
  }
}
