// P0-003：unknown 人工核查与解除。
// 覆盖：严格校验、非法目标、本进程 unknown 需重启、重启后解除、幂等、
// 多 unknown 部分解除、撤销旧授权、原执行永不重键、重启后不再 blocked、
// 写失败原子回滚、其他存储故障闩锁、跨进程 RPC 与 CLI 退出码。

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_OPERATOR_MAX_LENGTH,
} from "../packages/contracts/src/index.js";
import { ControllerError, TxController, type ControllerOptions } from "../packages/core/src/tx-controller.js";
import { FakeKeyer } from "../packages/core/src/keyer.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { DaemonClient } from "../packages/daemon/src/client.js";
import { DaemonServer } from "../packages/daemon/src/server.js";
import { endpointAddress } from "../packages/daemon/src/endpoint.js";
import { ROOT, cliEntry, sleep, startDaemon, testEndpoint } from "./helpers.js";

type Json = Record<string, unknown>;
type TestFn = (t: TestContext) => void | Promise<void>;

const TEST_TIMEOUT_MS = 30_000;
function ctest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}
function dtest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

const VALID = { operator: "alice", note: "checked, transmitter is stopped", confirmStopped: true } as const;

ctest("persisted storage fault survives restart alongside unresolved unknown", (t) => {
  const { controller, journal, keyer } = harness(t);
  const id = seedUnknown(controller, journal);
  controller.recoverOnStartup();
  const saveState = journal.saveState.bind(journal);
  journal.saveState = () => { throw new Error("transient state write failure"); };
  mustThrowCode(() => controller.setState({ frequencyHz: 7_040_000 }, "retune"), "internal");
  journal.saveState = saveState;
  controller.setState({ frequencyHz: 7_040_000 }, "retry-retune");
  assert.ok(journal.loadState().storageFault);
  const restarted = new TxController(TxController.loadState(journal), keyer, journal);
  restarted.recoverOnStartup();
  assert.equal(restarted.unknownReview().faultLatched, true);
  mustThrowCode(() => restarted.resolveUnknown(id, VALID), "blocked");
  assert.equal(journal.getResolution(id), undefined);
});

dtest("non-Fake server cannot use the offline unknown resolution flow", async (t) => {
  const { controller, journal, dir } = harness(t);
  const id = seedUnknown(controller, journal);
  controller.recoverOnStartup();
  const endpoint = testEndpoint(dir);
  const socketPath = endpointAddress(endpoint);
  const server = new DaemonServer({ endpoint, dbPath: journal.path, controller, journal, fakeOnly: false });
  await server.start();
  const client = await DaemonClient.connect(socketPath);
  try {
    await assert.rejects(client.request("resolve-unknown", { proposalId: id, ...VALID }), /only for the Fake backend/);
    assert.equal(journal.getResolution(id), undefined);
  } finally {
    client.close();
    await server.stop();
  }
});

function mustThrowCode(fn: () => unknown, code: string): ControllerError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ControllerError, `expected ControllerError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected ControllerError(${code}) but nothing was thrown`);
}

interface Harness {
  controller: TxController;
  journal: SqliteJournal;
  keyer: FakeKeyer;
  dir: string;
}

function harness(t: TestContext, options: ControllerOptions = {}, keyer = new FakeKeyer()): Harness {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-resolve-"));
  const journal = new SqliteJournal(join(dir, "test.sqlite"));
  const controller = new TxController(TxController.loadState(journal), keyer, journal, options);
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { controller, journal, keyer, dir };
}

/** 造一条 unknown 执行（消费提案与批准），返回 proposalId。 */
function seedUnknown(controller: TxController, journal: SqliteJournal): string {
  const proposal = controller.propose({ text: "CQ SEED" });
  controller.approve(proposal.id);
  journal.transaction(() => {
    journal.setProposalStatus(proposal.id, "consumed");
    journal.consumeApproval(proposal.id, new Date().toISOString());
    journal.insertExecution({
      proposalId: proposal.id,
      requestId: proposal.id,
      status: "unknown",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      detail: "seed unknown",
      frequencyHz: proposal.frequencyHz,
      mode: proposal.mode,
      stateGeneration: proposal.stateGeneration,
      contentSha256: proposal.contentSha256,
    });
  });
  return proposal.id;
}

