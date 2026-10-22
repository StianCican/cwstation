import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, rm, mkdir, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CwTrialRecordStore, cwTrialIntentDigest } from "../packages/cw-trial/src/index.js";
import { runCwTrial } from "../apps/rig-cw-trial.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "cw-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await CwTrialRecordStore.open(dir);
  const target = await store.append({ event: "intent", message: "E", detail: "historical unknown" });
  const input = { intentId: target.id, intentDigest: cwTrialIntentDigest(target), operator: "test operator", note: "Isolated simulator fixture; no radio." };
  const args = ["--review-intent", target.id, "--operator", input.operator, "--note", input.note, "--record-dir", dir];
  return { dir, store, target, input, args };
}

test("review appends v2 to the same ledger without changing original unknown result; new intent blocks again", async t => {
  const f = await fixture(t), before = await readFile(f.store.file, "utf8");
  const release = await f.store.acquireExclusive();
  try {
    await f.store.reviewIntent(f.input);
    assert.equal(await f.store.hasUnresolvedIntent(), false);
    const rows = await f.store.readAll();
    assert.deepEqual(rows[0], f.target);
    assert.equal(rows[1]!.schemaVersion, 2);
    assert.equal(rows[1]!.event, "intent_review");
    assert.equal((await readFile(f.store.file, "utf8")).startsWith(before), true);
    await assert.rejects(f.store.reviewIntent(f.input), /already reviewed/);
    await f.store.append({ event: "intent", message: "TEST" });
    assert.equal(await f.store.hasUnresolvedIntent(), true);
  } finally { await release(); }
});

test("review validates target/digest/operator and requires exclusive ownership", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.reviewIntent(f.input), /exclusive/);
  const release = await f.store.acquireExclusive();
  try {
    for (const bad of [{ ...f.input, intentId: "missing" }, { ...f.input, intentDigest: "0".repeat(64) },
      { ...f.input, operator: "" }, { ...f.input, note: "line\nbreak" }]) await assert.rejects(f.store.reviewIntent(bad));
    assert.equal((await f.store.readAll()).length, 1);
    assert.equal(await f.store.hasUnresolvedIntent(), true);
  } finally { await release(); }
});

