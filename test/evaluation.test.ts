import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config, codeIntelligenceEnabled } from "../src/config.ts";
import { execution } from "../src/auth/execution.ts";
import { createUser } from "../src/auth/users.ts";
import { SuiteSchema } from "../src/eval/dataset.ts";
import {
  fixtureGit,
  fixtureRoot,
  fixtureName,
  materializeSuite,
} from "../src/eval/fixtures.ts";
import {
  publishBuiltinSuite,
  createEvaluation,
  evaluationDetail,
  createComparison,
  comparisonDetail,
  cancelEvaluation,
  ConfigurationSchema,
} from "../src/eval/service.ts";
import {
  scoreEvidence,
  defaultScoring,
  aggregateResults,
  compareResults,
  PolicySchema,
  type Evidence,
} from "../src/eval/scoring.ts";
import {
  startPendingRun,
  approveStep,
  answerQuestions,
  getRun,
  reapExpiredLeases,
  beginAttempt,
} from "../src/workflow/engine.ts";
import { runOnce, claimJob } from "../src/workflow/scheduler.ts";
import { registerDefaultExecutors } from "../src/workflow/executors/index.ts";
import { sandboxIdentity } from "../src/eval/isolation.ts";
import { repositories } from "../src/repos/service.ts";
let suite: any, owner: any, other: any;
const evidence = (): Evidence => ({
  environment: true,
  authorized_changes: true,
  side_effects_blocked: true,
  security: true,
  syntax: true,
  regression_failed: 0,
  required_passed: 1,
  required_failed: 0,
  hidden_passed: 1,
  hidden_failed: 0,
  expected_passed: 2,
  expected_total: 2,
  clarification_required: false,
  clarification_passed: false,
  duration_ms: 10,
  runtime_budget_ms: 1000,
  retries: 0,
  human_interventions: 0,
  repository_correct: true,
  input_tokens: null,
  output_tokens: null,
  cached_tokens: null,
  cost_usd: null,
  failure_class: null,
  details: {},
});
before(async () => {
  await migrate();
  config.evaluation.enabled = true;
  config.learning.detectChanges = false;
  config.learning.evolveSkills = false;
  registerDefaultExecutors();
  owner = await createUser({
    username: "eval-owner",
    password: "test-eval-owner-password",
    role: "admin",
  });
  other = await createUser({
    username: "eval-other",
    password: "test-eval-other-password",
    role: "member",
  });
  suite = await publishBuiltinSuite();
});
after(async () => {
  const { settleBackground } = await import("../src/workflow/background.ts");
  await settleBackground();
  await pool.end();
});
async function drive(id: number) {
  const at = Date.now();
  for (;;) {
    if (Date.now() - at > 300000)
      throw new Error("Evaluation test wall time exceeded");
    const d = await evaluationDetail(id, owner.id);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(d.status)) return d;
    const approvals = await q(
      pool,
      "SELECT key FROM workflow_steps WHERE run_id=$1 AND status='WAITING_APPROVAL'",
      [d.workflow_run_id],
    );
    for (const step of approvals)
      await approveStep(d.workflow_run_id, step.key, {
        by: "synthetic test approval",
      });
    const questions = await q(
      pool,
      "SELECT id,options FROM workflow_questions WHERE run_id=$1 AND status='open'",
      [d.workflow_run_id],
    );
    if (questions.length)
      await answerQuestions(
        Object.fromEntries(questions.map((q) => [q.id, q.options[0]])),
        "synthetic test answer",
      );
    if (!(await runOnce())) await new Promise((r) => setTimeout(r, 10));
  }
}
test("15 labeled synthetic cases have valid pinned repositories and immutable suite versions", async () => {
  assert.equal(suite.manifest.cases.length, 15);
  assert.ok(suite.manifest.cases.every((c: any) => c.origin === "synthetic"));
  SuiteSchema.parse(suite.manifest);
  const again = await materializeSuite();
  assert.deepEqual(again, suite.manifest);
  const duplicate = structuredClone(again);
  duplicate.cases[1].task_id = duplicate.cases[0].task_id;
  assert.throws(() => SuiteSchema.parse(duplicate));
  const unpinned = structuredClone(again);
  unpinned.cases[0].base_commit = "main";
  assert.throws(() => SuiteSchema.parse(unpinned));
  const falseHistory = structuredClone(again);
  falseHistory.cases[0].origin = "real_derived";
  assert.throws(() => SuiteSchema.parse(falseHistory));
  await assert.rejects(
    q(pool, "UPDATE benchmark_suites SET title='tampered' WHERE id=$1", [
      suite.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    q(pool, "DELETE FROM benchmark_cases WHERE suite_id=$1", [suite.id]),
    /immutable/,
  );
  assert.equal((await publishBuiltinSuite()).id, suite.id);
});
test("Hard gates override a high weighted score; unknown/incorrect usage stays unknown or is rejected", () => {
  const e = evidence();
  assert.equal(scoreEvidence(e).verdict, "PASS");
  e.authorized_changes = false;
  const fail = scoreEvidence(e);
  assert.equal(fail.verdict, "FAIL");
  assert.ok(fail.quality_score > 60);
  e.authorized_changes = true;
  e.security = false;
  assert.equal(scoreEvidence(e).verdict, "FAIL");
  e.security = true;
  e.environment = false;
  e.failure_class = "infrastructure";
  assert.equal(scoreEvidence(e).verdict, "BLOCKED");
  const bad = evidence();
  bad.cost_usd = -1;
  assert.throws(() => scoreEvidence(bad), /Invalid observed metric/);
  bad.cost_usd = null;
  bad.input_tokens = 1.2;
  assert.throws(() => scoreEvidence(bad));
  assert.throws(() =>
    scoreEvidence(e, {
      ...defaultScoring,
      weights: { ...defaultScoring.weights, efficiency: 1 },
    }),
  );
  const row: any = {
    scenario: "BENCH-001",
    status: "PASS",
    correct: true,
    regression: false,
    quality_score: 100,
    hard_gates_passed: true,
    cost_usd: null,
    tokens: null,
    wall_s: 1,
    repairs: 0,
    human_gates: 0,
    data: { evidence: evidence(), repetition: 1 },
  };
  const summary = aggregateResults([row], 1);
  assert.equal(summary.average_input_tokens, null);
  assert.equal(summary.cost_per_success, null);
  assert.equal(summary.cost_known, 0);
  assert.equal(
    compareResults([row], [row], 1, new Set()).verdict,
    "INCONCLUSIVE",
  );
  const regression = { ...row, correct: false, status: "FAIL" };
  assert.equal(
    compareResults([row], [regression], 1, new Set(["BENCH-001"])).verdict,
    "FAIL",
  );
});
test("Configuration is bounded, live execution needs approval, and fixture repositories do not enter normal discovery", async () => {
  assert.throws(() => ConfigurationSchema.parse({ repetitions: 20 }));
  assert.throws(() => ConfigurationSchema.parse({ provider: "claude" }));
  await assert.rejects(
    createEvaluation(other.id, {
      suite_id: suite.id,
      request_key: "unapproved",
      configuration: { mode: "live", provider: "claude" },
    }),
    /approval/,
  );
  const ordinary = await repositories.allowedFor("Unmapped normal project");
  assert.ok(!ordinary.some((n) => n.startsWith("bench-")));
  const original = config.codeIntelligence.enabled;
  await Promise.all([
    execution.run(
      { userId: owner.id, kind: "run", evaluation: { codeIntelligence: true } },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(codeIntelligenceEnabled(), true);
      },
    ),
    execution.run(
      {
        userId: owner.id,
        kind: "run",
        evaluation: { codeIntelligence: false },
      },
      async () => {
        assert.equal(codeIntelligenceEnabled(), false);
      },
    ),
  ]);
  assert.equal(codeIntelligenceEnabled(), original);
});
test("Fixture evaluations use existing jobs, objective validators, checkpoints, artifacts, retry recovery and paired P1 comparisons", async () => {
  const baseline = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "pair-baseline",
    configuration: { adapter: "reference", repetitions: 2 },
  });
  const candidate = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "pair-candidate",
    configuration: {
      adapter: "reference",
      repetitions: 2,
      code_intelligence: true,
      context_strategy: "symbols",
    },
  });
  const duplicate = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "pair-baseline",
    configuration: { adapter: "reference", repetitions: 2 },
  });
  assert.equal(duplicate.id, baseline.id);
  await assert.rejects(
    createEvaluation(owner.id, {
      suite_id: suite.id,
      request_key: "pair-baseline",
      configuration: { adapter: "baseline", repetitions: 2 },
    }),
    /Idempotency/,
  );
  await startPendingRun(baseline.workflow_run_id);
  await startPendingRun(candidate.workflow_run_id);
  const a = await drive(baseline.id),
    b = await drive(candidate.id);
  const available = !!candidate.configuration.sandbox;
  if (!available) {
    assert.equal(b.summary.blocked, 30);
    assert.equal(b.summary.success_rate, null);
    return;
  }
  assert.equal(a.status, "COMPLETED");
  assert.equal(b.status, "COMPLETED");
  assert.equal(
    b.summary.successes,
    30,
    JSON.stringify(
      b.cases
        .filter((c: any) => c.correct !== true)
        .map((c: any) => ({
          task: c.task_id,
          diagnostic: c.data?.evidence?.details?.diagnostic,
          checks: c.data?.evidence?.details?.validation_checks,
        })),
    ),
  );
  assert.equal(
    a.summary.successes,
    28,
    "Metadata-only control misses only the two repository-discovery repetitions",
  );
  const clarification = b.cases.find((c: any) => c.task_id === "BENCH-010");
  assert.equal(clarification.data.evidence.clarification_passed, true);
  assert.equal(clarification.human_gates, 2);
  const retry = b.cases.find((c: any) => c.task_id === "BENCH-013");
  assert.equal(retry.repairs, 1);
  const freshness = b.cases.find((c: any) => c.task_id === "BENCH-015");
  assert.ok(freshness.data.evidence.details.stale_fallback > 0);
  assert.equal(b.summary.average_input_tokens, null);
  assert.equal(b.summary.cost_per_success, 0);
  const compare = await createComparison(
    owner.id,
    baseline.id,
    candidate.id,
    {},
  );
  const detail = await comparisonDetail(compare!.id, owner.id);
  assert.equal(detail.report.verdict, "PASS");
  assert.equal(detail.report.pairs.length, 30);
  assert.equal(
    (
      await q(
        pool,
        "SELECT id FROM execution_workspaces WHERE run_id=ANY($1::bigint[])",
        [[a.workflow_run_id, b.workflow_run_id]],
      )
    ).length,
    0,
  );
  for (const logical of Object.keys(suite.manifest.repositories))
    assert.equal(
      await fixtureGit(fixtureRoot(fixtureName(logical)), [
        "status",
        "--porcelain",
      ]),
      "",
    );
  assert.equal(
    (
      await q(
        pool,
        "SELECT id FROM pull_requests WHERE run_id=ANY($1::bigint[])",
        [[a.workflow_run_id, b.workflow_run_id]],
      )
    ).length,
    0,
  );
  const artifact = await one(
    pool,
    "SELECT content FROM workflow_artifacts WHERE id=$1",
    [clarification.data.evidence.details.artifact_id],
  );
  assert.ok(artifact!.content.includes("checks"));
});
test("Interrupted integration jobs recover from pinned fixtures; cancellation is private and idempotent", async () => {
  const e = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "recovery",
    configuration: { adapter: "reference", case_limit: 1 },
  });
  await startPendingRun(e.workflow_run_id);
  const job = (await claimJob("eval-crash", 30))!;
  const started = await beginAttempt(job, "eval-crash");
  assert.ok(started);
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await reapExpiredLeases();
  const done = await drive(e.id);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.cases.length, 1);
  await assert.rejects(evaluationDetail(e.id, other.id), /not found/i);
  await assert.rejects(cancelEvaluation(e.id, other.id), /not found/i);
  const canceled = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "cancel",
    configuration: { case_limit: 1 },
  });
  await cancelEvaluation(canceled.id, owner.id);
  assert.equal(
    (await evaluationDetail(canceled.id, owner.id)).status,
    "CANCELED",
  );
  const comparison = await createComparison(owner.id, e.id, canceled.id, {});
  assert.notEqual(
    (await comparisonDetail(comparison!.id, owner.id)).report.verdict,
    "PASS",
  );
});
test("A plausible provider-fixture explanation without working code fails objective evaluation", async () => {
  const e = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "provider-fixture",
    configuration: { adapter: "agent_fixture", case_limit: 1 },
  });
  await startPendingRun(e.workflow_run_id);
  const d = await drive(e.id);
  if (e.configuration.sandbox) {
    assert.equal(d.cases[0].correct, false);
    assert.equal(d.cases[0].status, "FAIL");
    assert.equal(d.cases[0].data.evidence.input_tokens, null);
  }
});

