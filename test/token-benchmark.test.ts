import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTokenEfficiency,
  attemptTokens,
  sumTokens,
  type AttemptTelemetryRow,
} from "../src/report/tokenBenchmark.ts";

let nextAttempt = 1;
const row = (o: Partial<AttemptTelemetryRow>): AttemptTelemetryRow => ({
  run_id: 1,
  run_status: "COMPLETED",
  work_item_id: null,
  attempt_id: nextAttempt++,
  number: 1,
  provider: "claude",
  model: "sonnet",
  execution_profile: "STANDARD",
  status: "COMPLETED",
  terminal_status: "COMPLETED",
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 300,
  cache_creation_tokens: 50,
  ...o,
});

const slice = (rows: AttemptTelemetryRow[], provider = "claude") => {
  const s = aggregateTokenEfficiency(rows).find((x) => x.provider === provider);
  assert.ok(s, `no ${provider} slice`);
  return s;
};

test("token totals are null when any part is missing, and 0 only when reported as 0", () => {
  assert.equal(attemptTokens(row({})).total, 470);
  assert.equal(attemptTokens(row({ output_tokens: null })).total, null);
  assert.equal(attemptTokens(row({ cache_creation_tokens: null })).total, null);
  const zero = row({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  });
  assert.equal(attemptTokens(zero).total, 0);
  assert.deepEqual(sumTokens([]), {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    total: 0,
  });
  const partial = sumTokens([attemptTokens(row({})), attemptTokens(row({ input_tokens: null }))]);
  assert.equal(partial.input, null);
  assert.equal(partial.output, 40);
  assert.equal(partial.total, null);
});

test("non-terminal runs are excluded from success and failure metrics", () => {
  const s = slice([
    row({ run_id: 1, run_status: "COMPLETED" }),
    row({ run_id: 2, run_status: "FAILED", status: "FAILED", terminal_status: "FAILED" }),
    row({ run_id: 3, run_status: "RUNNING", status: "RUNNING", terminal_status: null }),
    row({ run_id: 4, run_status: "WAITING", status: "WAITING_INPUT", terminal_status: null }),
    row({ run_id: 5, run_status: "CANCELED", status: "CANCELED", terminal_status: "CANCELED" }),
  ]);
  assert.equal(s.runs.successful, 1);
  assert.equal(s.runs.failed, 1);
  assert.equal(s.runs.canceled, 1);
  assert.equal(s.runs.success_rate, 0.5);
  assert.equal(s.attempts.count, 5);
});

test("a mixed-provider run is credited once, to the provider that finished it, with all its tokens", () => {
  const rows = [
    row({ run_id: 9, provider: "claude", number: 1, status: "FAILED", terminal_status: "FAILED" }),
    row({ run_id: 9, provider: "codex", number: 2 }),
  ];
  const claude = slice(rows, "claude");
  const codex = slice(rows, "codex");
  assert.equal(claude.runs.successful + claude.runs.failed, 0);
  assert.equal(claude.attempts.failed.count, 1);
  assert.equal(claude.attempts.failed.tokens.total, 470);
  assert.equal(codex.runs.successful, 1);
  assert.equal(codex.runs.first_pass_successes, 0);
  assert.equal(codex.runs.mean_tokens_per_success.total, 940);
  assert.equal(codex.attempts.retries.count, 1);
});

test("first pass requires a single attempt per step and no failed attempt in the whole run", () => {
  const s = slice([
    row({ run_id: 1 }),
    row({ run_id: 1, attempt_id: 1000 }),
    row({ run_id: 2, number: 2 }),
    row({ run_id: 3, provider: "codex", status: "FAILED", terminal_status: "FAILED" }),
    row({ run_id: 3 }),
  ]);
  assert.equal(s.runs.successful, 3);
  assert.equal(s.runs.first_pass_successes, 1);
  assert.equal(s.runs.first_pass_success_rate, 0.3333);
});

