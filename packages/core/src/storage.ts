// 核心定义的最小存储端口（port）。
// 目的：核心只依赖此接口，不依赖具体 SQLite 实现；SQLite 适配器实现它。
// 依赖方向：core → contracts；journal → core（仅类型）。core 不反向依赖 journal。

import type {
  Approval,
  AuditEvent,
  Execution,
  ExecutionResolution,
  Proposal,
  ProposalStatus,
  StationMode,
} from "../../contracts/src/index.js";

/** 持久化的台站真值子集（不含内存态 txBusy/backendConnected）。 */
export interface PersistedStationState {
  frequencyHz: number;
  mode: StationMode;
  generation: number;
  blockedReason: string | null;
  storageFault?: string | null;
}

/**
 * TxController 与 daemon 需要的最小存储能力。
 * 任何写入失败必须向上抛出；调用方据此 fail closed，绝不带病继续发射。
 */
export interface TxJournalStore {
  readonly schemaVersion: number;

  /** 原子事务；嵌套调用复用外层事务。 */
  transaction<T>(fn: () => T): T;

  // ── 审计 ──
  append(event: AuditEvent): void;
  recent(limit?: number): AuditEvent[];
  countAudit(): number;

  // ── 汇总 ──
  countProposalsByStatus(): Record<string, number>;
  countExecutionsByStatus(): Record<string, number>;
  getApprovalStatusCounts(): { active: number; consumed: number; revoked: number };

  // ── 台站状态 ──
  loadState(): PersistedStationState;
  saveState(state: PersistedStationState): void;
  saveStorageFault(reason: string): void;

  // ── 提案 ──
  insertProposal(proposal: Proposal): void;
  getProposal(id: string): Proposal | undefined;
  listProposals(limit?: number): Proposal[];
  setProposalStatus(id: string, status: ProposalStatus): void;
  terminateOpenProposals(status: ProposalStatus): string[];
  /** 批量终止全部开放提案：到期者 expired，其余 cancelled；返回各类计数。 */
  terminateOpenProposalsByExpiry(now: string): { expired: number; cancelled: number };

  // ── 批准 ──
  insertApproval(approval: Approval): void;
  getApproval(proposalId: string): Approval | undefined;
  consumeApproval(proposalId: string, at: string): void;
  revokeAllApprovals(at: string, reason: string): number;

  // ── 执行 ──
  insertExecution(execution: Execution): void;
  getExecution(proposalId: string): Execution | undefined;
  updateExecutionStatus(
    proposalId: string,
    status: Execution["status"],
    finishedAt: string | null,
    detail: string | null,
  ): void;
  listExecutions(limit?: number): Execution[];
  findRunningExecutions(): Execution[];
  findLastUnknownExecution(): Execution | undefined;

  // ── unknown 核查解除 ──
  /** 全部未解除的 unknown 执行（排除已有 resolution 的），无任意 LIMIT，按开始时间升序。 */
  findUnresolvedUnknowns(): Execution[];
  /** 最近一条未解除的 unknown 执行，用于恢复时写入阻止原因。 */
  findLastUnresolvedUnknown(): Execution | undefined;
  getResolution(proposalId: string): ExecutionResolution | undefined;
  listResolutions(limit?: number): ExecutionResolution[];
  insertResolution(resolution: ExecutionResolution): void;
  countResolutions(): number;
}
