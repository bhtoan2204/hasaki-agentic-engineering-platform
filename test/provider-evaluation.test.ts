import { compareContextEffect } from "../src/eval/contextEffect.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  publishBuiltinSuite,
  createEvaluation,
  evaluationDetail,
  ConfigurationSchema,
  createComparison,
} from "../src/eval/service.ts";
import {
  chooseRecommendation,
  createRecommendation,
  RECOMMENDATION_VERSION,
} from "../src/eval/recommendations.ts";
import { evaluationAnalytics } from "../src/eval/analytics.ts";
import { saveOptimizationPolicy } from "../src/eval/optimization.ts";
import { sha256 } from "../src/eval/dataset.ts";
import { startPendingRun, startRun, getRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerDefaultExecutors } from "../src/workflow/executors/index.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { sandboxIdentity } from "../src/eval/isolation.ts";
let owner: PublicUser,
  other: PublicUser,
  admin: PublicUser,
  suite: any,
  server: Server,
  base: string;
/**
 * Objective validation runs inside the evaluation sandbox (src/eval/isolation.ts): a container runtime with a
 * pre-loaded image (never pulled) and a pinned Nix Node closure. Where that infrastructure is absent (CI runners,
 * developer machines without Nix), the cases that need it are skipped with the reason instead of failing.
 */
const sandboxMissing = await sandboxIdentity().then(
  () => false as const,
  (e: Error) => `evaluation sandbox unavailable on this machine (${e.message.slice(0, 80)}…)`,
);
let seq = 0;
const url = (q = "") => new URL("http://local/?from=2026-01-01&to=2027-01-01&timezone=UTC" + q);
before(async () => {
  await migrate();
  config.evaluation.enabled = true;
  config.learning.detectChanges = false;
  config.learning.evolveSkills = false;
  registerDefaultExecutors();
  owner = await createUser({
    username: "p6-owner",
    password: "evaluation-password",
    role: "member",
  });
  other = await createUser({
    username: "p6-other",
    password: "evaluation-password",
    role: "member",
  });
  admin = await createUser({
    username: "p6-admin",
    password: "evaluation-password",
    role: "admin",
  });
  suite = await publishBuiltinSuite();
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  setHandoffReadinessForTests(undefined);
  server.close();
  await pool.end();
});
const plan = (values: string[]) => values.map((provider) => ({ provider, model: null }));
async function evaluation(providers: string[], variant = "tools", extra: any = {}) {
  return createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: `p6-${++seq}`,
    configuration: {
      adapter: "provider_fixture",
      provider_sequence: plan(providers),
      context_variant: variant,
      repetitions: 1,
      case_limit: 1,
      ...extra,
    },
  });
}
async function finish(id: number) {
  const d = await evaluationDetail(id, owner.id);
  await startPendingRun(d.workflow_run_id);
  await drain();
  return evaluationDetail(id, owner.id);
}

test("provider models and context settings are strictly validated without cross-provider options", () => {
  assert.equal(
    ConfigurationSchema.safeParse({
      adapter: "provider_fixture",
      provider_sequence: plan(["cursor"]),
      context_variant: "minimal",
    }).success,
    true,
  );
  for (const cfg of [
    { adapter: "provider_fixture" },
    { provider_sequence: plan(["codex"]), context_variant: "tools" },
    {
      adapter: "provider_fixture",
      provider_sequence: [{ provider: "codex", model: "claude-sonnet" }],
      context_variant: "tools",
    },
    {
      adapter: "provider_fixture",
      provider_sequence: [{ provider: "cursor", reasoning_effort: "high" }],
      context_variant: "tools",
    },
  ])
    assert.equal(ConfigurationSchema.safeParse(cfg).success, false);
});

