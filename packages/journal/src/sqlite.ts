// SQLite 持久化：提案、批准、执行记录、台站状态与审计。
// 设计要点：
//  - 显式版本化迁移；数据库版本高于程序支持版本时拒绝打开（fail closed）。
//  - 保留 v1 已有的 audit_events 数据。
//  - 状态变更与审计写入由 transaction() 包裹，保证原子性。
//  - 写入失败向上抛出，由调用方在产生副作用前终止。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Approval,
  AuditEvent,
  Execution,
  ExecutionResolution,
  Proposal,
  ProposalStatus,
  StationMode,
} from "../../contracts/src/index.js";
import type { PersistedStationState, TxJournalStore } from "../../core/src/storage.js";

/** 当前程序支持的最新 schema 版本。 */
export const SCHEMA_VERSION = 4;

interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

const MODE: StationMode = "CW";
const DEFAULT_FREQUENCY_HZ = 7_030_000;

// v1：与最初骨架一致，仅 schema_version + audit_events。
const migrationV1: Migration = {
  version: 1,
  up(db) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);" +
        "INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);" +
        "CREATE TABLE IF NOT EXISTS audit_events (" +
        "  id TEXT PRIMARY KEY," +
        "  at TEXT NOT NULL," +
        "  type TEXT NOT NULL," +
        "  entity_id TEXT NOT NULL," +
        "  payload_json TEXT NOT NULL" +
        ");",
    );
  },
};

// v2：提案 / 批准 / 执行 / 台站状态。
const migrationV2: Migration = {
  version: 2,
  up(db) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS proposals (" +
        "  id TEXT PRIMARY KEY," +
        "  contract_version INTEGER NOT NULL," +
        "  text TEXT NOT NULL," +
        "  frequency_hz INTEGER NOT NULL," +
        "  mode TEXT NOT NULL," +
        "  created_at TEXT NOT NULL," +
        "  expires_at TEXT NOT NULL," +
        "  state_generation INTEGER NOT NULL," +
        "  status TEXT NOT NULL," +
        "  content_sha256 TEXT NOT NULL" +
        ");" +
        "CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals (created_at DESC);" +
        "CREATE TABLE IF NOT EXISTS approvals (" +
        "  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id)," +
        "  approved_at TEXT NOT NULL," +
        "  expires_at TEXT NOT NULL," +
        "  content_sha256 TEXT NOT NULL," +
        "  frequency_hz INTEGER NOT NULL," +
        "  mode TEXT NOT NULL," +
        "  state_generation INTEGER NOT NULL," +
        "  consumed_at TEXT," +
        "  revoked_at TEXT," +
        "  revoked_reason TEXT" +
        ");" +
        "CREATE TABLE IF NOT EXISTS executions (" +
        "  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id)," +
        "  request_id TEXT NOT NULL," +
        "  status TEXT NOT NULL," +
        "  started_at TEXT NOT NULL," +
        "  finished_at TEXT," +
        "  detail TEXT," +
        "  frequency_hz INTEGER NOT NULL," +
        "  mode TEXT NOT NULL," +
        "  state_generation INTEGER NOT NULL," +
        "  content_sha256 TEXT NOT NULL" +
        ");" +
        "CREATE INDEX IF NOT EXISTS idx_executions_status ON executions (status);" +
        "CREATE TABLE IF NOT EXISTS station_state (" +
        "  id INTEGER PRIMARY KEY CHECK (id = 1)," +
        "  frequency_hz INTEGER NOT NULL," +
        "  mode TEXT NOT NULL," +
        "  generation INTEGER NOT NULL," +
        "  blocked_reason TEXT" +
        ");" +
        "INSERT INTO station_state (id, frequency_hz, mode, generation, blocked_reason) " +
        "  SELECT 1, " +
        DEFAULT_FREQUENCY_HZ +
        ", '" +
        MODE +
        "', 0, NULL WHERE NOT EXISTS (SELECT 1 FROM station_state);",
    );
  },
};

// v3：unknown 人工核查解除记录。仅新增表，绝不改写 executions.status，
// 保留 v1/v2 已有的审计、提案、批准与执行数据。
const migrationV3: Migration = {
  version: 3,
  up(db) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS execution_resolutions (" +
        "  proposal_id TEXT PRIMARY KEY REFERENCES executions(proposal_id)," +
        "  contract_version INTEGER NOT NULL," +
        "  resolved_at TEXT NOT NULL," +
        "  operator TEXT NOT NULL," +
        "  note TEXT NOT NULL," +
        "  confirmed_stopped INTEGER NOT NULL CHECK (confirmed_stopped = 1)" +
        ");" +
        "CREATE INDEX IF NOT EXISTS idx_resolutions_resolved ON execution_resolutions (resolved_at DESC);",
    );
  },
};

