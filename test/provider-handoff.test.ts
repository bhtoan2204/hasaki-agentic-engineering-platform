import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  getRun,
  cancelRun,
  stopStep,
  requestProviderHandoff,
  resumeProviderHandoff,
  finishAttempt,
  processAutomaticHandoff,
  reapExpiredLeases,
  beginAttempt,
  retryStep,
  answerQuestions,
  stepDetail,
} from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import {
  claimJob,
  processJob,
  reconcileAutomaticHandoff,
  runOnce,
  startScheduler,
} from "../src/workflow/scheduler.ts";
import { registerExecutor, type ExecutionContext } from "../src/workflow/executors/registry.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { repositories } from "../src/repos/service.ts";
import { recordWorkspace } from "../src/git/provider.ts";
import { ensureContextPack } from "../src/context/pack.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { dispatchPlatformTool, envFromExecution } from "../src/agent/platformTools.ts";
import { resumableSession } from "../src/agent/claude.ts";
import { handle } from "../src/http/app.ts";
import { config } from "../src/config.ts";
import type { ExecResult } from "../src/workflow/types.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
let owner: PublicUser,
  other: PublicUser,
  admin: PublicUser,
  server: Server,
  base: string,
  seq = 0;
const runs: number[] = [];
let execute: (ctx: ExecutionContext) => Promise<ExecResult>;
const seen: ExecutionContext[] = [];
const policy = { mode: "coding" as const, baseBranch: "main", workspaces: [] };
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  owner = await createUser({
    username: "handoff-owner",
    password: "handoff-password",
    role: "member",
  });
  other = await createUser({
    username: "handoff-other",
    password: "handoff-password",
    role: "member",
  });
  admin = await createUser({
    username: "handoff-admin",
    password: "handoff-password",
    role: "admin",
  });
  registerExecutor("coding_agent", {
    execute: async (ctx) => {
      seen.push(ctx);
      return execute(ctx);
    },
  });
  registerExecutor("agent", {
    execute: async (ctx) => {
      seen.push(ctx);
      return execute(ctx);
    },
  });
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  for (const id of runs.splice(0))
    if (!["CANCELED", "COMPLETED", "FAILED"].includes((await getRun(id)).status))
      await cancelRun(id);
  await settleBackground();
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
});
after(async () => {
  setHandoffReadinessForTests(undefined);
  server.close();
  await settleBackground();
  await pool.end();
});
async function run(provider = "claude", fallback: any = {}, extra: any = {}) {
  const key = `handoff-${++seq}`;
  await definitions.create({
    key,
    spec: {
      name: key,
      steps: [
        {
          key: "implement",
          type: "coding_agent",
          config: {
            instructions: "Preserve original business constraints and finish the task",
            agent: { provider, fallback, ...extra },
          },
        },
      ],
    },
  });
  const r = await startRun({
    definitionKey: key,
    ownerId: owner.id,
    agentProvider: "claude",
    profile: "STANDARD",
  });
  runs.push(r.id);
  return r;
}
async function once() {
  const j = await claimJob("handoff-worker", 120);
  assert.ok(j);
  await processJob(j, "handoff-worker", { leaseSeconds: 120, heartbeatSeconds: 1 });
  return j;
}
const fail = (code: string, message = code): ExecResult => ({
  kind: "failed",
  error: message,
  retryable: false,
  details: { provider_error: { code, message } },
});
async function quota() {
  execute = async () => fail("quota_exhausted", "Usage limit reached; api_key=supersecretvalue");
}
async function checkpoint(id: number) {
  return one(pool, "SELECT * FROM provider_handoffs WHERE run_id=$1 ORDER BY id DESC LIMIT 1", [
    id,
  ]);
}
const resume = (r: number, h: any, provider: string, actor: number = owner.id) =>
  resumeProviderHandoff(
    r,
    "implement",
    {
      handoff_id: h.id,
      expected_attempt_id: h.source_attempt_id,
      provider,
      model: null,
      confirm: true,
      checkpoint_fingerprint: h.workspace_fingerprint ?? "0".repeat(64),
    },
    actor,
  );