test(
  "six provider plans use durable attempts and equivalent pinned fixtures with objective validation",
  { skip: sandboxMissing },
  async () => {
    for (const route of [
      ["claude"],
      ["codex"],
      ["cursor"],
      ["claude", "codex"],
      ["codex", "claude"],
      ["claude", "codex", "cursor"],
    ]) {
      const e = await evaluation(route, "tools", { repetitions: 2 });
      const d = await finish(e.id);
      assert.equal(d.status, "COMPLETED");
      assert.equal(
        d.summary.successes,
        2,
        JSON.stringify(d.cases.map((c: any) => c.data?.evidence?.details)),
      );
      assert.ok(d.cases.every((c: any) => c.data.evidence.cost_usd === null));
      const attempts = await q(
        pool,
        "SELECT a.agent_provider,a.metrics FROM workflow_step_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE a.run_id=$1 AND s.type IN ('agent','coding_agent') ORDER BY a.id",
        [e.workflow_run_id],
      );
      assert.deepEqual(
        attempts.map((a) => a.agent_provider),
        [...route, ...route],
      );
      assert.ok(
        attempts.every(
          (a) =>
            a.metrics.execution_kind === "fixture_control" &&
            a.metrics.tokens === null &&
            a.metrics.cost_usd === null,
        ),
      );
      const samples = await q(
        pool,
        "SELECT * FROM evaluation_analytics_samples WHERE evaluation_id=$1",
        [e.id],
      );
      assert.ok(samples.every((s) => s.evidence_kind === "fixture_control" && s.cost_usd === null));
      assert.equal(samples[0].base_commit, d.cases[0].base_commit);
    }
  },
);

test(
  "A/B/C isolates pack/tool access and paired comparisons reject multiple changing factors",
  { skip: sandboxMissing },
  async () => {
    const a = await evaluation(["codex"], "minimal"),
      b = await evaluation(["codex"], "pack"),
      c = await evaluation(["codex"], "tools");
    assert.equal(a.constraints_hash, b.constraints_hash);
    assert.equal(b.constraints_hash, c.constraints_hash);
    for (const [e, variant] of [
      [a, "minimal"],
      [b, "pack"],
      [c, "tools"],
    ] as const) {
      await finish(e.id);
      const step = await one(
        pool,
        "SELECT id FROM workflow_steps WHERE run_id=$1 AND type='coding_agent'",
        [e.workflow_run_id],
      );
      const packs = await q(pool, "SELECT id FROM agent_context_packs WHERE step_id=$1", [step.id]);
      assert.equal(packs.length, variant === "minimal" ? 0 : 1);
      const calls = await q(
        pool,
        "SELECT tool FROM agent_context_tool_calls WHERE step_id=$1 AND tool='platform.get_run_context'",
        [step.id],
      );
      assert.equal(calls.length, variant === "tools" ? 1 : 0);
    }
    await createComparison(owner.id, a.id, b.id, {});
    const changed = await evaluation(["claude"], "pack");
    await assert.rejects(
      () => createComparison(owner.id, a.id, changed.id, {}),
      /provider\/model sequence fixed/,
    );
    const budget = await evaluation(["codex"], "pack", { max_tokens: 9999 });
    await assert.rejects(() => createComparison(owner.id, b.id, budget.id, {}), /identical suite/);
    const result = await evaluationAnalytics(owner, url());
    assert.ok(result.comparisons.every((g: any) => g.reported_cost_usd == null));
    assert.ok(result.context.some((g: any) => g.context_variant === "minimal"));
  },
);

test("changed context inventory blocks a frozen experiment rather than contaminating A/B", async () => {
  const e = await evaluation(["claude"], "pack");
  await knowledge.create({
    key: "p6-changed",
    title: "New rule",
    category: "business_rule",
    content: "A newly published fixture control rule",
    scope_type: "GLOBAL",
    ownerId: owner.id,
  });
  const d = await finish(e.id);
  assert.equal(d.cases[0].status, "BLOCKED");
  assert.equal(d.cases[0].correct, null);
});

