// P0-005：离线备份、bundle 只读核查、恢复到新数据库与存储故障清除。
// 覆盖：WAL 一致性快照、原库不变、输出不覆盖、活动 daemon/别名锁拒绝、
// bundle 篡改/未来版本/目录逃逸/symlink/坏库拒绝、恢复安全状态与旧版迁移、
// 解除故障的先备份/审计/generation/阻止保留/失败回滚，以及 CLI 退出码与严格旗标。

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { TxController } from "../packages/core/src/tx-controller.js";
import { FakeKeyer } from "../packages/core/src/keyer.js";
import { acquireLock } from "../packages/daemon/src/lock.js";
import { canonicalPath, dbLockPath } from "../packages/daemon/src/paths.js";
import {
  DATABASE_FILE_NAME,
  MaintenanceError,
  backupDatabase,
  clearStorageFault,
  inspectBundle,
  parseManifest,
  restoreBundle,
} from "../packages/maintenance/src/index.js";
import { ROOT, canCreateSymlinks, isInsideDirectory, startDaemon } from "./helpers.js";

type TestFn = (t: TestContext) => void | Promise<void>;
const TEST_TIMEOUT_MS = 60_000;
function mtest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}
/** CLI 端到端用例要启动多个 tsx 子进程，给更宽的超时上界。 */
function slowTest(name: string, fn: TestFn): void {
  test(name, { timeout: 60_000 }, fn);
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-maint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectMaintenanceError(fn: () => unknown, code: string): MaintenanceError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MaintenanceError, `expected MaintenanceError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected MaintenanceError(${code}) but nothing was thrown`);
}

interface SeedOptions {
  openApproval?: boolean;
  running?: boolean;
  unresolvedUnknown?: boolean;
  resolvedUnknown?: boolean;
  fault?: string;
}

interface SeededIds {
  openProposal: string;
  runningProposal: string;
  unresolvedProposal: string;
  resolvedProposal: string;
}

function seedProposal(journal: SqliteJournal, id: string, status: string): void {
  journal.insertProposal({
    id,
    contractVersion: 1,
    text: `CQ ${id.slice(0, 4)}`,
    frequencyHz: 7_030_000,
    mode: "CW",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    stateGeneration: 0,
    status: status as never,
    contentSha256: `hash-${id}`,
  });
}

function insertExecution(journal: SqliteJournal, id: string, status: string, detail: string | null = null): void {
  journal.insertExecution({
    proposalId: id,
    requestId: id,
    status: status as never,
    startedAt: new Date().toISOString(),
    finishedAt: status === "running" ? null : new Date().toISOString(),
    detail,
    frequencyHz: 7_030_000,
    mode: "CW",
    stateGeneration: 0,
    contentSha256: `hash-${id}`,
  });
}

function seedDb(path: string, options: SeedOptions = {}): SeededIds {
  const ids: SeededIds = {
    openProposal: randomUUID(),
    runningProposal: randomUUID(),
    unresolvedProposal: randomUUID(),
    resolvedProposal: randomUUID(),
  };
  const journal = new SqliteJournal(path);
  try {
    journal.transaction(() => {
      seedProposal(journal, ids.openProposal, "approved");
      journal.insertApproval({
        proposalId: ids.openProposal,
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        contentSha256: `hash-${ids.openProposal}`,
        frequencyHz: 7_030_000,
        mode: "CW",
        stateGeneration: 0,
        consumedAt: null,
        revokedAt: null,
        revokedReason: null,
      });

      seedProposal(journal, ids.runningProposal, "consumed");
      insertExecution(journal, ids.runningProposal, options.running ? "running" : "completed");

      seedProposal(journal, ids.unresolvedProposal, "consumed");
      if (options.unresolvedUnknown) insertExecution(journal, ids.unresolvedProposal, "unknown", "seeded unknown");

      seedProposal(journal, ids.resolvedProposal, "consumed");
      insertExecution(journal, ids.resolvedProposal, "unknown", "resolved unknown");
      journal.insertResolution({
        proposalId: ids.resolvedProposal,
        contractVersion: 1,
        resolvedAt: new Date().toISOString(),
        operator: "alice",
        note: "checked",
        confirmedStopped: true,
      });

      journal.append({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "seed.audit",
        entityId: "station",
        payload: { keep: true },
      });
      if (options.fault) journal.saveStorageFault(options.fault);
    });
  } finally {
    journal.close();
  }
  return ids;
}

