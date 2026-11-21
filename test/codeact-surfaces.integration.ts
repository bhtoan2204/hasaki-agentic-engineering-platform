/**
 * CodeAct through the real surfaces (P1-A): the workflow dispatcher (`platform.execute_code`) and Chat
 * (`code.execute`). Nested calls go through the real registry, binding validation and audit; fake SigNoz/Splunk-style
 * integrations are registered as ordinary read-only registry tools. The program runs in a plain child process here
 * (setCodeActLauncherForTests): the OS sandbox itself is covered by test/codeact-sandbox.integration.ts.
 */
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, beginAttempt, cancelRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { makeContext } from "../src/workflow/executors/registry.ts";
import { workItems } from "../src/workitems/service.ts";
import { envFromExecution, dispatchPlatformTool } from "../src/agent/platformTools.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { registerIntegrationTool } from "../src/agent/toolRegistry.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const policy = {
  mode: "analysis" as const,
  workspaces: [],
  protectedRoots: [],
  baseBranch: "main",
};
const runs: number[] = [];
let owner: PublicUser;
const calls: string[] = [];
let mutated = 0;
let revokeOnCall: number | null = null;
/** fixture.wait: holds until its abort signal fires (records what it saw), or until released. */
const waits: Array<{ aborted: boolean; release: () => void }> = [];

// Fake SigNoz/Splunk-style data: 400 spans, 600 log events (all values fake).
const SPANS = Array.from({ length: 400 }, (_, i) => ({
  trace_id: `trace-${i}`,
  service: "payment-gateway",
  order_id: `ORD-${i % 80}`,
  duration_ms: i % 20 === 0 ? 9000 : 35,
  attributes: { "http.route": "/v1/pay", padding: "x".repeat(120) },
}));
const EVENTS = Array.from({ length: 600 }, (_, i) => ({
  _time: new Date(1_790_000_000_000 + i * 1000).toISOString(),
  order_id: `ORD-${i % 80}`,
  message: i % 4 === 0 ? "upstream timeout after 8s" : "payment accepted",
  raw: "y".repeat(160),
}));

