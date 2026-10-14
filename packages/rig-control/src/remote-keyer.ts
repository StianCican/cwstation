// P2-002b：核心 Keyer 契约到 Fake 设备控制通道的受限适配器。
//
// 边界（docs/tasks/P2-002b-RemoteKeyer.md、docs/design/P2-002-设备持有者与受控写入.md v3）：
//  - 只实现既有 Keyer 契约；构造时接收 FakeRigClient（或其结构化替身），
//    客户端生命周期由宿主持有，本适配器不重启、不重连、不重发。
//  - 每次 transmit 前必须重新获取 capabilities/snapshot，核对 fake/simulation
//    标记、设备/启动身份、频率/CW/代次、证据能力、字符与长度、快照时效；
//    本次 send 使用捕获到的设备上下文，不使用过期缓存。
//  - operationId 固定为 proposal.id；发送与停止响应除协议校验外，适配器还核对
//    关联网守则中可用的字段与本次请求完全一致。
//  - completed 只凭 backend_completed，cancelled 只凭 backend_stopped 且目标相符，
//    其余一律 unknown；绝不把任意异常或 AbortSignal 已触发推断为取消成功。
//  - AbortSignal 触发且 send 已派发时只发一次 cw.stop；停止不依赖 send 授权期限。
//  - 适配器整体有界（TxRequest.timeoutMs 为上限），timer/listener 完整清理，
//    迟到结果不覆盖已锁定的 unknown。
//
// 本文件只驱动 Fake 模拟后端，不导入 serialport、不打开串口、不接真实电台。

import { randomUUID } from "node:crypto";
import type { Proposal, TxOutcome, TxRequest, TxResult } from "../../contracts/src/index.js";
import type { ExecutionMetrics, Keyer } from "../../core/src/keyer.js";
import { ControllerError, contentHash } from "../../core/src/tx-controller.js";
import { planCivCwMessage } from "../../devices/src/civ-tx-plan.js";
import type { SendInput, StopInput } from "./client.js";
import {
  RIG_CONTROL_CHARSET_VERSION,
  RIG_CONTROL_MAX_EXPIRES_MS,
  validateResponse,
  type DeviceCapabilities,
  type DeviceSnapshot,
  type OperationResult,
  type StopResult,
} from "./protocol.js";

/** RemoteKeyer 实际使用的最小客户端面；FakeRigClient 结构化满足该接口。 */
export interface RemoteKeyerClient {
  readonly deviceInstanceId: string;
  refreshCapabilities(): Promise<DeviceCapabilities>;
  snapshot(): Promise<DeviceSnapshot>;
  send(input: SendInput): Promise<OperationResult>;
  stop(input: StopInput): Promise<StopResult>;
}

export interface RemoteKeyerOptions {
  /** 由宿主持有生命周期的 Fake 客户端。 */
  readonly client: RemoteKeyerClient;
  /** 时间源；默认 Date.now。 */
  readonly now?: () => number;
  /** 快照最大允许时效，默认 2000ms；未来采样仅允许20ms时钟精度偏差。 */
  readonly maxSnapshotAgeMs?: number;
  /** 授权剩余期限上限，默认 60000ms；超过则保守拒绝，不重新续期。 */
  readonly maxExpiresMs?: number;
}

/** 发送响应的核对期望，来自本次请求与捕获到的设备上下文。 */
interface ExpectedContext {
  readonly operationId: string;
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
  readonly text: string;
  readonly contentSha256: string;
  readonly frequencyHz: number;
  readonly mode: "CW";
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
  readonly reliableStopEvidence: boolean;
}

type SendAttempt =
  | { readonly ok: true; readonly result: OperationResult }
  | { readonly ok: false; readonly error: unknown };

type StopAttempt =
  | { readonly ok: true; readonly stopId: string; readonly result: StopResult }
  | { readonly ok: false; readonly error: unknown };

