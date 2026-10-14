// 确定性发射控制器：提案、一次性批准、单一在途发射、超时/unknown、恢复。
// 安全约束：
//  - 只有本控制器可以触发键控；CLI 只能通过 RPC 请求。
//  - 未批准 / 过期 / 已撤销 / generation 不匹配一律拒绝。
//  - 批准在开始执行时即被消费；同一提案不会第二次键控。
//  - 超时、后端断连、状态改变或无法证明停止进入 unknown，并阻止后续发射。
//  - 任何持久化写入失败都向上抛出，绝不带病继续发射。

import { createHash, randomUUID } from "node:crypto";
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_OPERATOR_MAX_LENGTH,
  RESOLUTION_PROPOSAL_ID_MAX_LENGTH,
  type Approval,
  type AuditEvent,
  type Execution,
  type ExecutionResolution,
  type Proposal,
  type ProposeParams,
  type StationMode,
  type StationState,
  type TxOutcome,
  type UnknownReviewSummary,
  type UnresolvedUnknown,
} from "../../contracts/src/index.js";
import { KeyerAbortError, type ExecutionMetrics, type Keyer } from "./keyer.js";
import type { TxJournalStore } from "./storage.js";

export type ControllerErrorCode =
  | "not_found"
  | "conflict"
  | "busy"
  | "expired"
  | "blocked"
  | "unauthorized"
  | "invalid_params"
  | "internal";

export class ControllerError extends Error {
  constructor(readonly code: ControllerErrorCode, message: string) {
    super(message);
    this.name = "ControllerError";
  }
}

export interface ControllerOptions {
  /** 提案默认有效期；默认 60s。 */
  proposalTtlMs?: number;
  /** 提案允许的最大有效期；默认 10min。 */
  maxProposalTtlMs?: number;
  /** 批准有效期上限；默认 60s。 */
  approvalTtlMs?: number;
  /** 单次发射超时；到时仍不能确认停止则判 unknown。默认 5s。 */
  txTimeoutMs?: number;
  /** 报文最大长度。 */
  maxTextLength?: number;
  /** 频率合法区间。 */
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /**
   * 可选的同步批准前设备门禁。在批准返回/写入前，以及发射消费批准/写入
   * intent 前调用；回调抛出即拒绝该次操作，绝不落盘任何授权。
   * 默认无此回调，行为与旧版本兼容。
   */
  approvalGuard?: ((proposal: Readonly<Proposal>) => void) | undefined;
}

type AbortReason = "operator" | "timeout" | "state-change" | "backend-disconnect" | "shutdown" | null;

interface PublicStatus extends StationState {
  keyedCount: number | null;
  executionMetrics?: ExecutionMetrics;
  schemaVersion: number;
  proposalCounts: Record<string, number>;
  executionCounts: Record<string, number>;
  approvalCounts: { active: number; consumed: number; revoked: number };
  unknownReview: UnknownReviewSummary;
}

/** 人工核查解除的输入；confirmStopped 必须为字面量 true。 */
export interface ResolveUnknownParams {
  operator: string;
  note: string;
  confirmStopped: boolean;
}

const DEFAULT_PROPOSAL_TTL_MS = 60_000;
const DEFAULT_MAX_PROPOSAL_TTL_MS = 600_000;
const DEFAULT_APPROVAL_TTL_MS = 60_000;
const DEFAULT_TX_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TEXT_LENGTH = 400;
const MIN_FREQUENCY_HZ = 100_000;
const MAX_FREQUENCY_HZ = 100_000_000;

export function contentHash(text: string, frequencyHz: number, mode: StationMode): string {
  return createHash("sha256").update(`${text}\0${frequencyHz}\0${mode}`).digest("hex");
}

export class TxController {
  private active: { proposalId: string; abort: AbortController } | undefined;
  private abortReason: AbortReason = null;
  private recovered = false;
  private recoverySummary: Record<string, number> = {};
  /**
   * 启动恢复成功时已存在的 unresolved unknown ID。只有这些可被本进程解除；
   * 本次启动后新增的 unknown 必须先停机重启，避免本进程 FakeKeyer 迟到副作用。
   */
  private eligibleUnknownIds = new Set<string>();
  /** 显式故障闩锁：本进程发生 intent/outcome/state/解除持久化故障后禁止解除。 */
  private faultLatch: string | null = null;
  /** 非 unknown 的已有阻止原因；解除最后一条 unknown 后必须保留。 */
  private preservedBlockedReason: string | null = null;
  /** 可选的批准前设备门禁；同步回调，抛出即拒绝。 */
  private readonly approvalGuard: ((proposal: Readonly<Proposal>) => void) | undefined;

