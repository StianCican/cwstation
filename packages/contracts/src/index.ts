// 版本化契约：命令、事件、结果与本地 RPC 协议。
// 规则：修改破坏兼容性的字段必须提升 contractVersion / protocolVersion，
// 并在 journal 迁移中保留旧数据。

export const CONTRACT_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const;

// unknown 人工核查解除的参数上限。operator/note 必须非空且不超过上限；
// 仅追加接口与记录，不构成破坏性契约变化，故 CONTRACT_VERSION / PROTOCOL_VERSION 保持 1。
export const RESOLUTION_PROPOSAL_ID_MAX_LENGTH = 128;
export const RESOLUTION_OPERATOR_MAX_LENGTH = 64;
export const RESOLUTION_NOTE_MAX_LENGTH = 500;

/** 首版只有 CW；扩展模式时新增联合成员并提升版本。 */
export type StationMode = "CW";

/** 提案生命周期：pending → approved → consumed；其余为终止态。 */
export type ProposalStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "rejected"
  | "expired"
  | "cancelled";

/** 发射结果。unknown 表示无法证明已停止，必须 fail closed。 */
export type TxOutcome = "completed" | "cancelled" | "timed_out" | "unknown";
export type ExecutionStatus = "running" | TxOutcome;

/** 台站状态。blockedReason 非空时禁止新的发射。 */
export interface StationState {
  frequencyHz: number;
  mode: StationMode;
  txBusy: boolean;
  backendConnected: boolean;
  generation: number;
  blockedReason: string | null;
}

/** 提案：不可变内容 + 频率/模式/generation 绑定 + 期限。 */
export interface Proposal {
  id: string;
  contractVersion: typeof CONTRACT_VERSION;
  text: string;
  frequencyHz: number;
  mode: StationMode;
  createdAt: string;
  expiresAt: string;
  stateGeneration: number;
  status: ProposalStatus;
  contentSha256: string;
}

/** 服务端创建的一次性批准。consumedAt 一旦写入就不可再次发射。 */
export interface Approval {
  proposalId: string;
  approvedAt: string;
  expiresAt: string;
  contentSha256: string;
  frequencyHz: number;
  mode: StationMode;
  stateGeneration: number;
  consumedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** 一次发射尝试的持久化记录。每个提案最多一条（同 ID 重复执行不重新键控）。 */
export interface Execution {
  proposalId: string;
  requestId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string | null;
  detail: string | null;
  frequencyHz: number;
  mode: StationMode;
  stateGeneration: number;
  contentSha256: string;
}

/**
 * unknown 人工核查记录（独立于 Execution，绝不改写原执行结果）。
 * confirmedStopped 只能是 true：这是操作人的声明，不是物理停发证明。
 */
export interface ExecutionResolution {
  proposalId: string;
  contractVersion: typeof CONTRACT_VERSION;
  resolvedAt: string;
  operator: string;
  note: string;
  confirmedStopped: true;
}

/** 未解除的 unknown 执行；resolutionEligible 表示本进程是否允许解除该条。 */
export interface UnresolvedUnknown extends Execution {
  resolutionEligible: boolean;
}

/** 启动恢复限制与故障闩锁的只读摘要，供 status / doctor / unresolved 暴露。 */
export interface UnknownReviewSummary {
  /** 仍未解除的 unknown 执行数（原执行保持 unknown，永不改写）。 */
  unresolvedUnknownCount: number;
  /** 本进程启动恢复时已存在、当前可解除的条数。 */
  eligibleToResolve: number;
  /** 本次启动后新增、必须先停机重启才能核查的条数。 */
  requiresRestart: number;
  /** 本进程是否已发生持久化故障（true 时禁止解除）。 */
  faultLatched: boolean;
  /** 是否已完成启动恢复。 */
  recovered: boolean;
}

/** 传给键控器的请求；已是服务端内部类型，不直接暴露给 CLI。 */
export interface TxRequest {
  proposal: Proposal;
  approval: Approval;
  timeoutMs: number;
}

export interface TxResult {
  requestId: string;
  outcome: TxOutcome;
  startedAt: string;
  finishedAt: string;
  detail?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
}

/** 提交给服务端的提案参数（运行时校验）。 */
export interface ProposeParams {
  text: string;
  frequencyHz?: number;
  mode?: StationMode;
  ttlMs?: number;
}

// ── 本地 RPC 协议（NDJSON，每行一个 JSON 对象） ───────────────────────────

export type RpcErrorCode =
  | "invalid_request"
  | "invalid_params"
  | "protocol_version"
  | "unknown_method"
  | "not_found"
  | "conflict"
  | "busy"
  | "expired"
  | "blocked"
  | "unauthorized"
  | "unavailable"
  | "internal"
  | "request_timeout";

export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

export interface RpcRequest {
  protocolVersion: number;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  protocolVersion: number;
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: RpcError;
}
