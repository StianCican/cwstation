// V00-04-A：会话级自动派发授权专项。只验证控制对象，不打开设备或运行发送循环。

import test from "node:test";
import assert from "node:assert/strict";
import {
  ReplyDispatchControl,
  type ReplyDispatchIdentity,
} from "../apps/reply-dispatch-control.js";

const IDENTITY: ReplyDispatchIdentity = {
  text: "B2BB DE B1AA K",
  sessionId: "session-1",
  turnId: "session-1:turn-1",
  revision: 3,
};

function lease(control: ReplyDispatchControl, identity: ReplyDispatchIdentity = IDENTITY) {
  const result = control.authorize(identity, () => true);
  if (!result.authorized) throw new Error(`expected an automatic lease, got ${result.reason}`);
  return result.lease;
}

test("dispatch control defaults to manual and refuses a lease", () => {
  const control = new ReplyDispatchControl();
  assert.equal(control.mode, "manual");
  assert.equal(control.generation, 1);
  assert.deepEqual(control.authorize(IDENTITY, () => true), { authorized: false, reason: "manual" });
  assert.equal(control.hasLease, false);
});

test("automatic lease binds exact identity and can be consumed only once", () => {
  const control = new ReplyDispatchControl({ automatic: true });
  const first = lease(control);
  assert.equal(first.generation, 1);
  assert.deepEqual(first.identity, IDENTITY);
  assert.equal(control.check(first, () => true), null);

  assert.equal(control.consume(first, () => true), null);
  assert.equal(control.hasLease, false);
  assert.equal(control.check(first, () => true), "already_consumed");
  assert.equal(control.consume(first, () => true), "already_consumed");
  assert.deepEqual(control.authorize(IDENTITY, () => true), { authorized: false, reason: "already_consumed" });
  assert.deepEqual(control.authorize({ ...IDENTITY, text: "B2BB DE B1AA R" }, () => true), {
    authorized: false, reason: "already_consumed",
  });

  // 新提案可以取得新代次的 lease，但旧 lease 永远不会复活。
  const next = lease(control, { ...IDENTITY, turnId: "session-1:turn-2", revision: 1 });
  assert.ok(next.generation > first.generation);
  assert.equal(control.check(first, () => true), "already_consumed");
});

test("mode switch and edit revoke the old lease permanently", () => {
  for (const revoke of [
    (control: ReplyDispatchControl) => { control.requireManual(); control.enableAutomatic(); },
    (control: ReplyDispatchControl) => control.revoke(),
    (control: ReplyDispatchControl) => control.beginEdit(),
  ]) {
    const control = new ReplyDispatchControl({ automatic: true });
    const old = lease(control);
    revoke(control);
    assert.notEqual(control.check(old, () => true), null);
    // 重新开启自动模式不能恢复旧 lease，也不能重新自动授权同一提案。
    control.enableAutomatic();
    assert.equal(control.check(old, () => true), "revoked");
    assert.deepEqual(control.authorize(IDENTITY, () => true), { authorized: false, reason: "revoked" });
    assert.equal(control.mode, "automatic");
  }
});

test("editing before authorization holds manual mode and stop is terminal", () => {
  const control = new ReplyDispatchControl({ automatic: true });
  control.beginEdit();
  assert.equal(control.mode, "manual");
  assert.deepEqual(control.authorize(IDENTITY, () => true), { authorized: false, reason: "manual" });
  control.enableAutomatic();
  const active = lease(control);
  control.stop();
  control.enableAutomatic();
  assert.equal(control.signal.aborted, true);
  assert.equal(control.mode, "manual");
  assert.equal(control.check(active, () => true), "stopped");
  assert.deepEqual(control.authorize({ ...IDENTITY, revision: 4 }, () => true), { authorized: false, reason: "stopped" });
});

test("a different exact text or identity replaces and retires the previous lease", () => {
  const control = new ReplyDispatchControl({ automatic: true });
  const old = lease(control);
  const changedText = lease(control, { ...IDENTITY, text: "B2BB DE B1AA R" });
  assert.equal(control.check(old, () => true), "revoked");
  assert.equal(control.check(changedText, () => true), null);
  assert.deepEqual(control.authorize(IDENTITY, () => true), { authorized: false, reason: "revoked" });
});

test("isCurrent is checked at authorization and before every dispatch step", () => {
  const control = new ReplyDispatchControl({ automatic: true });
  assert.deepEqual(
    control.authorize(IDENTITY, () => false),
    { authorized: false, reason: "proposal_no_longer_current" },
  );
  const current = lease(control);
  assert.equal(control.check(current, () => false), "proposal_no_longer_current");
  assert.equal(control.consume(current, () => false), "proposal_no_longer_current");
  assert.equal(control.hasLease, true, "a refused consume must not spend the lease");
});

test("invalid identities and validity checks fail closed", () => {
  const control = new ReplyDispatchControl({ automatic: true });
  for (const identity of [
    { ...IDENTITY, text: "" },
    { ...IDENTITY, sessionId: "" },
    { ...IDENTITY, turnId: "" },
    { ...IDENTITY, revision: 0 },
    { ...IDENTITY, revision: 1.5 },
  ]) {
    assert.deepEqual(control.authorize(identity, () => true), { authorized: false, reason: "invalid_identity" });
  }
  assert.deepEqual(
    control.authorize(IDENTITY, "not-a-function" as unknown as () => boolean),
    { authorized: false, reason: "invalid_validity_check" },
  );
});
