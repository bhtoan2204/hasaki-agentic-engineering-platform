import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { migrate } from "../src/db/migrate.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  beginAttempt,
  finishAttempt,
  cancelRun,
  setStepAgent,
  retryStep,
  getRun,
  reapExpiredLeases,
  answerQuestions,
} from "../src/workflow/engine.ts";
import { claimJob, processJob } from "../src/workflow/scheduler.ts";
import { registerExecutor, makeContext } from "../src/workflow/executors/registry.ts";
import { resolveStepAgent, StepAgentConfig, validateAgentOptions } from "../src/agent/stepAgent.ts";
import { ensureContextPack } from "../src/context/pack.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { envFromExecution, dispatchPlatformTool } from "../src/agent/platformTools.ts";
import { decide } from "../src/agent/toolPolicy.ts";
import { runWorkingDirectory } from "../src/repos/workspaces.ts";
import { claudeExecutor, resumableSession } from "../src/agent/claude.ts";
import { handle } from "../src/http/app.ts";
import type { ExecResult } from "../src/workflow/types.ts";

let owner: PublicUser, other: PublicUser, admin: PublicUser, server: Server, base: string;
let seq = 0;
const runs: number[] = [];
const policy = { mode: "analysis" as const, workspaces: [], baseBranch: "main" };
before(async () => {
  await migrate();
  owner = await createUser({ username: "routing-owner", password: "routing-password", role: "member" });
  other = await createUser({ username: "routing-other", password: "routing-password", role: "member" });
  admin = await createUser({ username: "routing-admin", password: "routing-password", role: "admin" });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  for (const id of runs.splice(0))
    if (!["COMPLETED", "FAILED", "CANCELED"].includes((await getRun(id)).status)) await cancelRun(id);
});
after(async () => {
  server.close();
  await pool.end();
});
async function run(steps: any[], provider: "claude" | "codex" | "cursor" = "claude") {
  const key = `routing-${++seq}`;
  await definitions.create({ key, spec: { name: key, steps } });
  const r = await startRun({ definitionKey: key, ownerId: owner.id, agentProvider: provider, profile: "STANDARD" });
  runs.push(r.id);
  return r;
}
const agent = (key: string, provider?: string, depends_on: string[] = [], type = "agent") => ({
  key,
  type,
  depends_on,
  config: { instructions: "Investigate safely", ...(provider ? { agent: { provider } } : {}) },
});
async function begin() {
  const j = await claimJob("routing-test", 120);
  assert.ok(j);
  const b = await beginAttempt(j, "routing-test");
  return { j, b };
}
async function finish(
  x: Awaited<ReturnType<typeof begin>>,
  result: ExecResult = { kind: "completed", output: { summary: "done" } },
) {
  assert.ok(x.b);
  return finishAttempt(x.j.id, x.j.fencing_token, x.b.attempt.id, result);
}

test("provider precedence, provider-specific model routing and nullable defaults", () => {
  const r = { agent_provider: "cursor", profile: "DEEP" };
  assert.equal(resolveStepAgent(r, agent("one"))?.provider, "cursor");
  const step = {
    ...agent("one", "claude"),
    config: { agent: { provider: "claude", model: "claude-test", reasoning_effort: "high" } },
  };
  assert.equal(resolveStepAgent(r, step)?.provider, "claude");
  const overridden = resolveStepAgent(r, { ...step, agent_override: { provider: "codex", model: "gpt-test" } })!;
  assert.equal(overridden.provider, "codex");
  assert.equal(overridden.model, "gpt-test");
  assert.notEqual(overridden.reasoning_effort, "high");
  assert.equal(resolveStepAgent({}, agent("legacy"))?.provider, "claude");
  const original = config.agent.defaultProvider;
  try {
    config.agent.defaultProvider = "cursor";
    assert.equal(resolveStepAgent({}, agent("platform"))?.provider, "cursor");
  } finally {
    config.agent.defaultProvider = original;
  }
  assert.equal(
    resolveStepAgent(
      { agent_provider: "codex" },
      { type: "agent", config: { model: "claude-legacy", codex_model: "gpt-test" } },
    )?.model,
    "gpt-test",
  );
});

