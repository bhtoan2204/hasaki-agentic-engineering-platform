import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseFailure,
  failureSignature,
  jittered,
  retryAfterSeconds,
} from "../src/workflow/failures.ts";
import { processesInside } from "../src/workflow/recovery.ts";

test("explicit machine codes decide the category before any text rule", () => {
  const d = (failureCode: string, error = "network timed out") =>
    diagnoseFailure({ error, failureCode });
  assert.deepEqual(
    [d("RATE_LIMIT").category, d("RATE_LIMIT").strategy, d("RATE_LIMIT").source],
    ["rate_limit", "RETRY_BACKOFF", "code"],
  );
  assert.deepEqual(
    [d("QUOTA_EXHAUSTED").category, d("QUOTA_EXHAUSTED").strategy],
    ["quota", "HANDOFF"],
  );
  assert.deepEqual([d("AUTHENTICATION").category, d("AUTHENTICATION").strategy], ["auth", "STOP"]);
  assert.deepEqual(
    [d("CONTEXT_LIMIT").category, d("CONTEXT_LIMIT").strategy],
    ["session_expired", "RESUME"],
  );
  assert.deepEqual(
    [d("CONTRACT_INVALID").category, d("CONTRACT_INVALID").strategy],
    ["contract_invalid", "RESUME"],
  );
  assert.deepEqual(
    [d("POLICY_VIOLATION").category, d("POLICY_VIOLATION").strategy],
    ["scope_security", "STOP"],
  );
  assert.deepEqual(
    [d("UNSAFE_SIDE_EFFECT").category, d("UNSAFE_SIDE_EFFECT").strategy],
    ["unknown_side_effect", "WAIT"],
  );
  assert.deepEqual(
    [d("BUDGET_EXHAUSTED").category, d("BUDGET_EXHAUSTED").strategy],
    ["budget_exhausted", "STOP"],
  );
});

test("text fallback separates environment, infrastructure and code failures; unknown is never transient", () => {
  const t = (error: string) => diagnoseFailure({ error });
  assert.equal(t("fetch failed: ECONNRESET").category, "transient_network");
  assert.equal(t("verification could not complete (not a code failure)").category, "infra_test");
  assert.equal(
    t("missing test prerequisite: test PostgreSQL is not available").category,
    "dependency_env",
  );
  assert.equal(t("sh: go: command not found").category, "dependency_env");
  assert.equal(t("3 tests failed in ./internal/refund").strategy, "REPAIR");
  assert.equal(
    t("error: Your local changes would be overwritten; merge conflict").category,
    "workspace_conflict",
  );
  assert.equal(t("401 Unauthorized").strategy, "STOP");
  const unknown = t("the agent said something odd");
  assert.deepEqual(
    [unknown.category, unknown.strategy, unknown.source],
    ["unknown", "WAIT", "none"],
  );
});

test("Retry-After comes from structured details first, then the message; it is bounded", () => {
  assert.equal(retryAfterSeconds({ provider_error: { retry_after_s: 42 } }, ""), 42);
  assert.equal(retryAfterSeconds(null, "429 Too Many Requests, retry after 120 seconds"), 120);
  assert.equal(retryAfterSeconds(null, "Retry-After: 30"), 30);
  assert.equal(retryAfterSeconds(null, "rate limited"), null);
  assert.equal(retryAfterSeconds({ retry_after_s: 999999 }, ""), 3600);
  assert.equal(
    diagnoseFailure({ error: "429 retry after 90", failureCode: "RATE_LIMIT" }).retry_after_s,
    90,
  );
});

test("a failure signature ignores volatile details, so a repeat is recognised", () => {
  const a = failureSignature(
    "code_test",
    "FAIL TestRefund (0.31s) at /tmp/w1/refund_test.go:42 commit 3f9a1c2d",
  );
  const b = failureSignature(
    "code_test",
    "FAIL TestRefund (0.57s) at /tmp/w2/refund_test.go:48 commit 77ab01ef",
  );
  assert.equal(a, b);
  assert.notEqual(a, failureSignature("code_test", "FAIL TestCapture (0.31s)"));
  assert.notEqual(a, failureSignature("infra_test", "FAIL TestRefund (0.31s)"));
});

test("jitter only lengthens the delay, by at most 20%", () => {
  assert.equal(
    jittered(100, () => 0),
    100,
  );
  assert.equal(
    jittered(100, () => 1),
    120,
  );
  assert.equal(
    jittered(100, () => 5),
    120,
  );
  for (let i = 0; i < 50; i++) {
    const v = jittered(60);
    assert.ok(v >= 60 && v <= 72);
  }
});

test("process inspection finds a process working inside a directory and nothing elsewhere", async () => {
  if (process.platform !== "linux") return;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  assert.deepEqual(await processesInside([dir]), []);
  const child = spawn("sleep", ["5"], { cwd: dir });
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await processesInside([dir]), [child.pid]);
  } finally {
    child.kill("SIGKILL");
  }
  assert.deepEqual(await processesInside([]), []);
});
