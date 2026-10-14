// 维护模块：离线备份、bundle 只读核查、恢复到新数据库、清除已持久化的存储故障。
//
// 边界：
//  - 不新增 daemon RPC，不触碰发射路径；核心仍只通过 TxJournalStore 端口使用存储。
//  - 备份使用 node:sqlite 的一致性快照（VACUUM INTO）并在同一数据库锁内执行；
//    绝不裸 copy 主文件而忽略 WAL，也不用 SqliteJournal 构造器迁移备份源。
//  - backup/restore/clear 都不自动停止 daemon：取得同一 dbLockPath 而 daemon 持有时拒绝。
//  - 所有路径绝对规范化并解析已有符号链接，避免别名绕过 daemon 锁。
//  - 输出先写独占临时目录、校验后再发布；失败只清理本次临时产物，绝不动既有用户路径。

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_OPERATOR_MAX_LENGTH,
} from "../../contracts/src/index.js";
import type { TxJournalStore } from "../../core/src/storage.js";
import { SCHEMA_VERSION, SqliteJournal } from "../../journal/src/sqlite.js";
import { acquireLock, LockedError, type LockHandle } from "../../daemon/src/lock.js";
import { canonicalPath, dbLockPath, sqliteSidecarPaths } from "../../daemon/src/paths.js";

export const MANIFEST_VERSION = 1 as const;
export const BUNDLE_TYPE = "cwstation-backup" as const;
export const DATABASE_FILE_NAME = "cwstation.sqlite" as const;
const DEFAULT_FREQUENCY_HZ = 7_030_000;

export type MaintenanceErrorCode =
  | "usage"
  | "not_found"
  | "output_exists"
  | "output_parent_missing"
  | "locked"
  | "invalid_source"
  | "invalid_bundle"
  | "bundle_mismatch"
  | "conflict"
  | "internal";

export class MaintenanceError extends Error {
  constructor(
    readonly code: MaintenanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export interface BackupCounts {
  audit: number;
  proposals: Record<string, number>;
  executions: Record<string, number>;
  approvals: { active: number; consumed: number; revoked: number };
  resolutions: number;
}

export interface BackupStationState {
  frequencyHz: number;
  mode: string;
  generation: number;
  blockedReason: string | null;
  storageFault: string | null;
}

export interface BackupManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  bundleType: typeof BUNDLE_TYPE;
  createdAt: string;
  schemaVersion: number;
  database: { fileName: string; sizeBytes: number; sha256: string };
  counts: BackupCounts;
  stationState: BackupStationState;
}

export interface BackupResult {
  bundlePath: string;
  manifest: BackupManifest;
  databaseSha256: string;
}

export interface InspectResult {
  bundlePath: string;
  manifest: BackupManifest;
  schemaVersion: number;
  databaseSha256: string;
  databaseSizeBytes: number;
  counts: BackupCounts;
  stationState: BackupStationState;
}

export interface RestoreResult {
  dbPath: string;
  bundlePath: string;
  schemaVersion: number;
  recovery: Record<string, number>;
  generation: number;
  blockedReason: string | null;
}

export interface ClearStorageFaultResult {
  dbPath: string;
  backupPath: string;
  backupSha256: string;
  previousFault: string;
  generation: number;
  blockedReason: string | null;
}

type Row = Record<string, unknown>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// ── 结构与健康检查（只读，绝不迁移） ──────────────────────────────────────

const TABLE_COLUMNS: Record<string, string[]> = {
  schema_version: ["version"],
  audit_events: ["id", "at", "type", "entity_id", "payload_json"],
  proposals: [
    "id",
    "contract_version",
    "text",
    "frequency_hz",
    "mode",
    "created_at",
    "expires_at",
    "state_generation",
    "status",
    "content_sha256",
  ],
  approvals: [
    "proposal_id",
    "approved_at",
    "expires_at",
    "content_sha256",
    "frequency_hz",
    "mode",
    "state_generation",
    "consumed_at",
    "revoked_at",
    "revoked_reason",
  ],
  executions: [
    "proposal_id",
    "request_id",
    "status",
    "started_at",
    "finished_at",
    "detail",
    "frequency_hz",
    "mode",
    "state_generation",
    "content_sha256",
  ],
  station_state: ["id", "frequency_hz", "mode", "generation", "blocked_reason"],
  execution_resolutions: ["proposal_id", "contract_version", "resolved_at", "operator", "note", "confirmed_stopped"],
};

function requiredTables(version: number): Record<string, string[]> {
  const tables: Record<string, string[]> = {
    schema_version: [...(TABLE_COLUMNS.schema_version ?? [])],
    audit_events: [...(TABLE_COLUMNS.audit_events ?? [])],
  };
  if (version >= 2) {
    tables.proposals = [...(TABLE_COLUMNS.proposals ?? [])];
    tables.approvals = [...(TABLE_COLUMNS.approvals ?? [])];
    tables.executions = [...(TABLE_COLUMNS.executions ?? [])];
    tables.station_state = [...(TABLE_COLUMNS.station_state ?? [])];
  }
  if (version >= 3) tables.execution_resolutions = [...(TABLE_COLUMNS.execution_resolutions ?? [])];
  if (version >= 4) tables.station_state = [...(tables.station_state ?? []), "storage_fault"];
  return tables;
}

function readSchemaVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as Row | undefined;
  if (!table) return 0;
  const row = db.prepare("SELECT version FROM schema_version ORDER BY rowid LIMIT 1").get() as Row | undefined;
  return row ? num(row.version) : 0;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}