test("invalid provider options, unknown fields and inherited model mismatches fail before execution", async () => {
  for (const a of [
    { provider: "codex", model: "claude-test" },
    { provider: "claude", model: "gpt-test" },
    { provider: "cursor", reasoning_effort: "high" },
    { provider: "cursor", allowed_tools: [] },
    { provider: "codex", reasoning_effort: "max" },
  ])
    assert.throws(() => validateAgentOptions(StepAgentConfig.parse(a)));
  assert.equal(StepAgentConfig.safeParse({ provider: "other" }).success, false);
  assert.equal(StepAgentConfig.safeParse({ sdk_options: { bypass: true } }).success, false);
  await assert.rejects(
    () => run([{ ...agent("one"), config: { agent: { model: "claude-test" } } }], "codex"),
    /Claude model/,
  );
});

test("one durable DAG executes Claude → Codex → Cursor and keeps portable context", async () => {
  const r = await run([
    agent("research", "claude"),
    agent("implement", "codex", ["research"], "coding_agent"),
    agent("verify", "cursor", ["implement"]),
  ]);
  for (const [key, provider] of [
    ["research", "claude"],
    ["implement", "codex"],
    ["verify", "cursor"],
  ]) {
    const x = await begin();
    assert.ok(x.b);
    assert.equal(x.b.step.key, key);
    assert.equal(x.b.attempt.agent_provider, provider);
    const ctx = makeContext({ ...x.b, signal: new AbortController().signal });
    const pack = await ensureContextPack(ctx, newMetrics(""), {
      ...policy,
      mode: key === "implement" ? "coding" : "analysis",
    });
    assert.ok(pack.id);
    assert.ok(pack.estimated_tokens <= pack.budget_tokens);
    if (key !== "research") assert.match(JSON.stringify(pack), /done/);
    await finish(x);
  }
  const rows = await q(pool, "SELECT * FROM execution_attempt_telemetry WHERE run_id=$1 ORDER BY attempt_id", [r.id]);
  assert.deepEqual(
    rows.map((a) => a.provider),
    ["claude", "codex", "cursor"],
  );
  assert.ok(rows.every((a) => a.reported_cost_usd === null));
  assert.equal((await getRun(r.id)).status, "COMPLETED");
  await assert.rejects(
    () => q(pool, "UPDATE workflow_step_attempts SET agent_provider='claude' WHERE id=$1", [rows[1].attempt_id]),
    /immutable/,
  );
});

test("mixed read-only branches run concurrently with isolated agent directories; writer waits", async () => {
  const r = await run([agent("a", "claude"), agent("b", "codex"), agent("writer", "cursor", [], "coding_agent")]);
  const x = await begin(),
    y = await begin();
  assert.ok(x.b);
  assert.ok(y.b);
  assert.notEqual(await runWorkingDirectory(r.id, x.b.step.id), await runWorkingDirectory(r.id, y.b.step.id));
  const blocked = await begin();
  assert.equal(blocked.b, null);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE run_id=$1", [r.id])).n, 2);
  await finish(x);
  await finish(y);
  await q(pool, "UPDATE workflow_jobs SET available_at=now() WHERE id=$1", [blocked.j.id]);
  const writer = await begin();
  assert.equal(writer.b?.attempt.agent_provider, "cursor");
  await finish(writer);
});

