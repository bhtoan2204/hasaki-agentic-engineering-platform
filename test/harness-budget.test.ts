import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type PolicyContext } from "../src/agent/toolPolicy.ts";
import { budgetStop } from "../src/agent/harness/stages/budget.ts";
import type { LifecycleState } from "../src/agent/harness/state.ts";

const policy = (limit: number): PolicyContext => ({
  mode: "analysis",
  workspaces: [],
  baseBranch: "main",
  toolBudget: { calls: 0, limit, exhausted: false },
});

test("the tool budget counts native calls across turns and never blocks platform tools", () => {
  const p = policy(2);
  assert.equal(decide("Read", { file_path: "/a" }, p).allow, true);
  assert.equal(decide("mcp__platform__post_update", { message: "x" }, p).allow, true);
  assert.equal(decide("Grep", { pattern: "x" }, p).allow, true);
  const denied = decide("Read", { file_path: "/b" }, p);
  assert.equal(denied.allow, false);
  assert.match((denied as { reason: string }).reason, /tool budget of 2 calls/);
  assert.equal(p.toolBudget!.exhausted, true);
  assert.equal(decide("mcp__platform__submit_result", { output: {} }, p).allow, true);
});

const state = (over: Partial<LifecycleState>) =>
  ({
    mode: "analysis",
    policy: policy(1),
    budget: { remainingUsd: 1, enforcement: "between_turns" },
    submitted: undefined,
    ...over,
  }) as LifecycleState;

test("a cost stop pauses for the developer; a used-up tool budget without a result fails", () => {
  const paused = budgetStop(state({}), {
    isError: true,
    text: "spent",
    assistantTurns: 0,
    failure: "BUDGET_EXHAUSTED",
  });
  assert.equal(paused?.kind, "waiting_input");

  const exhausted = state({});
  exhausted.policy.toolBudget!.exhausted = true;
  const failed = budgetStop(exhausted, { isError: false, text: "", assistantTurns: 1 });
  assert.equal(failed?.kind, "failed");
  assert.equal(
    (failed as { details?: { failure_code?: string } }).details?.failure_code,
    "TOOL_BUDGET_EXHAUSTED",
  );

  const finished = state({ submitted: { summary: "done" } });
  finished.policy.toolBudget!.exhausted = true;
  assert.equal(budgetStop(finished, { isError: false, text: "", assistantTurns: 1 }), null);
});