function countRows(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as Row;
  return num(row.n);
}

function countsByColumn(db: DatabaseSync, table: string, column: string): Record<string, number> {
  if (!tableExists(db, table)) return {};
  const rows = db.prepare(`SELECT "${column}" AS k, COUNT(*) AS n FROM "${table}" GROUP BY "${column}"`).all() as Row[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[str(row.k)] = num(row.n);
  return counts;
}

function readApprovalCounts(db: DatabaseSync): { active: number; consumed: number; revoked: number } {
  const row = db
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN revoked_at IS NULL AND consumed_at IS NULL THEN 1 ELSE 0 END) AS active, " +
        "SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed, " +
        "SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked FROM approvals",
    )
    .get() as Row;
  return { active: num(row.active ?? 0), consumed: num(row.consumed ?? 0), revoked: num(row.revoked ?? 0) };
}

function readCounts(db: DatabaseSync, version: number): BackupCounts {
  const audit = countRows(db, "audit_events");
  if (version < 2) {
    return { audit, proposals: {}, executions: {}, approvals: { active: 0, consumed: 0, revoked: 0 }, resolutions: 0 };
  }
  return {
    audit,
    proposals: countsByColumn(db, "proposals", "status"),
    executions: countsByColumn(db, "executions", "status"),
    approvals: readApprovalCounts(db),
    resolutions: version >= 3 ? countRows(db, "execution_resolutions") : 0,
  };
}

function readState(db: DatabaseSync, version: number): BackupStationState {
  const fallback: BackupStationState = {
    frequencyHz: DEFAULT_FREQUENCY_HZ,
    mode: "CW",
    generation: 0,
    blockedReason: null,
    storageFault: null,
  };
  if (version < 2) return fallback;
  const columns = version >= 4
    ? "frequency_hz, mode, generation, blocked_reason, storage_fault"
    : "frequency_hz, mode, generation, blocked_reason";
  const row = db.prepare(`SELECT ${columns} FROM station_state WHERE id = 1`).get() as Row | undefined;
  if (!row) return fallback;
  return {
    frequencyHz: num(row.frequency_hz),
    mode: str(row.mode),
    generation: num(row.generation),
    blockedReason: nullableStr(row.blocked_reason),
    storageFault: version >= 4 ? nullableStr(row.storage_fault) : null,
  };
}

interface SnapshotInfo {
  schemaVersion: number;
  counts: BackupCounts;
  stationState: BackupStationState;
}

function assertHealthy(db: DatabaseSync, code: "invalid_source" | "invalid_bundle", label: string): void {
  let integrity: unknown[];
  let fk: Row[];
  try {
    integrity = (db.prepare("PRAGMA integrity_check").all() as Row[]).map((row) => Object.values(row)[0]);
    fk = db.prepare("PRAGMA foreign_key_check").all() as Row[];
  } catch (error) {
    throw new MaintenanceError(code, `cannot read SQLite integrity for ${label}: ${describe(error)}`);
  }
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    throw new MaintenanceError(code, `SQLite integrity_check failed for ${label}: ${String(integrity)}`);
  }
  if (fk.length > 0) {
    throw new MaintenanceError(code, `SQLite foreign_key_check failed for ${label}: ${fk.length} violation(s)`);
  }
}