test("manual retry override never relabels earlier metrics or resumes a foreign provider session", async () => {
  const r = await run([agent("one", "claude")]);
  const first = await begin();
  assert.ok(first.b);
  await q(
    pool,
    "INSERT INTO agent_sessions(attempt_id,session_id,cwd,provider,resumable) VALUES($1,'claude-only','/tmp/routing','claude',true)",
    [first.b.attempt.id],
  );
  await finish(first, { kind: "failed", error: "agent failed", retryable: false });
  await setStepAgent(r.id, "one", { provider: "codex", model: "gpt-test" }, owner.id);
  await retryStep(r.id, "one");
  const second = await begin();
  assert.ok(second.b);
  assert.equal(second.b.attempt.agent_provider, "codex");
  const ctx = makeContext({ ...second.b, signal: new AbortController().signal });
  ctx.input.pending = { resume: { from_attempt_id: first.b.attempt.id } } as any;
  assert.equal(await resumableSession(ctx, "/tmp/routing", "codex"), null);
  await finish(second);
  const attempts = await q(
    pool,
    "SELECT agent_provider,agent_model FROM workflow_step_attempts WHERE run_id=$1 ORDER BY id",
    [r.id],
  );
  assert.deepEqual(
    attempts.map((a) => a.agent_provider),
    ["claude", "codex"],
  );
  assert.equal(attempts[1].agent_model, "gpt-test");
});

test("attempt retry policy and execution deadline use pinned step configuration", async () => {
  const s = agent("one", "codex");
  s.config.agent = { provider: "codex", retry: { max_attempts: 2, backoff_seconds: 0 }, timeout_ms: 1000 } as any;
  const r = await run([s]);
  registerExecutor("agent", {
    execute: (ctx) =>
      new Promise((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve({ kind: "failed", error: "aborted", retryable: false }), {
          once: true,
        }),
      ),
  });
  const job = await claimJob("deadline", 120);
  assert.ok(job);
  await processJob(job, "deadline", { leaseSeconds: 120, heartbeatSeconds: 10 });
  assert.equal((await getRun(r.id)).steps[0].status, "RETRYING");
  const x = await begin();
  assert.equal(x.b?.attempt.number, 2);
  await finish(x);
  const rows = await q(
    pool,
    "SELECT normalized_failure_category FROM execution_attempt_telemetry WHERE run_id=$1 ORDER BY attempt_id",
    [r.id],
  );
  assert.equal(rows[0].normalized_failure_category, "EXECUTION_TIMEOUT");
});

test("custom tools intersect baseline policy and cannot bypass via call_tool aliases", async () => {
  const s = agent("one", "codex");
  s.config.agent = { provider: "codex", allowed_tools: ["Read", "platform.get_run_context"] } as any;
  await run([s]);
  const x = await begin();
  assert.ok(x.b);
  const ctx = makeContext({ ...x.b, signal: new AbortController().signal });
  const env = envFromExecution(ctx, "analysis", { ...policy, allowedTools: ["Bash"] }, newMetrics(""), () => {});
  assert.match(
    await dispatchPlatformTool("call_tool", { name: "platform.search_code", arguments: { query: "x" } }, env),
    /excluded/,
  );
  assert.equal(decide("Bash", { command: "ls" }, { ...policy, allowedTools: ["Read"] }).allow, false);
  assert.equal(decide("Write", { file_path: "/tmp/x" }, { ...policy, allowedTools: ["Write"] }).allow, false);
  assert.equal(decide("mcp__platform__submit_result", {}, { ...policy, allowedTools: [] }).allow, true);
});