  private readonly proposalTtlMs: number;
  private readonly maxProposalTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly txTimeoutMs: number;
  private readonly maxTextLength: number;
  private readonly minFrequencyHz: number;
  private readonly maxFrequencyHz: number;

  constructor(
    private state: StationState,
    private readonly keyer: Keyer,
    private readonly journal: TxJournalStore,
    options: ControllerOptions = {},
  ) {
    this.proposalTtlMs = options.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
    this.maxProposalTtlMs = options.maxProposalTtlMs ?? DEFAULT_MAX_PROPOSAL_TTL_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.txTimeoutMs = options.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.minFrequencyHz = options.minFrequencyHz ?? MIN_FREQUENCY_HZ;
    this.maxFrequencyHz = options.maxFrequencyHz ?? MAX_FREQUENCY_HZ;
    this.approvalGuard = options.approvalGuard;
    this.faultLatch = journal.loadState().storageFault ?? null;
    if (this.faultLatch) this.state.blockedReason = this.faultLatch;
  }

  /** 从数据库加载持久化台站状态（generation/blockedReason 等）。 */
  static loadState(journal: TxJournalStore, overrides: Partial<StationState> = {}): StationState {
    const persisted = journal.loadState();
    return {
      frequencyHz: overrides.frequencyHz ?? persisted.frequencyHz,
      mode: overrides.mode ?? persisted.mode,
      txBusy: false,
      backendConnected: overrides.backendConnected ?? true,
      generation: persisted.generation,
      blockedReason: persisted.blockedReason,
    };
  }

  get txTimeout(): number {
    return this.txTimeoutMs;
  }

  get hasActiveTransmission(): boolean {
    return this.active !== undefined;
  }

  status(): PublicStatus {
    return {
      frequencyHz: this.state.frequencyHz,
      mode: this.state.mode,
      txBusy: this.state.txBusy,
      backendConnected: this.state.backendConnected,
      generation: this.state.generation,
      blockedReason: this.state.blockedReason,
      keyedCount: this.keyer.keyedCount ?? null,
      ...(this.keyer.executionMetrics === undefined ? {} : { executionMetrics: this.keyer.executionMetrics }),
      schemaVersion: this.journal.schemaVersion,
      proposalCounts: this.journal.countProposalsByStatus(),
      executionCounts: this.journal.countExecutionsByStatus(),
      approvalCounts: this.journal.getApprovalStatusCounts(),
      unknownReview: this.unknownReview(),
    };
  }

  /** 未解除 unknown 的只读摘要：计数、可解除数、重启限制与故障闩锁。 */
  unknownReview(): UnknownReviewSummary {
    const unresolved = this.journal.findUnresolvedUnknowns();
    let eligibleToResolve = 0;
    for (const execution of unresolved) {
      if (this.eligibleUnknownIds.has(execution.proposalId)) eligibleToResolve += 1;
    }
    return {
      unresolvedUnknownCount: unresolved.length,
      eligibleToResolve,
      requiresRestart: unresolved.length - eligibleToResolve,
      faultLatched: this.faultLatch !== null,
      recovered: this.recovered,
    };
  }

  /** 未解除 unknown 列表，附带本进程是否允许解除该条。 */
  unresolvedUnknowns(): UnresolvedUnknown[] {
    return this.journal.findUnresolvedUnknowns().map((execution) => ({
      ...execution,
      resolutionEligible: this.eligibleUnknownIds.has(execution.proposalId),
    }));
  }

  recovery(): { recovered: boolean; summary: Record<string, number> } {
    return { recovered: this.recovered, summary: this.recoverySummary };
  }