/** 重新计算 bundle 数据库的大小/SHA256 并写回 manifest，用于构造“哈希正确但内容被篡改”的包。 */
function repairManifest(bundle: string): void {
  const dbPath = join(bundle, DATABASE_FILE_NAME);
  const manifestPath = join(bundle, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    database: { sizeBytes: number; sha256: string };
  };
  const data = readFileSync(dbPath);
  manifest.database.sizeBytes = data.byteLength;
  manifest.database.sha256 = createHash("sha256").update(data).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function runMaint(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const built = isInsideDirectory(fileURLToPath(import.meta.url), join(ROOT, "dist"));
  const entry = built ? [join(ROOT, "dist/apps/cwmaint.js")] : ["--import", "tsx", join(ROOT, "apps/cwmaint.ts")];
  const result = spawnSync(process.execPath, [...entry, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// ── 备份 ──────────────────────────────────────────────────────────────────

mtest("backup captures WAL-resident data and leaves the source unchanged", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);

  // 保持一个写连接，让最新审计留在 WAL 中而不写入主文件。
  const wal = new DatabaseSync(db);
  wal.exec("PRAGMA journal_mode=WAL;");
  const walId = randomUUID();
  wal
    .prepare("INSERT INTO audit_events (id, at, type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?)")
    .run(walId, new Date().toISOString(), "wal.audit", "station", '{"wal":true}');
  // 备份前的主文件字节：此时 WAL 尚未 checkpoint。
  const before = sha256File(db);

  const bundle = join(dir, "bundle");
  const result = backupDatabase(db, bundle);
  assert.equal(sha256File(db), before, "a read-only snapshot must not change the source main file");
  wal.close();

  const inspection = inspectBundle(bundle);
  assert.equal(inspection.manifest.database.sha256, result.databaseSha256);
  const snapshot = new DatabaseSync(join(bundle, DATABASE_FILE_NAME), { readOnly: true });
  try {
    const row = snapshot.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE id = ?").get(walId) as { n: number };
    assert.equal(row.n, 1, "WAL-resident audit row must be present in the consistent snapshot");
  } finally {
    snapshot.close();
  }
});

mtest("backup refuses an existing output and never deletes it", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);
  const sentinel = join(bundle, "user-sentinel.txt");
  writeFileSync(sentinel, "do not delete", "utf8");
  const manifestBefore = readFileSync(join(bundle, "manifest.json"), "utf8");

  expectMaintenanceError(() => backupDatabase(db, bundle), "output_exists");
  assert.equal(readFileSync(sentinel, "utf8"), "do not delete");
  assert.equal(readFileSync(join(bundle, "manifest.json"), "utf8"), manifestBefore);
});

mtest("backup is refused while the database lock is held, including via a symlink alias", (t) => {
  if (!canCreateSymlinks()) {
    t.skip("symlink creation is not permitted on this platform/user; lock-alias coverage is Unix-only");
    return;
  }
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);
  const canonical = canonicalPath(db);
  const lock = acquireLock(dbLockPath(canonical), "test-owner");
  const aliasDir = join(dir, "alias");
  mkdirSync(aliasDir);
  const alias = join(aliasDir, "alias.sqlite");
  symlinkSync(canonical, alias);
  try {
    expectMaintenanceError(() => backupDatabase(db, join(dir, "b1")), "locked");
    expectMaintenanceError(() => backupDatabase(alias, join(dir, "b2")), "locked");
    assert.equal(existsSync(join(dir, "b1")), false);
    assert.equal(existsSync(join(dir, "b2")), false);
  } finally {
    lock.release();
  }
  // 释放后可经别名正常备份。
  const result = backupDatabase(alias, join(dir, "b3"));
  assert.equal(result.manifest.schemaVersion, 4);
});

mtest("backup rejects a foreign or future database", (t) => {
  const dir = tempDir(t);
  const foreign = join(dir, "foreign.sqlite");
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE unrelated (x);");
  db.close();
  expectMaintenanceError(() => backupDatabase(foreign, join(dir, "b1")), "invalid_source");

  const future = join(dir, "future.sqlite");
  const fdb = new DatabaseSync(future);
  fdb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (99);");
  fdb.close();
  expectMaintenanceError(() => backupDatabase(future, join(dir, "b2")), "invalid_source");

  expectMaintenanceError(() => backupDatabase(join(dir, "missing.sqlite"), join(dir, "b3")), "not_found");
});

