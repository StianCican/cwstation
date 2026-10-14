import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FakeKeyer, KeyerAbortError, type Keyer } from "../packages/core/src/keyer.js";
import { ControllerError, TxController, type ControllerOptions } from "../packages/core/src/tx-controller.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import type { Approval, Proposal, TxRequest, TxResult } from "../packages/contracts/src/index.js";

type TestFn = (t: TestContext) => void | Promise<void>;
/** 控制器测试必须有界，防止永不返回的假键控器拖死测试运行器。 */
const TEST_TIMEOUT_MS = 20_000;
function ctest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

interface Fixture {
  controller: TxController;
  journal: SqliteJournal;
  keyer: Keyer;
}

function fixture(t: TestContext, keyer: Keyer, options: ControllerOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-controller-"));
  const journal = new SqliteJournal(join(dir, "test.sqlite"));
  const controller = new TxController(TxController.loadState(journal), keyer, journal, options);
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { controller, journal, keyer };
}

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

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ControllerError, `expected ControllerError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

ctest("propose, approve and transmit complete once and consume the approval", async (t) => {
  const { controller, journal, keyer } = fixture(t, new FakeKeyer({ durationMs: 5 }));
  const proposal = controller.propose({ text: "CQ TEST DE BD7XXX" });
  assert.equal(proposal.status, "pending");

  const approval = controller.approve(proposal.id);
  assert.equal(approval.consumedAt, null);
  assert.equal(journal.getProposal(proposal.id)?.status, "approved");

  const execution = await controller.transmit(proposal.id);
  assert.equal(execution.status, "completed");
  assert.equal(keyer.keyedCount, 1);
  assert.equal(journal.getProposal(proposal.id)?.status, "consumed");
  assert.ok(journal.getApproval(proposal.id)?.consumedAt);
  assert.ok(journal.recent(20).some((event) => event.type === "tx.completed"));
});

ctest("transmit of an unapproved proposal is rejected without keying", async (t) => {
  const { controller, keyer } = fixture(t, new FakeKeyer());
  const proposal = controller.propose({ text: "CQ" });
  await assert.rejects(() => controller.transmit(proposal.id), (error: unknown) => {
    assert.ok(error instanceof ControllerError);
    assert.equal(error.code, "conflict");
    return true;
  });
  assert.equal(keyer.keyedCount, 0);
  assert.equal(controller.status().executionCounts.completed ?? 0, 0);
});

ctest("repeating transmit returns the stored result and never keys twice", async (t) => {
  const { controller, keyer } = fixture(t, new FakeKeyer({ durationMs: 5 }));
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const first = await controller.transmit(proposal.id);
  const second = await controller.transmit(proposal.id);
  assert.deepEqual(second, first);
  assert.equal(keyer.keyedCount, 1);
});

ctest("proposal expired before approval is rejected", async (t) => {
  const { controller } = fixture(t, new FakeKeyer());
  const proposal = controller.propose({ text: "CQ", ttlMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  mustThrowCode(() => controller.approve(proposal.id), "expired");
});

ctest("approval expired before transmit is rejected", async (t) => {
  const { controller } = fixture(t, new FakeKeyer(), { approvalTtlMs: 1_000 });
  const proposal = controller.propose({ text: "CQ", ttlMs: 5_000 });
  controller.approve(proposal.id);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await rejectsWithCode(controller.transmit(proposal.id), "expired");
});

ctest("station state change revokes approval and blocks transmit", async (t) => {
  const { controller, journal, keyer } = fixture(t, new FakeKeyer());
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  controller.setState({ frequencyHz: 7_040_000 }, "cat-retune");
  assert.equal(journal.getApproval(proposal.id)?.revokedAt !== null, true);
  assert.equal(journal.getProposal(proposal.id)?.status, "cancelled");
  await rejectsWithCode(controller.transmit(proposal.id), "conflict");
  assert.equal(keyer.keyedCount, 0);
});

ctest("timeout with unresponsive keyer yields unknown and blocks further transmit", async (t) => {
  const { controller, keyer } = fixture(t, new FakeKeyer({ durationMs: 400, ignoreAbort: true }), { txTimeoutMs: 50 });
  const first = controller.propose({ text: "CQ" });
  controller.approve(first.id);
  const result = await controller.transmit(first.id);
  assert.equal(result.status, "unknown");
  assert.equal(keyer.keyedCount, 1);
  assert.ok(controller.status().blockedReason);

  const second = controller.propose({ text: "CQ AGAIN" });
  controller.approve(second.id);
  await rejectsWithCode(controller.transmit(second.id), "blocked");
  assert.equal(keyer.keyedCount, 1);
});

ctest("keyer fault yields unknown and blocks", async (t) => {
  const { controller } = fixture(t, new FakeKeyer({ fault: "fake backend exploded" }));
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const result = await controller.transmit(proposal.id);
  assert.equal(result.status, "unknown");
  assert.ok(controller.status().blockedReason);
});

ctest("abort preempts an in-flight transmission", async (t) => {
  const { controller, keyer } = fixture(t, new FakeKeyer({ durationMs: 500 }), { txTimeoutMs: 5_000 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const pending = controller.transmit(proposal.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const abortResult = controller.abort();
  assert.equal(abortResult.aborted, true);
  assert.equal(abortResult.proposalId, proposal.id);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(keyer.keyedCount, 1);
  assert.equal(controller.status().blockedReason, null);
});

ctest("only one transmission may be in flight", async (t) => {
  const { controller } = fixture(t, new FakeKeyer({ durationMs: 300 }), { txTimeoutMs: 5_000 });
  const a = controller.propose({ text: "CQ A" });
  const b = controller.propose({ text: "CQ B" });
  controller.approve(a.id);
  controller.approve(b.id);
  const pending = controller.transmit(a.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await rejectsWithCode(controller.transmit(b.id), "busy");
  controller.abort();
  await pending;
});

ctest("backend disconnect aborts in flight and marks unknown", async (t) => {
  const { controller } = fixture(t, new FakeKeyer({ durationMs: 500 }), { txTimeoutMs: 5_000 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const pending = controller.transmit(proposal.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.setState({ backendConnected: false }, "rig-disconnected");
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.ok(controller.status().blockedReason);
});

ctest("startup recovery converts running executions to unknown and revokes approvals", (t) => {
  const { controller, journal } = fixture(t, new FakeKeyer());
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const running = {
    proposalId: proposal.id,
    requestId: proposal.id,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    detail: null,
    frequencyHz: proposal.frequencyHz,
    mode: proposal.mode,
    stateGeneration: proposal.stateGeneration,
    contentSha256: proposal.contentSha256,
  };
  journal.transaction(() => {
    journal.setProposalStatus(proposal.id, "consumed");
    journal.consumeApproval(proposal.id, new Date().toISOString());
    journal.insertExecution(running);
  });

  const generationBefore = controller.status().generation;
  controller.recoverOnStartup();

  assert.equal(journal.getExecution(proposal.id)?.status, "unknown");
  assert.equal(journal.getProposal(proposal.id)?.status, "cancelled");
  assert.ok(journal.getApproval(proposal.id)?.revokedAt);
  assert.equal(controller.status().generation, generationBefore + 1);
  assert.ok(controller.status().blockedReason);
  assert.equal(controller.recovery().recovered, true);
});

ctest("shutdown aborts in flight and does not record completed", async (t) => {
  const { controller, journal } = fixture(t, new FakeKeyer({ durationMs: 500 }), { txTimeoutMs: 5_000 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const pending = controller.transmit(proposal.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shutdown = await controller.shutdown(2_000);
  assert.equal(shutdown.outcome, "unknown");
  const stored = journal.getExecution(proposal.id);
  assert.equal(stored?.status, "unknown");
  await pending.catch(() => undefined);
});

ctest("FakeKeyer returns cancelled immediately for a pre-aborted signal", async () => {
  const keyer = new FakeKeyer({ durationMs: 5_000 });
  const controller = new AbortController();
  controller.abort();
  const request = {
    proposal: { id: "p1" },
    approval: {},
    timeoutMs: 1_000,
  } as unknown as TxRequest;
  const result: TxResult = await keyer.transmit(request, controller.signal);
  assert.equal(result.outcome, "cancelled");
  assert.equal(keyer.keyedCount, 1);
});

ctest("KeyerAbortError is exported with stable name", () => {
  const error = new KeyerAbortError();
  assert.equal(error.name, "KeyerAbortError");
});

// ── 审查问题回归：状态真值、有界超时、迟到完成、写失败、恢复 ──────────────

/** 忽略 abort、延迟后才返回 completed 的键控器（模拟无法证明停止）。 */
class HangingKeyer implements Keyer {
  keyedCount = 0;
  constructor(private readonly delayMs: number) {}
  transmit(request: TxRequest): Promise<TxResult> {
    this.keyedCount += 1;
    const startedAt = new Date().toISOString();
    return new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            requestId: request.proposal.id,
            outcome: "completed",
            startedAt,
            finishedAt: new Date().toISOString(),
          }),
        this.delayMs,
      );
    });
  }
}

/** abort 后抛普通 Error（非 KeyerAbortError）。 */
class GenericErrorKeyer implements Keyer {
  keyedCount = 0;
  transmit(_request: TxRequest, signal: AbortSignal): Promise<TxResult> {
    this.keyedCount += 1;
    return new Promise((_resolve, reject) => {
      const fail = (): void => reject(new Error("backend exploded"));
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  }
}

/** 返回与请求不匹配的 requestId。 */
class WrongIdKeyer implements Keyer {
  keyedCount = 0;
  async transmit(): Promise<TxResult> {
    this.keyedCount += 1;
    return {
      requestId: "not-the-proposal",
      outcome: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}

ctest("setState persists new frequency and new proposals bind to it", (t) => {
  const { controller, journal } = fixture(t, new FakeKeyer());
  const before = controller.status();
  const state = controller.setState({ frequencyHz: 7_040_000 }, "cat-retune");
  assert.equal(state.frequencyHz, 7_040_000);
  assert.equal(journal.loadState().frequencyHz, 7_040_000, "frequency truth must be persisted");
  assert.equal(controller.status().generation, before.generation + 1);

  const proposal = controller.propose({ text: "CQ" });
  assert.equal(proposal.frequencyHz, 7_040_000);
  assert.equal(proposal.stateGeneration, state.generation);
});

ctest("frequency change aborts in-flight transmission as unknown", async (t) => {
  const { controller, keyer } = fixture(t, new FakeKeyer({ durationMs: 500 }), { txTimeoutMs: 5_000 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const pending = controller.transmit(proposal.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.setState({ frequencyHz: 7_040_000 }, "cat-retune");
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(keyer.keyedCount, 1);
  assert.ok(controller.status().blockedReason);
});

ctest("backend that never returns is bounded to unknown and late completion cannot override", async (t) => {
  const keyer = new HangingKeyer(600);
  const { controller, journal } = fixture(t, keyer, { txTimeoutMs: 60 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const started = Date.now();
  const result = await controller.transmit(proposal.id);
  const elapsed = Date.now() - started;
  assert.equal(result.status, "unknown");
  assert.ok(elapsed < 400, `transmit must be bounded, took ${elapsed}ms`);

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    journal.getExecution(proposal.id)?.status,
    "unknown",
    "late keyer completion must never overwrite unknown",
  );
});

ctest("arbitrary backend error after abort is unknown, not cancelled", async (t) => {
  const keyer = new GenericErrorKeyer();
  const { controller } = fixture(t, keyer, { txTimeoutMs: 5_000 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const pending = controller.transmit(proposal.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "unknown");
});

ctest("mismatched requestId from keyer is treated as unknown", async (t) => {
  const keyer = new WrongIdKeyer();
  const { controller } = fixture(t, keyer);
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const result = await controller.transmit(proposal.id);
  assert.equal(result.status, "unknown");
});

ctest("intent write failure never keys and blocks further execution", async (t) => {
  const { controller, journal, keyer } = fixture(t, new FakeKeyer({ durationMs: 5 }));
  const original = journal.insertExecution.bind(journal);
  let failed = false;
  journal.insertExecution = (execution) => {
    if (!failed) {
      failed = true;
      throw new Error("disk full");
    }
    original(execution);
  };

  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  await rejectsWithCode(controller.transmit(proposal.id), "internal");
  assert.equal(keyer.keyedCount, 0, "no keying may happen when intent cannot be persisted");
  assert.ok(controller.status().blockedReason);

  const next = controller.propose({ text: "CQ AGAIN" });
  controller.approve(next.id);
  await rejectsWithCode(controller.transmit(next.id), "blocked");
  assert.equal(keyer.keyedCount, 0);
});

ctest("outcome write failure blocks and never records completed", async (t) => {
  const { controller, journal, keyer } = fixture(t, new FakeKeyer({ durationMs: 5 }));
  journal.updateExecutionStatus = () => {
    throw new Error("read-only database");
  };

  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  await rejectsWithCode(controller.transmit(proposal.id), "internal");
  assert.equal(keyer.keyedCount, 1);
  assert.ok(controller.status().blockedReason);
  assert.equal(journal.getExecution(proposal.id)?.status, "running", "failed outcome must not be recorded as completed");
});

ctest("state write failure rolls back in-memory truth and blocks", (t) => {
  const { controller, journal } = fixture(t, new FakeKeyer());
  const generation = controller.status().generation;
  const frequencyHz = controller.status().frequencyHz;
  journal.saveState = () => {
    throw new Error("state write failed");
  };

  assert.throws(
    () => controller.setState({ frequencyHz: 7_040_000 }, "retune"),
    (error: unknown) => error instanceof ControllerError && error.code === "internal",
  );
  assert.equal(controller.status().generation, generation, "rolled-back generation must stay in memory too");
  assert.equal(controller.status().frequencyHz, frequencyHz, "rolled-back frequency must stay in memory too");
  assert.ok(controller.status().blockedReason);
});

ctest("backend timeout is unknown, requests stop and blocks after restart", async (t) => {
  let signal: AbortSignal | undefined;
  const keyer: Keyer = {
    async transmit(request, abortSignal) {
      signal = abortSignal;
      const now = new Date().toISOString();
      return { requestId: request.proposal.id, outcome: "timed_out", startedAt: now, finishedAt: now };
    },
  };
  const { controller, journal } = fixture(t, keyer);
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  assert.equal((await controller.transmit(proposal.id)).status, "unknown");
  assert.equal(signal?.aborted, true);
  assert.ok(controller.status().blockedReason);
  const restarted = new TxController(TxController.loadState(journal), keyer, journal);
  restarted.recoverOnStartup();
  assert.ok(restarted.status().blockedReason);
  const next = restarted.propose({ text: "CQ AGAIN" });
  restarted.approve(next.id);
  await rejectsWithCode(restarted.transmit(next.id), "blocked");
});

ctest("state persistence failure still aborts active keying", async (t) => {
  const { controller, journal } = fixture(t, new FakeKeyer({ durationMs: 5_000 }), { txTimeoutMs: 6_000 });
  const proposal = controller.propose({ text: "CQ" });
  controller.approve(proposal.id);
  const pending = controller.transmit(proposal.id);
  const saveState = journal.saveState.bind(journal);
  journal.saveState = () => { throw new Error("state write failed"); };
  mustThrowCode(() => controller.setState({ frequencyHz: 7_040_000 }, "retune"), "internal");
  journal.saveState = saveState;
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.match(result.detail ?? "", /aborted/);
  assert.ok(controller.status().blockedReason);
});

ctest("recovery terminates all open proposals without LIMIT and repeated recovery is idempotent", (t) => {
  const { controller } = fixture(t, new FakeKeyer());
  for (let i = 0; i < 5; i += 1) {
    const proposal = controller.propose({ text: `CQ ${i}` });
    controller.approve(proposal.id);
  }
  const before = controller.status().generation;
  controller.recoverOnStartup();
  const after = controller.status().generation;
  assert.equal(after, before + 1);
  assert.equal(controller.status().proposalCounts.cancelled, 5);

  controller.recoverOnStartup();
  assert.equal(controller.status().generation, after, "repeated recovery must not bump generation");
});

ctest("recovery without open work does not bump generation", (t) => {
  const { controller } = fixture(t, new FakeKeyer());
  const before = controller.status().generation;
  controller.recoverOnStartup();
  assert.equal(controller.status().generation, before);
});