function assertStructure(
  db: DatabaseSync,
  version: number,
  code: "invalid_source" | "invalid_bundle",
  label: string,
): void {
  const versionRows = db.prepare("SELECT version FROM schema_version").all();
  if (versionRows.length !== 1) throw new MaintenanceError(code, "schema_version must contain exactly one record");
  if (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')").all().length > 0) {
    throw new MaintenanceError(code, "custom triggers and views are unsupported in maintenance databases");
  }
  for (const [table, columns] of Object.entries(requiredTables(version))) {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Row[];
    if (info.length === 0) throw new MaintenanceError(code, `required table ${table} is missing in ${label}`);
    const present = new Set(info.map((row) => str(row.name)));
    for (const column of columns) {
      if (!present.has(column)) throw new MaintenanceError(code, `table ${table} is missing column ${column} in ${label}`);
    }
    const key = table === "schema_version" ? null : table === "station_state" || table === "audit_events" || table === "proposals" ? "id" : "proposal_id";
    if (key !== null && !info.some((row) => row.name === key && row.pk === 1)) {
      throw new MaintenanceError(code, `table ${table} has no expected primary key`);
    }
    if (["approvals", "executions", "execution_resolutions"].includes(table)) {
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Row[];
      const parent = table === "execution_resolutions" ? "executions" : "proposals";
      const target = table === "execution_resolutions" ? "proposal_id" : "id";
      if (!foreignKeys.some((row) => row.from === "proposal_id" && row.table === parent && row.to === target)) {
        throw new MaintenanceError(code, `table ${table} has no expected foreign key`);
      }
    }
  }
  if (version >= 2) {
    const states = db.prepare("SELECT id, frequency_hz, mode, generation FROM station_state").all() as Row[];
    const state = states[0];
    if (states.length !== 1 || !state || state.id !== 1 || state.mode !== "CW" ||
        !Number.isSafeInteger(state.frequency_hz) || num(state.frequency_hz) <= 0 ||
        !Number.isSafeInteger(state.generation) || num(state.generation) < 0 || num(state.generation) >= Number.MAX_SAFE_INTEGER) {
      throw new MaintenanceError(code, "station_state must contain one valid CW state with id=1");
    }
  }
}

function readSnapshotInfo(dbPath: string, scope: "source" | "bundle"): SnapshotInfo {
  const code = scope === "source" ? "invalid_source" : "invalid_bundle";
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new MaintenanceError(code, `cannot open database ${dbPath}: ${describe(error)}`);
  }
  try {
    assertHealthy(db, code, dbPath);
    const version = readSchemaVersion(db);
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      throw new MaintenanceError(code, `unsupported schema version ${version} in ${dbPath}`);
    }
    assertStructure(db, version, code, dbPath);
    return { schemaVersion: version, counts: readCounts(db, version), stationState: readState(db, version) };
  } finally {
    db.close();
  }
}

// ── manifest 严格校验 ─────────────────────────────────────────────────────

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new MaintenanceError("invalid_bundle", `manifest.${field} must be an object`);
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MaintenanceError("invalid_bundle", `manifest.${field} must be a non-negative integer`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MaintenanceError("invalid_bundle", `manifest.${field} must be a non-empty string`);
  }
  return value;
}

function parseCountMap(value: unknown, field: string): Record<string, number> {
  const obj = requireObject(value, field);
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(obj)) result[key] = requireNonNegativeInt(count, `${field}.${key}`);
  return result;
}

export function parseManifest(text: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MaintenanceError("invalid_bundle", `manifest.json is not valid JSON: ${describe(error)}`);
  }
  const obj = requireObject(parsed, "(root)");
  const allowed = new Set(["manifestVersion", "bundleType", "createdAt", "schemaVersion", "database", "counts", "stationState"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new MaintenanceError("invalid_bundle", `manifest has unknown field: ${key}`);
  }
  if (obj.manifestVersion !== MANIFEST_VERSION) {
    throw new MaintenanceError("invalid_bundle", `unsupported manifestVersion: ${String(obj.manifestVersion)}`);
  }
  if (obj.bundleType !== BUNDLE_TYPE) {
    throw new MaintenanceError("invalid_bundle", `manifest.bundleType must be ${BUNDLE_TYPE}`);
  }
  const createdAt = requireString(obj.createdAt, "createdAt");
  const schemaVersion = requireNonNegativeInt(obj.schemaVersion, "schemaVersion");
  if (schemaVersion < 1 || schemaVersion > SCHEMA_VERSION) {
    throw new MaintenanceError("invalid_bundle", `manifest.schemaVersion ${schemaVersion} is not supported`);
  }

  const database = requireObject(obj.database, "database");
  const fileName = requireString(database.fileName, "database.fileName");
  if (fileName !== DATABASE_FILE_NAME) {
    throw new MaintenanceError("invalid_bundle", `manifest.database.fileName must be ${DATABASE_FILE_NAME}`);
  }
  const sizeBytes = requireNonNegativeInt(database.sizeBytes, "database.sizeBytes");
  const sha256 = requireString(database.sha256, "database.sha256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new MaintenanceError("invalid_bundle", "manifest.database.sha256 must be a lowercase hex SHA256");
  }

  const countsObj = requireObject(obj.counts, "counts");
  for (const key of ["audit", "proposals", "executions", "approvals", "resolutions"]) {
    if (!(key in countsObj)) throw new MaintenanceError("invalid_bundle", `manifest.counts.${key} is required`);
  }
  for (const key of Object.keys(countsObj)) {
    if (!["audit", "proposals", "executions", "approvals", "resolutions"].includes(key)) {
      throw new MaintenanceError("invalid_bundle", `manifest.counts has unknown field: ${key}`);
    }
  }
  const approvalsObj = requireObject(countsObj.approvals, "counts.approvals");
  for (const key of ["active", "consumed", "revoked"]) {
    if (!(key in approvalsObj)) throw new MaintenanceError("invalid_bundle", `manifest.counts.approvals.${key} is required`);
  }
  const counts: BackupCounts = {
    audit: requireNonNegativeInt(countsObj.audit, "counts.audit"),
    proposals: parseCountMap(countsObj.proposals, "counts.proposals"),
    executions: parseCountMap(countsObj.executions, "counts.executions"),
    approvals: {
      active: requireNonNegativeInt(approvalsObj.active, "counts.approvals.active"),
      consumed: requireNonNegativeInt(approvalsObj.consumed, "counts.approvals.consumed"),
      revoked: requireNonNegativeInt(approvalsObj.revoked, "counts.approvals.revoked"),
    },
    resolutions: requireNonNegativeInt(countsObj.resolutions, "counts.resolutions"),
  };

  const stateObj = requireObject(obj.stationState, "stationState");
  const stateFields = new Set(["frequencyHz", "mode", "generation", "blockedReason", "storageFault"]);
  for (const key of Object.keys(stateObj)) {
    if (!stateFields.has(key)) throw new MaintenanceError("invalid_bundle", `manifest.stationState has unknown field: ${key}`);
  }
  for (const key of stateFields) {
    if (!(key in stateObj)) throw new MaintenanceError("invalid_bundle", `manifest.stationState.${key} is required`);
  }
  const validateNullableString = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    if (typeof value !== "string") throw new MaintenanceError("invalid_bundle", `manifest.${field} must be a string or null`);
    return value;
  };
  const stationState: BackupStationState = {
    frequencyHz: requireNonNegativeInt(stateObj.frequencyHz, "stationState.frequencyHz"),
    mode: requireString(stateObj.mode, "stationState.mode"),
    generation: requireNonNegativeInt(stateObj.generation, "stationState.generation"),
    blockedReason: validateNullableString(stateObj.blockedReason, "stationState.blockedReason"),
    storageFault: validateNullableString(stateObj.storageFault, "stationState.storageFault"),
  };

  return {
    manifestVersion: MANIFEST_VERSION,
    bundleType: BUNDLE_TYPE,
    createdAt,
    schemaVersion,
    database: { fileName, sizeBytes, sha256 },
    counts,
    stationState,
  };
}