const DEFAULT_BOUND_MS = 5_000;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 2_000;
const MAX_CLOCK_SKEW_MS = 20;

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function checkOperationResult(result: OperationResult, expected: ExpectedContext): string | null {
  if (result.operationId !== expected.operationId) return "operationId mismatch";
  if (result.deviceInstanceId !== expected.deviceInstanceId) return "deviceInstanceId mismatch";
  if (result.serviceInstanceId !== expected.serviceInstanceId) return "serviceInstanceId mismatch";
  if (result.text !== expected.text) return "text mismatch";
  if (result.contentSha256 !== expected.contentSha256) return "contentSha256 mismatch";
  if (result.frequencyHz !== expected.frequencyHz) return "frequencyHz mismatch";
  if (result.mode !== expected.mode) return "mode mismatch";
  if (result.connectionGeneration !== expected.connectionGeneration) return "connectionGeneration mismatch";
  if (result.permissionGeneration !== expected.permissionGeneration) return "permissionGeneration mismatch";
  if (result.stateGeneration !== expected.stateGeneration) return "stateGeneration mismatch";
  if (result.state === "completed" && result.evidence !== "backend_completed") {
    return "completed without backend_completed evidence";
  }
  if (result.state === "cancelled" && result.evidence !== "backend_stopped") {
    return "cancelled without backend_stopped evidence";
  }
  return null;
}

/**
 * 停止证据判定。stop 响应只携带 stopId/operationId/outcome/evidence/at/
 * permissionGeneration，因此只能核对这些字段；目标不符或证据不足一律不认。
 */
function evaluateStop(
  stop: StopAttempt | "timeout" | null,
  operationId: string,
): { cancelled: boolean; note: string } {
  if (stop === null) return { cancelled: false, note: " stop=not-requested" };
  if (stop === "timeout") return { cancelled: false, note: " stop=adapter-bound-timeout" };
  if (!stop.ok) return { cancelled: false, note: ` stop=failed(${describeError(stop.error)})` };
  if (stop.result.stopId !== stop.stopId) return { cancelled: false, note: " stop=stopId-mismatch" };
  if (stop.result.operationId !== operationId) return { cancelled: false, note: " stop=operationId-mismatch" };
  if (stop.result.outcome === "cancelled" && stop.result.evidence === "backend_stopped") {
    return { cancelled: true, note: " stop=backend_stopped" };
  }
  return { cancelled: false, note: ` stop=${stop.result.outcome}/${stop.result.evidence}` };
}

export class RemoteKeyer implements Keyer {
  private readonly client: RemoteKeyerClient;
  private readonly now: () => number;
  private readonly maxSnapshotAgeMs: number;
  private readonly maxExpiresMs: number;
  private keyCount = 0;
  private completedCount = 0;
  private stoppedCount = 0;
  private uncertainCount = 0;

  constructor(options: RemoteKeyerOptions) {
    if (options.client === undefined || options.client === null) {
      throw new Error("RemoteKeyer requires a Fake client instance");
    }
    this.client = options.client;
    this.now = options.now ?? (() => Date.now());
    this.maxSnapshotAgeMs = resolveNonNegativeInteger(
      "maxSnapshotAgeMs",
      options.maxSnapshotAgeMs,
      DEFAULT_MAX_SNAPSHOT_AGE_MS,
    );
    this.maxExpiresMs = resolveNonNegativeInteger("maxExpiresMs", options.maxExpiresMs, RIG_CONTROL_MAX_EXPIRES_MS);
  }

  /** IPC send请求数，不能作为后端实际执行次数。 */
  get sendRequestCount(): number {
    return this.keyCount;
  }

  get executionMetrics(): ExecutionMetrics {
    return { version: 1, source: "simulation", sendAttempts: this.keyCount,
      confirmedCompletions: this.completedCount, confirmedStops: this.stoppedCount,
      uncertainAttempts: this.uncertainCount };
  }

  checkApproval(proposal: Readonly<Proposal>, capabilities: DeviceCapabilities, snapshot: DeviceSnapshot): void {
    validateResponse({ protocolVersion: 1, id: "approval", ok: true, result: capabilities }, "device.capabilities");
    validateResponse({ protocolVersion: 1, id: "approval", ok: true, result: snapshot }, "device.snapshot");
    const reason = this.checkDeviceContext(capabilities, snapshot, proposal);
    if (reason !== null) throw new ControllerError("blocked", `simulation:fake approval rejected: ${reason}`);
  }

