/**
 * CodeAct failure diagnostics through the real workflow dispatcher (dispatchPlatformTool → runCodeForRun) and
 * PostgreSQL: a failed execution is persisted with a sanitized diagnosis (category, phase, nested tool), the agent
 * receives the execution id, the diagnosis and recovery advice, and nested failures inside a successful program stay
 * visible. Program text and tool payloads never reach the diagnosis. Fixture tools and data are fake.
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

const policy = {
  mode: "analysis" as const,
  workspaces: [],
  protectedRoots: [],
  baseBranch: "main",
};
const runs: number[] = [];
let owner: PublicUser;

before(async () => {
  await migrate();
  owner = await createUser({
    username: `diag-o-${Date.now()}`,
    password: "diagnostics-pass",
    role: "member",
  });
  registerIntegrationTool({
    name: "diag.traces",
    summary: "fixture traces",
    description: "Diagnostics fixture: spans of a service (refund-worker answers HTTP 503).",
    input: z.object({ service: z.string() }),
    readOnly: true,
    available: () => true,
    handler: async (a) => {
      if (a.service === "refund-worker")
        throw new Error("SigNoz unavailable for refund-worker (HTTP 503) api_key=sk-secret");
      return { spans: [{ order_id: "ORD-1", duration_ms: 6000 }] };
    },
  });
  await definitions.create({
    key: "codeact-diagnostics",
    spec: {
      name: "CodeAct diagnostics",
      steps: [{ key: "investigate", type: "agent", config: {} }],
    },
  });
  setCodeActLauncherForTests(async (node, args) => ({
    command: node,
    args,
    env: { PATH: process.env.PATH ?? "" },
  }));
});
afterEach(async () => {
  config.codeAct.enabled = false;
  for (const id of runs.splice(0)) {
    const r = await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [id]);
    if (!["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) await cancelRun(id);
  }
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  await settleBackground();
  await pool.end();
});

async function execute(code: string) {
  config.codeAct.enabled = true;
  const item = await workItems.createManual({
    title: "Refund timeouts",
    description: "Investigate refund timeouts",
    project: "OMS",
    ownerId: owner.id,
  });
  const run = await startRun({
    definitionKey: "codeact-diagnostics",
    workItemId: item.id,
    ownerId: owner.id,
  });
  runs.push(run.id);
  const job = (await claimJob("codeact-diagnostics", 120))!;
  const begun = (await beginAttempt(job, "codeact-diagnostics"))!;
  const env = envFromExecution(
    makeContext({ ...begun, signal: new AbortController().signal }),
    "analysis",
    policy,
    newMetrics("fixture-model"),
    () => {},
  );
  return JSON.parse(await dispatchPlatformTool("platform.execute_code", { code }, env));
}
const rowOf = (id: number) =>
  one<{
    status: string;
    error_category: string | null;
    diagnostics: Record<string, unknown> | null;
  }>(pool, "SELECT status, error_category, diagnostics FROM code_executions WHERE id = $1", [id]);

test("an uncaught nested failure: persisted diagnosis, execution id and recovery advice reach the agent", async () => {
  const PROGRAM_MARKER = "UNIQUE_PROGRAM_MARKER_42";
  const answer = await execute(
    `// ${PROGRAM_MARKER}
     const a = await platform.callTool("diag.traces", { service: "payment-gateway" });
     const b = await platform.callTool("diag.traces", { service: "refund-worker" });
     return a.spans.length + b.spans.length;`,
  );
  assert.equal(answer.ok, false);
  assert.ok(Number.isInteger(answer.execution_id), JSON.stringify(answer));
  const failure = {
    category: "program_runtime_error",
    phase: "program_run",
    last_nested_failure: { seq: 2, tool: "diag.traces", category: "tool_invocation_failed" },
  };
  assert.deepEqual(answer.failure, failure);
  assert.equal(answer.recovery.retry, "handle_partial_failure");
  const row = await rowOf(answer.execution_id);
  assert.equal(row!.status, "error");
  assert.equal(
    row!.error_category,
    "internal",
    "the coarse category is unchanged for existing readers",
  );
  assert.deepEqual(row!.diagnostics, {
    failure,
    nested_failures: [{ seq: 2, tool: "diag.traces", category: "tool_invocation_failed" }],
    persistence_failures: 0,
  });
  const stored = JSON.stringify(row!.diagnostics);
  for (const secret of [PROGRAM_MARKER, "sk-secret", "503"])
    assert.ok(!stored.includes(secret), `diagnostics never contain ${secret}`);
  console.log(
    `DIAG-FAILED ${JSON.stringify({ execution_id: answer.execution_id, diagnostics: row!.diagnostics })}`,
  );
});

test("a program that handles the failure succeeds; the nested failure stays visible, not hidden", async () => {
  const answer = await execute(
    `const out = {};
     for (const s of ["payment-gateway", "refund-worker"]) {
       try { out[s] = (await platform.callTool("diag.traces", { service: s })).spans.length; }
       catch { out[s] = null; }
     }
     return out;`,
  );
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.value, { "payment-gateway": 1, "refund-worker": null });
  assert.equal(answer.failure, undefined);
  const row = await rowOf(answer.execution_id);
  assert.equal(row!.status, "ok");
  assert.deepEqual(row!.diagnostics, {
    nested_failures: [{ seq: 2, tool: "diag.traces", category: "tool_invocation_failed" }],
    persistence_failures: 0,
  });
  console.log(
    `DIAG-RECOVERED ${JSON.stringify({ execution_id: answer.execution_id, diagnostics: row!.diagnostics })}`,
  );
});

test("a syntax error is diagnosed before any nested call; advice is to fix the program", async () => {
  const answer = await execute(`return {;`);
  assert.deepEqual(answer.failure, { category: "program_syntax_error", phase: "program_compile" });
  assert.equal(answer.recovery.retry, "fix_program");
  const row = await rowOf(answer.execution_id);
  assert.deepEqual(row!.diagnostics, {
    failure: { category: "program_syntax_error", phase: "program_compile" },
    nested_failures: [],
    persistence_failures: 0,
  });
});

test("an execution left running by a dead worker is reconciled with an explicit diagnosis", async () => {
  const stale = await one<{ id: number }>(
    pool,
    `INSERT INTO code_executions (owner_id, surface, status, code_sha256, created_at)
     VALUES ($1, 'chat', 'running', 'x', now() - interval '1 hour') RETURNING id`,
    [owner.id],
  );
  await execute(`return 1`);
  const row = await rowOf(Number(stale!.id));
  assert.equal(row!.status, "error");
  assert.deepEqual(row!.diagnostics, { failure: { category: "interrupted", phase: "unknown" } });
});

test("the diagnostics column is additive: earlier rows keep NULL", async () => {
  const cols = await q<{ column_name: string; is_nullable: string }>(
    pool,
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'code_executions' AND column_name = 'diagnostics'",
  );
  assert.deepEqual(cols, [{ column_name: "diagnostics", is_nullable: "YES" }]);
});