function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}
async function workspace(r: any) {
  await repositories.upsert("fixture", { description: "Handoff fixture" });
  await q(pool, "UPDATE workflow_runs SET allowed_repositories=ARRAY['fixture'] WHERE id=$1", [
    r.id,
  ]);
  const path = mkdtempSync(join(process.env.TEST_ROOT!, "handoff-wt-"));
  execFileSync("git", ["init", "-q", "-b", r.branch, path]);
  writeFileSync(join(path, "task.txt"), "original\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "baseline");
  await recordWorkspace(r.id, { repo: "fixture", path, branch: r.branch, created_from: "fixture" });
  return path;
}

test("quota pauses durably with redacted provider-neutral package; Claude → Codex preserves dirty Git and context", async () => {
  const r = await run();
  const path = await workspace(r);
  execute = async (ctx) => {
    await ensureContextPack(ctx, newMetrics(""), { ...policy, workspaces: [path] });
    writeFileSync(join(path, "task.txt"), "Claude partially implemented\n");
    await q(
      pool,
      "INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data) VALUES($1,$2,$3,'progress',$4)",
      [
        ctx.run.id,
        ctx.step.id,
        ctx.attempt.id,
        JSON.stringify({ decisions: ["Preserve idempotency"], unfinished: ["Run tests"] }),
      ],
    );
    return fail("quota_exhausted", "Usage limit reached api_key=supersecretvalue");
  };
  const job = await once();
  const h = await checkpoint(r.id);
  assert.equal(h.status, "READY");
  assert.equal(h.failure_category, "QUOTA_EXHAUSTED");
  assert.equal((await getRun(r.id)).status, "WAITING");
  assert.ok(h.package.repository_state[0].diff_hash);
  // Verified context travels with the handoff so the next provider does not re-investigate from scratch.
  assert.ok(Array.isArray(h.package.tests_already_executed));
  assert.ok(
    Array.isArray(h.package.missing_verification) &&
      h.package.missing_verification.includes(
        "no passing test run on the current workspace commits",
      ),
    "unverified state is explicit",
  );
  assert.ok("approved_scope" in h.package && "evidence_summary" in h.package);
  assert.ok(!JSON.stringify(h).includes("supersecretvalue"));
  assert.equal(
    (
      await one(pool, "SELECT status,lease_owner,lease_expires_at FROM workflow_jobs WHERE id=$1", [
        job.id,
      ])
    ).lease_expires_at,
    null,
  );
  const duplicate = await Promise.all([resume(r.id, h, "codex"), resume(r.id, h, "codex")]);
  assert.equal(duplicate.filter((x) => !x.duplicate).length, 1);
  execute = async (ctx) => {
    assert.equal(ctx.attempt.agent_provider, "codex");
    assert.match(readFileSync(join(path, "task.txt"), "utf8"), /Claude partially/);
    assert.equal(await resumableSession(ctx, path, "codex"), null);
    const pack = await ensureContextPack(ctx, newMetrics(""), { ...policy, workspaces: [path] });
    assert.match(JSON.stringify(pack), /provider_handoff/);
    const env = envFromExecution(
      ctx,
      "coding",
      { ...policy, workspaces: [path] },
      newMetrics(""),
      () => {},
    );
    assert.match(
      await dispatchPlatformTool("get_run_context", { section: "all", offset: 0, limit: 20 }, env),
      /provider_handoff/,
    );
    const original = await dispatchPlatformTool(
      "get_run_context",
      { section: "all", offset: 0, limit: 1, handoff_source_pack: true, handoff_limit: 12000 },
      env,
    );
    const sourcePack = JSON.parse(JSON.parse(original).provider_handoff.content);
    assert.equal(sourcePack.attempt_id, h.source_attempt_id);
    assert.notEqual(sourcePack.attempt_id, ctx.attempt.id);
    await ctx.recordMetrics({ provider: "codex", verification: { overall: "passed" } });
    return {
      kind: "completed",
      output: { summary: "continued", verification: { overall: "passed" } },
    };
  };
  const claims = await Promise.all([
    claimJob("competing-one", 120),
    claimJob("competing-two", 120),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const continuation = claims.find(Boolean)!;
  await processJob(continuation, "competing-one", { leaseSeconds: 120, heartbeatSeconds: 1 });
  assert.equal((await getRun(r.id)).status, "COMPLETED");
  assert.equal(
    (
      await finishAttempt(job.id, job.fencing_token, h.source_attempt_id, {
        kind: "completed",
        output: { stale: true },
      })
    ).applied,
    false,
  );
  const rows = await q(
    pool,
    "SELECT agent_provider,status FROM workflow_step_attempts WHERE run_id=$1 ORDER BY id",
    [r.id],
  );
  assert.deepEqual(
    rows.map((a) => a.agent_provider),
    ["claude", "codex"],
  );
  assert.deepEqual(
    rows.map((a) => a.status),
    ["FAILED", "COMPLETED"],
  );
  const metrics = await one(pool, "SELECT * FROM provider_handoff_metrics WHERE id=$1", [h.id]);
  assert.equal(
    metrics.target_attempt_id,
    (await one(pool, "SELECT id FROM workflow_step_attempts WHERE job_id=$1", [continuation.id]))
      .id,
  );
  assert.equal(metrics.reported_cost_usd, null);
  assert.ok(metrics.handoff_duration_ms >= 0);
  assert.deepEqual(metrics.final_verification_result, { overall: "passed" });
});

test("manual in-progress Codex → Cursor waits for cancellation and creates a fresh attempt", async () => {
  const r = await run("codex");
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  execute = async (ctx) => {
    entered();
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener(
        "abort",
        () => {
          release = () => {
            resolve();
          };
        },
        { once: true },
      ),
    );
    return fail("canceled");
  };
  const job = await claimJob("in-progress", 120);
  assert.ok(job);
  const processing = processJob(job, "in-progress", { leaseSeconds: 120, heartbeatSeconds: 1 });
  await started;
  const source = seen.at(-1)!;
  const h = await requestProviderHandoff(
    r.id,
    "implement",
    { expected_attempt_id: source.attempt.id, reason: "Switch while running" },
    owner.id,
  );
  assert.equal(h.status, "STOPPING");
  await assert.rejects(() => resume(r.id, h, "cursor"), /not ready/);
  release();
  await processing;
  void stopped;
  const ready = await checkpoint(r.id);
  assert.equal(ready.status, "READY");
  assert.equal(
    (await one(pool, "SELECT status FROM workflow_step_attempts WHERE id=$1", [source.attempt.id]))
      .status,
    "CANCELED",
  );
  await resume(r.id, ready, "cursor");
  execute = async (ctx) => {
    assert.equal(ctx.attempt.agent_provider, "cursor");
    assert.notEqual(ctx.attempt.id, source.attempt.id);
    return { kind: "completed", output: { summary: "Cursor finished" } };
  };
  await once();
  assert.equal((await getRun(r.id)).status, "COMPLETED");
});

test("workspace drift, unavailable providers and wrong workers block continuation", async () => {
  const r = await run();
  const path = await workspace(r);
  await quota();
  await once();
  const h = await checkpoint(r.id);
  setHandoffReadinessForTests(async () => ({
    ok: false,
    error: "Not logged in",
    quota: "unknown",
    cost: "unknown",
  }));
  await assert.rejects(() => resume(r.id, h, "codex"), /Not logged in/);
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  writeFileSync(join(path, "task.txt"), "changed after checkpoint");
  await assert.rejects(() => resume(r.id, h, "codex"), /Workspace changed/);
  await q(pool, "UPDATE workflow_runs SET worker_instance='different-worker' WHERE id=$1", [r.id]);
  await assert.rejects(() => resume(r.id, h, "codex"), /assigned worker/);
  await q(pool, "UPDATE workflow_runs SET worker_instance=$2 WHERE id=$1", [
    r.id,
    config.instanceId,
  ]);
  assert.equal((await checkpoint(r.id)).status, "READY");
  const fresh = await requestProviderHandoff(
    r.id,
    "implement",
    { expected_attempt_id: h.source_attempt_id, reason: "Review edited workspace" },
    owner.id,
  );
  assert.notEqual(fresh.workspace_fingerprint, h.workspace_fingerprint);
  await assert.rejects(() => resume(r.id, h, "codex"), /Checkpoint changed/);
  await repositories.upsert("fixture", { enabled: false });
  await assert.rejects(() => resume(r.id, fresh, "codex"), /permissions/);
  await repositories.upsert("fixture", { enabled: true });
  await resume(r.id, fresh, "codex");
});

test("automatic mode requires explicit cost permission, excludes auth/timeouts and never loops", async () => {
  const r = await run("claude", {
    mode: "automatic",
    providers: ["claude", "codex", "cursor"],
    max_switches: 2,
  });
  await quota();
  await once();
  const h = await checkpoint(r.id);
  await processAutomaticHandoff();
  assert.equal((await checkpoint(r.id)).status, "READY");
  assert.match((await checkpoint(r.id)).blocked_reason, /Unknown provider cost/);
  await q(
    pool,
    "UPDATE workflow_steps SET config=jsonb_set(config,'{agent,fallback,allow_unknown_cost}','true') WHERE run_id=$1",
    [r.id],
  );
  await q(pool, "UPDATE provider_handoffs SET next_check_at=now() WHERE id=$1", [h.id]);
  await processAutomaticHandoff();
  assert.equal((await checkpoint(r.id)).target_provider, "codex");
  await once();
  assert.equal((await checkpoint(r.id)).original_provider, "codex");
  await processAutomaticHandoff();
  assert.equal((await checkpoint(r.id)).target_provider, "cursor");
  await once();
  await processAutomaticHandoff();
  assert.equal((await checkpoint(r.id)).status, "READY");
  assert.match((await checkpoint(r.id)).blocked_reason, /loop|budget/);
});

test("authentication, context limits, timeouts and unknown structured provider failures pause for manual recovery", async () => {
  for (const code of [
    "authentication",
    "context_length_exceeded",
    "timeout",
    "unrecognized_provider_error",
  ]) {
    const r = await run("claude", { mode: "automatic", allow_unknown_cost: true });
    execute = async () => fail(code);
    await once();
    const h = await checkpoint(r.id);
    assert.equal(h.status, "READY");
    await processAutomaticHandoff();
    assert.equal((await checkpoint(r.id)).status, "READY");
    assert.equal((await getRun(r.id)).status, "WAITING");
    await cancelRun(r.id);
  }
});

test("rate limits retry with bounded backoff before handoff; timeout is not quota", async () => {
  const r = await run();
  execute = async () => ({ ...fail("rate_limit", "rate limit 429"), retryable: true });
  await once();
  assert.equal((await getRun(r.id)).steps[0].status, "RETRYING");
  assert.equal(await checkpoint(r.id), undefined);
  for (let i = 0; i < 2; i++) {
    await q(
      pool,
      "UPDATE workflow_jobs SET available_at=now() WHERE run_id=$1 AND status='queued'",
      [r.id],
    );
    await once();
  }
  assert.equal((await checkpoint(r.id)).failure_category, "RATE_LIMIT");
  const timed = await run("codex", { mode: "manual" }, { timeout_ms: 1000 });
  execute = (ctx) =>
    new Promise((resolve) =>
      ctx.signal.addEventListener("abort", () => resolve(fail("canceled")), { once: true }),
    );
  await once();
  assert.equal((await checkpoint(timed.id)).failure_category, "EXECUTION_TIMEOUT");
});

test("durable ready checkpoint survives scheduler restart; recovery blocks unconfirmed STOPPING executor", async () => {
  const r = await run();
  await quota();
  await once();
  const h = (await stepDetail(r.id, "implement")).handoffs[0];
  assert.equal(h.status, "READY");
  // A fresh Node process has no scheduler handles or application caches from the source execution.
  const restarted = execFileSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `
    const {setHandoffReadinessForTests}=await import(${JSON.stringify(new URL("../src/agent/handoff.ts", import.meta.url).href)});
    setHandoffReadinessForTests(async()=>({ok:true,quota:"unknown",cost:"unknown"}));
    const {resumeProviderHandoff}=await import(${JSON.stringify(new URL("../src/workflow/engine.ts", import.meta.url).href)});
    const result=await resumeProviderHandoff(${r.id},"implement",${JSON.stringify({ handoff_id: h.id, expected_attempt_id: h.source_attempt_id, provider: "codex", model: null, confirm: true, checkpoint_fingerprint: h.workspace_fingerprint })},${owner.id});
    console.log(result.handoff.status);
    await (await import(${JSON.stringify(new URL("../src/db/pool.ts", import.meta.url).href)})).pool.end();
  `,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(restarted.trim(), "RESUMED");
  execute = async () => ({ kind: "completed", output: { resumed_after_restart: true } });
  await once();
  const interrupted = await run("codex");
  const j = await claimJob("old-process", 120);
  assert.ok(j);
  const b = await beginAttempt(j, "old-process");
  assert.ok(b);
  await requestProviderHandoff(
    interrupted.id,
    "implement",
    { expected_attempt_id: b.attempt.id, reason: "Unresponsive process" },
    owner.id,
  );
  await q(pool, "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [
    j.id,
  ]);
  await reapExpiredLeases();
  const blocked = await checkpoint(interrupted.id);
  assert.equal(blocked.status, "BLOCKED");
  await assert.rejects(() => resume(interrupted.id, blocked, "cursor"), /not ready/);
  await assert.rejects(() => retryStep(interrupted.id, "implement"), /handoff/);
});

async function client(user: PublicUser) {
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: "handoff-password" }),
  });
  const body = await login.json();
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  return async (path: string, value?: unknown, csrf = true) =>
    fetch(base + path, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-csrf-token": csrf ? body.csrf : "",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
}
test("handoff endpoints enforce owner isolation, CSRF and explicit audited admin access", async () => {
  const r = await run();
  await quota();
  await once();
  const h = await checkpoint(r.id);
  const a = await client(owner),
    b = await client(other),
    support = await client(admin);
  const path = `/api/runs/${r.id}/steps/implement/handoff-resume`,
    body = {
      handoff_id: h.id,
      expected_attempt_id: h.source_attempt_id,
      provider: "codex",
      confirm: true,
      checkpoint_fingerprint: h.workspace_fingerprint ?? "0".repeat(64),
    };
  assert.equal((await a(path, body, false)).status, 403);
  assert.equal((await b(path, body)).status, 404);
  assert.equal((await support(path, body)).status, 404);
  assert.equal((await b(`/api/runs/${r.id}/handoffs`)).status, 404);
  assert.equal((await support(path + "?scope=all", body)).status, 200);
  assert.ok(
    await one(
      pool,
      "SELECT id FROM audit_log WHERE actor_id=$1 AND action='provider_handoff.resume'",
      [admin.id],
    ),
  );
  assert.ok(
    await one(pool, "SELECT id FROM audit_log WHERE actor_id=$1 AND action='support.access'", [
      admin.id,
    ]),
  );
  const metrics = await (await a(`/api/runs/${r.id}/handoffs`)).json();
  assert.equal(metrics[0].original_provider, "claude");
  await cancelRun(r.id);
  assert.equal((await a(path, body)).status, 409);
});

