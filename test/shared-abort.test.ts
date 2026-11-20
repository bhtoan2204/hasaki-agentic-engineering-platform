import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedAbort } from "../src/http/sharedAbort.ts";

test("a shared load is canceled only when every waiter has disconnected", () => {
  const shared = new SharedAbort();
  const a = new AbortController(),
    b = new AbortController();
  const first = shared.join("k", a.signal);
  const second = shared.join("k", b.signal);
  assert.equal(first.signal, second.signal, "one signal per key");
  a.abort();
  assert.equal(first.signal.aborted, false, "another waiter remains");
  b.abort();
  assert.equal(first.signal.aborted, true);
  assert.equal(shared.size, 0);
  // A new waiter after cancellation starts a fresh load.
  const third = shared.join("k", new AbortController().signal);
  assert.equal(third.signal.aborted, false);
  third.leave();
  assert.equal(shared.size, 0);
});

test("a waiter that completes normally never cancels the load for the others", () => {
  const shared = new SharedAbort();
  const a = new AbortController(),
    b = new AbortController();
  const first = shared.join("k", a.signal);
  const second = shared.join("k", b.signal);
  first.leave();
  a.abort(); // disconnect after its response: no effect
  assert.equal(second.signal.aborted, false);
  b.abort();
  assert.equal(second.signal.aborted, true);
});

test("an already disconnected waiter cancels on the next tick, and no signal means never", async () => {
  const shared = new SharedAbort();
  const gone = AbortSignal.abort();
  const w = shared.join("x", gone);
  await new Promise((r) => queueMicrotask(() => r(null)));
  assert.equal(w.signal.aborted, true);
  const plain = shared.join("y");
  assert.equal(plain.signal.aborted, false);
  plain.leave();
});