test("fixture controls and small or overlapping cohorts cannot create unsupported rankings", async () => {
  const rec = await createRecommendation(owner, { category: suite.manifest.cases[0].category });
  assert.equal(rec.decision.status, "INSUFFICIENT_EVIDENCE");
  const sample = (provider: string, successes: number, tasks = 15) => ({
    cohort: "same",
    variant: "tools",
    category: "go-backend",
    plan: plan([provider]),
    samples: 60,
    successes,
    tasks,
    evaluations: 2,
    repetitions: 2,
    stable_task_successes: Math.round((successes / 60) * tasks),
    median_ms: 100,
    cost_known: 0,
    cost_usd: null,
    evaluation_ids: [1, 2],
  });
  assert.equal(chooseRecommendation([sample("claude", 60)]).status, "INSUFFICIENT_EVIDENCE");
  assert.equal(
    chooseRecommendation([sample("claude", 60), sample("codex", 59)]).status,
    "INSUFFICIENT_EVIDENCE",
  );
  assert.equal(
    chooseRecommendation([sample("claude", 60, 1), sample("codex", 0, 1)]).status,
    "INSUFFICIENT_EVIDENCE",
  );
  const supported = chooseRecommendation([sample("claude", 0), sample("codex", 60)]);
  assert.equal(supported.status, "RECOMMENDED");
  assert.equal(supported.confidence, "MEDIUM");
  assert.equal(supported.plan?.[0].provider, "codex");
  assert.equal(supported.cost_per_verified_success, null);
});

async function recommendation(provider = "codex") {
  return one(
    pool,
    "INSERT INTO agent_recommendations(owner_id,version,category,evidence_hash,filters,decision) VALUES($1,$2,'go-backend',$3,'{}',$4) RETURNING *",
    [
      owner.id,
      RECOMMENDATION_VERSION,
      sha256("fixture evidence for optimizer test only"),
      JSON.stringify({
        status: "RECOMMENDED",
        confidence: "MEDIUM",
        category: "go-backend",
        cost_availability: "Unknown",
        plan: plan([provider]),
        evidence: [],
      }),
    ],
  );
}
test("optimization stays off by default, never changes running work, and persists immutable future-default provenance", async () => {
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  await definitions.create({
    key: "p6-opt",
    spec: { name: "Optimization test", steps: [{ key: "implementation", type: "coding_agent" }] },
  });
  const before = await startRun({
    definitionKey: "p6-opt",
    ownerId: owner.id,
    start: false,
    inputs: { task_category: "go-backend" },
  });
  const rec = await recommendation();
  const p = await saveOptimizationPolicy(owner.id, {
    recommendation_id: rec.id,
    category: "go-backend",
  });
  assert.equal(p.enabled, false);
  const untouched = await startRun({
    definitionKey: "p6-opt",
    ownerId: owner.id,
    start: false,
    inputs: { task_category: "go-backend" },
  });
  assert.equal((await getRun(untouched.id)).steps[0].config.agent, undefined);
  await saveOptimizationPolicy(owner.id, {
    recommendation_id: rec.id,
    category: "go-backend",
    enabled: true,
    allow_unknown_cost: true,
  });
  assert.equal((await getRun(before.id)).steps[0].config.agent, undefined);
  const optimized = await startRun({
    definitionKey: "p6-opt",
    ownerId: owner.id,
    start: false,
    inputs: { task_category: "go-backend" },
  });
  const step = (await getRun(optimized.id)).steps[0];
  assert.equal(step.config.agent.provider, "codex");
  assert.equal(step.config.optimization_decision.evidence_hash, rec.evidence_hash);
  assert.ok(
    await one(pool, "SELECT id FROM agent_optimization_decisions WHERE run_id=$1", [optimized.id]),
  );
  const explicit = await startRun({
    definitionKey: "p6-opt",
    ownerId: owner.id,
    start: false,
    agentProvider: "claude",
    inputs: { task_category: "go-backend" },
  });
  assert.equal((await getRun(explicit.id)).steps[0].config.agent, undefined);
  await assert.rejects(
    () =>
      saveOptimizationPolicy(other.id, {
        recommendation_id: rec.id,
        category: "go-backend",
        enabled: true,
      }),
    /not found/,
  );
  await assert.rejects(
    () => q(pool, "UPDATE agent_recommendations SET decision='{}' WHERE id=$1", [rec.id]),
    /immutable/,
  );
  setHandoffReadinessForTests(undefined);
});