test("fallback disabled, existing approval gates, and reported budgets remain authoritative", async () => {
  const disabled = await run("claude", { mode: "disabled" });
  await quota();
  await once();
  assert.equal((await getRun(disabled.id)).status, "FAILED");
  assert.equal(await checkpoint(disabled.id), undefined);
  const r = await run("claude", {
    mode: "automatic",
    allow_unknown_cost: true,
    max_reported_cost_usd: 0,
  });
  await quota();
  await once();
  await processAutomaticHandoff();
  assert.equal((await checkpoint(r.id)).status, "READY");
  assert.match((await checkpoint(r.id)).blocked_reason, /cost limit/);
  await q(pool, "UPDATE workflow_steps SET requires_approval=true,approval=NULL WHERE run_id=$1", [
    r.id,
  ]);
  const h = await checkpoint(r.id);
  await assert.rejects(() => resume(r.id, h, "codex"), /approval gate/);
});

test("pending human answers are retained and cannot be bypassed by a provider switch", async () => {
  const r = await run();
  execute = async (ctx) => {
    await ctx.ask([
      { question: "Which acceptance criterion applies?", options: ["Preserve idempotency"] },
    ]);
    return fail("quota_exhausted");
  };
  await once();
  const h = await checkpoint(r.id);
  await assert.rejects(() => resume(r.id, h, "codex"), /pending human questions/);
  const question = await one(
    pool,
    "SELECT id FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [r.id],
  );
  await answerQuestions({ [question.id]: "Preserve idempotency" });
  assert.equal((await getRun(r.id)).steps[0].status, "WAITING_INPUT");
  assert.equal(
    (await q(pool, "SELECT id FROM workflow_jobs WHERE run_id=$1 AND status='queued'", [r.id]))
      .length,
    0,
  );
  await resume(r.id, h, "codex");
});