test("Evaluation completion never sends notifications or triggers paid learning models, even with learning forced", async () => {
  const { mock } = await import("node:test");
  const { notify, notifyStepWaiting } = await import("../src/notify.ts");
  const { detectKnowledgeChanges, setKnowledgeChangeAnalyzer } =
    await import("../src/knowledge/learning.ts");
  const { extractRunMemory } = await import("../src/knowledge/memory.ts");
  const run = (await one(
    pool,
    "SELECT workflow_run_id FROM evaluation_runs ORDER BY id LIMIT 1",
  ))!.workflow_run_id;
  let called = 0;
  setKnowledgeChangeAnalyzer(async () => {
    called++;
    return {};
  });
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("Outbound notification should never execute");
  });
  const webhook = config.notifyWebhook;
  config.notifyWebhook = "http://benchmark-notifications.invalid";
  try {
    await notify("synthetic fixture complete", `/runs/${run}`);
    await notifyStepWaiting("question", {
      runId: run,
      runTitle: "fixture",
      stepId: 1,
      stepKey: "case",
      stepName: "case",
      status: "WAITING_INPUT",
      detail: "fixture",
      generation: 0,
      ownerId: owner.id,
    });
    assert.equal(
      (await detectKnowledgeChanges(run, { force: true })).status,
      "disabled",
    );
    assert.deepEqual(await extractRunMemory(run), []);
    assert.equal(called, 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    config.notifyWebhook = webhook;
    fetchMock.mock.restore();
  }
});

