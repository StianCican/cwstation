import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SqliteJournal, SchemaVersionError, SCHEMA_VERSION } from "../packages/journal/src/sqlite.js";
import type { Execution, ExecutionResolution, Proposal } from "../packages/contracts/src/index.js";

type TestFn = (t: TestContext) => void | Promise<void>;
const TEST_TIMEOUT_MS = 10_000;
function jtest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-journal-"));
  return { dir, path: join(dir, "test.sqlite") };
}

jtest("fresh database migrates to current schema", () => {
  const { dir, path } = tempDbPath();
  try {
    const journal = new SqliteJournal(path);
    assert.equal(journal.schemaVersion, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 4);
    assert.deepEqual(journal.countProposalsByStatus(), {});
    assert.equal(journal.countAudit(), 0);
    journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("v1 database is migrated without losing existing audit data", () => {
  const { dir, path } = tempDbPath();
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE schema_version (version INTEGER NOT NULL);" +
        "INSERT INTO schema_version (version) VALUES (1);" +
        "CREATE TABLE audit_events (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL);",
    );
    legacy
      .prepare("INSERT INTO audit_events (id, at, type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-1", "2020-01-01T00:00:00.000Z", "legacy.event", "station", '{"keep":true}');
    legacy.close();

    const journal = new SqliteJournal(path);
    assert.equal(journal.schemaVersion, SCHEMA_VERSION);
    const events = journal.recent(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, "legacy-1");
    assert.deepEqual(events[0]?.payload, { keep: true });

    // 新表可用，旧数据仍在。
    const proposal: Proposal = {
      id: randomUUID(),
      contractVersion: 1,
      text: "CQ",
      frequencyHz: 7_030_000,
      mode: "CW",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      stateGeneration: 1,
      status: "pending",
      contentSha256: "abc",
    };
    journal.transaction(() => journal.insertProposal(proposal));
    assert.equal(journal.getProposal(proposal.id)?.text, "CQ");
    assert.equal(journal.countAudit(), 1);
    journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("future schema version is refused", () => {
  const { dir, path } = tempDbPath();
  try {
    const future = new DatabaseSync(path);
    future.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (99);");
    future.close();
    assert.throws(() => new SqliteJournal(path), SchemaVersionError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("transaction rollback leaves no partial writes", () => {
  const { dir, path } = tempDbPath();
  try {
    const journal = new SqliteJournal(path);
    const before = journal.countAudit();
    assert.throws(() => {
      journal.transaction(() => {
        journal.append({
          id: randomUUID(),
          at: new Date().toISOString(),
          type: "should.rollback",
          entityId: "x",
          payload: {},
        });
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(journal.countAudit(), before);
    journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("execution records round-trip and running lookup works", () => {
  const { dir, path } = tempDbPath();
  try {
    const journal = new SqliteJournal(path);
    const id = randomUUID();
    const proposal: Proposal = {
      id,
      contractVersion: 1,
      text: "CQ",
      frequencyHz: 7_030_000,
      mode: "CW",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      stateGeneration: 0,
      status: "consumed",
      contentSha256: "deadbeef",
    };
    const execution: Execution = {
      proposalId: id,
      requestId: id,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      detail: null,
      frequencyHz: 7_030_000,
      mode: "CW",
      stateGeneration: 0,
      contentSha256: "deadbeef",
    };
    journal.transaction(() => {
      journal.insertProposal(proposal);
      journal.insertExecution(execution);
    });
    assert.equal(journal.findRunningExecutions().length, 1);
    journal.transaction(() => journal.updateExecutionStatus(id, "unknown", new Date().toISOString(), "test"));
    assert.equal(journal.findRunningExecutions().length, 0);
    assert.equal(journal.findLastUnknownExecution()?.proposalId, id);
    assert.deepEqual(journal.countExecutionsByStatus(), { unknown: 1 });
    journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("terminateOpenProposalsByExpiry terminates all open proposals in one batch", () => {
  const { dir, path } = tempDbPath();
  try {
    const journal = new SqliteJournal(path);
    const make = (suffix: string, expiresAt: string): Proposal => ({
      id: randomUUID(),
      contractVersion: 1,
      text: `CQ ${suffix}`,
      frequencyHz: 7_030_000,
      mode: "CW",
      createdAt: new Date().toISOString(),
      expiresAt,
      stateGeneration: 0,
      status: "pending",
      contentSha256: `hash-${suffix}`,
    });
    const now = Date.now();
    const past = make("past", new Date(now - 60_000).toISOString());
    const future = make("future", new Date(now + 60_000).toISOString());
    const approved = { ...make("approved", new Date(now + 60_000).toISOString()), status: "approved" as const };
    journal.transaction(() => {
      journal.insertProposal(past);
      journal.insertProposal(future);
      journal.insertProposal(approved);
    });

    const result = journal.terminateOpenProposalsByExpiry(new Date(now).toISOString());
    assert.deepEqual(result, { expired: 1, cancelled: 2 });
    assert.equal(journal.getProposal(past.id)?.status, "expired");
    assert.equal(journal.getProposal(future.id)?.status, "cancelled");
    assert.equal(journal.getProposal(approved.id)?.status, "cancelled");
    assert.deepEqual(journal.countProposalsByStatus(), { expired: 1, cancelled: 2 });

    // 再次调用不改变已终止状态。
    assert.deepEqual(journal.terminateOpenProposalsByExpiry(new Date(now).toISOString()), { expired: 0, cancelled: 0 });
    journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造一条 unknown 执行记录（proposal 与外键由调用方先插入）。 */
function unknownExecution(proposalId: string, startedAt: string): Execution {
  return {
    proposalId,
    requestId: proposalId,
    status: "unknown",
    startedAt,
    finishedAt: startedAt,
    detail: "test unknown",
    frequencyHz: 7_030_000,
    mode: "CW",
    stateGeneration: 0,
    contentSha256: `hash-${proposalId}`,
  };
}

function seedProposal(journal: SqliteJournal, id: string): Proposal {
  const proposal: Proposal = {
    id,
    contractVersion: 1,
    text: "CQ",
    frequencyHz: 7_030_000,
    mode: "CW",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    stateGeneration: 0,
    status: "consumed",
    contentSha256: `hash-${id}`,
  };
  journal.transaction(() => journal.insertProposal(proposal));
  return proposal;
}

jtest("v2 database with executions and audit migrates to current schema without data loss", () => {
  const { dir, path } = tempDbPath();
  try {
    const created = new SqliteJournal(path);
    const id = randomUUID();
    seedProposal(created, id);
    created.transaction(() => {
      created.insertExecution(unknownExecution(id, "2020-01-01T00:00:00.000Z"));
      created.append({
        id: "audit-v2",
        at: "2020-01-01T00:00:00.000Z",
        type: "legacy.event",
        entityId: "station",
        payload: { keep: true },
      });
    });
    created.close();

    // 回退到真实 v2 形态：删除 v3 新表并把版本设为 2。
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE execution_resolutions; ALTER TABLE station_state DROP COLUMN storage_fault; UPDATE schema_version SET version = 2;");
    legacy.close();

    const migrated = new SqliteJournal(path);
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.getExecution(id)?.status, "unknown", "v2 execution must be preserved as unknown");
    assert.equal(migrated.recent(10).some((event) => event.id === "audit-v2"), true, "v2 audit must be preserved");
    assert.equal(migrated.countResolutions(), 0);
    // v3 新表可用。
    migrated.transaction(() =>
      migrated.insertResolution({
        proposalId: id,
        contractVersion: 1,
        resolvedAt: new Date().toISOString(),
        operator: "op",
        note: "checked",
        confirmedStopped: true,
      }),
    );
    assert.equal(migrated.getResolution(id)?.confirmedStopped, true);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("v3 migration preserves resolution records and adds a separate storage fault", () => {
  const { dir, path } = tempDbPath();
  try {
    const created = new SqliteJournal(path);
    const id = randomUUID();
    seedProposal(created, id);
    created.insertExecution(unknownExecution(id, "2020-01-01T00:00:00.000Z"));
    created.insertResolution({ proposalId: id, contractVersion: 1, resolvedAt: new Date().toISOString(), operator: "op", note: "checked", confirmedStopped: true });
    created.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE station_state DROP COLUMN storage_fault; UPDATE schema_version SET version = 3;");
    legacy.close();
    const migrated = new SqliteJournal(path);
    try {
      assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
      assert.equal(migrated.getResolution(id)?.note, "checked");
      assert.equal(migrated.getExecution(id)?.status, "unknown");
      assert.equal(migrated.loadState().storageFault, null);
      migrated.saveStorageFault("disk failed");
      assert.equal(migrated.loadState().storageFault, "disk failed");
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("v3 migration preserves unrelated persisted blocking even alongside unknown", () => {
  const { dir, path } = tempDbPath();
  try {
    const created = new SqliteJournal(path);
    const id = randomUUID();
    seedProposal(created, id);
    created.insertExecution(unknownExecution(id, "2020-01-01T00:00:00.000Z"));
    created.saveState({ ...created.loadState(), blockedReason: "failed to persist state" });
    created.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE station_state DROP COLUMN storage_fault; UPDATE schema_version SET version = 3;");
    legacy.close();
    const migrated = new SqliteJournal(path);
    try {
      assert.equal(migrated.loadState().storageFault, "failed to persist state");
      assert.equal(migrated.findUnresolvedUnknowns().length, 1);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

jtest("unresolved unknown query excludes resolved and includes every unresolved row", () => {
  const { dir, path } = tempDbPath();
  try {
    const journal = new SqliteJournal(path);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      ids.push(id);
      seedProposal(journal, id);
      journal.transaction(() => journal.insertExecution(unknownExecution(id, `2020-01-0${i + 1}T00:00:00.000Z`)));
    }

    assert.equal(journal.findUnresolvedUnknowns().length, 5, "no LIMIT may hide unresolved unknowns");
    const resolution: ExecutionResolution = {
      proposalId: ids[2] as string,
      contractVersion: 1,
      resolvedAt: new Date().toISOString(),
      operator: "op",
      note: "confirmed stopped",
      confirmedStopped: true,
    };
    journal.transaction(() => journal.insertResolution(resolution));

    const unresolved = journal.findUnresolvedUnknowns();
    assert.equal(unresolved.length, 4);
    assert.equal(
      unresolved.some((execution) => execution.proposalId === ids[2]),
      false,
    );
    assert.equal(journal.getExecution(ids[2] as string)?.status, "unknown", "original execution stays unknown");
    assert.equal(journal.countResolutions(), 1);
    // 升序且 findLastUnresolvedUnknown 返回最后一条。
    assert.deepEqual(
      unresolved.map((execution) => execution.proposalId),
      [ids[0], ids[1], ids[3], ids[4]],
    );
    assert.equal(journal.findLastUnresolvedUnknown()?.proposalId, ids[4]);

    // 重复插入同一 resolution 必须失败（PRIMARY KEY），不静默覆盖。
    assert.throws(() => journal.transaction(() => journal.insertResolution(resolution)));
    journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