test("budget exhaustion and missing token coverage cannot silently start a fallback", async () => {
  const budget = await run("claude", { mode: "automatic", allow_unknown_cost: true });
  execute = async () => fail("quota_exhausted", "Billing hard limit: credits exhausted");
  await once();
  await processAutomaticHandoff();
  assert.equal((await checkpoint(budget.id)).status, "READY");
  assert.match((await checkpoint(budget.id)).blocked_reason, /Budget failure/);
  await cancelRun(budget.id);
  const tokens = await run("claude", {
    mode: "automatic",
    allow_unknown_cost: true,
    max_reported_tokens: 100,
  });
  await quota();
  await once();
  await processAutomaticHandoff();
  assert.equal((await checkpoint(tokens.id)).status, "READY");
  assert.match((await checkpoint(tokens.id)).blocked_reason, /token limit/);
});

test("switch racing executor completion blocks for reinspection instead of losing the request", async () => {
  const r = await run("codex");
  const job = await claimJob("completion-race", 120);
  assert.ok(job);
  const begun = await beginAttempt(job, "completion-race");
  assert.ok(begun);
  await q(pool, "UPDATE workflow_step_attempts SET executor_stopped_at=now() WHERE id=$1", [
    begun.attempt.id,
  ]);
  const requested = await requestProviderHandoff(
    r.id,
    "implement",
    { expected_attempt_id: begun.attempt.id, reason: "Racing completion" },
    owner.id,
  );
  assert.equal(requested.status, "STOPPING");
  assert.equal(
    (
      await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
        kind: "completed",
        output: { summary: "settled" },
      })
    ).applied,
    true,
  );
  const blocked = await checkpoint(r.id);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(
    (await one(pool, "SELECT output FROM workflow_step_attempts WHERE id=$1", [begun.attempt.id]))
      .output.summary,
    "settled",
  );
  assert.equal((await getRun(r.id)).status, "WAITING");
  const ready = await requestProviderHandoff(
    r.id,
    "implement",
    { expected_attempt_id: begun.attempt.id, reason: "Reinspect settled execution" },
    owner.id,
  );
  assert.equal(ready.status, "READY");
  await resume(r.id, ready, "cursor");
});

