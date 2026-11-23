import { test } from "node:test";
import assert from "node:assert/strict";
import { deferred } from "./fixtures/deferred.ts";
import {
  runningTurns,
  turnScheduled,
  turnSettled,
  whenNoTurnRuns,
  whenTurnSettles,
} from "../src/chat/turnActivity.ts";
import {
  HEALTH_REUSE_MS,
  clearProviderHealthForTests,
  invalidateSharedAgentHealth,
  primeSharedAgentHealth,
  rememberProviderQuota,
  setSharedHealthProber,
  sharedAgentHealth,
  type AgentHealth,
} from "../src/agent/health.ts";

test("turn activity: waits end when the turn settles or the instance is idle, bounded by a deadline", async (t) => {
  const { mock } = t;
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    for (const id of [1, 2, 3]) turnSettled(id);
  });
  assert.equal(runningTurns(), 0);
  await whenTurnSettles(1, 10_000); // not running here: resolves at once
  await whenNoTurnRuns(10_000);
  turnScheduled(1);
  turnScheduled(2);
  const order: string[] = [];
  const one = whenTurnSettles(1, 10_000).then(() => order.push("turn 1"));
  const idle = whenNoTurnRuns(10_000).then(() => order.push("idle"));
  turnSettled(1);
  await one;
  await Promise.resolve();
  assert.deepEqual(order, ["turn 1"], "idle waits for the other turn");
  turnSettled(2);
  await idle;
  assert.deepEqual(order, ["turn 1", "idle"]);
  turnScheduled(3);
  let deadlineReached = false;
  const bounded = whenNoTurnRuns(30).then(() => {
    deadlineReached = true;
  });
  mock.timers.tick(29);
  await Promise.resolve();
  assert.equal(deadlineReached, false, "the waiter stays pending until its deadline");
  mock.timers.tick(1);
  await bounded;
  assert.equal(runningTurns(), 1, "the deadline only releases the waiter");
  turnSettled(3);
  assert.equal(runningTurns(), 0);
});

test("shared agent health: concurrent readers share one probe, reuse it briefly, see remembered quota at once", async () => {
  clearProviderHealthForTests();
  let probes = 0;
  const rows: AgentHealth[] = [
    { provider: "claude", connected: true, quota: "unknown" },
    { provider: "codex", connected: true, quota: "unknown" },
  ];
  const probe = deferred<void>();
  setSharedHealthProber(async () => {
    probes++;
    await probe.promise;
    return rows;
  });
  try {
    const pending = Promise.all(Array.from({ length: 8 }, () => sharedAgentHealth()));
    probe.resolve();
    const all = await pending;
    assert.equal(probes, 1, "eight concurrent admissions, one probe");
    assert.ok(all.every((r) => r.length === 2));
    await sharedAgentHealth();
    assert.equal(probes, 1, `reused within ${HEALTH_REUSE_MS} ms`);

    rememberProviderQuota("codex", 60_000);
    const codex = (await sharedAgentHealth()).find((h) => h.provider === "codex")!;
    assert.equal(codex.quota, "exhausted", "a remembered quota applies to the reused reading");
    assert.equal(probes, 1);

    invalidateSharedAgentHealth();
    await sharedAgentHealth();
    assert.equal(
      probes,
      2,
      "invalidated (a provider failed as unavailable): the next reader probes",
    );

    primeSharedAgentHealth([
      { provider: "claude", connected: false, quota: "unknown", reason: "logged out" },
    ]);
    const primed = await sharedAgentHealth();
    assert.equal(
      primed[0].connected,
      false,
      "a fresh status-page probe becomes the shared reading",
    );
    assert.equal(probes, 2);

    // A failed probe is not reused.
    setSharedHealthProber(async () => {
      probes++;
      throw new Error("probe failed");
    });
    await assert.rejects(sharedAgentHealth());
    await assert.rejects(sharedAgentHealth());
    assert.equal(probes, 4);
  } finally {
    setSharedHealthProber(undefined);
    clearProviderHealthForTests();
  }
});
