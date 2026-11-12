import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  planHash,
  shouldDecompose,
  validateExpansion,
  type DecompositionPlan,
} from "../src/workflow/decomposition.ts";

const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  description: "d",
  objective: "o",
  expected_output: "e",
  acceptance_criteria: ["ac"],
  target_repos: ["repo-a"],
  code_context: [],
  depends_on: [],
  permissions: [],
  risk: "low" as const,
  complexity: "low" as const,
  execution_strategy: "parallel" as const,
  agent_role: "coder",
  testing: [],
  owned_files: [],
  ...over,
});
const plan = (...s: ReturnType<typeof sub>[]): DecompositionPlan => ({ summary: "s", subtasks: s });
const ctx = { existingKeys: ["plan"], allowedRepositories: ["repo-a"], limits: DEFAULT_LIMITS };

test("small task is not decomposed; large one is", () => {
  assert.equal(shouldDecompose({ repositories: 1, acceptance_criteria: 2, estimated_effort_hours: 1 }).decompose, false);
  assert.equal(shouldDecompose({ repositories: 2, acceptance_criteria: 5, estimated_effort_hours: 2 }).decompose, true);
});

test("valid independent plan passes", () => {
  assert.deepEqual(validateExpansion(plan(sub("a"), sub("b")), ctx).errors, []);
});

test("rejects cycles, unknown deps, duplicates, foreign repos, over limit", () => {
  const e = (p: DecompositionPlan, c = ctx) => validateExpansion(p, c).errors.join("|");
  assert.match(e(plan(sub("a", { depends_on: ["b"] }), sub("b", { depends_on: ["a"] }))), /cycle/);
  assert.match(e(plan(sub("a", { depends_on: ["zzz"] }))), /unknown/);
  assert.match(e(plan(sub("a"), sub("a"))), /duplicate/);
  assert.match(e(plan(sub("a", { target_repos: ["other"] }))), /outside the allowed/);
  assert.match(e(plan(sub("a"), sub("b")), { ...ctx, limits: { ...DEFAULT_LIMITS, max_subtasks: 1 } }), /limit/);
});

test("overlapping file ownership is serialized", () => {
  const r = validateExpansion(plan(sub("a", { owned_files: ["x.ts"] }), sub("b", { owned_files: ["x.ts"] })), ctx);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.subtasks[1].depends_on, ["a"]);
  assert.equal(r.subtasks[1].execution_strategy, "sequential");
});

test("planHash is order independent", () => {
  assert.equal(planHash(plan(sub("a"), sub("b"))), planHash(plan(sub("b"), sub("a"))));
  assert.notEqual(planHash(plan(sub("a"))), planHash(plan(sub("b"))));
});