async function client(user: PublicUser) {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: "evaluation-password" }),
  });
  const body = await r.json();
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return async (path: string, data?: unknown) =>
    fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": body.csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
}
test("analytics, evidence and recommendation endpoints preserve owner isolation and audited admin scope", async () => {
  // Its own evidence, not data left by earlier tests (those may be skipped where the sandbox is unavailable).
  await finish((await evaluation(["codex"], "tools", { repetitions: 3 })).id);
  const a = await client(owner),
    b = await client(other),
    support = await client(admin);
  const mine = await (
    await a("/api/agent-evaluation?from=2026-01-01&to=2027-01-01&timezone=UTC&page_size=2")
  ).json();
  assert.ok(mine.details.length <= 2);
  assert.ok(mine.pagination.total > 2);
  const foreign = await (
    await b("/api/agent-evaluation?from=2026-01-01&to=2027-01-01&scope=all")
  ).json();
  assert.equal(foreign.details.length, 0);
  const team = await (
    await support("/api/agent-evaluation?from=2026-01-01&to=2027-01-01&scope=all")
  ).json();
  assert.ok(team.details.length > 0);
  assert.ok(
    await one(
      pool,
      "SELECT id FROM audit_log WHERE actor_id=$1 AND action='support.list' AND resource_type='agent-evaluation'",
      [admin.id],
    ),
  );
  const rec = await recommendation();
  assert.equal((await b(`/api/agent-recommendations/${rec.id}`)).status, 404);
  assert.equal((await a(`/api/agent-recommendations/${rec.id}`)).status, 200);
});

test("live model execution remains explicitly blocked without verified usage-budget and isolation guarantees", async () => {
  const e = await createEvaluation(
    owner.id,
    {
      suite_id: suite.id,
      request_key: `live-${++seq}`,
      paid_approval: true,
      configuration: {
        mode: "live",
        provider: "cursor",
        provider_sequence: plan(["claude", "codex", "cursor"]),
        context_variant: "tools",
        case_limit: 1,
      },
    },
    true,
  );
  const d = await finish(e.id);
  assert.equal(d.cases[0].status, "BLOCKED");
  assert.equal(d.cases[0].correct, null);
  assert.match(d.configuration.blocked, /BLOCKED/);
});