/** 造出 count 条 unknown，并用新控制器完成启动恢复（模拟停机重启），使其可解除。 */
function recoverWithUnknowns(t: TestContext, count = 1, options: ControllerOptions = {}) {
  const h = harness(t, options);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(seedUnknown(h.controller, h.journal));
  const controller = new TxController(TxController.loadState(h.journal), h.keyer, h.journal, options);
  controller.recoverOnStartup();
  return { controller, journal: h.journal, keyer: h.keyer, ids, dir: h.dir };
}

// ── 严格校验 ──────────────────────────────────────────────────────────────

ctest("resolve-unknown rejects missing confirmation, empty fields and over-length input", (t) => {
  const { controller, journal, ids } = recoverWithUnknowns(t);
  const id = ids[0] as string;

  mustThrowCode(() => controller.resolveUnknown(id, { operator: "alice", note: "n", confirmStopped: false }), "invalid_params");
  mustThrowCode(
    () => controller.resolveUnknown(id, { operator: "alice", note: "n", confirmStopped: "true" as unknown as boolean }),
    "invalid_params",
  );
  mustThrowCode(() => controller.resolveUnknown(id, { operator: "", note: "n", confirmStopped: true }), "invalid_params");
  mustThrowCode(() => controller.resolveUnknown(id, { operator: "   ", note: "n", confirmStopped: true }), "invalid_params");
  mustThrowCode(() => controller.resolveUnknown(id, { operator: "alice", note: "", confirmStopped: true }), "invalid_params");
  mustThrowCode(
    () => controller.resolveUnknown(id, { operator: "x".repeat(RESOLUTION_OPERATOR_MAX_LENGTH + 1), note: "n", confirmStopped: true }),
    "invalid_params",
  );
  mustThrowCode(
    () => controller.resolveUnknown(id, { operator: "alice", note: "x".repeat(RESOLUTION_NOTE_MAX_LENGTH + 1), confirmStopped: true }),
    "invalid_params",
  );
  mustThrowCode(() => controller.resolveUnknown("", VALID), "invalid_params");

  // 全部被拒后仍是未解除，未写入任何 resolution。
  assert.equal(controller.unknownReview().unresolvedUnknownCount, 1);
  assert.equal(journal.getResolution(id), undefined);
});

// ── 非法目标 ──────────────────────────────────────────────────────────────

ctest("resolve-unknown rejects nonexistent, non-unknown and running executions", async (t) => {
  const { controller, journal } = harness(t, {}, new FakeKeyer({ durationMs: 5 }));
  controller.recoverOnStartup();

  mustThrowCode(() => controller.resolveUnknown("does-not-exist", VALID), "not_found");

  // 正常完成（非 unknown）。
  const completed = controller.propose({ text: "CQ DONE" });
  controller.approve(completed.id);
  assert.equal((await controller.transmit(completed.id)).status, "completed");
  mustThrowCode(() => controller.resolveUnknown(completed.id, VALID), "conflict");

  // running：恢复后新增的遗留 running 记录仍不可解除。
  const running = controller.propose({ text: "CQ RUN" });
  journal.transaction(() =>
    journal.insertExecution({
      proposalId: running.id,
      requestId: running.id,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      detail: null,
      frequencyHz: running.frequencyHz,
      mode: running.mode,
      stateGeneration: running.stateGeneration,
      contentSha256: running.contentSha256,
    }),
  );
  mustThrowCode(() => controller.resolveUnknown(running.id, VALID), "conflict");
});

// ── 本次进程新增 unknown 必须先重启 ──────────────────────────────────────

ctest("an unknown created after startup recovery requires a restart", async (t) => {
  const keyer = new FakeKeyer({ durationMs: 300, ignoreAbort: true });
  const { controller } = harness(t, { txTimeoutMs: 40 }, keyer);
  controller.recoverOnStartup();

  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  assert.equal((await controller.transmit(proposal.id)).status, "unknown");

  mustThrowCode(() => controller.resolveUnknown(proposal.id, VALID), "conflict");
  assert.equal(controller.unknownReview().unresolvedUnknownCount, 1);
  assert.equal(controller.unknownReview().eligibleToResolve, 0);
  assert.equal(controller.unknownReview().requiresRestart, 1);
});

// ── 重启后解除：撤销旧授权、原执行保留、需重新批准 ───────────────────────

