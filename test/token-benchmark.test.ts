import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTokenEfficiency,
  combineCacheTokens,
  combineTotalTokens,
  round,
  type AttemptTelemetryRow,
} from "../src/report/tokenBenchmark.ts";

const row = (o: Partial<AttemptTelemetryRow>): AttemptTelemetryRow => ({
  run_id: 1,
  run_profile: "STANDARD",
  run_status: "COMPLETED",
  execution_profile: "STANDARD",
  provider: "claude",
  model: "claude-3-5-sonnet",
  step_id: 1,
  attempt_id: 1,
  number: 1,
  retries: 0,
  status: "COMPLETED",
  terminal_status: "COMPLETED",
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 300,
  cache_creation_tokens: 100,
  ...o,
});

test("combineCacheTokens and combineTotalTokens distinguish missing (null) from zero (0)", () => {
  // Both null -> null
  assert.equal(combineCacheTokens(null, null), null);
  assert.equal(combineCacheTokens(undefined, undefined), null);

  // One present -> sum
  assert.equal(combineCacheTokens(100, null), 100);
  assert.equal(combineCacheTokens(null, 50), 50);

  // Both zero -> 0 (NOT null)
  assert.equal(combineCacheTokens(0, 0), 0);

  // Total tokens
  assert.equal(combineTotalTokens(null, null, null), null);
  assert.equal(combineTotalTokens(0, 0, 0), 0);
  assert.equal(combineTotalTokens(100, 20, 30), 150);
  assert.equal(combineTotalTokens(100, null, 30), 130);
});

test("first-pass success: single attempt that completed without retries", () => {
  const rows: AttemptTelemetryRow[] = [
    row({
      run_id: 101,
      number: 1,
      retries: 0,
      status: "COMPLETED",
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 300,
      cache_creation_tokens: 100,
    }),
  ];

  const results = aggregateTokenEfficiency(rows);
  assert.equal(results.length, 1);
  const r = results[0];

  assert.equal(r.provider, "claude");
  assert.equal(r.model, "claude-3-5-sonnet");
  assert.equal(r.execution_profile, "STANDARD");

  assert.equal(r.total_tasks, 1);
  assert.equal(r.successful_tasks, 1);
  assert.equal(r.failed_tasks, 0);
  assert.equal(r.first_pass_successes, 1);
  assert.equal(r.first_pass_success_rate, 1);
  assert.equal(r.success_rate, 1);

  // Tokens per successful task
  assert.equal(r.total_input_tokens_per_successful_task, 1000);
  assert.equal(r.total_output_tokens_per_successful_task, 200);
  assert.equal(r.total_cache_tokens_per_successful_task, 400); // 300 + 100
  assert.equal(r.total_tokens_per_successful_task, 1600); // 1000 + 200 + 400

  // Retry overhead: 0 retries
  assert.equal(r.retry_attempts, 0);
  assert.equal(r.retry_overhead_tokens, 0);
  assert.equal(r.retry_overhead_ratio, 0);

  // Wasted tokens from failed attempts: 0 failed attempts
  assert.equal(r.failed_attempts, 0);
  assert.equal(r.wasted_tokens, 0);
  assert.equal(r.wasted_input_tokens, 0);
  assert.equal(r.wasted_output_tokens, 0);
  assert.equal(r.wasted_cache_tokens, 0);

  assert.equal(r.usage_availability, "complete");
});

test("retry overhead and wasted tokens: task with failed attempt 1 and successful retry attempt 2", () => {
  const rows: AttemptTelemetryRow[] = [
    // Attempt 1: Failed
    row({
      run_id: 201,
      number: 1,
      retries: 0,
      status: "FAILED",
      terminal_status: "FAILED",
      input_tokens: 800,
      output_tokens: 50,
      cache_read_tokens: 100,
      cache_creation_tokens: 50, // cache = 150, total = 1000
    }),
    // Attempt 2: Succeeded retry
    row({
      run_id: 201,
      number: 2,
      retries: 1,
      status: "COMPLETED",
      terminal_status: "COMPLETED",
      input_tokens: 1200,
      output_tokens: 250,
      cache_read_tokens: 400,
      cache_creation_tokens: 150, // cache = 550, total = 2000
    }),
  ];

  const results = aggregateTokenEfficiency(rows);
  assert.equal(results.length, 1);
  const r = results[0];

  assert.equal(r.total_tasks, 1);
  assert.equal(r.successful_tasks, 1);
  assert.equal(r.first_pass_successes, 0, "Had retries and a failed attempt, so not first pass");
  assert.equal(r.first_pass_success_rate, 0);
  assert.equal(r.success_rate, 1);

  // Tokens per successful task: total across both attempts for run 201
  // Input: 800 + 1200 = 2000
  // Output: 50 + 250 = 300
  // Cache: 150 + 550 = 700
  // Total: 1000 + 2000 = 3000
  assert.equal(r.total_input_tokens_per_successful_task, 2000);
  assert.equal(r.total_output_tokens_per_successful_task, 300);
  assert.equal(r.total_cache_tokens_per_successful_task, 700);
  assert.equal(r.total_tokens_per_successful_task, 3000);

  // Retry overhead: attempt 2 was a retry (number=2, retries=1)
  assert.equal(r.retry_attempts, 1);
  assert.equal(r.retry_overhead.retried_tasks, 1);
  assert.equal(r.retry_overhead_tokens, 2000); // Attempt 2 tokens
  assert.equal(r.retry_overhead.tokens.input, 1200);
  assert.equal(r.retry_overhead.tokens.output, 250);
  assert.equal(r.retry_overhead.tokens.cache, 550);
  // Retry ratio = 2000 / 3000 ≈ 0.6667
  assert.equal(r.retry_overhead_ratio, round(2000 / 3000, 4));

  // Wasted tokens from failed attempts: attempt 1 failed
  assert.equal(r.failed_attempts, 1);
  assert.equal(r.wasted_tokens, 1000);
  assert.equal(r.wasted_input_tokens, 800);
  assert.equal(r.wasted_output_tokens, 50);
  assert.equal(r.wasted_cache_tokens, 150);
  assert.equal(r.wasted_tokens_from_failed_attempts.wasted_ratio, round(1000 / 3000, 4));
});

