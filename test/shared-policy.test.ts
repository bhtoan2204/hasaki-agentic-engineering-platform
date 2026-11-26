import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMinutes,
  canStart,
  isServable,
  retryState,
  staleReason,
  validUntil,
} from "../src/sharing/policy.ts";

const NOW = new Date("2026-06-01T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const TTL = { runtimeRcaHours: 24, bugHuntDays: 30, codeAssessmentDays: 30 };

test("servable: only a valid row that has not reached its end", () => {
  assert.equal(isServable({ status: "valid", valid_until: at(1) }, NOW), true);
  assert.equal(isServable({ status: "valid", valid_until: null }, NOW), true, "no end recorded");
  assert.equal(
    isServable({ status: "valid", valid_until: NOW }, NOW),
    false,
    "the end instant is already past",
  );
  assert.equal(isServable({ status: "valid", valid_until: at(-1) }, NOW), false);
  for (const status of ["stale", "failed", "running", "superseded"] as const)
    assert.equal(isServable({ status, valid_until: at(60) }, NOW), false, status);
});

test("TTL per kind, from configuration: RCA hours, bug hunt and assessment days", () => {
  assert.equal(
    validUntil("prod_error.runtime_rca", NOW, TTL).getTime(),
    NOW.getTime() + 24 * 3_600_000,
  );
  assert.equal(
    validUntil("prod_error.bug_hunt", NOW, TTL).getTime(),
    NOW.getTime() + 30 * 86_400_000,
  );
  assert.equal(
    validUntil("code_assessment", NOW, { ...TTL, codeAssessmentDays: 7 }).getTime(),
    NOW.getTime() + 7 * 86_400_000,
  );
  assert.equal(
    validUntil("prod_error.runtime_rca", NOW, { ...TTL, runtimeRcaHours: 6 }).getTime(),
    NOW.getTime() + 6 * 3_600_000,
  );
});

test("backoff grows as 2^failures minutes and stops at the cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMinutes(n, 60)),
    [2, 4, 8, 16, 32, 60, 60, 60],
  );
  assert.equal(backoffMinutes(0, 60), 2, "never less than one failure");
  assert.equal(backoffMinutes(99, 30), 30);
});

test("retry: a key is held back only while its latest version is failed, in backoff, or out of attempts", () => {
  const failed = (attempts: number, next: Date | null) => ({
    status: "failed" as const,
    attempts,
    next_retry_at: next,
  });
  assert.deepEqual(retryState(null, NOW), { state: "none" });
  assert.deepEqual(
    retryState({ status: "valid", attempts: 5, next_retry_at: at(10) }, NOW),
    { state: "none" },
    "only a failed latest version holds a key",
  );
  assert.deepEqual(retryState({ status: "stale", attempts: 0, next_retry_at: null }, NOW), {
    state: "none",
  });
  assert.deepEqual(retryState(failed(1, at(2)), NOW, 3), { state: "backoff", retryAt: at(2) });
  assert.deepEqual(
    retryState(failed(1, at(-1)), NOW, 3),
    { state: "none" },
    "the backoff has passed",
  );
  assert.deepEqual(
    retryState(failed(2, null), NOW, 3),
    { state: "none" },
    "a failure that did not count has no backoff",
  );
  assert.deepEqual(
    retryState(failed(3, at(-5)), NOW, 3),
    { state: "exhausted", failures: 3 },
    "out of attempts even after the backoff",
  );
  assert.equal(canStart(failed(1, at(2)), NOW), false);
  assert.equal(canStart(failed(1, at(-2)), NOW), true);
});

test("stale reason names what changed between two keys of one subject", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const base = {
    repos: [`oms-api@${A}`, `payment@${B}`],
    workflow: "codebase-assessment@12",
    rubric: "r1",
    model: "m1",
  };
  assert.equal(staleReason(base, { ...base }), "", "nothing differs");
  assert.equal(
    staleReason(base, { ...base, repos: [`oms-api@${C}`, `payment@${B}`] }),
    "commit_changed:oms-api",
  );
  assert.equal(
    staleReason(base, { ...base, repos: [`oms-api@${C}`, `payment@${C}`] }),
    "commit_changed:oms-api,payment",
  );
  assert.equal(
    staleReason(base, { ...base, workflow: "codebase-assessment@13" }),
    "definition_changed",
  );
  assert.equal(staleReason(base, { ...base, rubric: "r2" }), "rubric_changed");
  assert.equal(staleReason(base, { ...base, model: "m2" }), "model_changed");
  assert.equal(
    staleReason({ ...base, contract: "v1" }, { ...base, contract: "v2" }),
    "contract_changed",
  );
  assert.equal(
    staleReason(base, { ...base, rubric: "r2", model: "m2", workflow: "codebase-assessment@13" }),
    "definition_changed;rubric_changed;model_changed",
  );
});