before(async () => {
  await migrate();
  owner = await createUser({
    username: `codeact-${Date.now()}`,
    password: "codeact-pass",
    role: "member",
  });
  registerIntegrationTool({
    name: "fixture.traces",
    summary: "fixture traces",
    description: "Fake SigNoz-style trace search",
    input: z.object({ service: z.string() }),
    readOnly: true,
    available: () => true,
    handler: async (args) => {
      calls.push("fixture.traces");
      return { spans: SPANS.filter((s) => s.service === args.service) };
    },
  });
  registerIntegrationTool({
    name: "fixture.logs",
    summary: "fixture logs",
    description: "Fake Splunk-style log search",
    input: z.object({ order_ids: z.array(z.string()).max(100) }),
    readOnly: true,
    available: () => true,
    handler: async (args, ctx) => {
      calls.push("fixture.logs");
      if (revokeOnCall !== null && calls.length >= revokeOnCall)
        await q(pool, "UPDATE users SET active = false WHERE id = $1", [owner.id]);
      return {
        events: EVENTS.filter((e) => args.order_ids.includes(e.order_id)),
        scope: ctx.allowedRepositories,
      };
    },
  });
  registerIntegrationTool({
    name: "fixture.wait",
    summary: "fixture wait",
    description: "Waits until aborted or released",
    input: z.object({ i: z.number() }),
    readOnly: true,
    available: () => true,
    handler: (_args, ctx) =>
      new Promise((resolve) => {
        calls.push("fixture.wait");
        const w = { aborted: false, release: () => resolve({ late: true }) };
        waits.push(w);
        ctx.signal?.addEventListener("abort", () => {
          w.aborted = true;
          resolve({ aborted: true });
        });
      }),
  });
  registerIntegrationTool({
    name: "fixture.publish",
    summary: "fixture mutation",
    description: "A mutating tool CodeAct must never reach",
    input: z.object({ target: z.string() }),
    readOnly: false,
    available: () => true,
    handler: async () => {
      mutated++;
      return { done: true };
    },
  });
  await definitions.create({
    key: "codeact-fixture",
    spec: { name: "CodeAct fixture", steps: [{ key: "investigate", type: "agent", config: {} }] },
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
afterEach(async () => {
  config.codeAct.enabled = false;
  revokeOnCall = null;
  calls.length = 0;
  for (const w of waits.splice(0)) w.release();
  await q(pool, "UPDATE users SET active = true WHERE id = $1", [owner.id]);
  for (const id of runs.splice(0)) {
    const r = await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [id]);
    if (!["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) await cancelRun(id);
  }
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

async function attemptEnv(signal: AbortSignal = new AbortController().signal) {
  const item = await workItems.createManual({
    title: "Payment timeouts",
    description: "Investigate payment gateway timeouts",
    project: "OMS",
    ownerId: owner.id,
  });
  const run = await startRun({
    definitionKey: "codeact-fixture",
    workItemId: item.id,
    ownerId: owner.id,
  });
  runs.push(run.id);
  const job = (await claimJob("codeact-test", 120))!;
  const begun = (await beginAttempt(job, "codeact-test"))!;
  const ctx = makeContext({ ...begun, signal });
  return envFromExecution(ctx, "analysis", policy, newMetrics("fixture-model"), () => {});
}
const PROGRAM = `
  const { spans } = await platform.callTool("fixture.traces", { service: "payment-gateway" });
  const slow = [...new Set(spans.filter((s) => s.duration_ms > 5000).map((s) => s.order_id))];
  const { events, scope } = await platform.callTool("fixture.logs", { order_ids: slow });
  const timeouts = events.filter((e) => /timeout/.test(e.message));
  return { slow_orders: slow, timeouts: timeouts.length, first: timeouts[0]?._time ?? null, scope };
`;

test("workflow: one execution fetches, correlates and summarizes two bounded result sets", async () => {
  config.codeAct.enabled = true;
  const env = await attemptEnv();
  const text = await dispatchPlatformTool("platform.execute_code", { code: PROGRAM }, env);
  const r = JSON.parse(text);
  assert.equal(r.ok, true, text);
  assert.equal(r.untrusted, true, "a program's answer is never verified evidence");
  assert.deepEqual(r.value.slow_orders, ["ORD-0", "ORD-20", "ORD-40", "ORD-60"]);
  assert.equal(r.value.timeouts, 30);
  assert.deepEqual(
    r.value.scope,
    env.allowed,
    "nested calls carry the run's scope, not the program's",
  );
  assert.equal(r.evidence.length, 2);
  assert.match(r.evidence[0], /^codeact:\d+:1$/);
  const raw = JSON.stringify({ spans: SPANS }).length + JSON.stringify({ events: EVENTS }).length;
  assert.ok(text.length * 20 < raw, `model-visible ${text.length} bytes vs raw ${raw}`);

  const exec = await one(pool, "SELECT * FROM code_executions WHERE run_id = $1", [env.runId]);
  assert.deepEqual([exec.surface, exec.status, exec.calls], ["workflow", "ok", 2]);
  const rows = await q(
    pool,
    "SELECT * FROM code_execution_calls WHERE execution_id = $1 ORDER BY seq",
    [exec.id],
  );
  assert.deepEqual(
    rows.map((c) => [c.tool, c.status, c.read_only]),
    [
      ["fixture.traces", "ok", true],
      ["fixture.logs", "ok", true],
    ],
  );
  assert.ok(
    rows.every(
      (c) => /^[0-9a-f]{64}$/.test(c.input_sha256) && /^[0-9a-f]{64}$/.test(c.output_sha256),
    ),
  );
  const journal = await one(
    pool,
    "SELECT tool, read_only, status FROM agent_context_tool_calls WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
    [env.runId],
  );
  assert.deepEqual(journal, { tool: "platform.execute_code", read_only: true, status: "ok" });
});

test("workflow: mutating tools are unreachable from a program", async () => {
  config.codeAct.enabled = true;
  const env = await attemptEnv();
  const r = JSON.parse(
    await dispatchPlatformTool(
      "platform.execute_code",
      {
        code: `return await platform.callTool("fixture.publish", { target: "x" }).then(() => "ran", (e) => e.message);`,
      },
      env,
    ),
  );
  assert.match(r.value, /read-only/);
  assert.equal(mutated, 0);
});

test("workflow: a revoked owner stops the remaining nested calls", async () => {
  config.codeAct.enabled = true;
  const env = await attemptEnv();
  revokeOnCall = 1;
  const text = await dispatchPlatformTool(
    "platform.execute_code",
    {
      code: `
        await platform.callTool("fixture.logs", { order_ids: [] });
        return await platform.callTool("fixture.traces", { service: "payment-gateway" }).then(() => "ran", (e) => e.message);`,
    },
    env,
  );
  assert.deepEqual(calls, ["fixture.logs"], "the second call never reached the tool");
  // The dispatcher re-validates the binding after the read as well: the whole answer is refused.
  assert.match(text, /^ERROR:.*(inactive|not active|owner|user)/i);
  const exec = await one(pool, "SELECT id FROM code_executions WHERE run_id = $1", [env.runId]);
  const second = await one(
    pool,
    "SELECT status, result FROM code_execution_calls WHERE execution_id = $1 AND seq = 2",
    [exec.id],
  );
  assert.equal(second.status, "error");
  assert.match(JSON.stringify(second.result), /denied/);
});

test("workflow: disabled CodeAct is a typed unsupported answer and direct call_tool keeps working", async () => {
  const env = await attemptEnv();
  const r = JSON.parse(
    await dispatchPlatformTool("platform.execute_code", { code: "return 1" }, env),
  );
  assert.deepEqual([r.ok, r.category], [false, "unsupported"]);
  const direct = await dispatchPlatformTool(
    "call_tool",
    { name: "fixture.traces", arguments: { service: "none" } },
    env,
  );
  assert.match(direct, /spans/);
});

test("chat: code.execute runs in INVESTIGATE mode with the owner's audit and its own execution record", async () => {
  config.codeAct.enabled = true;
  const actor: Actor = { id: owner.id, username: owner.username, role: "member", active: true };
  const c = await chat.create(actor, { mode: "INVESTIGATE", provider: "claude" });
  let i = 0;
  const replies = [
    "```chat-tool\n" +
      JSON.stringify({ calls: [{ tool: "code.execute", arguments: { code: PROGRAM } }] }) +
      "\n```",
    "Done.",
  ];
  const runner: CompletionRunner = async () => ({ text: replies[Math.min(i++, 1)], tokens: null });
  setChatProviders(
    Object.fromEntries(PROVIDERS.map((p) => [p, runner])) as Record<
      AgentProvider,
      CompletionRunner
    >,
  );
  await chat.postMessage(actor, c.id, {
    content: "why are payments timing out?",
    client_message_id: "codeact-1",
  });
  for (let n = 0; n < 200; n++) {
    const d = await chat.get(actor, c.id);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status))) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const exec = await one(pool, "SELECT * FROM code_executions WHERE conversation_id = $1", [c.id]);
  assert.deepEqual([exec.surface, exec.status, exec.calls], ["chat", "ok", 2]);
  const call = await one(
    pool,
    "SELECT status, result FROM chat_tool_calls WHERE conversation_id = $1 AND tool = 'code.execute'",
    [c.id],
  );
  assert.equal(call.status, "ok");
  assert.equal(call.result.value.timeouts, 30);
  const audits = await q<{ action: string }>(
    pool,
    "SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'chat.%' AND resource_id = $2 ORDER BY id",
    [owner.id, String(c.id)],
  );
  assert.ok(
    audits.filter((a) => a.action === "chat.integration.call").length >= 2,
    JSON.stringify(audits),
  );
});

test("workflow: a program cannot widen the repository scope of a nested call", async () => {
  config.codeAct.enabled = true;
  const ci = config.codeIntelligence.enabled;
  config.codeIntelligence.enabled = true;
  const { registerBuiltinTools } = await import("../src/agent/toolRegistry.ts");
  registerBuiltinTools();
  try {
    const env = await attemptEnv();
    const r = JSON.parse(
      await dispatchPlatformTool(
        "platform.execute_code",
        {
          code: `return await platform.callTool("code_intelligence.search", {
            query: "RefundService", repositories: ["another-teams-repo"] }).then(() => "searched", (e) => e.message);`,
        },
        env,
      ),
    );
    assert.equal(r.ok, true);
    assert.match(r.value, /Unauthorized repository/);
  } finally {
    config.codeIntelligence.enabled = ci;
  }
});

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("workflow: cancelling the attempt cancels the program and the running nested call, and nothing runs after", async () => {
  config.codeAct.enabled = true;
  const ac = new AbortController();
  const env = await attemptEnv(ac.signal);
  const pending = dispatchPlatformTool(
    "platform.execute_code",
    {
      code: `await platform.callTool("fixture.wait", { i: 1 });
        await platform.callTool("fixture.traces", { service: "payment-gateway" });
        return "finished";`,
    },
    env,
  );
  await waitFor(() => waits.length === 1);
  ac.abort(new Error("run canceled by the user"));
  const r = JSON.parse(await pending);
  assert.equal(r.ok, false);
  assert.equal(r.category, "canceled");
  assert.match(r.error, /run canceled by the user/);
  assert.equal(waits[0].aborted, true, "the nested registry handler received the abort");
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(calls, ["fixture.wait"], "no nested call after cancellation");
  const exec = await one(
    pool,
    "SELECT status, error_category, finished_at FROM code_executions WHERE run_id = $1",
    [env.runId],
  );
  assert.deepEqual([exec.status, exec.error_category], ["error", "canceled"]);
  assert.ok(exec.finished_at);
});

test("workflow: an expired lease stops nested calls before they reach the tool", async () => {
  config.codeAct.enabled = true;
  const env = await attemptEnv();
  const pending = dispatchPlatformTool(
    "platform.execute_code",
    {
      code: `await platform.callTool("fixture.wait", { i: 1 });
        return await platform.callTool("fixture.traces", { service: "x" }).then(() => "ran", (e) => e.message);`,
    },
    env,
  );
  await waitFor(() => waits.length === 1);
  await q(
    pool,
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE run_id = $1",
    [env.runId],
  );
  waits[0].release();
  const text = await pending;
  assert.deepEqual(calls, ["fixture.wait"], "the second call never reached the tool");
  assert.match(
    text,
    /^ERROR:.*(lease|fenced|inactive)/i,
    "the dispatcher refuses the whole answer",
  );
});

test("registry: an aborted context never starts a handler and a late result is discarded", async () => {
  const { callTool } = await import("../src/agent/toolRegistry.ts");
  const before = calls.length;
  const ac = new AbortController();
  ac.abort();
  const r = await callTool(
    "fixture.traces",
    { service: "x" },
    { runId: null, allowedRepositories: [], mode: "analysis", signal: ac.signal },
  );
  assert.deepEqual([r.ok, r.error], [false, "canceled"]);
  assert.equal(calls.length, before, "handler not started");
  const late = new AbortController();
  const p = callTool(
    "fixture.wait",
    { i: 9 },
    { runId: null, allowedRepositories: [], mode: "analysis", signal: late.signal },
  );
  await waitFor(() => waits.length === 1);
  late.abort();
  const lr = await p;
  assert.deepEqual(
    [lr.ok, lr.error],
    [false, "canceled"],
    "a handler finishing after the abort does not count as a success",
  );
});

test("persistence: one terminal status; a stale running execution is reconciled as interrupted", async () => {
  config.codeAct.enabled = true;
  const env = await attemptEnv();
  const stale = await one(
    pool,
    `INSERT INTO code_executions (owner_id, surface, run_id, status, code_sha256, created_at)
     VALUES ($1, 'workflow', $2, 'running', repeat('0', 64), now() - interval '1 hour') RETURNING id`,
    [owner.id, env.runId],
  );
  const r = JSON.parse(
    await dispatchPlatformTool("platform.execute_code", { code: "return 1" }, env),
  );
  assert.equal(r.ok, true);
  const row = await one(pool, "SELECT status, error_category FROM code_executions WHERE id = $1", [
    stale.id,
  ]);
  assert.deepEqual([row.status, row.error_category], ["error", "internal"]);
  const { finishExecutionForTests } = await import("../src/codeact/surfaces.ts");
  const done = await one(
    pool,
    "SELECT id FROM code_executions WHERE run_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT 1",
    [env.runId],
  );
  assert.equal(
    await finishExecutionForTests(Number(done.id), "error", "canceled"),
    false,
    "a terminal status is never rewritten",
  );
  const again = await one(pool, "SELECT status FROM code_executions WHERE id = $1", [done.id]);
  assert.equal(again.status, "ok");
});

test("workflow: an oversized answer is a structured preview with its size and how to narrow it; secrets are redacted", async () => {
  config.codeAct.enabled = true;
  const env = await attemptEnv();
  const r = JSON.parse(
    await dispatchPlatformTool(
      "platform.execute_code",
      {
        code: `return { rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, note: "event ".repeat(5) })), token: "api_key=sk_live_supersecretvalue123" };`,
      },
      env,
    ),
  );
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.original_bytes > config.codeAct.maxOutputBytes);
  assert.match(r.note, /narrow|aggregate/i);
  assert.equal(r.untrusted, true);
  assert.doesNotMatch(JSON.stringify(r), /sk_live_supersecretvalue123/);
});
