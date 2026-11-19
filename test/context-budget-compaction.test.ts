import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetContextPack,
  compactContractEntry,
  ContextBudgetError,
  type ContextEntry,
} from "../src/context/pack.ts";

const big = (n: number, word: string) =>
  Array.from({ length: n }, (_, i) => `${word} ${i}`).join(". ");
const contract = {
  approved_plan: {
    plan: {
      summary: "Retry SPX delivery with backoff",
      subtasks: [{ title: "add retry", acceptance_criteria: ["retries 3 times"] }],
    },
    understand: { objectives: big(3000, "objective") },
    architecture: { modules: big(5000, "module") },
  },
  acceptance_criteria: ["retries 3 times", "no duplicate delivery"],
  business_constraints: ["never retry a 4xx"],
  required_tests: ["oms/pkg/kafka/TestWaitForDelivery"],
  selected_repositories: ["oms-background"],
};
const entry = (body: unknown): ContextEntry => ({
  id: "mandatory_execution_contract",
  section: "requirements",
  trust: "platform_constraint",
  required: true,
  priority: 1000,
  body: JSON.stringify(body),
  provenance: { ref: "run:143:execution_contract" } as unknown as ContextEntry["provenance"],
});
const base = {
  version: 1 as const,
  run_id: 143,
  step_id: 1,
  attempt_id: 1,
  owner_id: 1,
  snapshot_id: 1,
  created_at: "2026-11-19T00:00:00Z",
  budget_tokens: 20000,
  token_measurement: "character_estimate_not_provider_usage" as const,
  parent_pack_ids: [],
  retrieval_calls: 0,
  retrieval_failures: 0,
  preparation_ms: 0,
};

test("a contract whose supporting outputs exceed the budget is refused as is, and fits once they are summarized", () => {
  assert.throws(() => budgetContextPack(base, [entry(contract)]), ContextBudgetError);
  const { entry: compact, compacted } = compactContractEntry(entry(contract));
  assert.deepEqual(compacted, ["approved_plan.understand", "approved_plan.architecture"]);
  const pack = budgetContextPack(base, [compact]);
  assert.ok(pack.estimated_tokens <= base.budget_tokens);
});

test("compaction never touches the binding parts: plan, acceptance criteria, constraints, tests, repositories", () => {
  const { entry: compact } = compactContractEntry(entry(contract));
  const body = JSON.parse(compact.body);
  assert.deepEqual(body.approved_plan.plan, contract.approved_plan.plan);
  for (const k of [
    "acceptance_criteria",
    "business_constraints",
    "required_tests",
    "selected_repositories",
  ] as const)
    assert.deepEqual(body[k], contract[k]);
  assert.equal(
    body.approved_plan.architecture.full_text,
    'platform.get_step_output("architecture")',
  );
  assert.ok(body.approved_plan.architecture.summary.length <= 1600);
  assert.equal(compact.truncated, true);
});

test("a contract without supporting outputs (or not JSON) is left alone: the refusal stays explicit", () => {
  const planOnly = entry({ approved_plan: { summary: "x" }, acceptance_criteria: [] });
  assert.deepEqual(compactContractEntry(planOnly).compacted, []);
  assert.deepEqual(compactContractEntry({ ...planOnly, body: "not json" }).compacted, []);
});