async function client(user: PublicUser) {
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: "routing-password" }),
  });
  const body = await login.json();
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  return async (path: string, value: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": body.csrf },
      body: JSON.stringify(value),
    });
}
test("override endpoint preserves ownership and explicit audited admin scope; active attempts reject changes", async () => {
  const r = await run([agent("one")]);
  const path = `/api/runs/${r.id}/steps/one/agent`;
  const a = await client(owner),
    b = await client(other),
    support = await client(admin);
  assert.equal((await b(path, { agent: { provider: "cursor" } })).status, 404);
  assert.equal((await support(path, { agent: { provider: "cursor" } })).status, 404);
  assert.equal((await support(path + "?scope=all", { agent: { provider: "codex" } })).status, 200);
  const x = await begin();
  assert.equal(x.b?.attempt.agent_provider, "codex");
  assert.equal((await a(path, { agent: { provider: "cursor" } })).status, 409);
  assert.ok(
    await one(pool, "SELECT id FROM audit_log WHERE actor_id=$1 AND action='support.access' AND resource_id=$2", [
      admin.id,
      String(r.id),
    ]),
  );
  assert.ok(
    await one(pool, "SELECT id FROM audit_log WHERE actor_id=$1 AND action='step.agent_override' AND resource_id=$2", [
      admin.id,
      String(r.id),
    ]),
  );
  await cancelRun(r.id);
  assert.equal((await a(path, { agent: { provider: "cursor" } })).status, 409);
});