// ── 锁 ────────────────────────────────────────────────────────────────────

function acquireDatabaseLock(dbPath: string, label: string): LockHandle {
  try {
    return acquireLock(dbLockPath(dbPath), label, { dbPath });
  } catch (error) {
    if (error instanceof LockedError) {
      throw new MaintenanceError("locked", `database lock is held (daemon running?): ${describe(error)}`);
    }
    throw error;
  }
}

// ── 备份 ──────────────────────────────────────────────────────────────────

function assertInside(bundle: string, target: string): void {
  const rel = relative(bundle, target);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new MaintenanceError("invalid_bundle", `path escapes bundle: ${target}`);
  }
}

/**
 * 写出备份（调用方必须已持有同一数据库锁）。
 * 使用 VACUUM INTO 生成包含 WAL 的一致性快照，先写独占临时目录，校验后再原子发布。
 */
export function writeBackup(dbPath: string, outDir: string): BackupResult {
  const source = canonicalPath(dbPath);
  if (pathEntryExists(resolve(outDir))) throw new MaintenanceError("output_exists", "backup output already exists");
  const out = canonicalPath(outDir);

  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new MaintenanceError("not_found", `source database not found: ${source}`);
  }
  if (pathEntryExists(out)) {
    throw new MaintenanceError("output_exists", `backup output already exists: ${out}`);
  }
  const parent = dirname(out);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new MaintenanceError("output_parent_missing", `backup output parent directory does not exist: ${parent}`);
  }

  // 源数据库必须在快照前通过只读健康/结构检查，避免把垃圾或未来版本当成备份。
  const sourceInfo = readSnapshotInfo(source, "source");

  const tempDir = mkdtempSync(join(parent, `.${basename(out)}.tmp-`));
  const snapshot = join(tempDir, DATABASE_FILE_NAME);
  try {
    // 只读连接执行 VACUUM INTO：不触发 WAL checkpoint，源库主文件字节不变。
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      sourceDb.prepare("VACUUM INTO ?").run(snapshot);
    } finally {
      sourceDb.close();
    }
    if (existsSync(`${snapshot}-wal`) || existsSync(`${snapshot}-shm`)) {
      throw new MaintenanceError("internal", "consistent snapshot unexpectedly produced WAL sidecar files");
    }

    const snapshotInfo = readSnapshotInfo(snapshot, "source");
    if (
      snapshotInfo.schemaVersion !== sourceInfo.schemaVersion ||
      !isDeepStrictEqual(snapshotInfo.counts, sourceInfo.counts) ||
      !isDeepStrictEqual(snapshotInfo.stationState, sourceInfo.stationState)
    ) {
      throw new MaintenanceError("internal", "consistent snapshot does not match the source database");
    }

    const databaseSha256 = sha256File(snapshot);
    const manifest: BackupManifest = {
      manifestVersion: MANIFEST_VERSION,
      bundleType: BUNDLE_TYPE,
      createdAt: new Date().toISOString(),
      schemaVersion: snapshotInfo.schemaVersion,
      database: { fileName: DATABASE_FILE_NAME, sizeBytes: statSync(snapshot).size, sha256: databaseSha256 },
      counts: snapshotInfo.counts,
      stationState: snapshotInfo.stationState,
    };
    writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // 发布前用同一只读 inspect 逻辑复核整包，任何问题都不发布。
    inspectBundle(tempDir);

    let reserved = false;
    const publishedLinks: { source: string; target: string; hash: string }[] = [];
    try {
      mkdirSync(out, { mode: 0o700 });
      reserved = true;
      if (process.platform === "win32") {
        // Windows cannot replace the reserved directory. Publish verified snapshot
        // links exclusively, with the manifest last as the bundle commit marker.
        for (const file of [DATABASE_FILE_NAME, "manifest.json"]) {
          const sourceFile = join(tempDir, file);
          const targetFile = join(out, file);
          const hash = sha256File(sourceFile);
          linkSync(sourceFile, targetFile);
          publishedLinks.push({ source: sourceFile, target: targetFile, hash });
        }
      } else {
        renameSync(tempDir, out);
      }
      reserved = false;
    } catch (error) {
      if (isNodeError(error) && ["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(error.code ?? "")) {
        throw new MaintenanceError("output_exists", `backup output already exists: ${out}`);
      }
      throw error;
    } finally {
      if (reserved) {
        for (const entry of publishedLinks.reverse()) {
          try {
            const sourceStat = statSync(entry.source);
            const targetStat = lstatSync(entry.target);
            if (targetStat.isFile() && sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev &&
                sha256File(entry.target) === entry.hash) unlinkSync(entry.target);
          } catch { /* Preserve replacements or modified files from other writers. */ }
        }
        try { rmdirSync(out); } catch { /* Never remove content added by another writer. */ }
      }
    }
    return { bundlePath: out, manifest, databaseSha256 };
  } finally {
    // 只清理本次创建的临时目录；发布成功后该目录已不存在。
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
}