// ── 只读核查 ──────────────────────────────────────────────────────────────

mtest("inspect accepts a valid bundle and leaves it byte-for-byte unchanged", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db, { unresolvedUnknown: true, fault: "disk failed" });
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);

  const list = (): Record<string, string> => {
    const entries: Record<string, string> = {};
    for (const name of readdirSync(bundle).sort()) entries[name] = sha256File(join(bundle, name));
    return entries;
  };
  const before = list();
  const result = inspectBundle(bundle);
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.manifest.counts.audit, 1);
  assert.deepEqual(list(), before, "inspect must not add, remove or modify bundle files");
});

mtest("inspect rejects tampered data, future manifest versions, escapes and symlinks", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);

  const tampered = join(dir, "tampered");
  backupDatabase(db, tampered);
  const dbPath = join(tampered, DATABASE_FILE_NAME);
  const bytes = readFileSync(dbPath);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
  writeFileSync(dbPath, bytes);
  expectMaintenanceError(() => inspectBundle(tampered), "bundle_mismatch");

  const future = join(dir, "future");
  backupDatabase(db, future);
  const manifest = JSON.parse(readFileSync(join(future, "manifest.json"), "utf8")) as Record<string, unknown>;
  manifest.manifestVersion = 2;
  writeFileSync(join(future, "manifest.json"), JSON.stringify(manifest));
  expectMaintenanceError(() => inspectBundle(future), "invalid_bundle");

  const escape = join(dir, "escape");
  backupDatabase(db, escape);
  const escapeManifest = JSON.parse(readFileSync(join(escape, "manifest.json"), "utf8")) as {
    database: { fileName: string };
  };
  escapeManifest.database.fileName = "../outside.sqlite";
  writeFileSync(join(escape, "manifest.json"), JSON.stringify(escapeManifest));
  expectMaintenanceError(() => inspectBundle(escape), "invalid_bundle");

  const linked = join(dir, "linked");
  backupDatabase(db, linked);
  const linkedDb = join(linked, DATABASE_FILE_NAME);
  const realCopy = join(dir, "real-copy.sqlite");
  writeFileSync(realCopy, readFileSync(linkedDb));
  rmSync(linkedDb);
  if (canCreateSymlinks()) {
    symlinkSync(realCopy, linkedDb);
    expectMaintenanceError(() => inspectBundle(linked), "invalid_bundle");

    const manifestLink = join(dir, "manifest-link");
    backupDatabase(db, manifestLink);
    const realManifest = join(dir, "real-manifest.json");
    writeFileSync(realManifest, readFileSync(join(manifestLink, "manifest.json")));
    rmSync(join(manifestLink, "manifest.json"));
    symlinkSync(realManifest, join(manifestLink, "manifest.json"));
    expectMaintenanceError(() => inspectBundle(manifestLink), "invalid_bundle");
  } else {
    // 明确记录跳过原因，而不是静默省略 symlink 相关的核查覆盖。
    t.diagnostic("symlink checks skipped: symlink creation is not permitted on this platform/user");
  }
});

mtest("inspect rejects non-SQLite files, missing tables and forged columns", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);

  const garbage = join(dir, "garbage");
  backupDatabase(db, garbage);
  writeFileSync(join(garbage, DATABASE_FILE_NAME), Buffer.from("this is not a sqlite database at all"));
  repairManifest(garbage);
  expectMaintenanceError(() => inspectBundle(garbage), "invalid_bundle");

  const missingTable = join(dir, "missing-table");
  backupDatabase(db, missingTable);
  const mtDb = new DatabaseSync(join(missingTable, DATABASE_FILE_NAME));
  mtDb.exec("DROP TABLE execution_resolutions;");
  mtDb.close();
  repairManifest(missingTable);
  expectMaintenanceError(() => inspectBundle(missingTable), "invalid_bundle");

  const forgedColumn = join(dir, "forged-column");
  backupDatabase(db, forgedColumn);
  const fcDb = new DatabaseSync(join(forgedColumn, DATABASE_FILE_NAME));
  fcDb.exec("ALTER TABLE proposals RENAME COLUMN status TO proposal_status;");
  fcDb.close();
  repairManifest(forgedColumn);
  expectMaintenanceError(() => inspectBundle(forgedColumn), "invalid_bundle");

  expectMaintenanceError(() => parseManifest("not json"), "invalid_bundle");
  expectMaintenanceError(() => inspectBundle(join(dir, "missing-bundle")), "not_found");
});

