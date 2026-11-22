/**
 * CodeAct effectiveness evaluation (M2), deterministic CI path: the ten fixture tasks, Direct vs CodeAct, through the
 * real Chat harness (routing, prompts, dispatch, CodeAct surface, persistence) with the SIMULATED provider policy.
 * Checks the harness and the metrics' honesty (unknown stays null), not model quality.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { settleBackground } from "../src/workflow/background.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import { TASKS, referenceAnswer, gradeAnswer, parseAnswer } from "../src/eval/codeactTasks.ts";
import {
  runEvaluation,
  runSample,
  simulatedPolicy,
  summarize,
  renderMarkdown,
  type EffectReport,
} from "../src/eval/codeactEffect.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
let user: PublicUser;
let report: EffectReport;

before(async () => {
  await migrate();
  user = await createUser({
    username: `effect-${Date.now()}`,
    password: "effect-pass",
    role: "member",
  });
  setCodeActLauncherForTests(async (node, args) => ({
    command: node,
    args,
    env: { PATH: process.env.PATH ?? "" },
  }));
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

test("reference answers are what the fixture data says (hand-checked fields)", async () => {
  const ref = Object.fromEntries(
    await Promise.all(TASKS.map(async (t) => [t.id, await referenceAnswer(t)])),
  );
  assert.deepEqual(ref["T01-single-lookup"], { status: "paid" });
  assert.deepEqual(ref["T02-independent-lookups"], {
    statuses: { "ORD-3": "paid", "ORD-11": "paid", "ORD-42": "paid", "ORD-99": "refund_pending" },
  });
  assert.equal(ref["T06-refund-timeout"].root_operation, "provider.refund.http");
  assert.equal(
    ref["T06-refund-timeout"].db_pool_warning_overlap,
    0,
    "the DB pool warning is the misleading signal",
  );
  assert.ok((ref["T06-refund-timeout"].slow_refund_orders as number) > 0);
  assert.deepEqual(ref["T09-partial-failure"].unavailable, ["eval.traces"]);
  assert.equal(ref["T09-partial-failure"].slowest_operation, null);
  assert.deepEqual(ref["T10-codeact-unnecessary"].services, [
    "order-api",
    "payment-gateway",
    "payment-provider",
    "refund-worker",
  ]);
  assert.equal(
    (ref["T03-trace-log-correlation"].order_ids as string[]).length,
    ref["T03-trace-log-correlation"].count,
  );
});

test("grading: exact identifiers and counts; asserting what the evidence leaves unknown is unsupported", () => {
  const exp = { slowest_operation: null, count: 3 };
  assert.equal(gradeAnswer(exp, { slowest_operation: null, count: 3 }).correct, true);
  const g = gradeAnswer(exp, { slowest_operation: "refund.db.update", count: 3 });
  assert.equal(g.correct, false);
  assert.equal(g.unsupported, 1);
  assert.equal(gradeAnswer(exp, parseAnswer("no block")).answered, false);
  assert.deepEqual(parseAnswer('x\n```answer\n{"a":1}\n```'), { a: 1 });
});

test("every reference plan is plain JavaScript that runs as a CodeAct program", () => {
  for (const t of TASKS)
    assert.doesNotThrow(() => new Function(`return (${t.plan.toString()})`), t.id);
});

test("paired Direct vs CodeAct through the Chat harness (simulated provider)", async () => {
  const actor = { ...user, active: true };
  const { samples, stopped } = await runEvaluation(
    { repetitions: 1 },
    {
      actor,
      provider: "claude",
      runnerFor: (task) => simulatedPolicy(task),
      turnTimeoutMs: 60_000,
    },
  );
  assert.equal(stopped, null);
  assert.equal(samples.length, 20);
  report = summarize(samples, {
    level: "fixture-simulated-provider",
    sandbox: "plain-process",
    provider: "simulated",
    model: null,
  });
  console.log(`M2-REPORT ${JSON.stringify(report)}`);
  console.log(renderMarkdown(report));
  assert.ok(
    samples.every((s) => s.turn_status === "completed"),
    JSON.stringify(samples.map((s) => s.turn_status)),
  );
  const get = (id: string, v: string) => samples.find((s) => s.task_id === id && s.variant === v)!;
  for (const t of TASKS) assert.equal(get(t.id, "codeact").correct, true, `${t.id} with CodeAct`);
  for (const id of ["T01-single-lookup", "T02-independent-lookups", "T10-codeact-unnecessary"])
    assert.equal(get(id, "direct").correct, true, `${id} direct`);
  const t08 = get("T08-large-aggregation", "direct");
  assert.equal(
    t08.correct,
    false,
    "the direct path cannot count events it was only shown truncated",
  );
  assert.ok(t08.truncated_results > 0);
  // Only the variable changed: an ineligible task never uses CodeAct even when offered.
  assert.equal(get("T01-single-lookup", "codeact").codeact_executions, 0);
  assert.equal(get("T03-trace-log-correlation", "codeact").codeact_executions, 1);
  assert.equal(get("T03-trace-log-correlation", "codeact").nested_calls, 2);
  assert.equal(get("T03-trace-log-correlation", "direct").codeact_executions, 0);
  // Honest metrics: a provider that reports nothing yields unknown tokens and cost, never zero.
  assert.ok(samples.every((s) => s.input_tokens === null && s.cost_usd === null));
  assert.equal(report.variants.direct.metrics.input_tokens.known, 0);
  assert.equal(report.adoption.eligible_turns, 8);
  assert.equal(report.adoption.eligible_turns_using_codeact, 8);
  assert.equal(report.adoption.ineligible_turns_using_codeact, 0);
  assert.equal(report.adoption.evidence_incomplete_turns, 0);
  assert.match(renderMarkdown(report), /SIMULATED PROVIDER/);
  assert.match(renderMarkdown(report), /fixture-simulated-provider/);
});

test("the sample limit stops the evaluation before a pair that would not fit", async () => {
  const actor = { ...user, active: true };
  const { samples, stopped } = await runEvaluation(
    { repetitions: 1, tasks: ["T01-single-lookup", "T10-codeact-unnecessary"], maxSamples: 3 },
    {
      actor,
      provider: "claude",
      runnerFor: (task) => simulatedPolicy(task),
      turnTimeoutMs: 60_000,
    },
  );
  assert.equal(samples.length, 2, "one complete pair; the second would exceed the limit");
  assert.match(stopped ?? "", /sample limit/);
});

// A realistic CodeAct failure: the program also asks SigNoz for refund-worker spans (HTTP 503 in the fixture) without
// handling the error, so the whole program fails although its other calls succeeded.
const BUGGY_T06 = `
  const slow = (await platform.callTool("eval.traces", { service: "payment-gateway", operation: "gateway.refund", min_duration_ms: 5000 })).spans;
  const worker = (await platform.callTool("eval.traces", { service: "refund-worker" })).spans;
  return { slow: slow.length, worker: worker.length };`;

test("regression: a failed program is diagnosed, then recovered by a corrected program (Chat harness)", async () => {
  const actor = { ...user, active: true };
  const task = TASKS.find((t) => t.id === "T06-refund-timeout")!;
  const s = await runSample(task, "codeact", 0, {
    actor,
    provider: "claude",
    runnerFor: (t) => simulatedPolicy(t, { firstProgram: BUGGY_T06, onFailure: "retry" }),
    turnTimeoutMs: 60_000,
  });
  console.log(
    `FAULT-RECOVERED ${JSON.stringify({ codeact_failures: s.codeact_failures, recovery: s.recovery, correct: s.correct })}`,
  );
  assert.equal(s.codeact_executions, 2);
  assert.equal(s.codeact_failed, 1);
  assert.deepEqual(
    s.codeact_failures.map(({ execution_id: _id, ...f }) => f),
    [
      {
        category: "program_runtime_error",
        phase: "program_run",
        nested_tool: "eval.traces",
        nested_category: "tool_invocation_failed",
      },
    ],
  );
  assert.deepEqual(
    [s.recovery.execution_failures, s.recovery.recovery_attempts, s.recovery.recovered],
    [1, 1, 1],
  );
  assert.equal(s.nested_failures, 1, "the 503 inside the failed program is counted");
  assert.equal(s.correct, true, "final outcome reported separately from the failure");
  const report = summarize([s], {
    level: "fixture-simulated-provider",
    sandbox: "plain-process",
    provider: "simulated",
    model: null,
  });
  assert.equal(report.adoption.failed_executions, 1);
  assert.deepEqual(report.adoption.failure_categories, {
    "program_runtime_error<-tool_invocation_failed": 1,
  });
  assert.equal(report.adoption.recovery.recovered, 1);
  assert.equal(report.adoption.failed_but_correct_turns, 1);
  assert.match(
    renderMarkdown(report),
    /1 failed \(program_runtime_error<-tool_invocation_failed: 1\)/,
  );
});

test("regression: a failed program followed by direct calls is a fallback, not a repair", async () => {
  const actor = { ...user, active: true };
  const task = TASKS.find((t) => t.id === "T06-refund-timeout")!;
  const s = await runSample(task, "codeact", 0, {
    actor,
    provider: "claude",
    runnerFor: (t) => simulatedPolicy(t, { firstProgram: BUGGY_T06, onFailure: "direct" }),
    turnTimeoutMs: 60_000,
  });
  assert.equal(s.codeact_failed, 1);
  assert.deepEqual(
    [s.recovery.recovered, s.recovery.fallback_direct, s.recovery.recovery_attempts],
    [0, 1, 0],
  );
  assert.ok(s.integration_calls > 0);
});

test("provider telemetry flows through the Chat harness into the sample, including a failed program", async () => {
  const actor = { ...user, active: true };
  const task = TASKS.find((t) => t.id === "T06-refund-timeout")!;
  let call = 0;
  const s = await runSample(task, "codeact", 0, {
    actor,
    provider: "claude",
    model: "opus",
    runnerFor: (t) => {
      const policy = simulatedPolicy(t, { firstProgram: BUGGY_T06, onFailure: "retry" });
      return async (prompt, options) => {
        const r = await policy(prompt, options);
        call++;
        return {
          ...r,
          model: "claude-opus-5-5",
          cost_usd: 0.01,
          tokens: { input: 5, output: 50, cache_read: 1000, cache_creation: call === 1 ? 300 : 0 },
          telemetry: {
            model_turns: 2,
            assistant_messages: 2,
            provider_tool_uses: 1,
            provider_tool_errors: 0,
            session_model: "claude-opus-5-5",
            api_models: ["claude-opus-5-5-20261101"],
            provider_duration_ms: 100,
            reasoning_tokens: null,
          },
        };
      };
    },
    turnTimeoutMs: 60_000,
  });
  assert.equal(s.codeact_failed, 1, "the failed program is still visible");
  assert.equal(s.sdk_calls, call);
  assert.equal(s.model_turns, 2 * call, "model turns are summed per SDK call, not equal to it");
  assert.equal(s.provider_tool_uses, call);
  assert.deepEqual(s.provider_models, ["claude-opus-5-5-20261101"]);
  assert.equal(s.model_resolution, "provider_reported");
  assert.equal(s.requested_model, "opus");
  assert.equal(s.cost_usd, Math.round(0.01 * call * 1e6) / 1e6);
  assert.equal(s.input_tokens_total, 5 * call + 1000 * call + 300);
  assert.equal(s.codeact_offered, true);
});

test("a provider that reports no telemetry leaves turns and model identity unknown", async () => {
  const actor = { ...user, active: true };
  const task = TASKS.find((t) => t.id === "T01-single-lookup")!;
  const s = await runSample(task, "direct", 0, {
    actor,
    provider: "claude",
    runnerFor: (t) => simulatedPolicy(t),
    turnTimeoutMs: 60_000,
  });
  assert.equal(s.model_turns, null);
  assert.equal(s.provider_tool_uses, null);
  assert.deepEqual(s.provider_models, []);
  assert.equal(s.model_resolution, "unresolved");
  assert.equal(s.input_tokens_total, null);
  assert.equal(s.cost_usd, null);
  assert.equal(s.codeact_offered, false);
});

test("fairness: both variants can page large results; unpaged responses are unchanged", async () => {
  const { callTool } = await import("../src/agent/toolRegistry.ts");
  const ctx = { runId: null, allowedRepositories: [], mode: "analysis" as const };
  const all = (await callTool("eval.logs", { level: "error" }, ctx)).result as {
    events: unknown[];
  };
  const seen: unknown[] = [];
  let offset: number | null = 0;
  while (offset != null) {
    const r = (await callTool("eval.logs", { level: "error", limit: 100, offset }, ctx)).result as {
      events: unknown[];
      total: number;
      next_offset: number | null;
    };
    assert.equal(r.total, all.events.length);
    seen.push(...r.events);
    offset = r.next_offset;
  }
  assert.deepEqual(seen, all.events);
  assert.deepEqual(Object.keys(all), ["events"], "no paging fields unless asked");
  for (const t of TASKS)
    assert.ok(
      !/platform\.callTool|=>/.test(t.question),
      `${t.id}: no plan or hint in the question`,
    );
});