const migrationV4: Migration = {
  version: 4,
  up(db) {
    db.exec("ALTER TABLE station_state ADD COLUMN storage_fault TEXT;");
    // 旧库没有故障分类：仅识别由旧控制器生成的完整 unknown 文案，其他阻止保守保留。
    const state = db.prepare("SELECT blocked_reason FROM station_state WHERE id = 1").get();
    const reason = state?.blocked_reason;
    if (typeof reason !== "string") return;
    const unknowns = db.prepare(
      "SELECT e.proposal_id, e.started_at FROM executions e LEFT JOIN execution_resolutions r ON r.proposal_id = e.proposal_id " +
      "WHERE e.status = 'unknown' AND r.proposal_id IS NULL ORDER BY e.started_at DESC, e.proposal_id DESC",
    ).all();
    const knownReasons = new Set<string>();
    for (const execution of unknowns) {
      const id = execution.proposal_id;
      const started = execution.started_at;
      knownReasons.add(`unresolved unknown execution ${id}; stop cannot be confirmed`);
      knownReasons.add(`unresolved unknown execution ${id} (started ${started}); notify operator before further transmit`);
      knownReasons.add(`shutdown left unresolved execution ${id}`);
      const more = unknowns.length > 1 ? ` (+${unknowns.length - 1} more unresolved)` : "";
      knownReasons.add(`unresolved unknown execution ${id} (started ${started})${more}; operator review required before further transmit`);
    }
    if (!knownReasons.has(reason)) {
      db.prepare("UPDATE station_state SET storage_fault = ? WHERE id = 1").run(reason);
    }
  },
};

const MIGRATIONS: Migration[] = [migrationV1, migrationV2, migrationV3, migrationV4];

export class SchemaVersionError extends Error {}
export class DatabaseLockedError extends Error {}