mtest("inspect rejects a symlinked bundle directory and a future schema version", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);

  const realBundle = join(dir, "real-bundle");
  backupDatabase(db, realBundle);
  if (canCreateSymlinks()) {
    const linkBundle = join(dir, "link-bundle");
    symlinkSync(realBundle, linkBundle);
    expectMaintenanceError(() => inspectBundle(linkBundle), "invalid_bundle");
  } else {
    t.diagnostic("symlinked bundle directory check skipped: symlink creation is not permitted");
  }

  const futureSchema = join(dir, "future-schema");
  backupDatabase(db, futureSchema);
  const manifest = JSON.parse(readFileSync(join(futureSchema, "manifest.json"), "utf8")) as { schemaVersion: number };
  manifest.schemaVersion = 99;
  writeFileSync(join(futureSchema, "manifest.json"), JSON.stringify(manifest));
  expectMaintenanceError(() => inspectBundle(futureSchema), "invalid_bundle");
});

// ── 恢复 ──────────────────────────────────────────────────────────────────

mtest("restore creates a new database in a safe recovered state without touching the bundle", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  const ids = seedDb(db, { running: true, unresolvedUnknown: true, fault: "disk failed" });
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);
  const bundleHashBefore = sha256File(join(bundle, DATABASE_FILE_NAME));

  const target = join(dir, "restored.sqlite");
  const result = restoreBundle(bundle, target);
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.recovery.runningToUnknown, 1);
  assert.equal(result.recovery.approvalsRevoked, 1);
  assert.equal(sha256File(join(bundle, DATABASE_FILE_NAME)), bundleHashBefore, "restore must not modify the bundle");

  const journal = new SqliteJournal(target);
  try {
    assert.equal(journal.schemaVersion, 4);
    assert.equal(journal.getExecution(ids.runningProposal)?.status, "unknown");
    assert.equal(journal.getExecution(ids.runningProposal)?.detail?.includes("in-flight"), true);
    assert.equal(journal.getProposal(ids.openProposal)?.status, "cancelled");
    assert.ok(journal.getApproval(ids.openProposal)?.revokedAt, "restore must revoke all approvals");
    assert.equal(journal.getResolution(ids.resolvedProposal)?.note, "checked", "resolution records must be preserved");
    assert.equal(journal.getExecution(ids.resolvedProposal)?.status, "unknown");
    const state = journal.loadState();
    assert.equal(state.generation, 1, "restore must bump generation");
    assert.equal(state.storageFault, "disk failed", "storage fault must be preserved");
    assert.ok(state.blockedReason, "storage fault must keep the station blocked");
    assert.equal(journal.findUnresolvedUnknowns().length, 2, "running->unknown and prior unknown stay unresolved");
    assert.equal(journal.recent(20).some((event) => event.type === "maintenance.restored"), true);
    assert.equal(journal.countAudit() > 0, true);
  } finally {
    journal.close();
  }
});

mtest("restore refuses to overwrite an existing target or when its lock is held", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);

  const existing = join(dir, "existing.sqlite");
  writeFileSync(existing, "user data", "utf8");
  expectMaintenanceError(() => restoreBundle(bundle, existing), "conflict");
  assert.equal(readFileSync(existing, "utf8"), "user data");

  const lockedTarget = join(dir, "locked.sqlite");
  const lock = acquireLock(dbLockPath(canonicalPath(lockedTarget)), "test-owner");
  try {
    expectMaintenanceError(() => restoreBundle(bundle, lockedTarget), "locked");
  } finally {
    lock.release();
  }

  // 父目录不存在：拒绝凭空创建目录树，避免拼错路径的副作用。
  expectMaintenanceError(() => restoreBundle(bundle, join(dir, "missing-parent", "target.sqlite")), "output_parent_missing");
});