test("review serializes duplicate requests and never appends two review events", async t => {
  const f = await fixture(t), release = await f.store.acquireExclusive();
  try {
    const result = await Promise.allSettled([f.store.reviewIntent(f.input), f.store.reviewIntent(f.input)]);
    assert.equal(result.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(await f.store.hasUnresolvedIntent(), false);
  } finally { await release(); }
});

for (const corruption of ["{broken", JSON.stringify({ schemaVersion: 99 }), "bad-review", "duplicate"]) {
  test(`record corruption ${corruption} cannot be reviewed or unblock`, async t => {
    const f = await fixture(t);
    const line = corruption === "bad-review" ? JSON.stringify({ schemaVersion: 2, id: "bad", sessionId: "s", at: "now",
      event: "intent_review", message: null, contextFingerprint: null, detail: null,
      review: { ...f.input, intentDigest: "0".repeat(64) } })
      : corruption === "duplicate" ? JSON.stringify(f.target) : corruption;
    await appendFile(f.store.file, `${line}\n`);
    const release = await f.store.acquireExclusive();
    try {
      assert.equal(await f.store.hasUnresolvedIntent(), true);
      await assert.rejects(f.store.reviewIntent(f.input));
    } finally { await release(); }
  });
}

test("exclusive lock refuses a second process, directory aliases and stale locks", async t => {
  const f = await fixture(t), release = await f.store.acquireExclusive();
  try {
    const moduleUrl = new URL("../packages/cw-trial/src/record.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import {CwTrialRecordStore} from ${JSON.stringify(moduleUrl)}; try {const s=await CwTrialRecordStore.open(${JSON.stringify(f.dir)});await s.acquireExclusive();process.exitCode=9;} catch {process.exitCode=0;}`], { stdio: "pipe" });
    assert.equal((await once(child, "exit"))[0], 0);
    const alias = join(f.dir, "alias"); await symlink(f.dir, alias);
    await assert.rejects((await CwTrialRecordStore.open(alias)).acquireExclusive());
  } finally { await release(); }
  await mkdir(join(f.dir, ".cw-trial.lock"));
  await assert.rejects(f.store.acquireExclusive());
});

test("hard-linked and symlinked ledger files cannot bypass the directory lock", async t => {
  const f = await fixture(t), other = join(f.dir, "other"); await mkdir(other);
  const s = await CwTrialRecordStore.open(other);
  await link(f.store.file, s.file);
  await assert.rejects(s.acquireExclusive(), /aliases/);
  await rm(s.file); await symlink(f.store.file, s.file);
  await assert.rejects(s.acquireExclusive(), /aliases/);
});

test("CLI review explicitly confirms ID and digest, opens zero transports and releases lock", async t => {
  const f = await fixture(t); let transports = 0; const output: string[] = [];
  assert.equal(await runCwTrial(f.args, {
    createTransport: async () => { transports++; throw Error("must not open"); },
    io: { isTTY: true, write: line => output.push(line), prompt: async question => {
      assert.match(question, /personally checked/);
      return `REVIEW ${f.target.id} ${f.input.intentDigest}`;
    } },
  }), 0);
  assert.equal(transports, 0);
  assert.equal(await f.store.hasUnresolvedIntent(), false);
  assert.match(output.join("\n"), /old outcome remains UNKNOWN/);
  const release = await f.store.acquireExclusive(); await release();
});

test("CLI nonTTY, declined, cancelled, mixed sending args leave intent unchanged", async t => {
  const f = await fixture(t);
  for (const kind of ["nonTTY", "declined", "cancelled", "mixed"] as const) {
    const abort = new AbortController();
    const code = await runCwTrial(kind === "mixed" ? [...f.args, "--simulate"] : f.args, {
      signal: abort.signal,
      io: { isTTY: kind !== "nonTTY", write: () => {}, prompt: async () => {
        if (kind === "cancelled") { abort.abort(); return new Promise(() => {}); }
        return "WRONG";
      } },
      createTransport: async () => { throw Error("no transport"); },
    });
    assert.notEqual(code, 0);
    assert.equal((await f.store.readAll()).length, 1);
    const release = await f.store.acquireExclusive(); await release();
  }
});

test("runner cannot send while review owns the original ledger", async t => {
  const f = await fixture(t), release = await f.store.acquireExclusive(); let opens = 0;
  try {
    assert.notEqual(await runCwTrial(["--simulate", "--simulate-confirm", "E", "--record-dir", f.dir], {
      io: { isTTY: false, write: () => {}, prompt: async () => "E" },
      createTransport: async () => { opens++; throw Error("must not open"); },
    }), 0);
    assert.equal(opens, 0);
  } finally { await release(); }
});

test("cancellation during the final review reread writes no resolution", async t => {
  const f = await fixture(t), abort = new AbortController(), scan = f.store.scan.bind(f.store);
  let reads = 0;
  f.store.scan = async () => { const result = await scan(); if (++reads === 2) abort.abort(); return result; };
  assert.notEqual(await runCwTrial(f.args, {
    signal: abort.signal, openStore: async () => f.store,
    io: { isTTY: true, write: () => {}, prompt: async () => `REVIEW ${f.target.id} ${f.input.intentDigest}` },
  }), 0);
  assert.equal((await f.store.readAll()).length, 1);
  assert.equal(await f.store.hasUnresolvedIntent(), true);
});

test("target mutation during human confirmation refuses the original digest", async t => {
  const f = await fixture(t), scan = f.store.scan.bind(f.store); let reads = 0;
  f.store.scan = async () => {
    const result = await scan();
    return ++reads === 2 ? { ...result, records: result.records.map(row => ({ ...row, detail: "changed" })) } : result;
  };
  assert.notEqual(await runCwTrial(f.args, { openStore: async () => f.store,
    io: { isTTY: true, write: () => {}, prompt: async () => `REVIEW ${f.target.id} ${f.input.intentDigest}` },
  }), 0);
  assert.equal((await f.store.readAll()).length, 1);
});

test("failed review append never reports success or permits the next trial", async t => {
  const f = await fixture(t); const lines: string[] = [];
  // Inject a persistent write failure at the existing writer, without altering the ledger.
  const writer = f.store as unknown as { appendLine: (line: string) => Promise<void> };
  writer.appendLine = async () => { throw Error("injected disk failure"); };
  assert.notEqual(await runCwTrial(f.args, { openStore: async () => f.store,
    io: { isTTY: true, write: line => lines.push(line), prompt: async () => `REVIEW ${f.target.id} ${f.input.intentDigest}` },
  }), 0);
  assert.doesNotMatch(lines.join("\n"), /review appended/);
  assert.equal(await f.store.hasUnresolvedIntent(), true);
  assert.match(lines.join("\n"), /lock retained/);
  await assert.rejects((await CwTrialRecordStore.open(f.dir)).acquireExclusive(), /locked/);
});

test("one valid review does not resolve another historical intent", async t => {
  const f = await fixture(t), second = await f.store.append({ event: "intent", message: "TEST" });
  const release = await f.store.acquireExclusive();
  try {
    await f.store.reviewIntent(f.input);
    assert.equal(await f.store.hasUnresolvedIntent(), true);
    assert.equal((await f.store.intentForReview(second.id)).id, second.id);
  } finally { await release(); }
});

test("reviewed original directory permits one NEW simulated trial and its new intent blocks again", async t => {
  const f = await fixture(t);
  assert.equal(await runCwTrial(f.args, {
    io: { isTTY: true, write: () => {}, prompt: async () => `REVIEW ${f.target.id} ${f.input.intentDigest}` },
  }), 0);
  const args = ["--simulate", "--simulate-confirm", "E", "--record-dir", f.dir];
  const io = { isTTY: false, write: () => {}, prompt: async () => { throw Error("no TTY"); } };
  assert.equal(await runCwTrial(args, { io }), 0);
  assert.equal(await runCwTrial(args, { io }), 3);
  const rows = await f.store.readAll();
  assert.equal(rows[0]!.id, f.target.id);
  assert.deepEqual(rows.map(row => row.event), ["intent", "intent_review", "intent", "send_result", "stop_intent", "stop_result", "session_close"]);
});

test("a fully written review followed by fsync error retains the lock and cannot enable a new trial", async t => {
  const f = await fixture(t), output: string[] = [];
  const writer = f.store as unknown as { appendLine: (line: string) => Promise<void> };
  const append = writer.appendLine.bind(f.store);
  writer.appendLine = async line => { await append(line); throw Error("fsync outcome uncertain"); };
  assert.notEqual(await runCwTrial(f.args, { openStore: async () => f.store,
    io: { isTTY: true, write: line => output.push(line), prompt: async () => `REVIEW ${f.target.id} ${f.input.intentDigest}` },
  }), 0);
  assert.equal((await f.store.readAll()).length, 2);
  assert.match(output.join("\n"), /outcome UNKNOWN.*lock retained/);
  let opens = 0;
  assert.notEqual(await runCwTrial(["--simulate", "--simulate-confirm", "E", "--record-dir", f.dir], {
    io: { isTTY: false, write: () => {}, prompt: async () => "E" },
    createTransport: async () => { opens++; throw Error("must not open"); },
  }), 0);
  assert.equal(opens, 0);
});
