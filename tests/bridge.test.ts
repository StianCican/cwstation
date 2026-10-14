import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeExecutable } from "../packages/daemon/src/bridge.js";
import { DaemonClient } from "../packages/daemon/src/client.js";
import { startDaemon, sleep, ROOT } from "./helpers.js";

const windows = process.platform === "win32";
const options = { skip: !windows, timeout: 25_000 };
type Frame = Record<string, unknown>;
const name = (): string => `\\\\.\\pipe\\cwstation-secure-test-${process.pid}-${randomBytes(6).toString("hex")}`;

function helper(t: TestContext, role: string, pipe: string, parent = process.pid) {
  const child = spawn(bridgeExecutable(), [role, "--pipe", pipe, "--parent", String(parent)], { cwd: ROOT, stdio: "pipe" });
  const frames: Frame[] = [];
  let buffer = "";
  let diagnostic = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    buffer += text;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      frames.push(JSON.parse(buffer.slice(0, newline)) as Frame);
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { diagnostic += text; });
  child.stdin.on("error", () => undefined);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  t.after(async () => { child.kill(); await Promise.race([exited, sleep(2000)]); });
  return {
    child, frames, exited,
    async wait(type: string): Promise<Frame> {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const frame = frames.find((value) => value.t === type);
        if (frame) return frame;
        if (child.exitCode !== null) throw new Error(`helper exited: ${diagnostic}`);
        await sleep(10);
      }
      throw new Error(`helper ${type} timed out: ${diagnostic}`);
    },
  };
}

test("Windows creation ACL and actual token AccessCheck remain valid across replacement instances", options, async (t) => {
  const pipe = name();
  const service = helper(t, "server", pipe);
  const ready = await service.wait("ready");
  assert.equal(ready.verified, true);
  assert.equal(ready.rejectRemote, true);
  assert.match(String(ready.dacl), /D:P\(D;;FA;;;NU\)/);
  for (let i = 0; i < 6; i++) {
    const probe = spawnSync(bridgeExecutable(), ["acltest", "--pipe", pipe], { encoding: "utf8", timeout: 5000 });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const result = JSON.parse(probe.stdout.trim()) as Frame;
    assert.equal(result.currentTokenGranted, true);
    assert.equal(result.restrictedTokenDenied, true);
    assert.equal(result.restrictedError, 0);
    assert.equal(result.dacl, ready.dacl);
  }
});

test("Windows client rejects a default-ACL impostor before any RPC bytes are sent", options, async (t) => {
  const pipe = name();
  let received = 0;
  const server = createServer((socket) => {
    socket.on("data", (bytes: Buffer) => { received += bytes.length; });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  t.after(() => server.close());
  await assert.rejects(DaemonClient.connect(pipe), /identity verification failed/);
  assert.equal(received, 0);
  const service = helper(t, "server", pipe);
  await service.wait("fatal");
  assert.equal(await service.exited, 3);
});

test("Windows bridge rejects malformed internal frames and missing parent", options, async (t) => {
  const service = helper(t, "server", name());
  await service.wait("ready");
  service.child.stdin.write('{"v":99,"t":"shutdown"}\n');
  assert.equal(await service.exited, 3);
  const invalid = helper(t, "server", name(), 4294967294);
  await invalid.wait("fatal");
  assert.equal(await invalid.exited, 3);
});

test("Windows production helper has no default-DACL bypass", options, () => {
  const result = spawnSync(bridgeExecutable(), ["server", "--pipe", name(), "--parent", String(process.pid), "--test-insecure-default-dacl"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /unknown argument/);
});

test("Windows missing build artifact fails closed without creating a pipe", options, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-bridge-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  mkdirSync(join(dir, "src"));
  copyFileSync(join(ROOT, "dist/packages/daemon/src/bridge.js"), join(dir, "src/bridge.js"));
  writeFileSync(join(dir, "check.mjs"), 'import { WindowsBridge } from "./src/bridge.js";\ntry { new WindowsBridge("server", process.argv[2], () => {}, () => {}); process.exit(1); } catch (e) { console.log(e.message); }\n');
  const result = spawnSync(process.execPath, [join(dir, "check.mjs"), name()], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Windows bridge missing/);
});

test("Windows oversized internal input is rejected before unbounded allocation", options, async (t) => {
  const service = helper(t, "server", name());
  await service.wait("ready");
  service.child.stdin.write("x".repeat(129 * 1024));
  assert.equal(await service.exited, 3);
});

test("Windows helper crash stops daemon and revokes outstanding approval", options, async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const client = await daemon.client();
  t.after(() => client.close());
  const proposal = await client.request("propose", { text: "CQ" }) as { id: string };
  await client.request("approve", { id: proposal.id });
  const doctor = await client.request("doctor") as { endpointAccessBoundary: { helperPid: number } };
  const pid = doctor.endpointAccessBoundary.helperPid;
  assert.ok(Number.isSafeInteger(pid));
  process.kill(pid);
  assert.equal(await daemon.waitForTermination(6000), true);
  const restarted = await startDaemon({ dir: daemon.dir, endpoint: daemon.endpoint });
  t.after(() => restarted.stop());
  const recovered = await restarted.client();
  t.after(() => recovered.close());
  await assert.rejects(recovered.request("transmit", { id: proposal.id }));
});

test("Windows daemon force-kill leaves no serving bridge", options, async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const client = await daemon.client();
  const doctor = await client.request("doctor") as { endpointAccessBoundary: { helperPid: number } };
  client.close();
  await daemon.kill();
  const pid = doctor.endpointAccessBoundary.helperPid;
  const deadline = Date.now() + 5000;
  let running = true;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { running = false; break; }
    await sleep(50);
  }
  assert.equal(running, false);
  await assert.rejects(DaemonClient.connect(daemon.socketPath, { connectTimeoutMs: 200 }));
});