mtest("restore migrates an older schema bundle and preserves its data", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "legacy.sqlite");
  const ids = seedDb(db, { unresolvedUnknown: true });
  // 降级为真实 v2 形态：删除 v3/v4 结构并回退版本号。
  const legacy = new DatabaseSync(db);
  legacy.exec("DROP TABLE execution_resolutions; ALTER TABLE station_state DROP COLUMN storage_fault; UPDATE schema_version SET version = 2;");
  legacy.close();

  const bundle = join(dir, "bundle");
  const backup = backupDatabase(db, bundle);
  assert.equal(backup.manifest.schemaVersion, 2);

  const target = join(dir, "restored.sqlite");
  const result = restoreBundle(bundle, target);
  assert.equal(result.schemaVersion, 4);
  const journal = new SqliteJournal(target);
  try {
    assert.equal(journal.schemaVersion, 4, "restore must migrate the snapshot to the current schema");
    assert.equal(journal.getProposal(ids.openProposal)?.status, "cancelled");
    assert.equal(journal.getExecution(ids.unresolvedProposal)?.status, "unknown");
    assert.equal(journal.recent(20).some((event) => event.type === "seed.audit"), true, "legacy audit must survive migration");
  } finally {
    journal.close();
  }
});

mtest("a failed restore leaves no target file and no temporary directories", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as Record<string, unknown>;
  manifest.manifestVersion = 99;
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest));

  const target = join(dir, "restored.sqlite");
  expectMaintenanceError(() => restoreBundle(bundle, target), "invalid_bundle");
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(`${target}-wal`), false);
  assert.equal(existsSync(`${target}-shm`), false);
  assert.equal(
    readdirSync(dir).some((name) => name.startsWith(".cwmaint-restore-")),
    false,
    "no restore temp directory may survive a failure",
  );
});

// ── 清除存储故障 ──────────────────────────────────────────────────────────

mtest("clear-storage-fault requires confirmation and non-empty operator/note", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db, { fault: "disk failed" });
  expectMaintenanceError(() => clearStorageFault(db, "", "note", true), "usage");
  expectMaintenanceError(() => clearStorageFault(db, "alice", "   ", true), "usage");
  expectMaintenanceError(() => clearStorageFault(db, "alice", "note", false), "usage");
  const journal = new SqliteJournal(db);
  try {
    assert.equal(journal.loadState().storageFault, "disk failed");
  } finally {
    journal.close();
  }
});

mtest("clear-storage-fault conflicts and writes no audit when no fault exists", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);
  const journal = new SqliteJournal(db);
  const auditBefore = journal.countAudit();
  journal.close();

  expectMaintenanceError(() => clearStorageFault(db, "alice", "checked", true), "conflict");
  const after = new SqliteJournal(db);
  try {
    assert.equal(after.countAudit(), auditBefore);
    assert.equal(readdirSync(dir).some((name) => name.includes("fault-clear-backup")), false);
  } finally {
    after.close();
  }
});

mtest("clear-storage-fault backs up first, then clears, audits and bumps generation", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  const ids = seedDb(db, { running: true, fault: "disk write failed" });
  const before = new SqliteJournal(db);
  const generationBefore = before.loadState().generation;
  before.close();

  const result = clearStorageFault(db, "alice", "verified disk and restarted", true);
  assert.equal(result.previousFault, "disk write failed");
  assert.equal(result.generation, generationBefore + 1);
  assert.equal(existsSync(result.backupPath), true);
  const backupInspection = inspectBundle(result.backupPath);
  assert.equal(backupInspection.manifest.stationState.storageFault, "disk write failed");
  assert.equal(backupInspection.manifest.database.sha256, result.backupSha256);

  const journal = new SqliteJournal(db);
  try {
    assert.equal(journal.loadState().storageFault, null, "fault must be cleared");
    assert.equal(journal.loadState().generation, generationBefore + 1);
    assert.equal(journal.getExecution(ids.runningProposal)?.status, "unknown");
    const events = journal.recent(20);
    const cleared = events.find((event) => event.type === "maintenance.storage_fault_cleared");
    assert.ok(cleared, "clear must append an audit event");
    assert.equal(cleared?.payload.operator, "alice");
    assert.equal(cleared?.payload.backupPath, result.backupPath);
    assert.equal(cleared?.payload.previousFault, "disk write failed");
    // running→unknown 产生新的未核查 unknown，必须继续阻止。
    assert.match(journal.loadState().blockedReason ?? "", /unresolved unknown execution/);
  } finally {
    journal.close();
  }

  expectMaintenanceError(() => clearStorageFault(db, "alice", "again", true), "conflict");
});