test("controlled evidence query supports reproducible recommendations while keeping production observations separate", async () => {
  const manifest = structuredClone(suite.manifest);
  manifest.key = "p6-labeled-fixture";
  manifest.cases = manifest.cases.map((c: any) => ({ ...c, category: "go-backend" }));
  const s = await one(
    pool,
    "INSERT INTO benchmark_suites(suite_key,version,content_hash,title,manifest) VALUES($1,1,$2,'Synthetic evidence fixture',$3) RETURNING id",
    [manifest.key, sha256(JSON.stringify(manifest)), JSON.stringify(manifest)],
  );
  const ids = [];
  for (const task of manifest.cases)
    ids.push(
      await one(
        pool,
        "INSERT INTO benchmark_cases(suite_id,task_id,category,difficulty,origin,repository,base_commit,definition) VALUES($1,$2,'go-backend',$3,'synthetic',$4,$5,$6) RETURNING id,task_id",
        [
          s.id,
          task.task_id,
          task.difficulty,
          task.repository,
          task.base_commit,
          JSON.stringify(task),
        ],
      ),
    );
  await definitions.create({
    key: "p6-evidence",
    spec: {
      name: "Synthetic evidence setup",
      steps: [{ key: "validate", type: "integration", config: { action: "noop" } }],
    },
  });
  for (const provider of ["claude", "codex"]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const w = await startRun({ definitionKey: "p6-evidence", ownerId: owner.id, start: false });
      await q(
        pool,
        "UPDATE workflow_runs SET status='COMPLETED',created_at='2026-11-01T12:00:00Z' WHERE id=$1",
        [w.id],
      );
      const e = await one(
        pool,
        "INSERT INTO evaluation_runs(suite_id,owner_id,workflow_run_id,configuration,configuration_hash,scoring,constraints_hash,request_key,created_at) VALUES($1,$2,$3,$4,$5,'{}','controlled-fixture','test-live-fixture-'||$3::bigint::text,'2026-11-01T12:00:00Z') RETURNING id",
        [
          s.id,
          owner.id,
          w.id,
          JSON.stringify({
            mode: "live",
            adapter: "future_verified_connector",
            provider_sequence: plan([provider]),
            context_variant: "tools",
          }),
          sha256(provider + repeat),
        ],
      );
      for (const task of ids)
        for (let repetition = 1; repetition <= 2; repetition++) {
          const cr = await one(
            pool,
            "INSERT INTO evaluation_case_runs(evaluation_id,case_id,repetition,workflow_step_key) VALUES($1,$2,$3,$4) RETURNING id",
            [e.id, task.id, repetition, `case_${task.task_id.slice(-3)}_r${repetition}`],
          );
          const success = provider === "codex";
          await q(
            pool,
            "INSERT INTO eval_results(suite,scenario,candidate,status,correct,regression,verdict,run_id,data,case_run_id,owner_id,quality_score,hard_gates_passed) VALUES('synthetic test evidence',$1,$2,$3,$4,false,$3,$5,$6,$7,$8,$9,$4)",
            [
              task.task_id,
              provider,
              success ? "PASS" : "FAIL",
              success,
              w.id,
              JSON.stringify({
                evidence: {
                  environment: true,
                  expected_passed: success ? 2 : 0,
                  expected_total: 2,
                  duration_ms: 100,
                  details: { evidence_kind: "live_provider" },
                },
              }),
              cr.id,
              owner.id,
              success ? 100 : 0,
            ],
          );
        }
    }
  }
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  const rec = await createRecommendation(owner, {
    category: "go-backend",
    cohort: "controlled-fixture",
    from: "2026-11-01",
    to: "2026-11-02",
    timezone: "UTC",
  });
  assert.equal(rec.decision.status, "RECOMMENDED");
  assert.equal(rec.decision.plan[0].provider, "codex");
  assert.equal(rec.decision.samples, 60);
  assert.equal(rec.decision.distinct_tasks, 15);
  assert.equal(rec.decision.cost_availability, "Unknown");
  assert.ok(rec.decision.evidence.every((r: any) => r.evaluation_ids.length === 2));
  setHandoffReadinessForTests(async () => ({
    ok: false,
    error: "Provider unavailable",
    quota: "unknown",
    cost: "unknown",
  }));
  const unavailable = await createRecommendation(owner, {
    category: "go-backend",
    cohort: "controlled-fixture",
    from: "2026-11-01",
    to: "2026-11-02",
    timezone: "UTC",
  });
  assert.equal(unavailable.decision.status, "UNAVAILABLE");
  await assert.rejects(
    () =>
      saveOptimizationPolicy(owner.id, {
        recommendation_id: unavailable.id,
        category: "go-backend",
        enabled: true,
      }),
    /supported/,
  );
  setHandoffReadinessForTests(undefined);
  const metrics = await evaluationAnalytics(
    owner,
    url("&category=go-backend&from=2026-11-01T12:00:00Z&to=2026-11-01T12:00:01Z"),
  );
  assert.equal(metrics.production.length, 0);
});