test("missing usage stays null instead of becoming zero", () => {
  const missing = { input_tokens: null, output_tokens: null, cache_read_tokens: null };
  const s = slice([
    row({ run_id: 1, ...missing, cache_creation_tokens: null }),
    row({
      run_id: 2,
      status: "FAILED",
      terminal_status: "FAILED",
      run_status: "FAILED",
      ...missing,
    }),
  ]);
  assert.equal(s.attempts.usage_availability, "partial");
  assert.equal(s.attempts.with_usage, 1);
  assert.equal(s.attempts.tokens.total, null);
  assert.equal(s.attempts.failed.tokens.input, null);
  assert.equal(s.attempts.failed.ratio, null);
  assert.equal(s.runs.successes_with_usage, 0);
  assert.equal(s.runs.mean_tokens_per_success.input, null);
  assert.equal(s.runs.median_tokens_per_success.total, null);

  const none = slice([row({ ...missing, cache_creation_tokens: null })]);
  assert.equal(none.attempts.usage_availability, "unavailable");
});

test("reported zero usage and absent retries or failures are real zeros", () => {
  const s = slice([
    row({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }),
    row({ run_id: 2 }),
  ]);
  assert.equal(s.attempts.usage_availability, "complete");
  assert.equal(s.attempts.zero_usage, 1);
  assert.equal(s.attempts.retries.tokens.total, 0);
  assert.equal(s.attempts.retries.ratio, 0);
  assert.equal(s.attempts.failed.tokens.total, 0);
  assert.equal(s.runs.mean_tokens_per_success.total, 235);
  assert.equal(s.runs.median_tokens_per_success.total, 0);
});

test("attempt, run and work-item levels are counted separately", () => {
  const s = slice([
    // Work item 1: first run fails after a retry, a second run completes.
    row({
      run_id: 1,
      work_item_id: 1,
      run_status: "FAILED",
      status: "FAILED",
      terminal_status: "FAILED",
    }),
    row({
      run_id: 1,
      work_item_id: 1,
      run_status: "FAILED",
      number: 2,
      status: "FAILED",
      terminal_status: "FAILED",
    }),
    row({ run_id: 2, work_item_id: 1 }),
    // Work item 2: one clean run.
    row({ run_id: 3, work_item_id: 2 }),
    // Work item 3: its latest run is still running, so it has no outcome yet.
    row({
      run_id: 4,
      work_item_id: 3,
      run_status: "FAILED",
      status: "FAILED",
      terminal_status: "FAILED",
    }),
    row({
      run_id: 5,
      work_item_id: 3,
      run_status: "RUNNING",
      status: "RUNNING",
      terminal_status: null,
    }),
  ]);
  assert.equal(s.attempts.count, 6);
  assert.equal(s.attempts.failed.count, 3);
  assert.equal(s.attempts.retries.count, 1);

  assert.equal(s.runs.successful, 2);
  assert.equal(s.runs.failed, 2);
  assert.equal(s.runs.first_pass_successes, 2);
  assert.equal(s.runs.mean_tokens_per_success.total, 470);

  assert.equal(s.work_items.successful, 2);
  assert.equal(s.work_items.failed, 0);
  assert.equal(s.work_items.first_pass_successes, 1);
  assert.equal(s.work_items.success_rate, 1);
  assert.equal(s.work_items.median_tokens_per_success.total, 470);
  assert.equal(s.work_items.mean_tokens_per_success.total, (470 * 3 + 470) / 2);
});

test("slices are keyed by provider, model and execution profile and sorted", () => {
  const out = aggregateTokenEfficiency([
    row({ run_id: 1, provider: "codex", model: "gpt", execution_profile: "FAST" }),
    row({ run_id: 2, model: "opus" }),
    row({ run_id: 3, model: "opus", execution_profile: "DEEP" }),
    row({ run_id: 4, model: "a|b" }),
  ]);
  assert.deepEqual(
    out.map((s) => [s.provider, s.model, s.execution_profile]),
    [
      ["claude", "a|b", "STANDARD"],
      ["claude", "opus", "DEEP"],
      ["claude", "opus", "STANDARD"],
      ["codex", "gpt", "FAST"],
    ],
  );
});
