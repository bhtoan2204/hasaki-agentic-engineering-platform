/**
 * Recovery accounting from observable execution sequences: what happened after each failed CodeAct execution — another
 * program (recovery attempt, then recovered or not), a direct integration call (fallback), nothing (abandoned), or
 * something that does not show intent / overlaps in time (unknown). Never inferred from the number of tool calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRecovery, type ToolEvent } from "../src/eval/codeactRecovery.ts";

let clock = 0;
const ev = (
  tool: string,
  exec?: { id: number; ok: boolean; category?: string; nested?: number },
  o: { status?: string; start?: number; ms?: number } = {},
): ToolEvent => {
  const start = o.start ?? (clock += 100);
  return {
    tool,
    status: o.status ?? "ok",
    started_at: start,
    finished_at: start + (o.ms ?? 50),
    ...(exec
      ? {
          execution: {
            id: exec.id,
            ok: exec.ok,
            failure: exec.ok
              ? null
              : { category: exec.category ?? "program_runtime_error", phase: "program_run" },
            nested_failures: exec.nested ?? 0,
          },
        }
      : {}),
  };
};

test("a failure followed by a successful program is one recovered episode with one attempt", () => {
  const r = classifyRecovery([
    ev("code.execute", { id: 1, ok: false }),
    ev("code.execute", { id: 2, ok: true }),
  ]);
  assert.deepEqual(
    { ...r, episodes: undefined },
    {
      execution_failures: 1,
      episodes: undefined,
      recovery_attempts: 1,
      recovered: 1,
      recovery_failed: 0,
      fallback_direct: 0,
      abandoned: 0,
      unknown: 0,
      nested_failures_in_ok_executions: 0,
    },
  );
  assert.deepEqual(r.episodes, [
    {
      execution_ids: [1, 2],
      categories: ["program_runtime_error"],
      attempts: 1,
      outcome: "recovered",
    },
  ]);
});

test("consecutive failures form one episode; it ends by fallback to direct tools", () => {
  const r = classifyRecovery([
    ev("tools.call"),
    ev("code.execute", { id: 1, ok: false, category: "program_syntax_error" }),
    ev("code.execute", { id: 2, ok: false, category: "program_runtime_error" }),
    ev("tools.call"),
  ]);
  assert.equal(r.execution_failures, 2);
  assert.equal(r.recovery_attempts, 1);
  assert.equal(r.fallback_direct, 1);
  assert.equal(r.recovered, 0);
  assert.deepEqual(r.episodes[0].categories, ["program_syntax_error", "program_runtime_error"]);
});

test("a failure with nothing after it is abandoned; retries that never succeed and then stop are recovery_failed", () => {
  assert.equal(classifyRecovery([ev("code.execute", { id: 1, ok: false })]).abandoned, 1);
  const r = classifyRecovery([
    ev("code.execute", { id: 1, ok: false }),
    ev("code.execute", { id: 2, ok: false }),
  ]);
  assert.deepEqual([r.recovery_failed, r.abandoned, r.recovery_attempts], [1, 0, 1]);
});

test("ambiguous sequences are unknown: an overlapping call, or a follow-up that is not an integration call", () => {
  const overlapping = classifyRecovery([
    ev("code.execute", { id: 1, ok: false }, { start: 1000, ms: 500 }),
    ev("tools.call", undefined, { start: 1100, ms: 50 }),
  ]);
  assert.equal(overlapping.unknown, 1);
  const unrelated = classifyRecovery([
    ev("code.execute", { id: 1, ok: false }),
    ev("knowledge.search"),
  ]);
  assert.equal(unrelated.unknown, 1);
});

test("a code.execute the chat refused (no execution) counts as a failure; nested failures inside ok programs are separate", () => {
  const r = classifyRecovery([
    ev("code.execute", undefined, { status: "denied" }),
    ev("tools.call"),
    ev("code.execute", { id: 3, ok: true, nested: 2 }),
  ]);
  assert.equal(r.execution_failures, 1);
  assert.deepEqual(r.episodes[0].categories, ["denied"]);
  assert.equal(r.fallback_direct, 1);
  assert.equal(r.nested_failures_in_ok_executions, 2);
});

test("no failures: all counters are zero", () => {
  const r = classifyRecovery([ev("tools.call"), ev("code.execute", { id: 1, ok: true })]);
  assert.equal(r.execution_failures, 0);
  assert.deepEqual(r.episodes, []);
});
