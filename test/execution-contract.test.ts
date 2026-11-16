import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutionContract, executionContractProblems } from "../src/agent/contract.ts";

const plan = { summary: "Approved change", changes: [{ files: Array.from({ length: 40 }, (_, i) => `src/${i}.ts`), description: "x".repeat(4000) }], tests: ["runtime regression"] };
const upstream = {
  analyze: { status: "COMPLETED", attempt_id: 1, output: { acceptance_criteria: ["Preserve behavior"], constraints: ["No remote services"] } },
  plan: { status: "COMPLETED", attempt_id: 2, output: plan },
  approve_plan: { status: "COMPLETED", attempt_id: 3, output: { approved: true, by: "reviewer" } },
};
test("execution contract preserves the actual plan and approval identity separately", () => {
  const contract = buildExecutionContract(upstream, ["platform"]);
  assert.deepEqual(contract.approved_plan, plan);
  assert.deepEqual(contract.required_tests, ["runtime regression"]);
  assert.deepEqual(contract.business_constraints, ["No remote services"]);
  assert.deepEqual(contract.acceptance_criteria, ["Preserve behavior"]);
  assert.equal(contract.provenance?.plan_attempt_id, 2);
  assert.equal(contract.provenance?.approval_attempt_id, 3);
  assert.deepEqual(executionContractProblems(contract, ["platform"]), []);
  const revised = buildExecutionContract({ ...upstream, plan: { ...upstream.plan, attempt_id: 4 } }, ["platform"]);
  assert.notEqual(revised.provenance?.revision, contract.provenance?.revision);
});
test("execution contract refuses metadata-only, missing approval and unauthorized scope", () => {
  assert.ok(executionContractProblems(buildExecutionContract({ approve_plan: upstream.approve_plan }, ["platform"]), ["platform"]).length);
  assert.ok(executionContractProblems(buildExecutionContract({ plan: upstream.plan }, ["platform"]), ["platform"]).length);
  assert.ok(executionContractProblems(buildExecutionContract(upstream, ["other"]), ["platform"]).length);
});

test("execution contract revision is stable across JSON property ordering", () => {
  const reordered = { ...upstream, plan: { ...upstream.plan, output: { tests: plan.tests, changes: plan.changes, summary: plan.summary } } };
  assert.equal(buildExecutionContract(reordered, ["platform"]).provenance?.revision, buildExecutionContract(upstream, ["platform"]).provenance?.revision);
});

test("execution contracts retain architecture, subtask verification and payload constraints", () => {
  const contract = buildExecutionContract({ ...upstream,
    architecture: { status: "COMPLETED", attempt_id: 4, output: { decisions: ["Keep the existing transaction"] } },
    plan: { ...upstream.plan, output: { summary: "plan", subtasks: [{ acceptance_criteria: ["Atomic changes"], verification: ["app/TestAtomic"] }] } },
  }, ["platform"], { payload: { constraints: ["Never deploy"], acceptance_criteria: ["Preserve audit history"] } });
  assert.ok(JSON.stringify(contract.approved_plan).includes("Keep the existing transaction"));
  assert.ok(contract.required_tests.includes("app/TestAtomic"));
  assert.ok(contract.acceptance_criteria.includes("Atomic changes"));
  assert.ok(contract.acceptance_criteria.includes("Preserve audit history"));
  assert.ok(contract.business_constraints.includes("Never deploy"));
});
