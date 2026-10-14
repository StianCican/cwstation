// 锁的并发/陈旧回收语义回归：必须 fail closed，绝不误删他人或写入窗口中的锁。

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockedError } from "../packages/daemon/src/lock.js";

type TestFn = (t: TestContext) => void | Promise<void>;
const TEST_TIMEOUT_MS = 10_000;
function ltest(name: string, fn: TestFn): void {
  test(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

function tempPath(): { dir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-lock-"));
  return { dir, lockPath: join(dir, "cw.lock") };
}

ltest("live-pid lock is never removed", (t) => {
  const { dir, lockPath } = tempPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, label: "live", at: new Date().toISOString() }));
  assert.throws(() => acquireLock(lockPath, "test"), LockedError);
  assert.equal(existsSync(lockPath), true, "live lock must be preserved");
});

ltest("malformed or empty lock fails closed and is preserved", (t) => {
  const { dir, lockPath } = tempPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(lockPath, "");
  assert.throws(() => acquireLock(lockPath, "test"), LockedError);
  assert.equal(existsSync(lockPath), true, "empty lock must not be auto-removed");

  writeFileSync(lockPath, "not json at all");
  assert.throws(() => acquireLock(lockPath, "test"), LockedError);
  assert.equal(readFileSync(lockPath, "utf8"), "not json at all");
});

ltest("stale dead-pid lock is atomically reclaimed and replaced", (t) => {
  const { dir, lockPath } = tempPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 一个几乎不可能存活的 PID。
  writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_646, label: "dead", at: new Date().toISOString() }));
  const handle = acquireLock(lockPath, "test");
  t.after(() => handle.release());

  const content = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
  assert.equal(content.pid, process.pid);
  const stale = readFileSync(lockPath, "utf8");
  assert.match(stale, new RegExp(String(process.pid)));

  // 释放后可以再次获取。
  handle.release();
  assert.equal(existsSync(lockPath), false);
  const again = acquireLock(lockPath, "test2");
  again.release();
});

ltest("existing guard fails closed without creating a lock", (t) => {
  const { dir, lockPath } = tempPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(`${lockPath}.guard`);
  assert.throws(() => acquireLock(lockPath, "test"), LockedError);
  assert.equal(existsSync(lockPath), false, "must not create a lock while guard is held");
  assert.equal(existsSync(`${lockPath}.guard`), true, "guard residue is left for manual handling");
});

ltest("sequential acquire and release work cleanly", (t) => {
  const { dir, lockPath } = tempPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = acquireLock(lockPath, "first");
  assert.throws(() => acquireLock(lockPath, "second"), LockedError);
  first.release();
  const second = acquireLock(lockPath, "second");
  second.release();
  assert.equal(existsSync(lockPath), false);
});
