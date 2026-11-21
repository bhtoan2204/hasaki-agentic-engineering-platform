import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireVerificationSlot,
  verificationSlotLimit,
  verificationSlotsInUse,
} from "../src/workflow/executors/verificationSlots.ts";

const tick = () => new Promise((r) => setImmediate(r));

test("slot limit comes from VERIFY_MAX_CONCURRENT, else at least one", () => {
  assert.equal(verificationSlotLimit({ VERIFY_MAX_CONCURRENT: "3" }), 3);
  assert.ok(verificationSlotLimit({ VERIFY_MAX_CONCURRENT: "0" }) >= 1);
  assert.ok(verificationSlotLimit({ VERIFY_MAX_CONCURRENT: "x" }) >= 1);
});

test("at most `limit` holders; a release admits the next waiter", async () => {
  const signal = new AbortController().signal;
  const a = await acquireVerificationSlot(signal, 2);
  const b = await acquireVerificationSlot(signal, 2);
  const waiter: { release: (() => void) | null } = { release: null };
  const c = acquireVerificationSlot(signal, 2).then((r) => (waiter.release = r));
  await tick();
  assert.equal(waiter.release, null);
  assert.equal(verificationSlotsInUse(), 2);
  a!();
  a!();
  const admitted = await c;
  assert.ok(admitted);
  assert.equal(verificationSlotsInUse(), 2, "a double release frees one slot only");
  b!();
  admitted();
  assert.equal(verificationSlotsInUse(), 0);
});

test("an aborted waiter gets null and does not hold or block a slot", async () => {
  const held = await acquireVerificationSlot(new AbortController().signal, 1);
  const ac = new AbortController();
  const waiter = acquireVerificationSlot(ac.signal, 1);
  const next = acquireVerificationSlot(new AbortController().signal, 1);
  await tick();
  ac.abort();
  assert.equal(await waiter, null);
  held!();
  const r = await next;
  assert.ok(r);
  assert.equal(verificationSlotsInUse(), 1);
  r!();
  const pre = new AbortController();
  pre.abort();
  assert.equal(await acquireVerificationSlot(pre.signal, 5), null);
  assert.equal(verificationSlotsInUse(), 0);
});

test("with host-wide admission slots, the in-process default never exceeds them (no admission_timeout queue)", () => {
  assert.equal(verificationSlotLimit({}, 1), 1);
  assert.ok(verificationSlotLimit({}, 64) <= verificationSlotLimit({}));
  assert.equal(verificationSlotLimit({}, undefined), verificationSlotLimit({}));
  assert.equal(
    verificationSlotLimit({ VERIFY_MAX_CONCURRENT: "3" }, 1),
    3,
    "an explicit operator setting wins",
  );
});