  /**
   * 启动恢复：必须在 daemon 成功独占 socket 之后调用。
   *  - 遗留 running 执行 → unknown（不自动重试）。
   *  - 撤销全部批准，终止全部 pending/approved 提案（不设 LIMIT，避免遗漏旧记录）。
   *  - 仅当确实存在需要失效的开放授权时才 generation +1；重复调用为幂等。
   *  - 仅未解除的 unknown 会阻止；已解除的 unknown 不再阻止。
   *  - 记录本次恢复时已存在的 unresolved unknown ID：只有它们可被本进程解除。
   */
  recoverOnStartup(): void {
    if (this.recovered) return; // 幂等：重复恢复不再无故增加 generation。

    const now = new Date().toISOString();
    const summary: Record<string, number> = {
      runningToUnknown: 0,
      approvalsRevoked: 0,
      proposalsExpired: 0,
      proposalsCancelled: 0,
      unresolvedUnknowns: 0,
      resolutionEligible: 0,
    };

    let nextGeneration = this.state.generation;
    let nextBlockedReason = this.state.blockedReason;
    let eligibleIds: string[] = [];

    this.journal.transaction(() => {
      const running = this.journal.findRunningExecutions();
      for (const execution of running) {
        this.journal.updateExecutionStatus(
          execution.proposalId,
          "unknown",
          now,
          "daemon restarted while execution was in flight; stop cannot be confirmed",
        );
        this.journal.setProposalStatus(execution.proposalId, "cancelled");
        this.appendAudit("tx.unknown", execution.proposalId, { reason: "daemon-restart" });
        summary.runningToUnknown = (summary.runningToUnknown ?? 0) + 1;
      }

      summary.approvalsRevoked = this.journal.revokeAllApprovals(now, "daemon-restart");

      // 数据库批量终止全部开放提案（无 LIMIT / 无分页遗漏）。
      const terminated = this.journal.terminateOpenProposalsByExpiry(now);
      summary.proposalsExpired = terminated.expired;
      summary.proposalsCancelled = terminated.cancelled;

      const hadWork =
        (summary.runningToUnknown ?? 0) > 0 ||
        (summary.approvalsRevoked ?? 0) > 0 ||
        terminated.expired + terminated.cancelled > 0;
      if (hadWork) nextGeneration = this.state.generation + 1;

      // 仅未解除的 unknown 阻止；已写入 resolution 的 unknown 不再参与。
      const unresolved = this.journal.findUnresolvedUnknowns();
      eligibleIds = unresolved.map((execution) => execution.proposalId);
      summary.unresolvedUnknowns = unresolved.length;
      summary.resolutionEligible = unresolved.length;
      if (unresolved.length > 0) nextBlockedReason = this.unknownBlockReason(unresolved);
      if (this.faultLatch !== null) nextBlockedReason = this.faultLatch;

      this.journal.saveState({
        frequencyHz: this.state.frequencyHz,
        mode: this.state.mode,
        generation: nextGeneration,
        blockedReason: nextBlockedReason,
        storageFault: this.faultLatch,
      });
      this.appendAudit("daemon.recovered", "station", {
        ...summary,
        generation: nextGeneration,
        blocked: nextBlockedReason !== null,
      });
    });

    // 仅在事务提交成功后更新内存态，避免回滚后内存与数据库不一致。
    this.state.generation = nextGeneration;
    this.state.blockedReason = nextBlockedReason;
    this.eligibleUnknownIds = new Set(eligibleIds);
    // 有未解除 unknown 时，旧的持久化阻止原因就是 unknown 阻止本身；解除后回到无其他故障。
    // 没有未解除 unknown 时保留已有（非 unknown）阻止原因，不擅自清除。
    this.preservedBlockedReason = eligibleIds.length > 0 ? null : nextBlockedReason;
    this.recovered = true;
    this.recoverySummary = summary;
  }

  /**
   * 人工核查解除一条未解除的 unknown。
   *  - 严格校验：confirmStopped 必须为字面量 true；operator/note 非空且有长度上限。
   *  - 只允许解除启动恢复时已存在的 unresolved unknown；本进程新增的需先停机重启。
   *  - 同 ID 已解除的重试直接返回既有 resolution，不重复审计、不改 generation。
   *  - 提交事务：插入 resolution、撤销全部开放授权、终止开放提案、generation+1、
   *    更新 blockedReason（仍有 unresolved 则保持 blocked）、追加 tx.unknown_resolved。
   *  - 绝不改写原执行结果，绝不自动重发或自动批准。
   */
  resolveUnknown(proposalId: string, params: ResolveUnknownParams): ExecutionResolution {
    if (typeof proposalId !== "string" || proposalId.trim().length === 0) {
      throw new ControllerError("invalid_params", "proposalId must be a non-empty string");
    }
    if (proposalId.length > RESOLUTION_PROPOSAL_ID_MAX_LENGTH) {
      throw new ControllerError("invalid_params", `proposalId exceeds ${RESOLUTION_PROPOSAL_ID_MAX_LENGTH} characters`);
    }
    if (params.confirmStopped !== true) {
      throw new ControllerError("invalid_params", "confirmStopped must be exactly true");
    }
    const operator = params.operator;
    if (typeof operator !== "string" || operator.trim().length === 0) {
      throw new ControllerError("invalid_params", "operator must be a non-empty string");
    }
    if (operator.length > RESOLUTION_OPERATOR_MAX_LENGTH) {
      throw new ControllerError("invalid_params", `operator exceeds ${RESOLUTION_OPERATOR_MAX_LENGTH} characters`);
    }
    const note = params.note;
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new ControllerError("invalid_params", "note must be a non-empty string");
    }
    if (note.length > RESOLUTION_NOTE_MAX_LENGTH) {
      throw new ControllerError("invalid_params", `note exceeds ${RESOLUTION_NOTE_MAX_LENGTH} characters`);
    }

