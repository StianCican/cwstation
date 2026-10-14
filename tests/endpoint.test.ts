// P1-002：平台端点解析、校验、规范化与锁路径。
// 只要显式传入 platform，这些测试在 Linux 与 Windows 上结果一致。

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, join, resolve } from "node:path";
import {
  canonicalEndpoint,
  defaultEndpoint,
  endpointAddress,
  endpointLockPath,
  parseEndpointAddress,
  pipeLockKey,
  validatePipeName,
  EndpointError,
} from "../packages/daemon/src/endpoint.js";

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

test("local named pipe addresses parse on win32 and reject on other platforms", () => {
  assert.deepEqual(parseEndpointAddress("\\\\.\\pipe\\cwstation-test", "win32"), {
    kind: "pipe",
    name: "cwstation-test",
  });
  // 正斜杠写法归一化。
  assert.deepEqual(parseEndpointAddress("//./pipe/cwstation-test", "win32"), {
    kind: "pipe",
    name: "cwstation-test",
  });
  expectEndpointError(() => parseEndpointAddress("\\\\.\\pipe\\cwstation-test", "linux"), "endpoint_pipe_on_unix");
});

test("remote, UNC and unsupported endpoint formats are rejected", () => {
  expectEndpointError(() => parseEndpointAddress("\\\\server\\pipe\\cwstation", "win32"), "endpoint_remote_pipe");
  expectEndpointError(() => parseEndpointAddress("\\\\?\\pipe\\cwstation", "win32"), "endpoint_unsupported_platform");
  expectEndpointError(() => parseEndpointAddress("\\\\.\\PhysicalDrive0", "win32"), "endpoint_remote_pipe");
  expectEndpointError(() => parseEndpointAddress("   ", "win32"), "endpoint_invalid");
});

test("Unix socket paths are rejected on win32 instead of being silently converted", () => {
  expectEndpointError(() => parseEndpointAddress("/run/user/1000/cwstation.sock", "win32"), "endpoint_unix_on_windows");
  expectEndpointError(() => parseEndpointAddress("C:\\run\\cw.sock", "win32"), "endpoint_unix_on_windows");
});

test("Unix socket paths resolve to absolute paths on other platforms", () => {
  const parsed = parseEndpointAddress("relative/cw.sock", "linux");
  assert.equal(parsed.kind, "unix");
  assert.ok(parsed.kind === "unix" && isAbsolute(parsed.path));
});

test("pipe names are conservative and reject dangerous formats", () => {
  assert.equal(validatePipeName(" cwstation-abc "), "cwstation-abc");
  assert.equal(validatePipeName("A.b_c-1"), "A.b_c-1");
  for (const bad of ["", "  ", "a b", "a\\b", "a/b", "a:b", "..", "a..b", "\u0000x", "x".repeat(201)]) {
    expectEndpointError(() => validatePipeName(bad), "endpoint_pipe_name_invalid");
  }
});

test("pipe addresses are case-insensitive for locking; Unix paths are canonicalized", () => {
  const runtimeDir = process.platform === "win32" ? "C:\\cwrun" : "/tmp/cwrun";
  const upper = endpointLockPath({ kind: "pipe", name: "CwStation-Test" }, { CWSTATION_RUNTIME_DIR: runtimeDir });
  const lower = endpointLockPath({ kind: "pipe", name: "cwstation-test" }, { CWSTATION_RUNTIME_DIR: runtimeDir });
  assert.equal(upper, lower, "Windows pipe names are case-insensitive, so the lock key must normalize case");
  assert.equal(pipeLockKey("CwStation-Test"), pipeLockKey("cwstation-test"));
  assert.match(upper, /pipe-cwstation-test-[0-9a-f]{16}\.lock$/);
});

test("pipe lock lives in the user runtime dir, never as a file path derived from the pipe name", () => {
  const runtimeDir = process.platform === "win32" ? "C:\\cwrun" : "/tmp/cwrun";
  const lock = endpointLockPath({ kind: "pipe", name: "cwstation-test" }, { CWSTATION_RUNTIME_DIR: runtimeDir });
  assert.equal(lock, join(resolve(runtimeDir), `pipe-${pipeLockKey("cwstation-test")}.lock`));
  assert.ok(!lock.includes("\\\\.\\pipe\\"));
  // 绝不能把管道地址当成文件并追加 .lock。
  assert.ok(!lock.startsWith(endpointAddress({ kind: "pipe", name: "cwstation-test" })));
});

test("canonicalEndpoint never runs file-system resolution on a pipe", () => {
  const pipe = { kind: "pipe", name: "cwstation-test" } as const;
  assert.deepEqual(canonicalEndpoint(pipe), pipe);
  const unix = canonicalEndpoint({ kind: "unix", path: "/tmp/../tmp/cwstation.sock" });
  assert.equal(unix.kind, "unix");
});

test("default endpoints distinguish users and stay on the expected platform", () => {
  const alice = defaultEndpoint("win32", { USERNAME: "alice" });
  const bob = defaultEndpoint("win32", { USERNAME: "bob" });
  assert.equal(alice.kind, "pipe");
  assert.notEqual(endpointAddress(alice), endpointAddress(bob));
  assert.match(endpointAddress(alice), /^\\\\\.\\pipe\\cwstation-alice-[0-9a-f]{8}$/);
  assert.equal(defaultEndpoint("linux", {}).kind, "unix");
});
