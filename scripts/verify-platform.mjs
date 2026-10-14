import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const deadlineMs = 5_000;
const marker = "CWSTATION_CHILD_OK\n";
const childArgs = ["-e", `process.stdout.write(${JSON.stringify(marker)})`];
const usage = "node scripts/verify-platform.mjs [--source|--built] [--list]\n" +
  "node scripts/verify-platform.mjs --preflight\n" +
  "Default: build and run all compiled tests; exit 2 means usage or environment failure.";

function report(event, fields) {
  console.log(JSON.stringify({ source: "cwstation-verification", event, ...fields }));
}

function parseArgs(args) {
  const allowed = new Set(["--source", "--built", "--preflight", "--list", "--help"]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length ||
      (args.includes("--source") && args.includes("--built")) ||
      (args.includes("--help") && args.length !== 1) ||
      (args.includes("--preflight") && args.length !== 1)) {
    throw new Error(usage);
  }
  return { mode: args.includes("--source") ? "source" : "built", list: args.includes("--list"),
    preflightOnly: args.includes("--preflight"), help: args.includes("--help") };
}

function testFiles(mode) {
  const sources = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) sources.push(relative(root, path));
    }
  }
  visit(join(root, "tests"));
  visit(join(root, "packages"));
  return sources.sort().map((path) => mode === "source" ? path : join("dist", path.replace(/\.ts$/, ".js")));
}

function syncChildProbe() {
  const result = spawnSync(process.execPath, childArgs, {
    encoding: "utf8", timeout: deadlineMs, cwd: root,
  });
  // A denied pipe setup can report status 0 together with an error.
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal !== null || result.stdout !== marker || result.stderr !== "") {
    throw new Error(`unexpected child result: status=${result.status}, signal=${result.signal}, ` +
      `stdoutBytes=${Buffer.byteLength(result.stdout ?? "")}, stderrBytes=${Buffer.byteLength(result.stderr ?? "")}`);
  }
}

function asyncChildProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("Node child probe timed out");
      child.kill("SIGKILL");
    }, deadlineMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || signal !== null || stdout !== marker || stderr !== "") {
        reject(new Error(`unexpected child result: status=${code}, signal=${signal}, ` +
          `stdoutBytes=${Buffer.byteLength(stdout)}, stderrBytes=${Buffer.byteLength(stderr)}`));
      } else resolve();
    });
  });
}

async function listenProbe(http) {
  let dir;
  const server = http ? createHttpServer((_req, res) => { res.writeHead(204); res.end(); }) : createServer();
  // These listeners only test local capabilities and are closed before any build or tests.
  server.on("connection", (socket) => { socket.destroy(); });
  try {
    let address;
    if (!http) {
      if (process.platform === "win32") address = `\\\\.\\pipe\\cwstation-preflight-${process.pid}-${randomUUID()}`;
      else {
        dir = mkdtempSync(join(tmpdir(), "cw-preflight-"));
        address = join(dir, "probe.sock");
      }
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("local listener probe timed out")), deadlineMs);
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.once("listening", () => { clearTimeout(timer); resolve(); });
      if (http) server.listen(0, "127.0.0.1");
      else server.listen(address);
    });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

async function preflight() {
  const checks = [
    ["node-version", () => { if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node >=24 required"); }],
    ["node-child-sync", syncChildProbe],
    ["node-child-async", asyncChildProbe],
    ["local-ipc-listen", () => listenProbe(false)],
    ["local-http-listen", () => listenProbe(true)],
  ];
  let ok = true;
  for (const [check, run] of checks) {
    try {
      await run();
      report("preflight", { check, ok: true });
    } catch (error) {
      ok = false;
      report("preflight", { check, ok: false, code: error.code ?? "probe_failed", error: error.message });
    }
  }
  return ok;
}

function runStep(step, args, timeout) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", timeout });
  if (result.error || result.signal !== null) {
    report("step-failed", { step, code: result.error?.code ?? "signal", error: result.error?.message ?? result.signal });
    return 1;
  }
  if (result.status !== 0) report("step-failed", { step, exitCode: result.status });
  return result.status === 0 ? 0 : 1;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(usage); return 0; }
  const files = testFiles(options.mode);
  if (files.length === 0) throw new Error("no tests discovered");
  report("environment", { platform: process.platform, node: process.version, executable: process.execPath, mode: options.mode });
  if (options.list) { report("test-plan", { count: files.length, files }); return 0; }
  if (!(await preflight())) {
    report("blocked", { code: "environment_unavailable", testsStarted: false, buildStarted: false });
    return 2;
  }
  if (options.preflightOnly) return 0;
  if (process.platform === "win32") {
    const code = runStep("native", [join(root, "scripts/build-native-windows.mjs")], 60_000);
    if (code !== 0) return code;
  }
  if (options.mode === "built") {
    const code = runStep("build", [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], 120_000);
    if (code !== 0) return code;
  }
  report("test-plan", { count: files.length, files });
  return runStep("tests", [...(options.mode === "source" ? ["--import", "tsx"] : []),
    "--test", "--test-reporter=tap", "--test-timeout=60000", ...files.map((path) => join(root, path))], 180_000);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  report("error", { code: "verification_failed", error: error.message });
  process.exitCode = 2;
}