/** 取得数据库锁后备份；daemon 持锁时拒绝，不自动停止 daemon。 */
export function backupDatabase(dbPath: string, outDir: string): BackupResult {
  const source = canonicalPath(dbPath);
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new MaintenanceError("not_found", `source database not found: ${source}`);
  }
  const lock = acquireDatabaseLock(source, "maintenance-backup");
  try {
    return writeBackup(source, outDir);
  } finally {
    lock.release();
  }
}

// ── 只读核查 ──────────────────────────────────────────────────────────────

export function inspectBundle(bundlePath: string): InspectResult {
  const rawBundle = resolve(bundlePath);
  if (!existsSync(rawBundle)) {
    throw new MaintenanceError("not_found", `bundle directory not found: ${rawBundle}`);
  }
  if (lstatSync(rawBundle).isSymbolicLink()) {
    throw new MaintenanceError("invalid_bundle", `bundle path must not be a symlink: ${rawBundle}`);
  }
  const bundle = canonicalPath(rawBundle);
  if (!statSync(bundle).isDirectory()) {
    throw new MaintenanceError("invalid_bundle", `bundle path is not a directory: ${bundle}`);
  }

  const manifestPath = join(bundle, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new MaintenanceError("not_found", `manifest.json not found in bundle: ${bundle}`);
  }
  if (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) {
    throw new MaintenanceError("invalid_bundle", "manifest.json must be a regular file, not a symlink");
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));

  const dbPath = join(bundle, manifest.database.fileName);
  if (sqliteSidecarPaths(dbPath).slice(1).some(pathEntryExists) || pathEntryExists(`${dbPath}-journal`)) {
    throw new MaintenanceError("invalid_bundle", "bundle must be a standalone snapshot without SQLite sidecars");
  }
  assertInside(bundle, dbPath);
  if (!existsSync(dbPath)) {
    throw new MaintenanceError("not_found", `bundle database file not found: ${dbPath}`);
  }
  const dbStat = lstatSync(dbPath);
  if (dbStat.isSymbolicLink()) {
    throw new MaintenanceError("invalid_bundle", "bundle database file must not be a symlink");
  }
  if (!dbStat.isFile()) {
    throw new MaintenanceError("invalid_bundle", "bundle database path is not a regular file");
  }

  if (dbStat.size !== manifest.database.sizeBytes) {
    throw new MaintenanceError(
      "bundle_mismatch",
      `database size mismatch: manifest ${manifest.database.sizeBytes}, actual ${dbStat.size}`,
    );
  }
  const databaseSha256 = sha256File(dbPath);
  if (databaseSha256 !== manifest.database.sha256) {
    throw new MaintenanceError("bundle_mismatch", "database SHA256 does not match manifest");
  }

  const info = readSnapshotInfo(dbPath, "bundle");
  if (info.schemaVersion !== manifest.schemaVersion) {
    throw new MaintenanceError(
      "bundle_mismatch",
      `schema version mismatch: manifest ${manifest.schemaVersion}, database ${info.schemaVersion}`,
    );
  }
  if (!isDeepStrictEqual(info.counts, manifest.counts)) {
    throw new MaintenanceError("bundle_mismatch", "database counts do not match manifest");
  }
  if (!isDeepStrictEqual(info.stationState, manifest.stationState)) {
    throw new MaintenanceError("bundle_mismatch", "database station state does not match manifest");
  }

  return {
    bundlePath: bundle,
    manifest,
    schemaVersion: info.schemaVersion,
    databaseSha256,
    databaseSizeBytes: dbStat.size,
    counts: info.counts,
    stationState: info.stationState,
  };
}

