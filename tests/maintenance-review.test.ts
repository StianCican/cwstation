import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { backupDatabase, clearStorageFault, inspectBundle, restoreBundle } from "../packages/maintenance/src/index.js";
import { defaultRuntimeDir } from "../packages/daemon/src/paths.js";
import { ROOT, canCreateSymlinks, isInsideDirectory } from "./helpers.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cw-maint-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "source.sqlite");
  const journal = new SqliteJournal(db);
  journal.close();
  return { dir, db };
}

test("Codex: default runtime directory retains its environment override", () => {
  assert.equal(defaultRuntimeDir({ CWSTATION_RUNTIME_DIR: "/tmp/cw-override" }), resolve("/tmp/cw-override"));
});

test("Codex: dangling output links are preserved for backup and restore", (t) => {
  if (!canCreateSymlinks()) {
    t.skip("symlink creation is not permitted on this platform/user");
    return;
  }
  const { dir, db } = fixture(t);
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);
  const output = join(dir, "output");
  symlinkSync(join(dir, "missing"), output);
  assert.throws(() => backupDatabase(db, output));
  assert.throws(() => restoreBundle(bundle, output));
  assert.ok(lstatSync(output).isSymbolicLink());
});

test("Codex: database hard-link aliases cannot bypass maintenance locking", (t) => {
  const { dir, db } = fixture(t);
  const alias = join(dir, "alias.sqlite");
  linkSync(db, alias);
  assert.throws(() => backupDatabase(alias, join(dir, "bundle")), /hard links/);
});

test("Codex: bundle SQLite sidecars including dangling links are rejected", (t) => {
  if (!canCreateSymlinks()) {
    t.skip("symlink creation is not permitted on this platform/user");
    return;
  }
  const { dir, db } = fixture(t);
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);
  const wal = join(bundle, "cwstation.sqlite-wal");
  symlinkSync(join(dir, "missing"), wal);
  assert.throws(() => inspectBundle(bundle), /sidecars/);
  assert.ok(lstatSync(wal).isSymbolicLink());
});

for (const [name, sql] of [
  ["duplicate schema records", "INSERT INTO schema_version VALUES (4)"],
  ["missing station state", "DELETE FROM station_state"],
  ["missing primary key", "ALTER TABLE audit_events RENAME TO old_audit; CREATE TABLE audit_events AS SELECT * FROM old_audit; DROP TABLE old_audit"],
  ["custom trigger", "CREATE TRIGGER custom_write AFTER INSERT ON audit_events BEGIN DELETE FROM approvals; END"],
] as const) {
  test(`Codex: maintenance rejects ${name}`, (t) => {
    const { dir, db } = fixture(t);
    const raw = new DatabaseSync(db);
    raw.exec(sql);
    raw.close();
    assert.throws(() => backupDatabase(db, join(dir, "bundle")));
  });
}

test("Codex: clearing a fault refuses unrelated blocking and retains the original state", (t) => {
  const { db } = fixture(t);
  const journal = new SqliteJournal(db);
  journal.saveStorageFault("disk fault");
  journal.saveState({ ...journal.loadState(), blockedReason: "operator hold" });
  journal.close();
  assert.throws(() => clearStorageFault(db, "operator", "checked", true), /unrelated/);
  const check = new SqliteJournal(db);
  try {
    assert.equal(check.loadState().storageFault, "disk fault");
    assert.equal(check.loadState().blockedReason, "operator hold");
    assert.equal(check.loadState().generation, 0);
  } finally { check.close(); }
});

test("Codex: restore and fault clearing cannot replace an operator hold with unknown blocking", (t) => {
  const { dir, db } = fixture(t);
  const raw = new DatabaseSync(db);
  raw.exec("INSERT INTO proposals VALUES ('p', 1, 'E', 7030000, 'CW', '2026-10-05T00:00:00Z', '2026-10-05T00:01:00Z', 0, 'consumed', 'hash');" +
    "INSERT INTO executions VALUES ('p', 'request', 'unknown', '2026-10-05T00:00:00Z', '2026-10-05T00:00:01Z', NULL, 7030000, 'CW', 0, 'hash');" +
    "UPDATE station_state SET blocked_reason='operator hold', storage_fault='disk fault';");
  raw.close();
  const bundle = join(dir, "bundle");
  backupDatabase(db, bundle);
  const target = join(dir, "restored.sqlite");
  assert.throws(() => restoreBundle(bundle, target), /unrelated/);
  assert.throws(() => clearStorageFault(db, "operator", "checked", true), /unrelated/);
  const check = new SqliteJournal(db);
  try { assert.equal(check.loadState().blockedReason, "operator hold"); } finally { check.close(); }
});

test("Codex: cwmaint accepts leading config and honors environment then CLI overrides", (t) => {
  const { dir, db } = fixture(t);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ version: 1, dbPath: join(dir, "missing.sqlite") }));
  const built = isInsideDirectory(fileURLToPath(import.meta.url), join(ROOT, "dist"));
  const entry = built ? [join(ROOT, "dist/apps/cwmaint.js")] : ["--import", "tsx", join(ROOT, "apps/cwmaint.ts")];
  const out = join(dir, "bundle");
  const result = spawnSync(process.execPath, [...entry, "--config", config, "backup", "--out", out], {
    cwd: ROOT, encoding: "utf8", timeout: 15_000, env: { ...process.env, CWSTATION_DB: db },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).schemaVersion, 4);
  const second = spawnSync(process.execPath, [...entry, "backup", "--config", config, "--db", db, "--out", join(dir, "second")], {
    cwd: ROOT, encoding: "utf8", timeout: 15_000, env: { ...process.env, CWSTATION_DB: join(dir, "missing.sqlite") },
  });
  assert.equal(second.status, 0, second.stdout + second.stderr);
});