test("distinguishes zero usage from missing usage", () => {
  // Case A: Provider reported 0 tokens (explicit 0)
  const zeroRows: AttemptTelemetryRow[] = [
    row({
      run_id: 301,
      provider: "codex",
      model: "gpt-4o",
      execution_profile: "FAST",
      status: "COMPLETED",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
  ];

  const zeroRes = aggregateTokenEfficiency(zeroRows);
  assert.equal(zeroRes.length, 1);
  const z = zeroRes[0];
  assert.equal(z.attempts_zero_usage, 1);
  assert.equal(z.attempts_missing_usage, 0);
  assert.equal(z.usage_availability, "complete");
  assert.equal(z.total_input_tokens_per_successful_task, 0, "Zero usage is 0, not null");
  assert.equal(z.total_output_tokens_per_successful_task, 0);
  assert.equal(z.total_cache_tokens_per_successful_task, 0);
  assert.equal(z.total_tokens_per_successful_task, 0);

  // Case B: Provider reported NO usage (null / unavailable)
  const missingRows: AttemptTelemetryRow[] = [
    row({
      run_id: 302,
      provider: "cursor",
      model: "auto",
      execution_profile: "FAST",
      status: "COMPLETED",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    }),
  ];

  const missingRes = aggregateTokenEfficiency(missingRows);
  assert.equal(missingRes.length, 1);
  const m = missingRes[0];
  assert.equal(m.attempts_zero_usage, 0);
  assert.equal(m.attempts_missing_usage, 1);
  assert.equal(m.usage_availability, "unavailable");
  assert.equal(m.total_input_tokens_per_successful_task, null, "Missing usage is null, not 0");
  assert.equal(m.total_output_tokens_per_successful_task, null);
  assert.equal(m.total_cache_tokens_per_successful_task, null);
  assert.equal(m.total_tokens_per_successful_task, null);

  // Case C: Failed attempt with missing usage -> wasted tokens is null, not 0
  const failedMissingRows: AttemptTelemetryRow[] = [
    row({
      run_id: 303,
      run_status: "FAILED",
      provider: "cursor",
      model: "auto",
      execution_profile: "FAST",
      status: "FAILED",
      terminal_status: "FAILED",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    }),
  ];

  const failedRes = aggregateTokenEfficiency(failedMissingRows);
  assert.equal(failedRes[0].failed_attempts, 1);
  assert.equal(
    failedRes[0].wasted_tokens,
    null,
    "Wasted tokens from failed attempt with missing usage stays null",
  );
  assert.equal(failedRes[0].wasted_tokens_from_failed_attempts.failed_attempts_missing_usage, 1);
});

test("grouping: results are partitioned by provider, model, and execution profile", () => {
  const rows: AttemptTelemetryRow[] = [
    row({
      run_id: 401,
      provider: "claude",
      model: "claude-3-5-sonnet",
      execution_profile: "STANDARD",
      input_tokens: 1000,
    }),
    row({
      run_id: 402,
      provider: "claude",
      model: "claude-3-5-haiku",
      execution_profile: "STANDARD",
      input_tokens: 500,
    }),
    row({
      run_id: 403,
      provider: "claude",
      model: "claude-3-5-sonnet",
      execution_profile: "MICRO",
      input_tokens: 300,
    }),
    row({
      run_id: 404,
      provider: "codex",
      model: "gpt-4o",
      execution_profile: "FAST",
      input_tokens: 1500,
    }),
  ];

  const results = aggregateTokenEfficiency(rows);
  assert.equal(results.length, 4);

  const keys = results.map((r) => `${r.provider}|${r.model}|${r.execution_profile}`);
  assert.deepEqual(keys, [
    "claude|claude-3-5-haiku|STANDARD",
    "claude|claude-3-5-sonnet|MICRO",
    "claude|claude-3-5-sonnet|STANDARD",
    "codex|gpt-4o|FAST",
  ]);

  const haiku = results.find((r) => r.model === "claude-3-5-haiku")!;
  assert.equal(haiku.total_tasks, 1);
  assert.equal(haiku.total_input_tokens_per_successful_task, 500);

  const microSonnet = results.find(
    (r) => r.model === "claude-3-5-sonnet" && r.execution_profile === "MICRO",
  )!;
  assert.equal(microSonnet.total_input_tokens_per_successful_task, 300);
});

test("multiple tasks in cohort: calculates averages, first-pass success rate, and medians correctly", () => {
  const rows: AttemptTelemetryRow[] = [
    // Task 1: Succeeded on first pass (1000 input, 100 output, 200 cache)
    row({
      run_id: 501,
      number: 1,
      retries: 0,
      status: "COMPLETED",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 200,
      cache_creation_tokens: 0,
    }),
    // Task 2: Succeeded on first pass (2000 input, 200 output, 400 cache)
    row({
      run_id: 502,
      number: 1,
      retries: 0,
      status: "COMPLETED",
      input_tokens: 2000,
      output_tokens: 200,
      cache_read_tokens: 400,
      cache_creation_tokens: 0,
    }),
    // Task 3: Succeeded on retry (Attempt 1 failed: 500 in, 50 out; Attempt 2: 3000 in, 300 out, 600 cache)
    row({
      run_id: 503,
      number: 1,
      retries: 0,
      status: "FAILED",
      input_tokens: 500,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
    row({
      run_id: 503,
      number: 2,
      retries: 1,
      status: "COMPLETED",
      input_tokens: 3000,
      output_tokens: 300,
      cache_read_tokens: 600,
      cache_creation_tokens: 0,
    }),
    // Task 4: Failed run (failed attempt: 400 in, 40 out)
    row({
      run_id: 504,
      run_status: "FAILED",
      number: 1,
      retries: 0,
      status: "FAILED",
      input_tokens: 400,
      output_tokens: 40,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
  ];

  const results = aggregateTokenEfficiency(rows);
  assert.equal(results.length, 1);
  const r = results[0];

  assert.equal(r.total_tasks, 4);
  assert.equal(r.successful_tasks, 3);
  assert.equal(r.failed_tasks, 1);
  assert.equal(r.first_pass_successes, 2, "Tasks 501 and 502 passed on first try");
  assert.equal(r.success_rate, 0.75); // 3 / 4
  assert.equal(r.first_pass_success_rate, 0.5); // 2 / 4

  // Successful task tokens:
  // Task 501: 1000 in, 100 out, 200 cache = 1300 tot
  // Task 502: 2000 in, 200 out, 400 cache = 2600 tot
  // Task 503: 3500 in (500+3000), 350 out (50+300), 600 cache = 4450 tot
  // Total in: 1000 + 2000 + 3500 = 6500. Avg in: 6500 / 3 ≈ 2166.67
  // Total out: 100 + 200 + 350 = 650. Avg out: 650 / 3 ≈ 216.67
  // Total cache: 200 + 400 + 600 = 1200. Avg cache: 1200 / 3 = 400
  // Total tot: 1300 + 2600 + 4450 = 8350. Avg tot: 8350 / 3 ≈ 2783.33
  assert.equal(r.total_input_tokens_per_successful_task, 2166.67);
  assert.equal(r.total_output_tokens_per_successful_task, 216.67);
  assert.equal(r.total_cache_tokens_per_successful_task, 400);
  assert.equal(r.total_tokens_per_successful_task, 2783.33);

  // Medians of [1000, 2000, 3500] -> 2000
  assert.equal(r.median_input_tokens_per_successful_task, 2000);
  assert.equal(r.median_output_tokens_per_successful_task, 200);
  assert.equal(r.median_cache_tokens_per_successful_task, 400);

  // Retry overhead:
  // Attempt 2 of Task 503: 3000 in, 300 out, 600 cache = 3900 tokens
  assert.equal(r.retry_attempts, 1);
  assert.equal(r.retry_overhead_tokens, 3900);
  assert.equal(r.retry_overhead.retried_tasks, 1);

  // Wasted tokens from failed attempts:
  // Failed attempt 1 of Task 503: 500 in + 50 out = 550
  // Failed attempt of Task 504: 400 in + 40 out = 440
  // Total wasted: 550 + 440 = 990
  assert.equal(r.failed_attempts, 2);
  assert.equal(r.wasted_tokens, 990);
  assert.equal(r.wasted_input_tokens, 900); // 500 + 400
  assert.equal(r.wasted_output_tokens, 90); // 50 + 40
  assert.equal(r.wasted_cache_tokens, 0);
});