// ── 恢复 ──────────────────────────────────────────────────────────────────

function unknownBlockReason(executions: ReadonlyArray<{ proposalId: string; startedAt: string }>): string {
  const first = executions[0];
  if (!first) return "unresolved unknown execution; operator review required before further transmit";
  const more = executions.length > 1 ? ` (+${executions.length - 1} more unresolved)` : "";
  return `unresolved unknown execution ${first.proposalId} (started ${first.startedAt})${more}; operator review required before further transmit`;
}

/**
 * 只读核查 WAL 模式数据库时，SQLite 可能重建空的 -wal/-shm。
 * 仅当 WAL 为空（只读连接不可能提交数据）时才移除，否则拒绝发布。
 */
function removeReadOnlySidecars(dbPath: string): void {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) {
    const size = statSync(walPath).size;
    if (size !== 0) {
      throw new MaintenanceError("internal", `refusing to remove a non-empty WAL at ${walPath} (size ${size})`);
    }
    rmSync(walPath, { force: true });
  }
  if (existsSync(shmPath)) rmSync(shmPath, { force: true });
}

function appendAudit(
  journal: TxJournalStore,
  type: string,
  entityId: string,
  payload: Record<string, unknown>,
): void {
  journal.append({ id: randomUUID(), at: new Date().toISOString(), type, entityId, payload });
}

/**
 * 在已迁移到当前 schema 的（临时）数据库上执行恢复：
 * 撤销全部批准、终止开放提案、running→unknown、generation+1、追加 maintenance.restored，
 * 保留原执行与核查记录，不重发也不重新批准。storage_fault 与未核查 unknown 继续阻止。
 */
function applyRestoreRecovery(journal: TxJournalStore, bundlePath: string): { recovery: Record<string, number>; generation: number; blockedReason: string | null } {
  const recovery: Record<string, number> = {
    runningToUnknown: 0,
    approvalsRevoked: 0,
    proposalsExpired: 0,
    proposalsCancelled: 0,
    unresolvedUnknowns: 0,
  };
  let generation = 0;
  let blockedReason: string | null = null;

  journal.transaction(() => {
    const now = new Date().toISOString();
    const originalState = journal.loadState();
    const originalUnknowns = journal.findUnresolvedUnknowns();
    const originalBlock = originalState.blockedReason;
    const knownUnknownBlock = originalUnknowns.length > 0 && (
      originalBlock === unknownBlockReason(originalUnknowns) || originalUnknowns.some((execution) =>
        originalBlock === `unresolved unknown execution ${execution.proposalId}; stop cannot be confirmed` ||
        originalBlock === `shutdown left unresolved execution ${execution.proposalId}`)
    );
    if (originalBlock !== null && originalBlock !== originalState.storageFault && !knownUnknownBlock &&
        (originalUnknowns.length > 0 || originalState.storageFault || journal.findRunningExecutions().length > 0)) {
      throw new MaintenanceError("conflict", "restore cannot classify an unrelated blocked reason; review the source first");
    }
    for (const execution of journal.findRunningExecutions()) {
      journal.updateExecutionStatus(
        execution.proposalId,
        "unknown",
        now,
        "restore converted an in-flight execution to unknown; stop cannot be confirmed",
      );
      journal.setProposalStatus(execution.proposalId, "cancelled");
      appendAudit(journal, "tx.unknown", execution.proposalId, { reason: "maintenance-restore" });
      recovery.runningToUnknown = (recovery.runningToUnknown ?? 0) + 1;
    }

    recovery.approvalsRevoked = journal.revokeAllApprovals(now, "maintenance-restore");
    const terminated = journal.terminateOpenProposalsByExpiry(now);
    recovery.proposalsExpired = terminated.expired;
    recovery.proposalsCancelled = terminated.cancelled;

    const state = journal.loadState();
    generation = state.generation + 1;

    const unresolved = journal.findUnresolvedUnknowns();
    recovery.unresolvedUnknowns = unresolved.length;
    blockedReason = state.blockedReason;
    if (unresolved.length > 0) blockedReason = unknownBlockReason(unresolved);
    if (state.storageFault) blockedReason = state.storageFault;

    journal.saveState({
      frequencyHz: state.frequencyHz,
      mode: state.mode,
      generation,
      blockedReason,
      storageFault: state.storageFault ?? null,
    });
    appendAudit(journal, "maintenance.restored", "station", {
      ...recovery,
      generation,
      blocked: blockedReason !== null,
      bundlePath,
    });
  });

  return { recovery, generation, blockedReason };
}