test("ordinary step cancellation retains termination proof for a later safe handoff", async () => {
  const r = await run("codex");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  execute = (ctx) =>
    new Promise((resolve) => {
      entered();
      ctx.signal.addEventListener("abort", () => resolve(fail("canceled")), { once: true });
    });
  const job = await claimJob("ordinary-stop", 120);
  assert.ok(job);
  const processing = processJob(job, "ordinary-stop", { leaseSeconds: 120, heartbeatSeconds: 1 });
  await started;
  const attempt = seen.at(-1)!.attempt;
  await stopStep(r.id, "implement", "User stopped step");
  await processing;
  assert.ok(
    (
      await one(pool, "SELECT executor_stopped_at FROM workflow_step_attempts WHERE id=$1", [
        attempt.id,
      ])
    ).executor_stopped_at,
  );
  const handoff = await requestProviderHandoff(
    r.id,
    "implement",
    { expected_attempt_id: attempt.id, reason: "Continue safely after stop" },
    owner.id,
  );
  assert.equal(handoff.status, "READY");
  await resume(r.id, handoff, "cursor");
});

async function readyAutomaticHandoff() {
  const r = await run("claude", {
    mode: "automatic",
    allow_unknown_cost: true,
    providers: ["claude", "codex"],
  });
  await quota();
  await once();
  const h = await checkpoint(r.id);
  assert.equal(h.status, "READY");
  assert.equal(h.target_provider, null);
  await q(
    pool,
    "UPDATE provider_handoffs SET next_check_at = now() + interval '1 hour' WHERE id = $1",
    [h.id],
  );
  return r;
}

