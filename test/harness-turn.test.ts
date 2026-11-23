import { test } from "node:test";
import assert from "node:assert/strict";
import { stopFailure, superviseTurn, turnLimits } from "../src/agent/harness/cliTurn.ts";
import { FAILURE_POLICY } from "../src/agent/harness/failure.ts";

test("turn limits: step settings win, then provider config, then platform defaults; MICRO caps idle", () => {
  assert.deepEqual(turnLimits({ timeout_ms: 60_000, idle_timeout_ms: 20_000 }, 99_000), {
    timeoutMs: 60_000,
    idleMs: 20_000,
  });
  assert.equal(turnLimits({}, 99_000).timeoutMs, 99_000);
  assert.equal(turnLimits(null).timeoutMs, 45 * 60_000);
  assert.equal(turnLimits(null).idleMs, 30 * 60_000);
  assert.equal(turnLimits({ execution_profile: "MICRO" }).idleMs, 3 * 60_000);
  assert.equal(turnLimits({ timeout_ms: 5_000 }).idleMs, 5_000);
});

test("watchdog stops a silent turn as idle and keeps an active one alive", ({ mock }) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const stops: string[] = [];
  const ac = new AbortController();
  const watch = superviseTurn({
    signal: ac.signal,
    timeoutMs: 5_000,
    idleMs: 60,
    stop: (r) => stops.push(r),
  });
  for (let i = 0; i < 4; i++) {
    mock.timers.tick(30);
    watch.touch();
  }
  assert.equal(watch.reason, null);
  mock.timers.tick(59);
  assert.equal(watch.reason, null, "the last touch resets the full idle window");
  mock.timers.tick(1);
  assert.equal(watch.reason, "idle");
  assert.deepEqual(stops, ["idle"]);
  watch.dispose();
});

test("watchdog reports the wall-clock limit and cancellation once", ({ mock }) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const ac = new AbortController();
  const stops: string[] = [];
  const timed = superviseTurn({
    signal: ac.signal,
    timeoutMs: 40,
    idleMs: 1_000,
    stop: (r) => stops.push(r),
  });
  mock.timers.tick(39);
  assert.equal(timed.reason, null);
  mock.timers.tick(1);
  ac.abort();
  assert.equal(timed.reason, "timeout");
  timed.dispose();
  const canceled = superviseTurn({
    signal: ac.signal,
    timeoutMs: 1_000,
    idleMs: 1_000,
    stop: (r) => stops.push(r),
  });
  assert.equal(canceled.reason, "canceled");
  canceled.dispose();
  assert.deepEqual(stops, ["timeout", "canceled"]);
});

test("stopped turns map onto the shared failure policy", () => {
  const limits = { timeoutMs: 120_000, idleMs: 60_000 };
  assert.equal(stopFailure("canceled", "X", limits).failure, "CANCELED");
  assert.match(stopFailure("timeout", "Codex", limits).text, /Codex execution timeout: .*2 minute/);
  const idle = stopFailure("idle", "Copilot", limits);
  assert.equal(idle.failure, "IDLE_TIMEOUT");
  assert.equal(FAILURE_POLICY[idle.failure].retryable, true);
});