mtest("clear-storage-fault keeps unresolved unknowns and unrelated blocking", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db, { unresolvedUnknown: true, fault: "disk failed" });
  const result = clearStorageFault(db, "alice", "checked", true);
  assert.match(result.blockedReason ?? "", /unresolved unknown execution/);

  // 有故障但 blockedReason 被写成另一个原因：清除后必须保留该原因。
  const other = join(dir, "other.sqlite");
  seedDb(other, { fault: "disk failed" });
  const journal = new SqliteJournal(other);
  const state = journal.loadState();
  journal.transaction(() => journal.saveState({ ...state, blockedReason: "operator hold" }));
  journal.close();
  expectMaintenanceError(() => clearStorageFault(other, "alice", "checked", true), "conflict");
});

mtest("clear-storage-fault rolls back and keeps the fault on a write failure", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  const ids = seedDb(db, { running: true, fault: "disk failed" });
  const setup = new SqliteJournal(db);
  const generationBefore = setup.loadState().generation;
  const auditBefore = setup.countAudit();
  setup.close();

  const originalAppend = SqliteJournal.prototype.append;
  t.mock.method(SqliteJournal.prototype, "append", function(this: SqliteJournal, event: Parameters<SqliteJournal["append"]>[0]) {
    if (event.type === "maintenance.storage_fault_cleared") throw new Error("injected audit write failure");
    return originalAppend.call(this, event);
  });
  assert.throws(() => clearStorageFault(db, "alice", "checked", true), /injected audit write failure/);

  const journal = new SqliteJournal(db);
  try {
    assert.equal(journal.loadState().storageFault, "disk failed", "fault must survive a failed clear");
    assert.equal(journal.loadState().generation, generationBefore, "generation must roll back");
    assert.equal(journal.getExecution(ids.runningProposal)?.status, "running", "running must roll back");
    assert.equal(journal.countAudit(), auditBefore, "audit must roll back");
  } finally {
    journal.close();
  }
});

mtest("after clearing, a restarted controller can re-authorize while the old unknown is never re-keyed", async (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  const ids = seedDb(db, { fault: "disk failed" });
  clearStorageFault(db, "alice", "checked", true);

  const journal = new SqliteJournal(db);
  const keyer = new FakeKeyer({ durationMs: 5 });
  const controller = new TxController(TxController.loadState(journal), keyer, journal, { txTimeoutMs: 500 });
  try {
    controller.recoverOnStartup();
    assert.equal(controller.status().blockedReason, null, "cleared fault with no unresolved unknown must unblock");

    // 原始已核查 unknown 重试仍返回 unknown，绝不重新键控。
    const retry = await controller.transmit(ids.resolvedProposal);
    assert.equal(retry.status, "unknown");
    assert.equal(keyer.keyedCount, 0, "an already-recorded execution must never be re-keyed");

    const fresh = controller.propose({ text: "CQ FRESH" });
    controller.approve(fresh.id);
    assert.equal((await controller.transmit(fresh.id)).status, "completed");
    assert.equal(keyer.keyedCount, 1);
  } finally {
    journal.close();
  }
});

// ── CLI ───────────────────────────────────────────────────────────────────

slowTest("cwmaint strictly rejects bad flags and maps exit codes", (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db);

  const unknownFlag = runMaint(["backup", "--db", db, "--out", join(dir, "b1"), "--bogus"]);
  assert.equal(unknownFlag.status, 2, unknownFlag.stdout);
  const duplicate = runMaint(["backup", "--db", db, "--db", db, "--out", join(dir, "b2")]);
  assert.equal(duplicate.status, 2, duplicate.stdout);
  const positional = runMaint(["backup", "extra", "--db", db, "--out", join(dir, "b3")]);
  assert.equal(positional.status, 2, positional.stdout);
  const missingValue = runMaint(["backup", "--db", "--out", join(dir, "b4")]);
  assert.equal(missingValue.status, 2, missingValue.stdout);
  const noConfirm = runMaint(["clear-storage-fault", "--db", db, "--operator", "alice", "--note", "checked"]);
  assert.equal(noConfirm.status, 2, noConfirm.stdout);
  const inlineConfirm = runMaint([
    "clear-storage-fault",
    "--db",
    db,
    "--operator",
    "alice",
    "--note",
    "checked",
    "--confirm-stopped=true",
  ]);
  assert.equal(inlineConfirm.status, 2, inlineConfirm.stdout);
  const missingBundle = runMaint(["inspect", "--bundle", join(dir, "missing")]);
  assert.equal(missingBundle.status, 3, missingBundle.stdout);
});