type Row = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class SqliteJournal implements TxJournalStore {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get schemaVersion(): number {
    return this.readVersion();
  }

  /** 显式迁移：拒绝未来版本，逐版本应用，保护既有数据。 */
  private migrate(): void {
    const current = this.readVersion();
    if (current > SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `database schema version ${current} is newer than supported version ${SCHEMA_VERSION}; refusing to open ${this.path}`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        migration.up(this.db);
        this.writeVersion(migration.version);
      });
    }
  }

  private readVersion(): number {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as Row | undefined;
    if (!table) return 0;
    const row = this.db.prepare("SELECT version FROM schema_version ORDER BY rowid LIMIT 1").get() as Row | undefined;
    return row ? num(row.version) : 0;
  }

  private writeVersion(version: number): void {
    this.db.exec("DELETE FROM schema_version;");
    this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  }

  /** 原子事务；嵌套调用复用外层事务。 */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE;");
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // 回滚失败时保留原始错误；连接随后会被关闭。
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  // ── 审计 ────────────────────────────────────────────────────────────────
  append(event: AuditEvent): void {
    this.transaction(() => this.insertAudit(event));
  }

  private insertAudit(event: AuditEvent): void {
    this.db
      .prepare("INSERT INTO audit_events (id, at, type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.at, event.type, event.entityId, JSON.stringify(event.payload));
  }

  recent(limit = 20): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT id, at, type, entity_id, payload_json FROM audit_events ORDER BY rowid DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: str(row.id),
      at: str(row.at),
      type: str(row.type),
      entityId: str(row.entity_id),
      payload: JSON.parse(str(row.payload_json)) as Record<string, unknown>,
    }));
  }

  countAudit(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as Row;
    return num(row.n);
  }

  countProposalsByStatus(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM proposals GROUP BY status").all() as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[str(row.status)] = num(row.n);
    return counts;
  }

  countExecutionsByStatus(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM executions GROUP BY status").all() as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[str(row.status)] = num(row.n);
    return counts;
  }

  // ── 台站状态 ────────────────────────────────────────────────────────────
  loadState(): PersistedStationState {
    const row = this.db.prepare("SELECT frequency_hz, mode, generation, blocked_reason, storage_fault FROM station_state WHERE id = 1").get() as Row | undefined;
    if (!row) return { frequencyHz: DEFAULT_FREQUENCY_HZ, mode: MODE, generation: 0, blockedReason: null };
    return {
      frequencyHz: num(row.frequency_hz),
      mode: str(row.mode) as StationMode,
      generation: num(row.generation),
      blockedReason: nullableStr(row.blocked_reason),
      storageFault: nullableStr(row.storage_fault),
    };
  }

  saveState(state: PersistedStationState): void {
    this.db
      .prepare("UPDATE station_state SET frequency_hz = ?, mode = ?, generation = ?, blocked_reason = ?, storage_fault = COALESCE(?, storage_fault) WHERE id = 1")
      .run(state.frequencyHz, state.mode, state.generation, state.blockedReason, state.storageFault ?? null);
  }

  // ── 提案 ────────────────────────────────────────────────────────────────
  saveStorageFault(reason: string): void {
    this.db.prepare("UPDATE station_state SET storage_fault = ?, blocked_reason = ? WHERE id = 1").run(reason, reason);
  }

  /**
   * 专用故障解除入口（只允许维护模块调用）：
   * 显式清空 storage_fault，并写入新的 blocked_reason 与 generation。
   * 刻意不加入 TxJournalStore 端口，也不改变 saveState 的 COALESCE 保留语义，
   * 避免普通状态写入顺带清掉已落盘的存储故障。
   */
  clearStorageFault(blockedReason: string | null, generation: number): void {
    this.db
      .prepare("UPDATE station_state SET storage_fault = NULL, blocked_reason = ?, generation = ? WHERE id = 1")
      .run(blockedReason, generation);
  }

  insertProposal(proposal: Proposal): void {
    this.db
      .prepare(
        "INSERT INTO proposals (id, contract_version, text, frequency_hz, mode, created_at, expires_at, state_generation, status, content_sha256) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        proposal.id,
        proposal.contractVersion,
        proposal.text,
        proposal.frequencyHz,
        proposal.mode,
        proposal.createdAt,
        proposal.expiresAt,
        proposal.stateGeneration,
        proposal.status,
        proposal.contentSha256,
      );
  }

  getProposal(id: string): Proposal | undefined {
    const row = this.db
      .prepare(
        "SELECT id, contract_version, text, frequency_hz, mode, created_at, expires_at, state_generation, status, content_sha256 FROM proposals WHERE id = ?",
      )
      .get(id) as Row | undefined;
    return row ? mapProposal(row) : undefined;
  }

  listProposals(limit = 50): Proposal[] {
    const rows = this.db
      .prepare(
        "SELECT id, contract_version, text, frequency_hz, mode, created_at, expires_at, state_generation, status, content_sha256 FROM proposals ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Row[];
    return rows.map(mapProposal);
  }

  setProposalStatus(id: string, status: ProposalStatus): void {
    this.db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
  }

  /** 批量终止 pending/approved 提案，返回受影响 id。 */
  terminateOpenProposals(status: ProposalStatus): string[] {
    const rows = this.db
      .prepare("SELECT id FROM proposals WHERE status IN ('pending', 'approved')")
      .all() as Row[];
    const ids = rows.map((row) => str(row.id));
    for (const id of ids) this.setProposalStatus(id, status);
    return ids;
  }

  /**
   * 在数据库内一次性终止全部开放提案（无 LIMIT），已到期记 expired，其余记 cancelled。
   * 用于启动恢复，避免 listProposals 上限遗漏旧批准。
   */
  terminateOpenProposalsByExpiry(now: string): { expired: number; cancelled: number } {
    const expired = this.db
      .prepare("UPDATE proposals SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= ?")
      .run(now);
    const cancelled = this.db
      .prepare("UPDATE proposals SET status = 'cancelled' WHERE status IN ('pending', 'approved')")
      .run();
    return { expired: Number(expired.changes), cancelled: Number(cancelled.changes) };
  }

  // ── 批准 ────────────────────────────────────────────────────────────────
  insertApproval(approval: Approval): void {
    this.db
      .prepare(
        "INSERT INTO approvals (proposal_id, approved_at, expires_at, content_sha256, frequency_hz, mode, state_generation, consumed_at, revoked_at, revoked_reason) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        approval.proposalId,
        approval.approvedAt,
        approval.expiresAt,
        approval.contentSha256,
        approval.frequencyHz,
        approval.mode,
        approval.stateGeneration,
        approval.consumedAt,
        approval.revokedAt,
        approval.revokedReason,
      );
  }

  getApproval(proposalId: string): Approval | undefined {
    const row = this.db
      .prepare(
        "SELECT proposal_id, approved_at, expires_at, content_sha256, frequency_hz, mode, state_generation, consumed_at, revoked_at, revoked_reason FROM approvals WHERE proposal_id = ?",
      )
      .get(proposalId) as Row | undefined;
    return row ? mapApproval(row) : undefined;
  }

  consumeApproval(proposalId: string, at: string): void {
    this.db.prepare("UPDATE approvals SET consumed_at = ? WHERE proposal_id = ? AND consumed_at IS NULL").run(at, proposalId);
  }

  revokeApproval(proposalId: string, at: string, reason: string): void {
    this.db
      .prepare("UPDATE approvals SET revoked_at = ?, revoked_reason = ? WHERE proposal_id = ? AND revoked_at IS NULL")
      .run(at, reason, proposalId);
  }

  revokeAllApprovals(at: string, reason: string): number {
    const result = this.db
      .prepare("UPDATE approvals SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL")
      .run(at, reason);
    return Number(result.changes);
  }

  getApprovalStatusCounts(): { active: number; consumed: number; revoked: number } {
    const row = this.db
      .prepare(
        "SELECT " +
          "SUM(CASE WHEN revoked_at IS NULL AND consumed_at IS NULL THEN 1 ELSE 0 END) AS active, " +
          "SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed, " +
          "SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked FROM approvals",
      )
      .get() as Row;
    return { active: num(row.active ?? 0), consumed: num(row.consumed ?? 0), revoked: num(row.revoked ?? 0) };
  }

  // ── 执行 ────────────────────────────────────────────────────────────────
  insertExecution(execution: Execution): void {
    this.db
      .prepare(
        "INSERT INTO executions (proposal_id, request_id, status, started_at, finished_at, detail, frequency_hz, mode, state_generation, content_sha256) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        execution.proposalId,
        execution.requestId,
        execution.status,
        execution.startedAt,
        execution.finishedAt,
        execution.detail,
        execution.frequencyHz,
        execution.mode,
        execution.stateGeneration,
        execution.contentSha256,
      );
  }

  getExecution(proposalId: string): Execution | undefined {
    const row = this.db
      .prepare(
        "SELECT proposal_id, request_id, status, started_at, finished_at, detail, frequency_hz, mode, state_generation, content_sha256 FROM executions WHERE proposal_id = ?",
      )
      .get(proposalId) as Row | undefined;
    return row ? mapExecution(row) : undefined;
  }

  updateExecutionStatus(proposalId: string, status: Execution["status"], finishedAt: string | null, detail: string | null): void {
    this.db
      .prepare("UPDATE executions SET status = ?, finished_at = ?, detail = ? WHERE proposal_id = ?")
      .run(status, finishedAt, detail, proposalId);
  }

  listExecutions(limit = 50): Execution[] {
    const rows = this.db
      .prepare(
        "SELECT proposal_id, request_id, status, started_at, finished_at, detail, frequency_hz, mode, state_generation, content_sha256 FROM executions ORDER BY started_at DESC LIMIT ?",
      )
      .all(limit) as Row[];
    return rows.map(mapExecution);
  }

  findRunningExecutions(): Execution[] {
    const rows = this.db
      .prepare(
        "SELECT proposal_id, request_id, status, started_at, finished_at, detail, frequency_hz, mode, state_generation, content_sha256 FROM executions WHERE status = 'running'",
      )
      .all() as Row[];
    return rows.map(mapExecution);
  }

  findLastUnknownExecution(): Execution | undefined {
    const row = this.db
      .prepare(
        "SELECT proposal_id, request_id, status, started_at, finished_at, detail, frequency_hz, mode, state_generation, content_sha256 FROM executions WHERE status = 'unknown' ORDER BY started_at DESC LIMIT 1",
      )
      .get() as Row | undefined;
    return row ? mapExecution(row) : undefined;
  }

  // ── unknown 核查解除 ────────────────────────────────────────────────────
  /**
   * 全部未解除的 unknown 执行：status='unknown' 且不存在 resolution。
   * 刻意不加 LIMIT，避免遗漏旧记录导致阻止状态被错误清除。
   */
  findUnresolvedUnknowns(): Execution[] {
    const rows = this.db
      .prepare(
        "SELECT e.proposal_id, e.request_id, e.status, e.started_at, e.finished_at, e.detail, " +
          "e.frequency_hz, e.mode, e.state_generation, e.content_sha256 " +
          "FROM executions e LEFT JOIN execution_resolutions r ON r.proposal_id = e.proposal_id " +
          "WHERE e.status = 'unknown' AND r.proposal_id IS NULL " +
          "ORDER BY e.started_at ASC, e.proposal_id ASC",
      )
      .all() as Row[];
    return rows.map(mapExecution);
  }

  findLastUnresolvedUnknown(): Execution | undefined {
    const row = this.db
      .prepare(
        "SELECT e.proposal_id, e.request_id, e.status, e.started_at, e.finished_at, e.detail, " +
          "e.frequency_hz, e.mode, e.state_generation, e.content_sha256 " +
          "FROM executions e LEFT JOIN execution_resolutions r ON r.proposal_id = e.proposal_id " +
          "WHERE e.status = 'unknown' AND r.proposal_id IS NULL " +
          "ORDER BY e.started_at DESC, e.proposal_id DESC LIMIT 1",
      )
      .get() as Row | undefined;
    return row ? mapExecution(row) : undefined;
  }

  insertResolution(resolution: ExecutionResolution): void {
    this.db
      .prepare(
        "INSERT INTO execution_resolutions (proposal_id, contract_version, resolved_at, operator, note, confirmed_stopped) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        resolution.proposalId,
        resolution.contractVersion,
        resolution.resolvedAt,
        resolution.operator,
        resolution.note,
        resolution.confirmedStopped ? 1 : 0,
      );
  }

  getResolution(proposalId: string): ExecutionResolution | undefined {
    const row = this.db
      .prepare(
        "SELECT proposal_id, contract_version, resolved_at, operator, note, confirmed_stopped FROM execution_resolutions WHERE proposal_id = ?",
      )
      .get(proposalId) as Row | undefined;
    return row ? mapResolution(row) : undefined;
  }

  listResolutions(limit = 50): ExecutionResolution[] {
    const rows = this.db
      .prepare(
        "SELECT proposal_id, contract_version, resolved_at, operator, note, confirmed_stopped FROM execution_resolutions ORDER BY resolved_at DESC LIMIT ?",
      )
      .all(limit) as Row[];
    return rows.map(mapResolution);
  }

  countResolutions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM execution_resolutions").get() as Row;
    return num(row.n);
  }

  countExecutions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM executions").get() as Row;
    return num(row.n);
  }

  checkpoint(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // 关闭路径上的 checkpoint 失败不应掩盖主错误。
    }
  }

  close(): void {
    this.db.close();
  }
}

