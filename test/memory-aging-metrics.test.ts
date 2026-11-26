import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_AGING_ACTIONS,
  MEMORY_AGING_POLICIES,
  countMemoryAging,
  resetRuntimeMetrics,
  runtimeMetricsSnapshot,
  setActiveTaskMemory,
} from "../src/runtimeMetrics.ts";

test("aging counters have a fixed label set (every policy and action), and only count what they know", () => {
  resetRuntimeMetrics();
  const idle = runtimeMetricsSnapshot().memory_aging.actions;
  assert.equal(
    Object.keys(idle).length,
    MEMORY_AGING_POLICIES.length * MEMORY_AGING_ACTIONS.length,
  );
  assert.ok(Object.values(idle).every((n) => n === 0));
  countMemoryAging("stale", "archive");
  countMemoryAging("stale", "archive");
  countMemoryAging("replacement", "supersede");
  countMemoryAging("manual", "restore");
  countMemoryAging("stale" as never, "explode" as never);
  const after = runtimeMetricsSnapshot().memory_aging.actions;
  assert.equal(after["stale.archive"], 2);
  assert.equal(after["replacement.supersede"], 1);
  assert.equal(after["manual.restore"], 1);
  assert.equal(
    Object.keys(after).length,
    Object.keys(idle).length,
    "an unknown action adds no label",
  );
});

test("active task memory per owner is bounded: the largest owners are listed, the rest are summed", () => {
  resetRuntimeMetrics();
  const byOwner = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [String(i + 1), i + 1]));
  setActiveTaskMemory(byOwner);
  const m = runtimeMetricsSnapshot().memory_aging.active_task_memory;
  assert.equal(Object.keys(m.per_owner).length, 50);
  assert.equal(m.per_owner["80"], 80);
  assert.equal(m.per_owner["30"], undefined, "owner 30 is below the 50 largest");
  assert.equal(m.other, (1 + 30) * 15, "owners 1..30 are folded into 'other'");
  assert.equal(m.total, (80 * 81) / 2);
  resetRuntimeMetrics();
  assert.deepEqual(runtimeMetricsSnapshot().memory_aging.active_task_memory, {
    total: 0,
    per_owner: {},
    other: 0,
  });
});