test("shared executor routes a Claude-default run to the real Codex CLI adapter", async () => {
  const envKeys = [
    "CODEX_BIN",
    "CODEX_MODEL",
    "CODEX_REASONING_EFFORT",
    "FAKE_CODEX_MODE",
    "FAKE_CODEX_LOG",
    "CLAUDE_CODE_EXECUTABLE",
  ];
  const old = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  try {
    const logfile = join(process.env.TEST_ROOT!, "step-codex.jsonl");
    Object.assign(process.env, {
      CODEX_BIN: join(import.meta.dirname, "fixtures/fake-codex.mjs"),
      CODEX_MODEL: "gpt-test",
      CODEX_REASONING_EFFORT: "low",
      FAKE_CODEX_MODE: "ok",
      FAKE_CODEX_LOG: logfile,
      CLAUDE_CODE_EXECUTABLE: "/does-not-exist-phase4",
    });
    const r = await run([
      {
        ...agent("implementation", "codex"),
        config: { agent: { provider: "codex", model: "gpt-test", reasoning_effort: "low" } },
      },
      { key: "approval", type: "human_input", depends_on: ["implementation"] },
    ]);
    registerExecutor("agent", claudeExecutor);
    const job = await claimJob("real-adapter", 120);
    assert.ok(job);
    await processJob(job, "real-adapter", { leaseSeconds: 120, heartbeatSeconds: 10 });
    const attempt = await one(pool, "SELECT * FROM workflow_step_attempts WHERE run_id=$1", [r.id]);
    assert.equal(attempt.status, "COMPLETED");
    assert.equal(attempt.agent_provider, "codex");
    assert.equal(attempt.metrics.provider, "codex");
    assert.equal(attempt.metrics.cost_usd, null);
    assert.equal(attempt.metrics.tokens.input, 120);
    assert.equal(attempt.metrics.tokens.cache_read, 100);
    const calls = readFileSync(logfile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((l) => l.argv);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argv.includes('model="gpt-test"'));
    assert.deepEqual(
      calls[0].argv.filter((a: string) => a.startsWith("model=")),
      ['model="gpt-test"'],
    );
    await cancelRun(r.id);
    process.env.FAKE_CODEX_MODE = "hang";
    process.env.FAKE_CODEX_PIDFILE = join(process.env.TEST_ROOT!, "deadline-child.pid");
    const timed = await run([
      { ...agent("timeout", "codex"), config: { agent: { provider: "codex", model: "gpt-test", timeout_ms: 1000 } } },
    ]);
    const slow = await claimJob("adapter-timeout", 120);
    assert.ok(slow);
    await processJob(slow, "adapter-timeout", { leaseSeconds: 120, heartbeatSeconds: 10 });
    const timedTelemetry = await one(
      pool,
      "SELECT normalized_failure_category,reported_cost_usd,input_tokens FROM execution_attempt_telemetry WHERE run_id=$1",
      [timed.id],
    );
    assert.equal(timedTelemetry.normalized_failure_category, "EXECUTION_TIMEOUT");
    assert.equal(timedTelemetry.reported_cost_usd, null);
    assert.equal(timedTelemetry.input_tokens, null);
    delete process.env.FAKE_CODEX_PIDFILE;
  } finally {
    for (const key of envKeys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});

test("recovery keeps original provider session evidence and permits a portable provider switch", async () => {
  const r = await run([agent("one", "codex")]);
  const first = await begin();
  assert.ok(first.b);
  const ctx = makeContext({ ...first.b, signal: new AbortController().signal });
  const pack = await ensureContextPack(ctx, newMetrics(""), policy);
  assert.ok(pack.id);
  await q(
    pool,
    "INSERT INTO agent_sessions(attempt_id,session_id,cwd,provider,resumable) VALUES($1,'codex-recovery','/tmp/recovery','codex',true)",
    [first.b.attempt.id],
  );
  await q(pool, "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [first.j.id]);
  await reapExpiredLeases();
  const step = (await getRun(r.id)).steps[0];
  assert.equal(step.status, "WAITING_INPUT");
  assert.equal(step.pending_input.resume.checkpoint.session_id, "codex-recovery");
  await setStepAgent(r.id, "one", { provider: "cursor" }, owner.id);
  const question = await one(pool, "SELECT id,options FROM workflow_questions WHERE step_id=$1 AND status='open'", [
    step.id,
  ]);
  assert.ok(question);
  await answerQuestions({ [question.id]: question.options[0] });
  const second = await begin();
  assert.ok(second.b);
  assert.equal(second.b.attempt.number, 2);
  assert.equal(second.b.attempt.agent_provider, "cursor");
  const next = makeContext({ ...second.b, signal: new AbortController().signal });
  assert.equal(await resumableSession(next, "/tmp/recovery", "cursor"), null);
  const continued = await ensureContextPack(next, newMetrics(""), policy);
  assert.ok(continued.id);
  assert.ok(JSON.stringify(continued).includes("checkpoint"));
  await cancelRun(r.id);
  const telemetry = await q(
    pool,
    "SELECT provider,terminal_status FROM execution_attempt_telemetry WHERE run_id=$1 ORDER BY attempt_id",
    [r.id],
  );
  assert.deepEqual(
    telemetry.map((t) => t.provider),
    ["codex", "cursor"],
  );
  assert.equal(telemetry[1].terminal_status, "CANCELED");
});

test("manual override cannot replace trusted verification or broaden a restrictive workflow allowlist", async () => {
  const r = await run([
    { ...agent("one", "claude"), config: { agent: { provider: "claude", allowed_tools: ["Read"] } } },
  ]);
  await assert.rejects(
    () => setStepAgent(r.id, "one", { verification: { command: "untrusted" } }, owner.id),
    /Unrecognized/,
  );
  await assert.rejects(() => setStepAgent(r.id, "one", { allowed_tools: ["Read", "Bash"] }, owner.id), /subset/);
  await assert.rejects(() => setStepAgent(r.id, "one", { allowed_tools: null }, owner.id), /subset/);
  assert.equal(
    (await setStepAgent(r.id, "one", { provider: "codex", allowed_tools: [] }, owner.id)).effective_agent?.provider,
    "codex",
  );
});

test("FAST run optimization preserves explicit provider boundaries", async () => {
  const key = `routing-fast-${++seq}`;
  const steps = [
    agent("research", "claude"),
    agent("implementation", "codex", ["research"], "coding_agent"),
    agent("verification", "cursor", ["implementation"]),
  ];
  await definitions.create({ key, spec: { name: key, steps } });
  const r = await startRun({ definitionKey: key, ownerId: owner.id, profile: "FAST" });
  runs.push(r.id);
  assert.equal(r.profile, "STANDARD");
  assert.deepEqual(
    r.graph.steps.map((s) => s.key),
    steps.map((s) => s.key),
  );
  assert.match(JSON.stringify(r.profile_decision), /execution boundary/);
});