    // 幂等：同 ID 已成功解除的重试返回既有记录，绝不重复审计或改变 generation。
    const existing = this.journal.getResolution(proposalId);
    if (existing) return existing;

    if (this.faultLatch !== null) {
      throw new ControllerError("blocked", `persistence fault latched; resolve-unknown is refused: ${this.faultLatch}`);
    }
    if (!this.recovered) {
      throw new ControllerError("blocked", "startup recovery has not completed; resolve-unknown is refused");
    }
    if (this.active || this.state.txBusy) {
      throw new ControllerError("busy", "a transmission is in flight; resolve-unknown is refused");
    }
    if (!this.state.backendConnected) {
      throw new ControllerError("conflict", "backend disconnected; resolve-unknown is refused");
    }

    const execution = this.journal.getExecution(proposalId);
    if (!execution) throw new ControllerError("not_found", `no execution found for proposal ${proposalId}`);
    if (execution.status === "running") {
      throw new ControllerError("conflict", `execution ${proposalId} is still running; stop the station and restart first`);
    }
    if (execution.status !== "unknown") {
      throw new ControllerError("conflict", `execution ${proposalId} is not unknown (status=${execution.status})`);
    }
    if (!this.eligibleUnknownIds.has(proposalId)) {
      throw new ControllerError(
        "conflict",
        `unknown execution ${proposalId} was created after this daemon started; stop and restart before resolving`,
      );
    }

    const resolvedAt = new Date().toISOString();
    const resolution: ExecutionResolution = {
      proposalId,
      contractVersion: 1,
      resolvedAt,
      operator,
      note,
      confirmedStopped: true,
    };

    let nextGeneration = this.state.generation;
    let nextBlockedReason = this.state.blockedReason;
    try {
      this.journal.transaction(() => {
        this.journal.insertResolution(resolution);
        const revoked = this.journal.revokeAllApprovals(resolvedAt, `unknown-resolved:${proposalId}`);
        const terminated = this.journal.terminateOpenProposals("cancelled");

        nextGeneration = this.state.generation + 1;
        const remaining = this.journal.findUnresolvedUnknowns();
        nextBlockedReason = remaining.length > 0 ? this.unknownBlockReason(remaining) : this.preservedBlockedReason;

        this.journal.saveState({
          frequencyHz: this.state.frequencyHz,
          mode: this.state.mode,
          generation: nextGeneration,
          blockedReason: nextBlockedReason,
          storageFault: this.faultLatch,
        });
        this.appendAudit("tx.unknown_resolved", proposalId, {
          operator,
          note,
          confirmedStopped: true,
          resolvedAt,
          stateGeneration: nextGeneration,
          remainingUnknowns: remaining.length,
          approvalsRevoked: revoked,
          proposalsTerminated: terminated.length,
        });
      });
    } catch (error) {
      // 原子回滚：resolution/audit/generation 都不落盘；保持 blocked 并闩锁存储故障。
      const reason = this.latchPersistenceFault(`failed to persist unknown resolution for ${proposalId}: ${String(error)}`);
      throw new ControllerError("internal", reason);
    }