test("claiming a job does not resume a due automatic handoff; runOnce still does", async () => {
  const r = await readyAutomaticHandoff();
  await q(pool, "UPDATE provider_handoffs SET next_check_at = now() WHERE run_id = $1", [r.id]);
  assert.equal(await claimJob("idle-claim", 120), undefined);
  assert.equal((await checkpoint(r.id)).status, "READY");
  assert.equal((await checkpoint(r.id)).target_provider, null);
  execute = async () => ({ kind: "completed", output: { continued: true } });
  assert.equal(
    await runOnce("manual-maintenance", { leaseSeconds: 120, heartbeatSeconds: 30 }),
    true,
  );
  assert.equal((await checkpoint(r.id)).target_provider, "codex");
  assert.equal((await getRun(r.id)).steps[0].status, "COMPLETED");
});

test("the scheduler reconciles one due automatic handoff without a per-claim scan", async () => {
  const r = await readyAutomaticHandoff();
  await q(pool, "UPDATE provider_handoffs SET next_check_at = now() WHERE run_id = $1", [r.id]);
  execute = async () => ({ kind: "completed", output: { continued: true } });
  const sched = startScheduler({
    workers: 1,
    lightWorkers: 0,
    leaseSeconds: 30,
    heartbeatSeconds: 5,
    pollMs: 30,
  });
  let provider: string | null = null;
  try {
    for (let i = 0; i < 40 && provider == null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      provider = (await checkpoint(r.id)).target_provider;
    }
  } finally {
    await sched.stop();
  }
  assert.equal(provider, "codex");
});

test("an in-flight automatic handoff scan does not start another, and the following scan is not skipped", async () => {
  const first = await readyAutomaticHandoff();
  const second = await readyAutomaticHandoff();
  await q(pool, "UPDATE provider_handoffs SET next_check_at = now() WHERE run_id = ANY($1)", [
    [first.id, second.id],
  ]);
  let release!: (value: { ok: true; quota: "unknown"; cost: "unknown" }) => void;
  let calls = 0;
  setHandoffReadinessForTests(
    () =>
      new Promise((resolve) => {
        calls += 1;
        release = resolve;
      }),
  );
  const started = reconcileAutomaticHandoff();
  for (let i = 0; i < 50 && calls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  const overlapped = reconcileAutomaticHandoff();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(overlapped, started);
  release({ ok: true, quota: "unknown", cost: "unknown" });
  await started;
  const resumed = [await checkpoint(first.id), await checkpoint(second.id)].filter(
    (h) => h.target_provider,
  );
  assert.equal(resumed.length, 1);
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  await reconcileAutomaticHandoff();
  assert.equal((await checkpoint(first.id)).target_provider, "codex");
  assert.equal((await checkpoint(second.id)).target_provider, "codex");
});