/**
 * 从 bundle 恢复到一个全新的数据库路径。
 * 依次：规范化 → 建父目录 → 取得目标锁 → 复查目标不存在 → 只读核查 bundle
 * → 从一致快照创建临时 DB → 显式迁移 + 恢复 → 校验 → 原子发布。
 * 失败只清理本次临时文件并释放锁；绝不覆盖源、绝不就地覆盖。
 */
export function restoreBundle(bundlePath: string, dbPath: string): RestoreResult {
  if (pathEntryExists(resolve(dbPath))) throw new MaintenanceError("conflict", "restore target already exists");
  const target = canonicalPath(dbPath);
  const targetParent = dirname(target);
  // 不因拼错路径凭空创建目录树：恢复目标父目录必须已存在。
  if (!existsSync(targetParent) || !statSync(targetParent).isDirectory()) {
    throw new MaintenanceError("output_parent_missing", `restore target parent directory does not exist: ${targetParent}`);
  }

  const lock = acquireDatabaseLock(target, "maintenance-restore");
  let tempDir: string | undefined;
  try {
    if (sqliteSidecarPaths(target).some(pathEntryExists)) {
      throw new MaintenanceError("conflict", `restore target already exists: ${target}`);
    }

    const inspection = inspectBundle(bundlePath);

    tempDir = mkdtempSync(join(targetParent, ".cwmaint-restore-"));
    const tempDb = join(tempDir, DATABASE_FILE_NAME);

    const bundleDb = new DatabaseSync(join(inspection.bundlePath, DATABASE_FILE_NAME), { readOnly: true });
    try {
      bundleDb.prepare("VACUUM INTO ?").run(tempDb);
    } finally {
      bundleDb.close();
    }

    const journal = new SqliteJournal(tempDb);
    let recovery: Record<string, number>;
    let generation: number;
    let blockedReason: string | null;
    try {
      const result = applyRestoreRecovery(journal, inspection.bundlePath);
      recovery = result.recovery;
      generation = result.generation;
      blockedReason = result.blockedReason;
      journal.checkpoint();
    } finally {
      journal.close();
    }

    // 发布前再次确认临时库健康、schema 正确；同时确认目标仍未被占用。
    const migrated = readSnapshotInfo(tempDb, "source");
    if (migrated.schemaVersion !== SCHEMA_VERSION) {
      throw new MaintenanceError("internal", `restored database schema is ${migrated.schemaVersion}, expected ${SCHEMA_VERSION}`);
    }
    // 只读核查 WAL 模式数据库时 SQLite 可能重建空的 -wal/-shm：确认空后移除，绝不带走已提交数据。
    removeReadOnlySidecars(tempDb);
    if (existsSync(`${tempDb}-wal`) || existsSync(`${tempDb}-shm`)) {
      throw new MaintenanceError("internal", "temporary database still has WAL sidecar files; refusing to publish");
    }
    if (sqliteSidecarPaths(target).some(pathEntryExists)) {
      throw new MaintenanceError("conflict", `restore target appeared while restoring: ${target}`);
    }

    // Hard-link publication fails atomically if the destination appears; both paths share a filesystem.
    try {
      linkSync(tempDb, target);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") throw new MaintenanceError("conflict", "restore target appeared while publishing");
      throw error;
    }
    return {
      dbPath: target,
      bundlePath: inspection.bundlePath,
      schemaVersion: migrated.schemaVersion,
      recovery,
      generation,
      blockedReason,
    };
  } finally {
    if (tempDir !== undefined) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响结论。
      }
    }
    lock.release();
  }
}

// ── 清除已持久化的存储故障 ────────────────────────────────────────────────

