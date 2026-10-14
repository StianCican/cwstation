// P0-005/P1-002：版本 1/2 JSON 配置的加载、严格校验与优先级，以及平台端点选择。

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_NUMBER_LIMITS,
  ConfigError,
  loadConfigFile,
  resolveDaemonConfig,
  resolveEndpoint,
} from "../packages/daemon/src/config.js";
import { EndpointError } from "../packages/daemon/src/endpoint.js";
import { baseSocketPath } from "../packages/daemon/src/paths.js";
import { IS_WINDOWS, ROOT, cliEntry, startDaemon, testEndpoint } from "./helpers.js";
import { endpointAddress } from "../packages/daemon/src/endpoint.js";

type TestFn = (t: TestContext) => void | Promise<void>;
const TEST_TIMEOUT_MS = 30_000;
function ctest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir: string, value: unknown, name = "station.json"): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function expectConfigError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  throw new Error(`expected ConfigError(${code}) but nothing was thrown`);
}

function expectEndpointError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EndpointError, `expected EndpointError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  throw new Error(`expected EndpointError(${code}) but nothing was thrown`);
}

ctest("no config keeps the existing Linux defaults", () => {
  const effective = resolveDaemonConfig(undefined, {}, {}, "linux");
  assert.equal(effective.socketPath, baseSocketPath({}));
  assert.equal(effective.endpoint.kind, "unix");
  assert.equal(effective.dbPath, resolve("data/cwstation.sqlite"));
  assert.equal(effective.txTimeoutMs, 5_000);
  assert.equal(effective.requestTimeoutMs, 10_000);
  assert.equal(effective.proposalTtlMs, 60_000);
  assert.equal(effective.approvalTtlMs, 60_000);
  assert.equal(effective.maxFrameBytes, 65_536);
  assert.equal(effective.fakeDurationMs, 30);
  assert.equal(effective.shutdownTimeoutMs, 3_000);
  assert.equal(effective.shutdownWatchdogMs, 8_000);
});

ctest("win32 default is a user-distinct local named pipe, never a Unix file", () => {
  const effective = resolveDaemonConfig(undefined, {}, { USERNAME: "alice" }, "win32");
  assert.equal(effective.endpoint.kind, "pipe");
  assert.match(effective.socketPath, /^\\\\\.\\pipe\\cwstation-alice-[0-9a-f]{8}$/);
  const other = resolveDaemonConfig(undefined, {}, { USERNAME: "bob" }, "win32");
  assert.notEqual(effective.socketPath, other.socketPath, "different users must get different default pipes");
});

ctest("cross-platform incompatible addresses are rejected, never silently converted", () => {
  // Windows 上的 Unix 文件路径必须拒绝，而不是偷偷当成管道。
  expectEndpointError(
    () => resolveDaemonConfig(undefined, {}, { CWSTATION_SOCKET: "C:\\run\\cw.sock" }, "win32"),
    "endpoint_unix_on_windows",
  );
  // Linux 上的 Windows 管道必须拒绝。
  expectEndpointError(
    () => resolveDaemonConfig(undefined, {}, { CWSTATION_SOCKET: "\\\\.\\pipe\\cwstation" }, "linux"),
    "endpoint_pipe_on_unix",
  );
  // 远程/UNC 管道明确拒绝。
  expectEndpointError(
    () => resolveDaemonConfig(undefined, {}, { CWSTATION_SOCKET: "\\\\server\\pipe\\cwstation" }, "win32"),
    "endpoint_remote_pipe",
  );
  expectEndpointError(
    () => resolveDaemonConfig(undefined, {}, { CWSTATION_SOCKET: "\\\\?\\pipe\\cwstation" }, "win32"),
    "endpoint_unsupported_platform",
  );
  // 危险/不支持管道名（分隔符、路径穿越）拒绝。
  expectEndpointError(
    () => resolveDaemonConfig(undefined, {}, { CWSTATION_SOCKET: "\\\\.\\pipe\\a\\b" }, "win32"),
    "endpoint_pipe_name_invalid",
  );
  expectEndpointError(
    () => resolveDaemonConfig(undefined, {}, { CWSTATION_SOCKET: "\\\\.\\pipe\\.." }, "win32"),
    "endpoint_pipe_name_invalid",
  );
});

ctest("existing CWSTATION_* environment variables still override defaults (Linux)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-config-env-"));
  const env = {
    CWSTATION_SOCKET: join(dir, "env.sock"),
    CWSTATION_DB: join(dir, "env.sqlite"),
    CWSTATION_TX_TIMEOUT_MS: "1234",
    CWSTATION_FAKE_DURATION_MS: "0",
  };
  try {
    const effective = resolveDaemonConfig(undefined, {}, env, "linux");
    assert.equal(effective.socketPath, resolve(env.CWSTATION_SOCKET));
    assert.equal(effective.dbPath, resolve(env.CWSTATION_DB));
    assert.equal(effective.txTimeoutMs, 1_234);
    assert.equal(effective.requestTimeoutMs, 10_000, "request timeout must not drop below its default");
    assert.equal(effective.fakeDurationMs, 0);

    const runtimeDir = resolveDaemonConfig(undefined, {}, { CWSTATION_RUNTIME_DIR: dir }, "linux");
    assert.equal(runtimeDir.socketPath, join(resolve(dir), "cwstation.sock"));

    const cliWins = resolveDaemonConfig(
      undefined,
      { socketPath: join(dir, "cli.sock"), dbPath: join(dir, "cli.sqlite") },
      env,
      "linux",
    );
    assert.equal(cliWins.socketPath, resolve(join(dir, "cli.sock")));
    assert.equal(cliWins.dbPath, resolve(join(dir, "cli.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

ctest("version1 config keeps working unchanged (relative paths resolve against the config dir)", (t) => {
  const base = tempDir(t);
  const configDir = join(base, "config");
  mkdirSync(configDir, { recursive: true });
  const path = writeConfig(configDir, {
    version: 1,
    socketPath: "../run/cw.sock",
    dbPath: "data/cw.sqlite",
    txTimeoutMs: 2_000,
    requestTimeoutMs: 3_000,
    proposalTtlMs: 5_000,
    approvalTtlMs: 5_000,
    maxFrameBytes: 4_096,
    fakeDurationMs: 0,
    shutdownTimeoutMs: 1_000,
    shutdownWatchdogMs: 2_000,
  });

  const config = loadConfigFile(path);
  assert.equal(config.version, 1);
  assert.equal(config.socketPath, resolve(base, "run/cw.sock"));
  assert.equal(config.dbPath, resolve(configDir, "data/cw.sqlite"));

  const effective = resolveDaemonConfig(config, {}, {}, "linux");
  assert.equal(effective.socketPath, config.socketPath);
  assert.equal(effective.endpoint.kind, "unix");
  assert.equal(effective.dbPath, config.dbPath);
  assert.equal(effective.txTimeoutMs, 2_000);
  assert.equal(effective.fakeDurationMs, 0);
  assert.equal(effective.maxFrameBytes, 4_096);
  // requestTimeoutMs 仍受 txTimeoutMs + 2000 的安全下限约束。
  assert.equal(effective.requestTimeoutMs, 4_000);
});

ctest("version2 endpoint expresses platform endpoints explicitly", (t) => {
  const base = tempDir(t);
  const configDir = join(base, "config");
  mkdirSync(configDir, { recursive: true });

  const unixPath = writeConfig(
    configDir,
    { version: 2, endpoint: { kind: "unix", path: "run/cw.sock" }, dbPath: "data/cw.sqlite" },
    "unix.json",
  );
  const unixConfig = loadConfigFile(unixPath);
  assert.deepEqual(unixConfig.endpoint, { kind: "unix", path: resolve(configDir, "run/cw.sock") });
  assert.equal(resolveEndpoint(unixConfig, undefined, {}, "linux").kind, "unix");

  const pipePath = writeConfig(
    configDir,
    { version: 2, endpoint: { kind: "pipe", name: "cwstation-test" }, dbPath: "data/cw.sqlite" },
    "pipe.json",
  );
  const pipeConfig = loadConfigFile(pipePath);
  assert.deepEqual(pipeConfig.endpoint, { kind: "pipe", name: "cwstation-test" });
  // 管道名不按配置目录解析。
  assert.equal(pipeConfig.endpoint?.kind, "pipe");
  const resolved = resolveEndpoint(pipeConfig, undefined, {}, "win32");
  assert.deepEqual(resolved, { kind: "pipe", name: "cwstation-test" });
  // 同一份 pipe 配置在 Linux 上明确拒绝，而不是改写。
  expectEndpointError(() => resolveEndpoint(pipeConfig, undefined, {}, "linux"), "endpoint_pipe_on_unix");
});

ctest("version2 still accepts socketPath as a Unix convenience but not together with endpoint", (t) => {
  const dir = tempDir(t);
  const ok = loadConfigFile(writeConfig(dir, { version: 2, socketPath: "cw.sock" }, "ok.json"));
  assert.equal(ok.endpoint, undefined);
  assert.equal(resolveEndpoint(ok, undefined, {}, "linux").kind, "unix");
  expectConfigError(
    () => loadConfigFile(writeConfig(dir, { version: 2, socketPath: "a.sock", endpoint: { kind: "pipe", name: "x" } }, "both.json")),
    "config_invalid",
  );
  // version1 不承载管道语义：endpoint 是未知字段。
  expectConfigError(
    () => loadConfigFile(writeConfig(dir, { version: 1, endpoint: { kind: "pipe", name: "x" } }, "v1pipe.json")),
    "config_unknown_field",
  );
});

ctest("version2 endpoint strictly validates shape, kind and pipe names", (t) => {
  const dir = tempDir(t);
  const make = (endpoint: unknown, name: string): string => writeConfig(dir, { version: 2, endpoint }, name);
  expectConfigError(() => loadConfigFile(make({ kind: "tcp", host: "x" }, "kind.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make("pipe", "string.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ kind: "unix" }, "nopath.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ kind: "unix", path: "" }, "emptypath.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ kind: "pipe" }, "noname.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ kind: "pipe", name: "a b" }, "space.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ kind: "pipe", name: "a\\b" }, "sep.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ kind: "pipe", name: ".." }, "dotdot.json")), "config_invalid");
  expectConfigError(
    () => loadConfigFile(make({ kind: "pipe", name: "ok", extra: 1 }, "extra.json")),
    "config_unknown_field",
  );
  expectConfigError(() => loadConfigFile(make({ kind: "unix", path: "x", name: "y" }, "wrongfield.json")), "config_unknown_field");
});

ctest("precedence is default < config < environment < CLI flags", (t) => {
  const base = tempDir(t);
  const configDir = join(base, "config");
  mkdirSync(configDir, { recursive: true });
  const path = writeConfig(configDir, {
    version: 1,
    socketPath: join(base, "from-config.sock"),
    dbPath: join(base, "from-config.sqlite"),
    txTimeoutMs: 2_000,
  });
  const config = loadConfigFile(path);
  const env = {
    CWSTATION_SOCKET: join(base, "from-env.sock"),
    CWSTATION_DB: join(base, "from-env.sqlite"),
    CWSTATION_TX_TIMEOUT_MS: "4000",
  };
  const cli = { socketPath: join(base, "from-cli.sock"), dbPath: join(base, "from-cli.sqlite") };

  const configOnly = resolveDaemonConfig(config, {}, {}, "linux");
  assert.equal(configOnly.socketPath, config.socketPath);
  assert.equal(configOnly.dbPath, config.dbPath);
  assert.equal(configOnly.txTimeoutMs, 2_000);

  const envWins = resolveDaemonConfig(config, {}, env, "linux");
  assert.equal(envWins.socketPath, resolve(env.CWSTATION_SOCKET));
  assert.equal(envWins.dbPath, resolve(env.CWSTATION_DB));
  assert.equal(envWins.txTimeoutMs, 4_000);

  const cliWins = resolveDaemonConfig(config, cli, env, "linux");
  assert.equal(cliWins.socketPath, resolve(cli.socketPath));
  assert.equal(cliWins.dbPath, resolve(cli.dbPath));
  assert.equal(cliWins.txTimeoutMs, 4_000, "no CLI flag for numeric params; env still wins");

  const dbFromConfig = resolveDaemonConfig(config, { dbPath: cli.dbPath }, {}, "linux");
  assert.equal(dbFromConfig.dbPath, resolve(cli.dbPath));
});

ctest("config strictly rejects unknown fields, future versions and wrong shapes", (t) => {
  const dir = tempDir(t);
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: 1, nope: 1 }, "unknown.json")), "config_unknown_field");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: 3 }, "future.json")), "config_future_version");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { socketPath: "/x" }, "missing-version.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: "1" }, "version-type.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(writeConfig(dir, [1, 2, 3], "array.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(writeConfig(dir, "{ not json", "broken.json")), "config_invalid_json");
  expectConfigError(() => loadConfigFile(join(dir, "does-not-exist.json")), "config_not_found");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: 1, socketPath: "" }, "empty.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: 1, dbPath: "   " }, "blank.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: 1, socketPath: 42 }, "path-type.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(writeConfig(dir, { version: 0 }, "zero.json")), "config_invalid");
});

ctest("config rejects unreasonable numbers but allows a zero Fake duration", (t) => {
  const dir = tempDir(t);
  const make = (patch: Record<string, unknown>, name: string): string => writeConfig(dir, { version: 1, ...patch }, name);

  expectConfigError(() => loadConfigFile(make({ txTimeoutMs: "5000" }, "n1.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ txTimeoutMs: 1.5 }, "n2.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ txTimeoutMs: 0 }, "n3.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ txTimeoutMs: -1 }, "n4.json")), "config_invalid");
  expectConfigError(
    () => loadConfigFile(make({ txTimeoutMs: CONFIG_NUMBER_LIMITS.txTimeoutMs!.max + 1 }, "n5.json")),
    "config_invalid",
  );
  expectConfigError(() => loadConfigFile(make({ proposalTtlMs: 10 }, "n6.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ maxFrameBytes: 1 }, "n7.json")), "config_invalid");
  expectConfigError(() => loadConfigFile(make({ fakeDurationMs: -1 }, "n8.json")), "config_invalid");

  const zeroFake = loadConfigFile(make({ fakeDurationMs: 0 }, "ok.json"));
  assert.equal(zeroFake.fakeDurationMs, 0);
});

ctest("cwctl validates a config file without requiring a running daemon", (t) => {
  const dir = tempDir(t);
  const bad = writeConfig(dir, { version: 1, bogus: true }, "bad.json");
  const run = (configPath: string): { status: number | null; stdout: string } => {
    const result = spawnSync(
      process.execPath,
      [...cliEntry("cwctl"), "--config", configPath, "status"],
      { cwd: ROOT, encoding: "utf8" },
    );
    return { status: result.status, stdout: result.stdout.trim() };
  };

  const invalid = run(bad);
  assert.equal(invalid.status, 2, invalid.stdout);
  assert.equal((JSON.parse(invalid.stdout) as { code: string }).code, "config_unknown_field");

  // 有效配置但端点不存在：证明配置本身已通过校验，失败发生在连接阶段。
  const missing = IS_WINDOWS
    ? { version: 2, endpoint: { kind: "pipe", name: "cwstation-missing-probe" } }
    : { version: 1, socketPath: join(dir, "missing.sock") };
  const valid = writeConfig(dir, missing, "valid.json");
  const unavailable = run(valid);
  assert.equal(unavailable.status, 5, unavailable.stdout);
  assert.equal((JSON.parse(unavailable.stdout) as { code: string }).code, "unavailable");
});

ctest("daemon honors --config for endpoint, db and Fake duration", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-config-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  const endpoint = testEndpoint(dir);
  const dbPath = join(dir, "data", "cw.sqlite");
  const configPath = writeConfig(configDir, {
    version: 2,
    endpoint:
      endpoint.kind === "unix"
        ? { kind: "unix", path: endpoint.path }
        : { kind: "pipe", name: endpoint.name },
    dbPath,
    txTimeoutMs: 2_000,
    fakeDurationMs: 0,
  });

  const daemon = await startDaemon({ dir, socketPath: endpointAddress(endpoint), dbPath, configPath });
  t.after(() => daemon.stop());
  const client = await daemon.client();
  try {
    const status = (await client.request("status")) as { schemaVersion: number };
    assert.equal(status.schemaVersion, 4);
  } finally {
    client.close();
  }
});

ctest("daemon honors a version1 config on Unix without modification", async (t) => {
  if (IS_WINDOWS) {
    t.skip("version1 configs are Unix socket paths; Windows requires a version2 pipe endpoint");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cwstation-config-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  const socketPath = join(dir, "run", "cw.sock");
  const dbPath = join(dir, "data", "cw.sqlite");
  const configPath = writeConfig(configDir, {
    version: 1,
    socketPath: join("..", "run", "cw.sock"),
    dbPath: join("..", "data", "cw.sqlite"),
    txTimeoutMs: 2_000,
    fakeDurationMs: 0,
  });

  const daemon = await startDaemon({ dir, socketPath, dbPath, configPath });
  t.after(() => daemon.stop());
  const client = await daemon.client();
  try {
    const status = (await client.request("status")) as { schemaVersion: number };
    assert.equal(status.schemaVersion, 4);
  } finally {
    client.close();
  }
});