test("observational verification coverage, unknown cost and timezone boundaries stay truthful", async () => {
  await definitions.create({
    key: "p6-production",
    spec: {
      name: "Production analytics fixture",
      steps: [{ key: "implementation", type: "coding_agent" }],
    },
  });
  for (const passed of [true, false]) {
    const r = await startRun({
      definitionKey: "p6-production",
      ownerId: owner.id,
      start: false,
      agentProvider: "codex",
      inputs: { task_category: "go-backend" },
    });
    const s = (await getRun(r.id)).steps[0];
    const a = await one(
      pool,
      "INSERT INTO workflow_step_attempts(step_id,run_id,number,generation,status,metrics,started_at,finished_at) VALUES($1,$2,1,$3,$4,$5,'2026-11-01T23:30:00Z','2026-11-01T23:30:10Z') RETURNING id",
      [
        s.id,
        r.id,
        s.generation,
        passed ? "COMPLETED" : "FAILED",
        JSON.stringify({
          provider: "codex",
          model: "gpt-test",
          verification: { passed },
          cost_usd: passed ? null : 0.25,
          tokens: null,
        }),
      ],
    );
    await q(
      pool,
      "UPDATE workflow_runs SET status=$2,created_at='2026-11-01T23:30:00Z' WHERE id=$1",
      [r.id, passed ? "COMPLETED" : "FAILED"],
    );
    await q(pool, "UPDATE workflow_steps SET current_attempt_id=$2,status=$3 WHERE id=$1", [
      s.id,
      a.id,
      passed ? "COMPLETED" : "FAILED",
    ]);
  }
  const bkk = await evaluationAnalytics(
    owner,
    new URL(
      "http://local/?from=2026-11-02&to=2026-11-03&timezone=Asia/Bangkok&provider=codex&category=go-backend",
    ),
  );
  assert.equal(bkk.production[0].attempts, 2);
  assert.equal(bkk.production[0].verified_success_rate, 0.5);
  assert.equal(bkk.production[0].verified_coverage, 2);
  assert.equal(bkk.production[0].cost_known, 1);
  assert.equal(bkk.production[0].reported_cost_usd, 0.25);
  const utc = await evaluationAnalytics(
    owner,
    new URL(
      "http://local/?from=2026-11-02&to=2026-11-03&timezone=UTC&provider=codex&category=go-backend",
    ),
  );
  assert.equal(utc.production.length, 0);
  const otherScope = await evaluationAnalytics(
    other,
    new URL(`http://local/?from=2026-11-01&to=2026-11-03&timezone=UTC&user=${owner.id}`),
  );
  assert.equal(otherScope.production.length, 0);
  assert.equal(otherScope.details.length, 0);
});

test("context value assessment uses paired task outcomes, not fixture or agent claims", () => {
  const cfg = { mode: "live", provider_sequence: plan(["codex"]), context_variant: "minimal" };
  const trials = (win: boolean) =>
    Array.from({ length: 12 }, (_, i) =>
      [1, 2].map((repetition) => ({
        task_id: `task-${i}`,
        repetition,
        status: win ? "PASS" : "FAIL",
        correct: win,
        hard_gates_passed: win,
        completion_duration_ms: win ? 50 : 100,
        data: { evidence: { details: { evidence_kind: "live_provider" } } },
      })),
    ).flat();
  const a = { configuration: cfg, status: "COMPLETED", cases: trials(false) },
    b = {
      configuration: { ...cfg, context_variant: "tools" },
      status: "COMPLETED",
      cases: trials(true),
    };
  assert.equal(compareContextEffect(a, b)?.status, "MEASURABLE_QUALITY_GAIN");
  assert.equal(
    compareContextEffect({ ...a, configuration: { ...cfg, mode: "fixture" } }, b)?.status,
    "HARNESS_CONTROL_ONLY",
  );
  assert.equal(
    compareContextEffect({ ...a, cases: a.cases.slice(0, 4) }, { ...b, cases: b.cases.slice(0, 4) })
      ?.status,
    "INSUFFICIENT_EVIDENCE",
  );
});