function mapProposal(row: Row): Proposal {
  return {
    id: str(row.id),
    contractVersion: 1,
    text: str(row.text),
    frequencyHz: num(row.frequency_hz),
    mode: str(row.mode) as StationMode,
    createdAt: str(row.created_at),
    expiresAt: str(row.expires_at),
    stateGeneration: num(row.state_generation),
    status: str(row.status) as ProposalStatus,
    contentSha256: str(row.content_sha256),
  };
}

function mapApproval(row: Row): Approval {
  return {
    proposalId: str(row.proposal_id),
    approvedAt: str(row.approved_at),
    expiresAt: str(row.expires_at),
    contentSha256: str(row.content_sha256),
    frequencyHz: num(row.frequency_hz),
    mode: str(row.mode) as StationMode,
    stateGeneration: num(row.state_generation),
    consumedAt: nullableStr(row.consumed_at),
    revokedAt: nullableStr(row.revoked_at),
    revokedReason: nullableStr(row.revoked_reason),
  };
}

function mapExecution(row: Row): Execution {
  return {
    proposalId: str(row.proposal_id),
    requestId: str(row.request_id),
    status: str(row.status) as Execution["status"],
    startedAt: str(row.started_at),
    finishedAt: nullableStr(row.finished_at),
    detail: nullableStr(row.detail),
    frequencyHz: num(row.frequency_hz),
    mode: str(row.mode) as StationMode,
    stateGeneration: num(row.state_generation),
    contentSha256: str(row.content_sha256),
  };
}

function mapResolution(row: Row): ExecutionResolution {
  return {
    proposalId: str(row.proposal_id),
    contractVersion: 1,
    resolvedAt: str(row.resolved_at),
    operator: str(row.operator),
    note: str(row.note),
    confirmedStopped: true,
  };
}
