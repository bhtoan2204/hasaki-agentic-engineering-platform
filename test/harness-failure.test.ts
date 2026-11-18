import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_POLICY,
  HARNESS_FAILURE_CODES,
  blocksRebuild,
  failurePolicy,
  isTerminalFailure,
  toFailureCode,
} from "../src/agent/harness/failure.ts";
import { classifyFailure } from "../src/workflow/failures.ts";
import { normalizeProviderFailure } from "../src/agent/telemetry.ts";
import { classifyCopilotError } from "../src/agent/copilot/stream.ts";
import { classifyAntigravityError } from "../src/agent/antigravity/stream.ts";

test("failure table covers every harness failure code", () => {
  assert.deepEqual(Object.keys(FAILURE_POLICY).sort(), [...HARNESS_FAILURE_CODES].sort());
});

test("a timeout gets the same retry decision whichever provider reported it", () => {
  for (const label of ["timeout", "EXECUTION_TIMEOUT"]) {
    assert.equal(toFailureCode(label), "EXECUTION_TIMEOUT");
    assert.equal(isTerminalFailure(label), false);
    assert.equal(blocksRebuild(label), true);
    assert.equal(failurePolicy(label)?.providerErrorCode, "timeout");
  }
});

test("legacy codex labels map onto the shared taxonomy and keep handoff codes", () => {
  assert.equal(failurePolicy("quota")?.providerErrorCode, "quota_exhausted");
  assert.equal(failurePolicy("auth")?.providerErrorCode, "authentication");
  assert.equal(failurePolicy("model")?.providerErrorCode, "agent_error");
  assert.equal(failurePolicy("policy")?.providerErrorCode, "agent_error");
  for (const terminal of ["quota", "auth", "model", "policy", "canceled", "CONTEXT_LIMIT"])
    assert.equal(isTerminalFailure(terminal), true, terminal);
  for (const retryable of ["error", "incomplete", "rate_limit", undefined, "something-new"])
    assert.equal(isTerminalFailure(retryable), false, String(retryable));
});

test("handoff normalization reads structured codes before message text", () => {
  for (const code of ["PROVIDER_UNAVAILABLE", "provider_unavailable", "RATE_LIMIT"])
    assert.equal(normalizeProviderFailure({ code, message: "Turn failed" }), code.toUpperCase());
  assert.equal(
    normalizeProviderFailure({ code: "unknown", message: "429 Too Many Requests" }),
    "RATE_LIMIT",
  );
});

test("engine recovery uses the structured failure class over error text", () => {
  const base = { attempt: 1, maxAttempts: 3, baseBackoff: 5 };
  assert.equal(classifyFailure("tests failed", { ...base, failureClass: "auth" }).action, "stop");
  assert.equal(classifyFailure("tests failed", base).class, "code");
  assert.equal(
    classifyFailure("anything", { ...base, failureClass: "transient", executorRetryable: true })
      .action,
    "retry",
  );
});

test("copilot and antigravity share one CLI error classifier", () => {
  assert.equal(classifyCopilotError, classifyAntigravityError);
  assert.equal(classifyCopilotError("Monthly quota exhausted"), "QUOTA_EXHAUSTED");
});
