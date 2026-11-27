import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeReportReasoner, workflowReportReasoner } from "../src/report/executor.ts";
import {
  claudeTestFailureAdvisor,
  providerTestFailureAdvisor,
} from "../src/workflow/executors/testFailure.ts";

test("the provider-neutral helpers exist and the old Claude names stay as deprecated aliases", () => {
  assert.equal(typeof workflowReportReasoner, "function");
  assert.equal(claudeReportReasoner, workflowReportReasoner);
  assert.equal(typeof providerTestFailureAdvisor.explain, "function");
  assert.equal(claudeTestFailureAdvisor, providerTestFailureAdvisor);
});
