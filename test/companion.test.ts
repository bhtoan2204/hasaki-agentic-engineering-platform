import { test } from "node:test";
import assert from "node:assert/strict";
import { companionActivity, prioritizeCompanionRuns } from "../web/src/office/companionState.ts";
import type { OfficeSnapshot, StepLite } from "../web/src/office/types.ts";

const run = (status = "RUNNING"): OfficeSnapshot["run"] => ({ id: 42, title: "Payment fix", status });
const step = (status = "RUNNING", type = "coding_agent"): StepLite => ({ key: "implement", name: "Implement payment fix", type, status });
const agent: any = { role: "developer", pose: "work", activity: "typing", retrying: false };
const state = (over: { run?: OfficeSnapshot["run"]; step?: StepLite | null; agent?: any; attempt?: any; pending?: boolean } = {}) => companionActivity(over.run === undefined ? run() : over.run, over.step === undefined ? step() : over.step, over.agent === undefined ? agent : over.agent, over.attempt ?? null, Date.parse("2026-11-09T10:00:00Z"), over.pending ?? false);

test("companion: provider and model come from the selected attempt and completed history is preserved", () => {
  for (const provider of ["claude", "codex", "cursor"]) {
    const activity = state({ attempt: { provider, model: `${provider}-model`, status: "RUNNING" } });
    assert.equal(activity.state, "CODING");
    assert.equal(activity.provider, provider);
    assert.equal(activity.model, `${provider}-model`);
    assert.equal(activity.run?.id, 42);
  }
});

test("companion: approval, question, handoff, failure, retry, and success use recorded signals", () => {
  assert.equal(state({ step: step("WAITING_APPROVAL") }).state, "APPROVAL_REQUIRED");
  assert.equal(state({ step: step("WAITING_INPUT") }).state, "ASKING");
  assert.equal(state({ pending: true, step: step("READY") }).action, "question");
  assert.equal(state({ step: { ...step("WAITING_INPUT"), handoff: true } as any }).state, "HANDOFF");
  assert.equal(state({ step: step("FAILED") }).state, "FAILED");
  assert.equal(state({ step: step("FAILED"), attempt: { normalized_failure_category: "QUOTA_EXHAUSTED" } }).action, "handoff");
  assert.equal(state({ step: step("FAILED"), attempt: { normalized_failure_category: "EXECUTION_TIMEOUT" } }).action, "failure", "a timeout does not imply exhausted quota");
  assert.equal(state({ step: step("RETRYING") }).state, "RETRYING");
  assert.equal(state({ run: run("COMPLETED"), step: step("COMPLETED"), attempt: { finished_at: "2026-11-09T09:59:55Z" } }).state, "CELEBRATING");
});

test("companion: READY and missing execution evidence never claim coding progress", () => {
  assert.equal(state({ step: step("READY") }).state, "SLEEPING");
  assert.equal(state({ run: run("RUNNING"), step: null }).state, "SLEEPING");
  assert.equal(state({ run: null, step: null }).state, "SLEEPING");
});

test("companion: human gates and active work outrank recent run history", () => {
  const chosen = prioritizeCompanionRuns([
    { id: 99, status: "COMPLETED", updated_at: "2026-11-09T10:00:00Z", steps: [] },
    { id: 42, status: "RUNNING", updated_at: "2026-11-09T09:00:00Z", steps: [{ status: "WAITING_APPROVAL" }] },
  ]);
  assert.equal(chosen.id, 42);
  const latestTerminal = prioritizeCompanionRuns([
    { id: 11, status: "FAILED", updated_at: "2026-11-08T09:00:00Z", steps: [{ status: "FAILED" }] },
    { id: 12, status: "COMPLETED", updated_at: "2026-11-09T09:00:00Z", steps: [{ status: "COMPLETED" }] },
  ]);
  assert.equal(latestTerminal.id, 12, "newer completed run supersedes stale failure attention");
  assert.equal(prioritizeCompanionRuns([]), null);
});