  async transmit(request: TxRequest, signal: AbortSignal): Promise<TxResult> {
    const { proposal, approval } = request;
    const requestId = proposal.id;
    const startedAt = new Date().toISOString();
    let dispatched = false;
    const finish = (outcome: TxOutcome, detail: string): TxResult => {
      if (dispatched) {
        if (outcome === "completed") this.completedCount += 1;
        else if (outcome === "cancelled") this.stoppedCount += 1;
        else this.uncertainCount += 1;
      }
      return { requestId, outcome, startedAt, finishedAt: new Date().toISOString(), detail };
    };
    const boundMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? Math.min(request.timeoutMs, DEFAULT_BOUND_MS * 12) : 0;
    if (boundMs === 0) return finish("unknown", "simulation:fake invalid timeout; cw.send was not dispatched");

    // 初始已 abort：不得派发，也不能推断取消成功。
    if (signal.aborted) {
      return finish("unknown", "simulation:fake aborted before preflight; cw.send was not dispatched");
    }

    // 授权一致性是同步预检：proposal/approval 必须完全一致且仍在期限内。
    const authorizationError = this.checkAuthorization(proposal, approval);
    if (authorizationError !== null) {
      return finish("unknown", `simulation:fake preflight rejected (${authorizationError}); cw.send was not dispatched`);
    }

    let abortRequested = false;
    let stopAttempt: Promise<StopAttempt> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    // The same deadline covers preflight, send and stop evidence.
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error(`adapter deadline exceeded ${boundMs}ms`)), boundMs);
    });
    const requestStop = (): void => {
      if (stopAttempt === null) stopAttempt = this.performStop(requestId);
    };
    const onAbort = (): void => {
      abortRequested = true;
      // 预检阶段 abort 不得发 send；只有在 send 已同步派发后才尝试停止。
      if (dispatched) requestStop();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      let capabilities: DeviceCapabilities;
      let snapshot: DeviceSnapshot;
      try {
        capabilities = await Promise.race([this.client.refreshCapabilities(), deadline]);
        validateResponse({ protocolVersion: 1, id: "preflight", ok: true, result: capabilities }, "device.capabilities");
        if (abortRequested || signal.aborted) {
          return finish("unknown", "simulation:fake aborted during preflight; cw.send was not dispatched");
        }
        snapshot = await Promise.race([this.client.snapshot(), deadline]);
        validateResponse({ protocolVersion: 1, id: "preflight", ok: true, result: snapshot }, "device.snapshot");
      } catch (error) {
        return finish(
          "unknown",
          `simulation:fake preflight request failed (${describeError(error)}); cw.send was not dispatched`,
        );
      }
      if (abortRequested || signal.aborted) {
        return finish("unknown", "simulation:fake aborted during preflight; cw.send was not dispatched");
      }

      const contextError = this.checkDeviceContext(capabilities, snapshot, proposal);
      if (contextError !== null) {
        return finish("unknown", `simulation:fake preflight rejected (${contextError}); cw.send was not dispatched`);
      }

      // expiresAt 取提案/批准较小值；剩余超过 60 秒保守拒绝，绝不重新续期。
      const now = this.now();
      const expiresAt = Math.min(Date.parse(proposal.expiresAt), Date.parse(approval.expiresAt));
      if (now >= expiresAt) {
        return finish("unknown", "simulation:fake authorization expired before dispatch; cw.send was not dispatched");
      }
      if (expiresAt - now > this.maxExpiresMs) {
        return finish(
          "unknown",
          "simulation:fake authorization exceeds the device 60s limit; renewal is not performed",
        );
      }

      const expected: ExpectedContext = {
        operationId: proposal.id,
        deviceInstanceId: capabilities.deviceInstanceId,
        serviceInstanceId: capabilities.serviceInstanceId,
        text: proposal.text,
        contentSha256: contentHash(proposal.text, proposal.frequencyHz, proposal.mode),
        frequencyHz: proposal.frequencyHz,
        mode: proposal.mode,
        connectionGeneration: snapshot.connectionGeneration,
        permissionGeneration: snapshot.permissionGeneration,
        stateGeneration: proposal.stateGeneration,
        reliableStopEvidence: capabilities.reliableStopEvidence,
      };
      const input: SendInput = {
        operationId: proposal.id,
        text: proposal.text,
        stateGeneration: proposal.stateGeneration,
        expiresAt,
        frequencyHz: proposal.frequencyHz,
        connectionGeneration: snapshot.connectionGeneration,
        permissionGeneration: snapshot.permissionGeneration,
      };

      // client.send 在返回 promise 前已同步写出请求帧；此后才允许 abort 触发 stop。
      let sendAttempt: Promise<SendAttempt>;
      dispatched = true;
      this.keyCount += 1;
      try {
        sendAttempt = this.client.send(input).then(
          (result): SendAttempt => ({ ok: true, result }),
          (error): SendAttempt => ({ ok: false, error }),
        );
      } catch (error) {
        requestStop();
        return finish("unknown", `simulation:fake cw.send dispatch threw (${describeError(error)}); execution uncertain; stop=attempted-once`);
      }
      if (abortRequested || signal.aborted) requestStop();

      const first = await Promise.race([sendAttempt, deadline]);
      if (!first.ok) {
        requestStop();
        return finish("unknown", `simulation:fake cw.send failed (${describeError(first.error)}); stop=attempted-once`);
      }
      try {
        validateResponse({ protocolVersion: 1, id: "send", ok: true, result: first.result }, "cw.send");
        const mismatch = checkOperationResult(first.result, expected);
        if (mismatch !== null) throw new Error(mismatch);
      } catch (error) {
        requestStop();
        return finish("unknown", `simulation:fake cw.send response rejected (${describeError(error)}); stop attempted once`);
      }

      if (abortRequested) requestStop();
      const pendingStop = stopAttempt;
      const stop = pendingStop === null ? null : await Promise.race([pendingStop, deadline]);
      if (abortRequested && first.result.state === "completed") return finish("unknown", "simulation:fake completion raced with abort; stop not confirmed");
      return this.decideSend(first, stop, expected, finish);
    } catch (error) {
      if (dispatched) requestStop();
      return finish("unknown", `simulation:fake ${describeError(error)}; stop=${dispatched ? "attempted-once" : "not-dispatched"}`);
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private decideSend(
    send: SendAttempt,
    stop: StopAttempt | "timeout" | null,
    expected: ExpectedContext,
    finish: (outcome: TxOutcome, detail: string) => TxResult,
  ): TxResult {
    if (!send.ok) {
      return finish(
        "unknown",
        this.unknownDetail(`cw.send failed (${describeError(send.error)})`, stop, expected.operationId),
      );
    }
    const result = send.result;
    const mismatch = checkOperationResult(result, expected);
    if (mismatch !== null) {
      return finish(
        "unknown",
        this.unknownDetail(`cw.send response rejected (${mismatch})`, stop, expected.operationId),
      );
    }
    const stopEvaluation = evaluateStop(stop, expected.operationId);
    const sendCompleted = result.state === "completed" && result.evidence === "backend_completed";
    const sendCancelled = result.state === "cancelled" && result.evidence === "backend_stopped";
    if ((sendCancelled || stopEvaluation.cancelled) && !expected.reliableStopEvidence) return finish("unknown", "simulation:fake stop capability does not provide reliable evidence");
    if (sendCompleted && !stopEvaluation.cancelled) {
      return finish(
        "completed",
        `simulation:fake backend_completed operation=${result.operationId} frame=${result.frameHex ?? "none"}`,
      );
    }
    if (sendCancelled || stopEvaluation.cancelled) {
      if (sendCompleted) {
        return finish(
          "unknown",
          this.unknownDetail(
            "cw.send reported completion while stop evidence reported cancellation",
            stop,
            expected.operationId,
          ),
        );
      }
      return finish(
        "cancelled",
        `simulation:fake backend_stopped operation=${result.operationId}${stopEvaluation.note}`,
      );
    }
    return finish(
      "unknown",
      this.unknownDetail(
        `cw.send state=${result.state} evidence=${result.evidence}; stop not confirmed`,
        stop,
        expected.operationId,
      ),
    );
  }

  private checkAuthorization(proposal: TxRequest["proposal"], approval: TxRequest["approval"]): string | null {
    if (proposal.status !== "approved" || approval.revokedAt !== null || approval.consumedAt !== null) return "approval is not active";
    if (proposal.id !== approval.proposalId) return "approval proposalId mismatch";
    if (proposal.contentSha256 !== approval.contentSha256) return "approval content hash mismatch";
    if (proposal.frequencyHz !== approval.frequencyHz) return "approval frequency mismatch";
    if (proposal.mode !== approval.mode) return "approval mode mismatch";
    if (proposal.stateGeneration !== approval.stateGeneration) return "approval stateGeneration mismatch";
    if (proposal.mode !== "CW") return `unsupported mode: ${String(proposal.mode)}`;
    if (proposal.contentSha256 !== contentHash(proposal.text, proposal.frequencyHz, proposal.mode)) {
      return "proposal content hash does not match text/frequency/mode";
    }
    const now = this.now();
    const proposalExpires = Date.parse(proposal.expiresAt);
    const approvalExpires = Date.parse(approval.expiresAt);
    if (!Number.isFinite(proposalExpires) || !Number.isFinite(approvalExpires)) return "invalid expiry timestamp";
    if (now >= proposalExpires) return "proposal expired";
    if (now >= approvalExpires) return "approval expired";
    return null;
  }

  private checkDeviceContext(
    capabilities: DeviceCapabilities,
    snapshot: DeviceSnapshot,
    proposal: TxRequest["proposal"],
  ): string | null {
    if (capabilities.backendKind !== "fake") return "backendKind is not fake";
    if (capabilities.evidenceSource !== "simulation") return "evidenceSource is not simulation";
    if (snapshot.simulation !== true) return "snapshot is not marked as simulation";
    if (capabilities.deviceInstanceId !== this.client.deviceInstanceId) {
      return "capabilities deviceInstanceId does not match the configured device";
    }
    if (snapshot.deviceInstanceId !== this.client.deviceInstanceId) {
      return "snapshot deviceInstanceId does not match the configured device";
    }
    if (capabilities.serviceInstanceId !== snapshot.serviceInstanceId) {
      return "capabilities/snapshot serviceInstanceId mismatch";
    }
    if (capabilities.reliableCompletionEvidence !== true) return "reliable completion evidence is unavailable";
    if (!capabilities.methods.includes("cw.send") || !capabilities.methods.includes("cw.stop")) {
      return "device capabilities do not advertise cw.send/cw.stop";
    }
    if (capabilities.charsetVersion !== RIG_CONTROL_CHARSET_VERSION) {
      return `unexpected charset version: ${capabilities.charsetVersion}`;
    }
    if (capabilities.maxMessageBytes < Buffer.byteLength(proposal.text, "utf8")) {
      return "message exceeds the device maxMessageBytes";
    }
    try {
      planCivCwMessage(proposal.text, { radioAddress: capabilities.civAddress });
    } catch (error) {
      return `message rejected by the IC-7300 Command 17 planner: ${describeError(error)}`;
    }
    if (snapshot.mode !== "CW" || proposal.mode !== "CW") return "device/proposal mode is not CW";
    if (snapshot.frequencyHz !== proposal.frequencyHz) return "device frequency does not match the proposal";
    if (snapshot.connectionGeneration !== capabilities.connectionGeneration) {
      return "snapshot/capabilities connectionGeneration mismatch";
    }
    if (snapshot.permissionGeneration !== capabilities.permissionGeneration) {
      return "snapshot/capabilities permissionGeneration mismatch";
    }
    if (capabilities.blocked) {
      return `device service is blocked: ${capabilities.blockedReason ?? "unknown"}`;
    }
    const now = this.now();
    if (snapshot.snapshotTime > now + MAX_CLOCK_SKEW_MS) return `snapshot sample is from the future beyond ${MAX_CLOCK_SKEW_MS}ms clock tolerance`;
    const age = now - snapshot.snapshotTime;
    if (age > this.maxSnapshotAgeMs) {
      return `snapshot is stale (${age}ms > ${this.maxSnapshotAgeMs}ms)`;
    }
    return null;
  }

  private performStop(operationId: string): Promise<StopAttempt> {
    const stopId = randomUUID();
    let pending: Promise<StopResult>;
    try { pending = this.client.stop({ stopId, operationId }); }
    catch (error) { return Promise.resolve({ ok: false, error }); }
    return pending.then(
      (result): StopAttempt => {
        try { validateResponse({ protocolVersion: 1, id: "stop", ok: true, result }, "cw.stop"); }
        catch (error) { return { ok: false, error }; }
        if (result.stopId !== stopId || result.operationId !== operationId) {
          return { ok: false, error: new Error("cw.stop response correlation mismatch") };
        }
        return { ok: true, stopId, result };
      },
      (error): StopAttempt => ({ ok: false, error }),
    );
  }

  private unknownDetail(reason: string, stop: StopAttempt | "timeout" | null, operationId: string): string {
    return `simulation:fake ${reason};${evaluateStop(stop, operationId).note}`;
  }
}

function resolveNonNegativeInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  const max = name === "maxSnapshotAgeMs" ? DEFAULT_MAX_SNAPSHOT_AGE_MS : RIG_CONTROL_MAX_EXPIRES_MS;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${name} must be an integer in [0, ${max}]`);
  }
  return resolved;
}