ctest("resolve after restart unblocks, revokes old authorizations and never re-keys", async (t) => {
  const { controller, journal, keyer, ids } = recoverWithUnknowns(t);
  const originalId = ids[0] as string;

  // 解除前存在一条已批准提案，解除必须一并撤销。
  const open = controller.propose({ text: "CQ NEXT" });
  controller.approve(open.id);
  const generationBefore = controller.status().generation;

  const resolution = controller.resolveUnknown(originalId, VALID);
  assert.equal(resolution.proposalId, originalId);
  assert.equal(resolution.confirmedStopped, true);
  assert.equal(resolution.operator, "alice");

  assert.equal(controller.status().generation, generationBefore + 1, "resolution must bump generation");
  assert.equal(journal.getProposal(open.id)?.status, "cancelled");
  assert.ok(journal.getApproval(open.id)?.revokedAt, "old approval must be revoked");
  assert.equal(controller.status().blockedReason, null);
  assert.equal(journal.getExecution(originalId)?.status, "unknown", "original execution stays unknown");
  assert.equal(journal.getResolution(originalId)?.note, VALID.note);
  assert.ok(journal.recent(50).some((event) => event.type === "tx.unknown_resolved"));

  // 原提案重试仍返回原 unknown 结果，绝不重新键控。
  const retry = await controller.transmit(originalId);
  assert.equal(retry.status, "unknown");
  assert.equal(keyer.keyedCount, 0);

  // 新提案必须重新批准；旧批准已不可用。
  const fresh = controller.propose({ text: "CQ FRESH" });
  await assert.rejects(controller.transmit(fresh.id), (error: unknown) => {
    assert.ok(error instanceof ControllerError);
    assert.equal(error.code, "conflict");
    return true;
  });
  controller.approve(fresh.id);
  assert.equal((await controller.transmit(fresh.id)).status, "completed");
  assert.equal(keyer.keyedCount, 1);
});

// ── 幂等 ──────────────────────────────────────────────────────────────────

ctest("repeating resolve returns the existing resolution without extra audit or generation change", (t) => {
  const { controller, journal, ids } = recoverWithUnknowns(t);
  const id = ids[0] as string;

  const first = controller.resolveUnknown(id, VALID);
  const generation = controller.status().generation;
  const auditCount = journal.countAudit();

  const second = controller.resolveUnknown(id, { operator: "bob", note: "different", confirmStopped: true });
  assert.deepEqual(second, first, "retry must return the stored resolution");
  assert.equal(controller.status().generation, generation);
  assert.equal(journal.countAudit(), auditCount, "retry must not write extra audit");
  assert.equal(journal.countResolutions(), 1);
});

// ── 多 unknown 部分解除仍阻止 ─────────────────────────────────────────────

ctest("multiple unknowns stay blocked until the last one is resolved", (t) => {
  const { controller, ids } = recoverWithUnknowns(t, 2);
  assert.equal(controller.unknownReview().unresolvedUnknownCount, 2);
  assert.equal(controller.unknownReview().eligibleToResolve, 2);
  const generation = controller.status().generation;

  controller.resolveUnknown(ids[0] as string, VALID);
  assert.ok(controller.status().blockedReason, "one remaining unknown must keep the station blocked");
  assert.equal(controller.unknownReview().unresolvedUnknownCount, 1);
  assert.equal(controller.status().generation, generation + 1);

  controller.resolveUnknown(ids[1] as string, VALID);
  assert.equal(controller.status().blockedReason, null);
  assert.equal(controller.unknownReview().unresolvedUnknownCount, 0);
  assert.equal(controller.status().generation, generation + 2);
});

// ── 重启后已解除不再 blocked ─────────────────────────────────────────────

ctest("a resolved unknown does not block again after restart", (t) => {
  const { controller, journal, keyer, ids } = recoverWithUnknowns(t);
  controller.resolveUnknown(ids[0] as string, VALID);
  assert.equal(controller.status().blockedReason, null);

  const restarted = new TxController(TxController.loadState(journal), keyer, journal);
  restarted.recoverOnStartup();
  assert.equal(restarted.status().blockedReason, null, "resolved unknown must not re-block");
  assert.equal(restarted.unknownReview().unresolvedUnknownCount, 0);
  assert.equal(restarted.unknownReview().eligibleToResolve, 0);
});

// ── 写失败原子回滚 ────────────────────────────────────────────────────────