    // 仅在事务提交成功后更新内存态。
    this.state.generation = nextGeneration;
    this.state.blockedReason = nextBlockedReason;
    this.eligibleUnknownIds.delete(proposalId);
    return resolution;
  }

  propose(params: ProposeParams): Proposal {
    const text = typeof params.text === "string" ? params.text : "";
    if (text.trim().length === 0) throw new ControllerError("invalid_params", "message cannot be empty");
    if (text.length > this.maxTextLength) {
      throw new ControllerError("invalid_params", `message exceeds ${this.maxTextLength} characters`);
    }

    const frequencyHz = params.frequencyHz ?? this.state.frequencyHz;
    const mode = params.mode ?? this.state.mode;
    if (!Number.isInteger(frequencyHz) || frequencyHz < this.minFrequencyHz || frequencyHz > this.maxFrequencyHz) {
      throw new ControllerError("invalid_params", `frequencyHz out of range [${this.minFrequencyHz}, ${this.maxFrequencyHz}]`);
    }
    if (mode !== "CW") throw new ControllerError("invalid_params", `unsupported mode: ${String(mode)}`);
    if (frequencyHz !== this.state.frequencyHz || mode !== this.state.mode) {
      throw new ControllerError("invalid_params", "proposal must match current station frequency/mode; change station state first");
    }

    const ttlMs = params.ttlMs ?? this.proposalTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > this.maxProposalTtlMs) {
      throw new ControllerError("invalid_params", `ttlMs out of range [1000, ${this.maxProposalTtlMs}]`);
    }

    const now = Date.now();
    const proposal: Proposal = {
      id: randomUUID(),
      contractVersion: 1,
      text,
      frequencyHz,
      mode,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      stateGeneration: this.state.generation,
      status: "pending",
      contentSha256: contentHash(text, frequencyHz, mode),
    };

    this.journal.transaction(() => {
      this.journal.insertProposal(proposal);
      this.appendAudit("proposal.created", proposal.id, {
        text,
        frequencyHz,
        mode,
        stateGeneration: proposal.stateGeneration,
        expiresAt: proposal.expiresAt,
      });
    });
    return proposal;
  }

  /** 服务端创建一次性批准；重复调用返回仍有效的同一批准。 */
  approve(id: string): Approval {
    const proposal = this.journal.getProposal(id);
    if (!proposal) throw new ControllerError("not_found", `unknown proposal: ${id}`);

    // 设备能力门禁：在返回既有批准或写入新批准之前同步复核；抛出即不落盘。
    this.approvalGuard?.(proposal);

    const existing = this.journal.getApproval(id);
    if (proposal.status === "approved" && existing && !existing.consumedAt && !existing.revokedAt && Date.parse(existing.expiresAt) > Date.now()) {
      if (existing.stateGeneration !== this.state.generation) {
        throw new ControllerError("conflict", "approval belongs to a previous station generation");
      }
      return existing;
    }

    if (proposal.status === "expired") throw new ControllerError("expired", "proposal expired");
    if (proposal.status !== "pending") {
      throw new ControllerError("conflict", `proposal is not pending (status=${proposal.status})`);
    }
    if (Date.now() >= Date.parse(proposal.expiresAt)) {
      this.journal.transaction(() => {
        this.journal.setProposalStatus(id, "expired");
        this.appendAudit("proposal.expired", id, {});
      });
      throw new ControllerError("expired", "proposal expired");
    }
    if (proposal.stateGeneration !== this.state.generation) {
      this.journal.transaction(() => {
        this.journal.setProposalStatus(id, "cancelled");
        this.appendAudit("proposal.cancelled", id, { reason: "generation-mismatch" });
      });
      throw new ControllerError("conflict", "station state changed; proposal no longer valid");
    }
    if (!this.state.backendConnected) throw new ControllerError("conflict", "backend disconnected");

    const now = Date.now();
    const approval: Approval = {
      proposalId: id,
      approvedAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(Date.parse(proposal.expiresAt), now + this.approvalTtlMs)).toISOString(),
      contentSha256: proposal.contentSha256,
      frequencyHz: proposal.frequencyHz,
      mode: proposal.mode,
      stateGeneration: proposal.stateGeneration,
      consumedAt: null,
      revokedAt: null,
      revokedReason: null,
    };

    this.journal.transaction(() => {
      this.journal.insertApproval(approval);
      this.journal.setProposalStatus(id, "approved");
      this.appendAudit("proposal.approved", id, {
        contentSha256: approval.contentSha256,
        expiresAt: approval.expiresAt,
        stateGeneration: approval.stateGeneration,
      });
    });
    return approval;
  }

  /** 执行已批准的提案。返回持久化执行记录；重复请求返回既有记录，不重新键控。 */
  async transmit(id: string): Promise<Execution> {
    const existing = this.journal.getExecution(id);
    if (existing) {
      if (existing.status === "running") {
        throw new ControllerError("busy", `execution already in flight for proposal ${id}`);
      }
      this.journal.append(this.auditEvent("tx.repeat_request", id, { status: existing.status }));
      return existing;
    }

    if (this.state.blockedReason !== null) {
      throw new ControllerError("blocked", `station blocked: ${this.state.blockedReason}`);
    }
    if (this.active) throw new ControllerError("busy", "another transmission is active");

    const proposal = this.journal.getProposal(id);
    if (!proposal) throw new ControllerError("not_found", `unknown proposal: ${id}`);
    // 设备能力门禁：终态幂等查询之后、消费批准/写 intent 之前同步复核。
    this.approvalGuard?.(proposal);
    if (proposal.status !== "approved") {
      throw new ControllerError("conflict", `proposal is not approved (status=${proposal.status})`);
    }

    const approval = this.journal.getApproval(id);
    if (!approval) throw new ControllerError("conflict", "no server-side approval exists");
    if (approval.revokedAt) throw new ControllerError("unauthorized", `approval revoked: ${approval.revokedReason ?? "unknown"}`);
    if (approval.consumedAt) throw new ControllerError("conflict", "approval already consumed");

    const now = Date.now();
    if (now >= Date.parse(proposal.expiresAt) || now >= Date.parse(approval.expiresAt)) {
      this.journal.transaction(() => {
        this.journal.setProposalStatus(id, "expired");
        this.appendAudit("proposal.expired", id, {});
      });
      throw new ControllerError("expired", "approval or proposal expired");
    }
    if (proposal.stateGeneration !== this.state.generation || approval.stateGeneration !== this.state.generation) {
      throw new ControllerError("conflict", "station state changed; authorization revoked");
    }
    if (approval.contentSha256 !== proposal.contentSha256) {
      throw new ControllerError("unauthorized", "approval content hash mismatch");
    }
    if (
      approval.frequencyHz !== proposal.frequencyHz ||
      approval.mode !== proposal.mode ||
      proposal.frequencyHz !== this.state.frequencyHz ||
      proposal.mode !== this.state.mode
    ) {
      throw new ControllerError("conflict", "approval does not match current frequency/mode");
    }
    if (!this.state.backendConnected) throw new ControllerError("conflict", "backend disconnected");

    const startedAt = new Date(now).toISOString();
    const execution: Execution = {
      proposalId: id,
      requestId: id,
      status: "running",
      startedAt,
      finishedAt: null,
      detail: null,
      frequencyHz: proposal.frequencyHz,
      mode: proposal.mode,
      stateGeneration: proposal.stateGeneration,
      contentSha256: proposal.contentSha256,
    };

    // 在执行任何副作用前原子持久化 intent；失败则不键控（fail closed）。
    const abort = new AbortController();
    this.active = { proposalId: id, abort };
    this.abortReason = null;
    this.state.txBusy = true;
    try {
      this.journal.transaction(() => {
        this.journal.setProposalStatus(id, "consumed");
        this.journal.consumeApproval(id, startedAt);
        this.journal.insertExecution(execution);
        this.appendAudit("tx.started", id, {
          frequencyHz: proposal.frequencyHz,
          mode: proposal.mode,
          contentSha256: proposal.contentSha256,
          stateGeneration: proposal.stateGeneration,
        });
      });
    } catch (error) {
      this.active = undefined;
      this.abortReason = null;
      this.state.txBusy = false;
      // 写入失败必须阻止后续执行：无法证明授权已被消费，绝不重试键控，并闩锁解除路径。
      const reason = this.latchPersistenceFault(`failed to persist transmission intent for ${id}: ${String(error)}`);
      throw new ControllerError("internal", reason);
    }

    let outcome: TxOutcome = "unknown";
    let detail: string | null = null;
    try {
      const result = await this.runKeyer(proposal, approval, abort);
      outcome = result.outcome;
      detail = result.detail;
    } finally {
      this.active = undefined;
      this.state.txBusy = false;
      this.abortReason = null;
    }

    const finishedAt = new Date().toISOString();
    try {
      this.journal.transaction(() => {
        this.journal.updateExecutionStatus(id, outcome, finishedAt, detail);
        if (outcome === "unknown") {
          this.state.blockedReason = `unresolved unknown execution ${id}; stop cannot be confirmed`;
        }
        this.journal.saveState({
          frequencyHz: this.state.frequencyHz,
          mode: this.state.mode,
          generation: this.state.generation,
          blockedReason: this.state.blockedReason,
          storageFault: this.faultLatch,
        });
        this.appendAudit(`tx.${outcome}`, id, { detail });
      });
    } catch (error) {
      // 结果已无法可靠落盘：保持 fail closed，阻止后续发射，并闩锁解除路径。
      const reason = this.latchPersistenceFault(`failed to persist tx outcome for ${id}: ${String(error)}`);
      throw new ControllerError("internal", reason);
    }

    const stored = this.journal.getExecution(id);
    if (!stored) throw new ControllerError("internal", `execution record missing after tx: ${id}`);
    return stored;
  }

  /**
   * 在独立的有界超时内运行键控器。
   *  - 即使后端永不返回，也在 txTimeoutMs 后判 unknown 并解除阻塞。
   *  - unknown 一旦确定，迟到的完成/异常绝不允许覆盖结果（settled 保护）。
   *  - 只有 KeyerAbortError 才可解释为“取消成功”；其它异常一律 unknown。
   *  - 返回值必须与请求 requestId 匹配，且 outcome 合法，否则 unknown。
   */
  private runKeyer(
    proposal: Proposal,
    approval: Approval,
    abort: AbortController,
  ): Promise<{ outcome: TxOutcome; detail: string | null }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { outcome: TxOutcome; detail: string | null }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        if (this.abortReason === null) this.abortReason = "timeout";
        abort.abort();
        finish({
          outcome: "unknown",
          detail: `keyer did not return within ${this.txTimeoutMs}ms; stop not confirmed`,
        });
      }, this.txTimeoutMs);

      let result: Promise<{ requestId: string; outcome: TxOutcome; detail?: string }>;
      try {
        result = this.keyer.transmit({ proposal, approval, timeoutMs: this.txTimeoutMs }, abort.signal);
      } catch (error) {
        // 同步抛出的后端异常同样不得推断为取消成功。
        finish({ outcome: "unknown", detail: `keyer threw: ${String(error)}` });
        return;
      }

      result.then(
        (value) => {
          if (settled) return; // 超时后迟到完成：绝不覆盖 unknown。
          if (!value || value.requestId !== proposal.id) {
            finish({ outcome: "unknown", detail: "keyer returned a mismatched requestId" });
            return;
          }
          if (value.outcome !== "completed" && value.outcome !== "cancelled" && value.outcome !== "timed_out" && value.outcome !== "unknown") {
            finish({ outcome: "unknown", detail: `keyer returned invalid outcome: ${String(value.outcome)}` });
            return;
          }
          // 超时 / 状态改变 / 断连 / 关闭后即使键控器“完成”，也不能证明真实停止。
          if (this.abortReason !== null && this.abortReason !== "operator") {
            finish({ outcome: "unknown", detail: `keying returned after ${this.abortReason}; stop not confirmed` });
            return;
          }
          if (value.outcome === "cancelled" && this.abortReason === "operator") {
            finish({ outcome: "cancelled", detail: "operator abort" });
            return;
          }
          if (value.outcome === "timed_out") {
            abort.abort();
            finish({ outcome: "unknown", detail: value.detail ?? "keyer reported timeout; stop not confirmed" });
            return;
          }
          finish({ outcome: value.outcome, detail: value.detail ?? null });
        },
        (error: unknown) => {
          if (settled) return; // 迟到异常同样不覆盖已确定结果。
          if (error instanceof KeyerAbortError) {
            if (this.abortReason === "operator") {
              finish({ outcome: "cancelled", detail: "operator abort" });
            } else {
              finish({ outcome: "unknown", detail: `aborted (${this.abortReason ?? "unknown"}); stop not confirmed` });
            }
            return;
          }
          // 任意后端异常：不得只因 signal.aborted 就推断取消成功。
          finish({ outcome: "unknown", detail: `keyer error: ${String(error)}` });
        },
      );
    });
  }

  /** 操作员 abort：抢占在途发射。 */
  abort(): { aborted: boolean; proposalId: string | null } {
    if (!this.active) return { aborted: false, proposalId: null };
    const proposalId = this.active.proposalId;
    if (this.abortReason === null) this.abortReason = "operator";
    this.active.abort.abort();
    this.journal.append(this.auditEvent("tx.abort_requested", proposalId, { reason: "operator" }));
    return { aborted: true, proposalId };
  }

  /** 状态改变 / 后端断连：写入新真值、撤销授权，并抢占在途发射。 */
  setState(patch: { frequencyHz?: number; mode?: StationMode; backendConnected?: boolean }, reason: string): StationState {
    const nextFrequency = patch.frequencyHz ?? this.state.frequencyHz;
    const nextMode = patch.mode ?? this.state.mode;
    if (!Number.isInteger(nextFrequency) || nextFrequency < this.minFrequencyHz || nextFrequency > this.maxFrequencyHz) {
      throw new ControllerError("invalid_params", `frequencyHz out of range [${this.minFrequencyHz}, ${this.maxFrequencyHz}]`);
    }
    if (nextMode !== "CW") throw new ControllerError("invalid_params", `unsupported mode: ${String(nextMode)}`);

    const frequencyChanged = nextFrequency !== this.state.frequencyHz;
    const modeChanged = nextMode !== this.state.mode;
    const disconnecting = patch.backendConnected === false && this.state.backendConnected;

    const previous = {
      frequencyHz: this.state.frequencyHz,
      mode: this.state.mode,
      backendConnected: this.state.backendConnected,
    };

    // 频率/模式是台站真值：必须写入内存，随后持久化到 station_state。
    this.state.frequencyHz = nextFrequency;
    this.state.mode = nextMode;
    if (patch.backendConnected !== undefined) this.state.backendConnected = patch.backendConnected;

    if (frequencyChanged || modeChanged || disconnecting) {
      const invalidateReason = reason || (disconnecting ? "backend-disconnected" : "state-changed");
      const abortReason: AbortReason = disconnecting ? "backend-disconnect" : "state-change";
      try {
        // 频率/模式变化同样使在途发射的物理条件失效，必须抢占。
        this.invalidate(invalidateReason, true, abortReason);
      } catch (error) {
        // 持久化失败：回滚内存真值并 fail closed，避免内存与数据库不一致；同时闩锁解除路径。
        this.state.frequencyHz = previous.frequencyHz;
        this.state.mode = previous.mode;
        this.state.backendConnected = previous.backendConnected;
        const reason = this.latchPersistenceFault(
          `failed to persist station state change (${invalidateReason}): ${String(error)}`,
        );
        throw error instanceof ControllerError ? error : new ControllerError("internal", reason);
      }
    }
    return { ...this.state };
  }

  /** 递增 generation 并撤销所有开放授权；事务提交后才更新内存 generation。 */
  invalidate(reason: string, abortInFlight = false, abortReason: AbortReason = "state-change"): void {
    // 停止请求不能依赖数据库写入成功。
    if (abortInFlight && this.active) {
      if (this.abortReason === null) this.abortReason = abortReason;
      this.active.abort.abort();
    }
    const now = new Date().toISOString();
    const nextGeneration = this.state.generation + 1;
    try {
      this.journal.transaction(() => {
        const terminated = this.journal.terminateOpenProposals("cancelled");
        const revoked = this.journal.revokeAllApprovals(now, reason);
        this.journal.saveState({
          frequencyHz: this.state.frequencyHz,
          mode: this.state.mode,
          generation: nextGeneration,
          blockedReason: this.state.blockedReason,
          storageFault: this.faultLatch,
        });
        this.appendAudit("authorization.invalidated", "station", {
          reason,
          generation: nextGeneration,
          proposalsTerminated: terminated.length,
          approvalsRevoked: revoked,
        });
      });
    } catch (error) {
      // 授权失效无法落盘：闩锁解除路径，绝不冒险让清除阻止的操作通过。
      this.latchPersistenceFault(`failed to persist authorization invalidation (${reason}): ${String(error)}`);
      throw error;
    }
    // 仅在事务提交成功后更新内存，回滚时保持一致。
    this.state.generation = nextGeneration;

  }

  /** 关闭时撤销开放授权并等待在途发射有限时间；不得把未完成操作记为 completed。 */
  async shutdown(timeoutMs = 3_000): Promise<{ aborted: boolean; outcome: TxOutcome | null }> {
    const inFlight = this.active;
    if (!inFlight) return { aborted: false, outcome: null };

    if (this.abortReason === null) this.abortReason = "shutdown";
    inFlight.abort.abort();
    this.journal.append(this.auditEvent("tx.abort_requested", inFlight.proposalId, { reason: "shutdown" }));

    const settled = await Promise.race([
      this.waitForIdle(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
    ]);

    if (settled === "timeout") {
      // 无法证明停止：记录 unknown 并阻止后续执行。
      const now = new Date().toISOString();
      try {
        this.journal.transaction(() => {
          this.journal.updateExecutionStatus(inFlight.proposalId, "unknown", now, "daemon shutdown could not confirm stop");
          this.journal.setProposalStatus(inFlight.proposalId, "cancelled");
          this.state.blockedReason = `shutdown left unresolved execution ${inFlight.proposalId}`;
          this.journal.saveState({
            frequencyHz: this.state.frequencyHz,
            mode: this.state.mode,
            generation: this.state.generation,
            blockedReason: this.state.blockedReason,
            storageFault: this.faultLatch,
          });
          this.appendAudit("tx.unknown", inFlight.proposalId, { reason: "shutdown-timeout" });
        });
      } catch (error) {
        // 数据库可能已不可写；内存状态仍保持 blocked 并闩锁解除路径。
        this.latchPersistenceFault(`failed to persist shutdown unknown for ${inFlight.proposalId}: ${String(error)}`);
      }
      return { aborted: true, outcome: "unknown" };
    }

    const stored = this.journal.getExecution(inFlight.proposalId);
    return { aborted: true, outcome: stored?.status === "running" ? "unknown" : (stored?.status ?? null) };
  }

  private waitForIdle(): Promise<"idle"> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.active) resolve("idle");
        else setTimeout(check, 10);
      };
      check();
    });
  }

  /** 由当前 unresolved 列表生成稳定、可读的阻止原因。 */
  private unknownBlockReason(executions: Execution[]): string {
    const first = executions[0];
    if (!first) return "unresolved unknown execution; operator review required before further transmit";
    const more = executions.length > 1 ? ` (+${executions.length - 1} more unresolved)` : "";
    return `unresolved unknown execution ${first.proposalId} (started ${first.startedAt})${more}; operator review required before further transmit`;
  }

  /** 记录持久化故障并闩锁解除路径；返回原因字符串。 */
  private latchPersistenceFault(message: string): string {
    this.faultLatch = message;
    this.state.blockedReason = message;
    try {
      this.journal.saveStorageFault(message);
    } catch {
      // 数据库完全不可写时，故障闩锁仍在当前进程生效。
    }
    return message;
  }

  private appendAudit(type: string, entityId: string, payload: Record<string, unknown>): void {
    this.journal.append(this.auditEvent(type, entityId, payload));
  }

  private auditEvent(type: string, entityId: string, payload: Record<string, unknown>): AuditEvent {
    return { id: randomUUID(), at: new Date().toISOString(), type, entityId, payload };
  }
}
