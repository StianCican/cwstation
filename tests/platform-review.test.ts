import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveEndpoint } from "../packages/daemon/src/config.js";
import { endpointAddress } from "../packages/daemon/src/endpoint.js";
import { sleep, startDaemon } from "./helpers.js";
import { backupDatabase } from "../packages/maintenance/src/index.js";

test("endpoint overrides select the final platform address before compatibility checks", () => {
  const windows = "\\\\.\\pipe\\cwstation-review";
  assert.deepEqual(resolveEndpoint({ version: 1, socketPath: "/tmp/legacy.sock" }, windows, {}, "win32"), {
    kind: "pipe", name: "cwstation-review",
  });
  assert.equal(resolveEndpoint(undefined, windows, { CWSTATION_SOCKET: "/tmp/incompatible.sock" }, "win32").kind, "pipe");
  assert.equal(resolveEndpoint({ version: 2, endpoint: { kind: "pipe", name: "old" } }, undefined,
    { CWSTATION_SOCKET: "/tmp/new.sock" }, "linux").kind, "unix");
});

test("a second daemon on the same endpoint with a different database is refused", { timeout: 30_000 }, async (t) => {
  const first = await startDaemon();
  const second = await startDaemon({ endpoint: first.endpoint, waitForReady: false });
  t.after(async () => { await second.stop(); await first.stop(); });
  assert.equal(await second.waitForExit(10_000), 1, second.stderr());
  assert.throws(() => backupDatabase(first.dbPath, join(first.dir, "busy-backup")),
    (error: unknown) => (error as { code?: string }).code === "locked");
  if (process.platform === "win32") {
    const alias = await startDaemon({ dbPath: first.dbPath.toUpperCase(), waitForReady: false });
    try {
      assert.equal(await alias.waitForExit(10_000), 1, alias.stderr());
    } finally { await alias.stop(); }
  }
  const client = await first.client();
  try {
    assert.equal((await client.request("ping") as { pong: boolean }).pong, true);
  } finally { client.close(); }
});

test("RPC stop during unresponsive keying preserves unknown through restart", { timeout: 30_000 }, async (t) => {
  const first = await startDaemon({ env: {
    CWSTATION_FAKE_DURATION_MS: "5000", CWSTATION_FAKE_IGNORE_ABORT: "1", CWSTATION_TX_TIMEOUT_MS: "300",
  } });
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const client = await first.client();
  t.after(async () => { client.close(); await second?.stop(); await first.stop(); });
  const proposal = await client.request("propose", { text: "CQ" }) as { id: string };
  await client.request("approve", { id: proposal.id });
  const transmission = client.request("transmit", { id: proposal.id }).catch(() => undefined);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await client.request("status") as { txBusy: boolean }).txBusy) break;
    await sleep(10);
  }
  assert.equal((await client.request("status") as { txBusy: boolean }).txBusy, true);
  assert.equal((await client.request("daemon.stop") as { accepted: boolean }).accepted, true);
  assert.equal(await first.waitForTermination(5000), true, first.stderr());
  await transmission;
  second = await startDaemon({ dir: first.dir, endpoint: first.endpoint });
  const recovered = await second.client();
  try {
    const status = await recovered.request("status") as { blockedReason: string | null; keyedCount: number };
    assert.ok(status.blockedReason);
    assert.equal(status.keyedCount, 0);
    assert.equal((await recovered.request("transmit", { id: proposal.id }) as { status: string }).status, "unknown");
    assert.equal(endpointAddress(second.endpoint), first.socketPath);
  } finally { recovered.close(); }
});