ctest("resolve write failure rolls back atomically and keeps the station blocked", (t) => {
  const { controller, journal, ids } = recoverWithUnknowns(t);
  const id = ids[0] as string;
  const generation = controller.status().generation;
  const auditCount = journal.countAudit();

  journal.insertResolution = () => {
    throw new Error("disk full");
  };
  mustThrowCode(() => controller.resolveUnknown(id, VALID), "internal");

  assert.equal(journal.getResolution(id), undefined, "resolution must not be persisted");
  assert.equal(journal.countResolutions(), 0);
  assert.equal(journal.getExecution(id)?.status, "unknown", "original execution unchanged");
  assert.equal(controller.status().generation, generation, "generation must roll back");
  assert.ok(controller.status().blockedReason, "station must stay blocked");
  assert.equal(journal.countAudit(), auditCount, "audit must roll back with the transaction");
  assert.equal(controller.unknownReview().faultLatched, true);
});

// ── 其他存储故障不得被 resolution 清除 ───────────────────────────────────

ctest("a persistence fault latches and resolve-unknown refuses to clear it", (t) => {
  const { controller, journal, ids } = recoverWithUnknowns(t);
  const id = ids[0] as string;

  const original = journal.saveState.bind(journal);
  journal.saveState = () => {
    throw new Error("state write failed");
  };
  mustThrowCode(() => controller.setState({ frequencyHz: 7_040_000 }, "retune"), "internal");
  journal.saveState = original;

  assert.equal(controller.unknownReview().faultLatched, true);
  mustThrowCode(() => controller.resolveUnknown(id, VALID), "blocked");
  assert.equal(journal.getResolution(id), undefined, "latched fault must not be cleared by resolution");
  assert.ok(controller.status().blockedReason);
});

// ── 恢复与后端前提 ────────────────────────────────────────────────────────

ctest("resolve-unknown requires completed recovery and a connected backend", (t) => {
  const fresh = harness(t);
  mustThrowCode(() => fresh.controller.resolveUnknown("anything", VALID), "blocked");

  const recovered = recoverWithUnknowns(t);
  recovered.controller.setState({ backendConnected: false }, "rig-down");
  mustThrowCode(() => recovered.controller.resolveUnknown(recovered.ids[0] as string, VALID), "conflict");
});

// ── 跨进程 RPC 与 CLI ────────────────────────────────────────────────────

async function request(socketPath: string, method: string, params: Json = {}): Promise<Json> {
  const client = await DaemonClient.connect(socketPath, { requestTimeoutMs: 20_000 });
  try {
    return (await client.request(method, params)) as Json;
  } finally {
    client.close();
  }
}

function runCli(socketPath: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [...cliEntry("cwctl"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CWSTATION_SOCKET: socketPath },
  });
  return { status: result.status, stdout: result.stdout.trim() };
}

dtest("cross-process crash, restart, resolve and re-authorize via RPC and CLI", async (t) => {
  const first = await startDaemon({ env: { CWSTATION_FAKE_DURATION_MS: "3000" } });
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  t.after(async () => {
    await second?.stop();
    await first.stop();
  });

  const proposal = await request(first.socketPath, "propose", { text: "CQ" });
  await request(first.socketPath, "approve", { id: proposal.id });
  const client = await DaemonClient.connect(first.socketPath, { requestTimeoutMs: 20_000 });
  const pending = client.request("transmit", { id: proposal.id }).catch(() => undefined);
  await sleep(150);
  first.kill();
  await first.waitForTermination(3_000);
  client.close();
  await Promise.race([pending, sleep(2_000)]);

  second = await startDaemon({ dir: first.dir });

  const unresolved = await request(second.socketPath, "unresolved");
  const review = unresolved.unknownReview as Json;
  assert.equal(review.unresolvedUnknownCount, 1);
  assert.equal(review.eligibleToResolve, 1);
  assert.equal(review.requiresRestart, 0);
  assert.equal((unresolved.unresolved as Json[])[0]?.resolutionEligible, true);

  // CLI 成功解除。
  const cli = runCli(second.socketPath, [
    "resolve-unknown",
    String(proposal.id),
    "--operator",
    "alice",
    "--note",
    "checked, stopped",
    "--confirm-stopped",
  ]);
  assert.equal(cli.status, 0, cli.stdout);
  const cliJson = JSON.parse(cli.stdout) as Json;
  const resolution = cliJson.result as Json;
  assert.equal(resolution.confirmedStopped, true);
  assert.equal(resolution.proposalId, proposal.id);

  // RPC 幂等重试返回既有 resolution。
  const retry = await request(second.socketPath, "resolve-unknown", {
    proposalId: proposal.id,
    operator: "bob",
    note: "again",
    confirmStopped: true,
  });
  assert.deepEqual(retry, resolution);

  const status = await request(second.socketPath, "status");
  assert.equal(status.blockedReason, null);
  assert.equal((status.unknownReview as Json).unresolvedUnknownCount, 0);

  // 原执行重试仍是 unknown，绝不重新键控。
  const original = await request(second.socketPath, "transmit", { id: proposal.id });
  assert.equal(original.status, "unknown");
  assert.equal((await request(second.socketPath, "status")).keyedCount, 0);

  // 新提案需另批准后才能发。
  const fresh = await request(second.socketPath, "propose", { text: "CQ FRESH" });
  await request(second.socketPath, "approve", { id: fresh.id });
  assert.equal((await request(second.socketPath, "transmit", { id: fresh.id })).status, "completed");
  assert.equal((await request(second.socketPath, "status")).keyedCount, 1);
});

