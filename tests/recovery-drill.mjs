import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DaemonClient } from "../dist/packages/daemon/src/client.js";

// Standalone Linux Fake drill. Retain isolated artifacts for human review.
assert.equal(process.platform, "linux");
const dir = mkdtempSync(join(tmpdir(), "cw-recovery-drill-"));
const db = join(dir, "core.sqlite");
const socket = join(dir, "core.sock");
let daemon;
let client;
console.log(JSON.stringify({ event: "drill.start", dir, simulation: true }));
async function wait(check) {
  for (let n = 0; n < 400; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("wait timeout");
}
async function start() {
  let out = "";
  let err = "";
  daemon = spawn(process.execPath, ["dist/apps/daemon.js", "--socket", socket, "--db", db], {
    env: { ...process.env, CWSTATION_FAKE_DURATION_MS: "3000", CWSTATION_FAKE_IGNORE_ABORT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (chunk) => { out += chunk; });
  daemon.stderr.on("data", (chunk) => { err += chunk; });
  await wait(() => {
    if (daemon.exitCode !== null) throw new Error(err);
    return out.includes('"event":"daemon.ready"');
  });
  client = await DaemonClient.connect(socket);
  console.log(JSON.stringify({ event: "daemon.ready", pid: daemon.pid }));
}
function cli(entry, args) {
  const result = spawnSync(process.execPath, [`dist/apps/${entry}.js`, ...args], { encoding: "utf8", timeout: 15000 });
  console.log(JSON.stringify({ event: "cli", entry, args, status: result.status, stdout: result.stdout?.trim() }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
try {
  await start();
  const proposal = await client.request("propose", { text: "CQ DRILL" });
  await client.request("approve", { id: proposal.id });
  const sending = client.request("transmit", { id: proposal.id }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await client.request("status")).txBusy, true);
  daemon.kill("SIGKILL");
  client.close();
  await wait(() => daemon.exitCode !== null || daemon.signalCode !== null);
  await sending;
  mkdirSync(join(dir, "raw-evidence"));
  for (const suffix of ["", "-wal", "-shm", "-journal", ".lock"]) {
    if (existsSync(db + suffix)) cpSync(db + suffix, join(dir, "raw-evidence", "core.sqlite" + suffix), { preserveTimestamps: true });
  }
  console.log(JSON.stringify({ event: "raw-evidence.saved", beforeRestart: true, operationId: proposal.id }));
  cli("cwmaint", ["backup", "--db", db, "--out", join(dir, "bundle")]);
  cli("cwmaint", ["inspect", "--bundle", join(dir, "bundle")]);
  cli("cwmaint", ["restore", "--bundle", join(dir, "bundle"), "--db", join(dir, "restored.sqlite")]);
  const restored = new DatabaseSync(join(dir, "restored.sqlite"), { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT status FROM executions WHERE proposal_id = ?").get(proposal.id).status, "unknown");
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM approvals WHERE consumed_at IS NULL AND revoked_at IS NULL").get().n, 0);
  } finally { restored.close(); }
  await start();
  assert.ok((await client.request("status")).blockedReason);
  console.log(JSON.stringify({ event: "recovery.unresolved", result: await client.request("unresolved") }));
  cli("cwctl", ["--socket", socket, "resolve-unknown", proposal.id, "--operator", "offline-drill", "--note",
    "isolated Fake parent killed, old process exited, raw snapshot and bundle preserved", "--confirm-stopped"]);
  assert.equal((await client.request("status")).blockedReason, null);
  assert.equal((await client.request("transmit", { id: proposal.id })).status, "unknown");
  const replayCount = (await client.request("status")).keyedCount;
  assert.equal(replayCount, 0);
  assert.equal((await client.request("unresolved")).unknownReview.unresolvedUnknownCount, 0);
  await client.request("daemon.stop");
  client.close();
  await wait(() => daemon.exitCode !== null || daemon.signalCode !== null);
  assert.equal(daemon.exitCode, 0);
  const guard = db + ".lock.guard";
  mkdirSync(guard);
  cpSync(guard, join(dir, "raw-evidence", "synthetic-guard"), { recursive: true, preserveTimestamps: true });
  const refused = spawnSync(process.execPath, ["dist/apps/cwmaint.js", "backup", "--db", db, "--out", join(dir, "blocked-bundle")],
    { encoding: "utf8", timeout: 15000 });
  console.log(JSON.stringify({ event: "guard.refused", status: refused.status, stdout: refused.stdout?.trim() }));
  assert.equal(refused.status, 4);
  assert.equal(JSON.parse(refused.stdout).code, "locked");
  assert.ok(existsSync(guard));
  assert.equal(existsSync(join(dir, "blocked-bundle")), false);
  renameSync(guard, guard + ".quarantined");
  assert.equal(existsSync(guard), false);
  assert.ok(existsSync(guard + ".quarantined"));
  console.log(JSON.stringify({ event: "guard.quarantined", synthetic: true, startupOwnership: "controlled by this drill; external starters not tested" }));
  cli("cwmaint", ["backup", "--db", db, "--out", join(dir, "after-guard-bundle")]);
  cli("cwmaint", ["inspect", "--bundle", join(dir, "after-guard-bundle")]);
  console.log(JSON.stringify({ event: "drill.pass", originalUnknownPreserved: true, replayed: replayCount, dir }));
} finally {
  client?.close();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGKILL");
    await wait(() => daemon.exitCode !== null || daemon.signalCode !== null);
  }
}