function uniqueBackupPath(dbPath: string): string {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const candidate = join(dir, `${base}.fault-clear-backup-${stamp}-${randomUUID().slice(0, 8)}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new MaintenanceError("internal", "could not allocate a unique pre-clear backup path");
}

/**
 * 仅在人工确认已停机、并成功生成不可覆盖的故障解除前备份后：
 * 撤销全部批准、取消开放提案、running→unknown、generation+1、显式清空 storage_fault，
 * 依据全部 unresolved unknown 重设阻止，并追加 maintenance.storage_fault_cleared 审计。
 * 不清理 unknown 或其他不明阻止原因；没有 storage_fault 直接冲突，不写审计。
 */
export function clearStorageFault(
  dbPath: string,
  operator: string,
  note: string,
  confirmStopped: boolean,
): ClearStorageFaultResult {
  const trimmedOperator = operator.trim();
  const trimmedNote = note.trim();
  if (trimmedOperator.length === 0) throw new MaintenanceError("usage", "--operator must be non-empty");
  if (trimmedOperator.length > RESOLUTION_OPERATOR_MAX_LENGTH) {
    throw new MaintenanceError("usage", `--operator exceeds ${RESOLUTION_OPERATOR_MAX_LENGTH} characters`);
  }
  if (trimmedNote.length === 0) throw new MaintenanceError("usage", "--note must be non-empty");
  if (trimmedNote.length > RESOLUTION_NOTE_MAX_LENGTH) {
    throw new MaintenanceError("usage", `--note exceeds ${RESOLUTION_NOTE_MAX_LENGTH} characters`);
  }
  if (confirmStopped !== true) throw new MaintenanceError("usage", "--confirm-stopped is required");

  const target = canonicalPath(dbPath);
  if (!existsSync(target) || !lstatSync(target).isFile()) {
    throw new MaintenanceError("not_found", `database not found: ${target}`);
  }

  const lock = acquireDatabaseLock(target, "maintenance-clear-storage-fault");
  try {
    // 1) 只读完整性/版本/结构检查，并确认确有 storage_fault。
    const before = readSnapshotInfo(target, "source");
    const fault = before.stationState.storageFault;
    if (!fault) {
      throw new MaintenanceError("conflict", "no persisted storage fault was found; refusing to clear");
    }
    if (before.stationState.blockedReason !== null && before.stationState.blockedReason !== fault) {
      throw new MaintenanceError("conflict", "an unrelated blocked reason requires separate review; storage fault was not cleared");
    }

    // 2) 先成功生成不可覆盖的故障解除前备份（同一锁内）。
    const backupPath = uniqueBackupPath(target);
    const backup = writeBackup(target, backupPath);

    // 3) 显式写事务：可写性由成功提交验证；任何失败回滚并保留故障。
    const journal = new SqliteJournal(target);
    let generation: number;
    let blockedReason: string | null;
    try {
      const result = journal.transaction(() => {
        const now = new Date().toISOString();
        const state = journal.loadState();
        const currentFault = state.storageFault;
        if (!currentFault || currentFault !== fault || (state.blockedReason !== null && state.blockedReason !== currentFault)) {
          throw new MaintenanceError("conflict", "storage fault disappeared before clearing; refusing");
        }

        let runningToUnknown = 0;
        for (const execution of journal.findRunningExecutions()) {
          journal.updateExecutionStatus(
            execution.proposalId,
            "unknown",
            now,
            "storage fault cleared while an execution was still running; stop cannot be confirmed",
          );
          journal.setProposalStatus(execution.proposalId, "cancelled");
          appendAudit(journal, "tx.unknown", execution.proposalId, { reason: "maintenance-storage-fault-cleared" });
          runningToUnknown += 1;
        }

        const approvalsRevoked = journal.revokeAllApprovals(now, "maintenance:storage_fault_cleared");
        const terminated = journal.terminateOpenProposalsByExpiry(now);

        const nextGeneration = state.generation + 1;
        const unresolved = journal.findUnresolvedUnknowns();
        let nextBlocked: string | null;
        if (unresolved.length > 0) nextBlocked = unknownBlockReason(unresolved);
        else if (state.blockedReason !== null && state.blockedReason !== currentFault) nextBlocked = state.blockedReason;
        else nextBlocked = null;

        // 专用入口：显式清空 storage_fault，并写入新的 blocked_reason 与 generation；
        // 不借用 saveState 的 COALESCE 保留语义。
        journal.clearStorageFault(nextBlocked, nextGeneration);
        appendAudit(journal, "maintenance.storage_fault_cleared", "station", {
          operator: trimmedOperator,
          note: trimmedNote,
          confirmedStopped: true,
          previousFault: currentFault,
          backupPath: backup.bundlePath,
          backupSha256: backup.databaseSha256,
          generation: nextGeneration,
          runningToUnknown,
          approvalsRevoked,
          proposalsExpired: terminated.expired,
          proposalsCancelled: terminated.cancelled,
          unresolvedUnknowns: unresolved.length,
          blocked: nextBlocked !== null,
        });

        return { generation: nextGeneration, blockedReason: nextBlocked };
      });
      generation = result.generation;
      blockedReason = result.blockedReason;
      journal.checkpoint();
    } finally {
      journal.close();
    }

    return {
      dbPath: target,
      backupPath: backup.bundlePath,
      backupSha256: backup.databaseSha256,
      previousFault: fault,
      generation,
      blockedReason,
    };
  } finally {
    lock.release();
  }
}