dtest("CLI resolve-unknown strictly validates flags and maps semantic exit codes", async (t) => {
  const daemon = await startDaemon({
    env: { CWSTATION_FAKE_DURATION_MS: "500", CWSTATION_FAKE_IGNORE_ABORT: "1", CWSTATION_TX_TIMEOUT_MS: "50" },
  });
  t.after(() => daemon.stop());

  // 本进程新增 unknown：不能解除，必须先停机重启。
  const proposal = await request(daemon.socketPath, "propose", { text: "CQ" });
  await request(daemon.socketPath, "approve", { id: proposal.id });
  assert.equal((await request(daemon.socketPath, "transmit", { id: proposal.id })).status, "unknown");

  const conflict = runCli(daemon.socketPath, [
    "resolve-unknown",
    String(proposal.id),
    "--operator",
    "alice",
    "--note",
    "checked",
    "--confirm-stopped",
  ]);
  assert.equal(conflict.status, 4, conflict.stdout);

  const missing = runCli(daemon.socketPath, [
    "resolve-unknown",
    "does-not-exist",
    "--operator",
    "alice",
    "--note",
    "checked",
    "--confirm-stopped",
  ]);
  assert.equal(missing.status, 3, missing.stdout);

  const noConfirm = runCli(daemon.socketPath, ["resolve-unknown", String(proposal.id), "--operator", "alice", "--note", "checked"]);
  assert.equal(noConfirm.status, 2);

  const extra = runCli(daemon.socketPath, [
    "resolve-unknown",
    String(proposal.id),
    "extra",
    "--operator",
    "alice",
    "--note",
    "checked",
    "--confirm-stopped",
  ]);
  assert.equal(extra.status, 2);

  const badFlag = runCli(daemon.socketPath, [
    "resolve-unknown",
    String(proposal.id),
    "--operator",
    "alice",
    "--note",
    "checked",
    "--confirm-stopped",
    "--bogus",
  ]);
  assert.equal(badFlag.status, 2);

  const inline = runCli(daemon.socketPath, [
    "resolve-unknown",
    String(proposal.id),
    "--operator",
    "alice",
    "--note",
    "checked",
    "--confirm-stopped=false",
  ]);
  assert.equal(inline.status, 2);

  const emptyOperator = runCli(daemon.socketPath, [
    "resolve-unknown",
    String(proposal.id),
    "--operator",
    "",
    "--note",
    "checked",
    "--confirm-stopped",
  ]);
  assert.equal(emptyOperator.status, 2);

  const unresolved = runCli(daemon.socketPath, ["unresolved"]);
  assert.equal(unresolved.status, 0);
  assert.equal(((JSON.parse(unresolved.stdout) as Json).result as Json).unknownReview !== undefined, true);
  assert.equal(
    (((JSON.parse(unresolved.stdout) as Json).result as Json).unknownReview as Json).requiresRestart,
    1,
  );

  const unresolvedExtra = runCli(daemon.socketPath, ["unresolved", "5"]);
  assert.equal(unresolvedExtra.status, 2);
});