mtest("cwmaint takes dbPath from --config and lets --db override it", (t) => {
  const dir = tempDir(t);
  const fromConfig = join(dir, "from-config.sqlite");
  const fromCli = join(dir, "from-cli.sqlite");
  seedDb(fromConfig);
  seedDb(fromCli);
  const configPath = join(dir, "station.json");
  writeFileSync(configPath, `${JSON.stringify({ version: 1, dbPath: fromConfig })}\n`, "utf8");

  const viaConfig = runMaint(["backup", "--config", configPath, "--out", join(dir, "b1")]);
  assert.equal(viaConfig.status, 0, viaConfig.stdout);
  const configManifest = JSON.parse(viaConfig.stdout) as { result: { manifest: { counts: { audit: number } } } };
  assert.equal(configManifest.result.manifest.counts.audit, 1);

  const viaCli = runMaint(["backup", "--config", configPath, "--db", fromCli, "--out", join(dir, "b2")]);
  assert.equal(viaCli.status, 0, viaCli.stdout);
  const cliManifest = JSON.parse(viaCli.stdout) as { result: { bundlePath: string } };
  assert.equal(cliManifest.result.bundlePath, join(dir, "b2"));

  // config 无效时即使 inspect 不需要 dbPath 也必须先报用法错误。
  writeFileSync(join(dir, "bad.json"), `${JSON.stringify({ version: 1, nope: true })}\n`, "utf8");
  const badConfig = runMaint(["inspect", "--config", join(dir, "bad.json"), "--bundle", join(dir, "b1")]);
  assert.equal(badConfig.status, 2, badConfig.stdout);
});

slowTest("cwmaint end-to-end: backup, inspect, restore and clear with pure JSON exit codes", async (t) => {
  const dir = tempDir(t);
  const db = join(dir, "cw.sqlite");
  seedDb(db, { running: true, fault: "disk failed" });
  const bundle = join(dir, "bundle");
  const target = join(dir, "restored.sqlite");

  const backup = runMaint(["backup", "--db", db, "--out", bundle]);
  assert.equal(backup.status, 0, backup.stdout);
  assert.equal((JSON.parse(backup.stdout) as { ok: boolean }).ok, true);

  const overwrite = runMaint(["backup", "--db", db, "--out", bundle]);
  assert.equal(overwrite.status, 4, overwrite.stdout);

  const inspect = runMaint(["inspect", "--bundle", bundle]);
  assert.equal(inspect.status, 0, inspect.stdout);

  const restore = runMaint(["restore", "--bundle", bundle, "--db", target]);
  assert.equal(restore.status, 0, restore.stdout);

  const clear = runMaint([
    "clear-storage-fault",
    "--db",
    db,
    "--operator",
    "alice",
    "--note",
    "checked and restarted",
    "--confirm-stopped",
  ]);
  assert.equal(clear.status, 0, clear.stdout);
  const clearJson = JSON.parse(clear.stdout) as { result: { backupPath: string } };
  assert.equal(existsSync(clearJson.result.backupPath), true);

  // 活动 daemon 持锁时 backup 必须拒绝。
  const daemon = await startDaemon({ dir: join(dir, "daemon"), env: { CWSTATION_FAKE_DURATION_MS: "5" } });
  try {
    t.signal.throwIfAborted();
    const locked = runMaint(["backup", "--db", daemon.dbPath, "--out", join(dir, "daemon-bundle")]);
    assert.equal(locked.status, 4, locked.stdout);
    assert.equal(locked.stdout.includes("locked"), true);
  } finally {
    await daemon.stop();
  }
});