test("Incomplete and approved-but-unsupported live execution is BLOCKED, never a passing score", async () => {
  const blocked = await createEvaluation(
    owner.id,
    {
      suite_id: suite.id,
      request_key: "approved-live-blocked",
      paid_approval: true,
      configuration: { mode: "live", provider: "codex", case_limit: 1 },
    },
    true,
  );
  assert.match(blocked.configuration.blocked, /Live execution is BLOCKED/);
  await startPendingRun(blocked.workflow_run_id);
  const result = await drive(blocked.id);
  assert.equal(result.cases[0].status, "BLOCKED");
  assert.equal(result.cases[0].correct, null);
  assert.equal(result.summary.success_rate, null);
  const dry = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "dry",
    configuration: { mode: "dry_run", case_limit: 1 },
  });
  await startPendingRun(dry.workflow_run_id);
  assert.equal((await drive(dry.id)).cases[0].status, "BLOCKED");
});

test("Two evaluations can execute concurrently without A/B scope or workspace contamination", async () => {
  const { processJob } = await import("../src/workflow/scheduler.ts");
  const a = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "concurrent-a",
    configuration: {
      adapter: "reference",
      case_limit: 1,
      code_intelligence: false,
    },
  });
  const b = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "concurrent-b",
    configuration: {
      adapter: "reference",
      case_limit: 1,
      code_intelligence: true,
      context_strategy: "symbols",
    },
  });
  await startPendingRun(a.workflow_run_id);
  await startPendingRun(b.workflow_run_id);
  const jobs = await Promise.all([
    claimJob("eval-a", 30),
    claimJob("eval-b", 30),
  ]);
  assert.ok(jobs[0] && jobs[1]);
  assert.notEqual(jobs[0]!.id, jobs[1]!.id);
  await Promise.all(
    jobs.map((j, i) =>
      processJob(j!, `eval-${i}`, { leaseSeconds: 30, heartbeatSeconds: 5 }),
    ),
  );
  const ra = await evaluationDetail(a.id, owner.id),
    rb = await evaluationDetail(b.id, owner.id);
  assert.equal(ra.configuration.code_intelligence, false);
  assert.equal(rb.configuration.code_intelligence, true);
  if (a.configuration.sandbox && b.configuration.sandbox) {
    assert.equal(ra.cases[0].correct, true);
    assert.equal(rb.cases[0].correct, true);
    assert.equal(ra.cases[0].data.evidence.details.context_size, 0);
    assert.ok(rb.cases[0].data.evidence.details.context_size > 0);
  }
});

test("An expired worker cannot publish an evaluation result before the normal reaper runs", async () => {
  const { executeBenchmarkCase } = await import("../src/eval/runner.ts");
  const { makeContext } = await import("../src/workflow/executors/registry.ts");
  const e = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: "stale-publication",
    configuration: { mode: "dry_run", case_limit: 1 },
  });
  await startPendingRun(e.workflow_run_id);
  const job = (await claimJob("stale-evaluator", 30))!;
  const begun = (await beginAttempt(job, "stale-evaluator"))!;
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  const result = await execution.run(
    { userId: owner.id, runId: e.workflow_run_id, kind: "run" },
    () =>
      executeBenchmarkCase(
        makeContext({ ...begun, signal: new AbortController().signal }),
      ),
  );
  assert.equal(result.kind, "failed");
  assert.equal(
    (
      await q(
        pool,
        "SELECT er.id FROM eval_results er JOIN evaluation_case_runs cr ON cr.id=er.case_run_id WHERE cr.evaluation_id=$1",
        [e.id],
      )
    ).length,
    0,
  );
  await cancelEvaluation(e.id, owner.id);
});
