/**
 * Three-arm RCA evaluation and offline end-to-end investigation (fixture data, no network, no VPN):
 *   A  Direct tools through the Chat harness (simulated provider)
 *   B  CodeAct-enabled Chat (simulated provider)
 *   C  the incident-investigation workflow through the real Workflow Engine, scheduler, Agent Harness (Codex provider
 *      path: fake `codex` CLI scripting the agent through the real MCP bridge and broker), CodeAct in the OS sandbox,
 *      provenance and the evidence-sufficiency report.
 * Same incidents, symptoms, ground truth, read-only rca.* tools and grader in every arm. The scripted agent runs the
 * incident's reference plan (as the simulated chat policy does): this verifies the platform path and the grading, not
 * a model's reasoning. Negative runs prove that fabricated evidence, wrong causal conclusions, empty evidence,
 * unauthorized tools and partial outages cannot produce a verified investigation; replay and cancellation hold.
 */
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { getRun, cancelRun, reexecuteStep, startRun } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { integrationExecutor } from "../src/workflow/executors/builtin.ts";
import { agentExecutor } from "../src/agent/harness/executor.ts";
import { registerIntegrationTool } from "../src/agent/toolRegistry.ts";
import { probeIsolation } from "../src/agent/isolation.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { withCodeActScope } from "../src/codeact/scope.ts";
import { resolveCodeActEvidence } from "../src/codeact/surfaces.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import { rcaTasks, type GroundTruth, type Scenario } from "../src/eval/rcaIncidents.ts";
import { runSample, simulatedPolicy } from "../src/eval/codeactEffect.ts";
import {
  ensureRcaWorkflow,
  runWorkflowSample,
  scriptedRcaAgent,
  summarizeWorkflowArm,
  workflowRequest,
  type WorkflowSample,
} from "../src/eval/rcaWorkflowArm.ts";

const SCENARIOS: Scenario[] = [
  "provider-timeout",
  "retry-amplification",
  "db-pool-saturation",
  "kafka-consumer-lag",
  "idempotency-conflict",
  "missing-spans",
  "misleading-warnings",
  "partial-outage",
];
const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const bin = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const root = process.env.TEST_ROOT!;
let owner: PublicUser;
let definitionKey: string;
let sandbox = "os-sandbox";
let mutations = 0;
const runs: number[] = [];
const tasks = rcaTasks([1], SCENARIOS);
const taskOf = (s: Scenario) => tasks.find((t) => t.id === `INC-${s}-1`)!;

function useScript(name: string, body: string) {
  const path = join(root, `${name}.mjs`);
  writeFileSync(path, body);
  process.env.FAKE_CODEX_SCRIPT = path;
}
const workflowSample = async (s: Scenario, script = scriptedRcaAgent(taskOf(s))) => {
  useScript(`rca-${s}-${Date.now()}`, script);
  const r = await runWorkflowSample(taskOf(s), 0, {
    ownerId: owner.id,
    provider: "codex",
    definitionKey,
  });
  runs.push(r.run_id);
  return r;
};

before(async () => {
  await migrate();
  owner = await createUser({
    username: `rca3-${Date.now()}`,
    password: "rca-three-arm",
    role: "member",
  });
  registerIntegrationTool({
    name: "rca.mutate",
    summary: "fixture mutation",
    description: "A mutating tool (must never run from an investigation)",
    input: z.object({}),
    readOnly: false,
    available: () => true,
    handler: async () => {
      mutations++;
      return { mutated: true };
    },
  });
  registerIntegrationTool({
    name: "rca.slow",
    summary: "fixture slow lookup",
    description: "Waits until aborted",
    input: z.object({}),
    readOnly: true,
    available: () => true,
    handler: (_a, ctx) =>
      new Promise((resolve) =>
        ctx.signal?.addEventListener("abort", () => resolve({ aborted: true })),
      ),
  });
  registerExecutor("agent", agentExecutor);
  registerExecutor("integration", integrationExecutor);
  definitionKey = await ensureRcaWorkflow();
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.FAKE_CODEX_LOG = join(root, "rca-codex.jsonl");
  process.env.FAKE_CODEX_MODE = "script";
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  if (!(await probeIsolation()).available) {
    sandbox = "plain-process";
    setCodeActLauncherForTests(async (node, args) => ({
      command: node,
      args,
      env: { PATH: process.env.PATH ?? "" },
    }));
  }
});
afterEach(async () => {
  for (const id of runs.splice(0)) {
    const r = await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [id]);
    if (!["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) await cancelRun(id);
  }
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  setChatHealthProbe(undefined);
  for (const key of ["CODEX_BIN", "FAKE_CODEX_LOG", "FAKE_CODEX_MODE", "FAKE_CODEX_SCRIPT"])
    delete process.env[key];
  await settleBackground();
  await pool.end();
});

test("three arms on 8 incidents: same ground truth and grader; the workflow arm runs the real engine end to end", async () => {
  const actor = { ...owner, active: true };
  const rows: Array<Record<string, unknown>> = [];
  const wf: WorkflowSample[] = [];
  for (const s of SCENARIOS) {
    const task = taskOf(s);
    const opts = {
      actor,
      provider: "claude" as const,
      runnerFor: (t: typeof task) => simulatedPolicy(t),
      turnTimeoutMs: 60_000,
    };
    const a = await runSample(task, "direct", 0, opts);
    const b = await runSample(task, "codeact", 0, opts);
    const c = await workflowSample(s);
    wf.push(c);
    if (c.run_status !== "COMPLETED")
      console.log(
        "RCA-DEBUG",
        JSON.stringify(
          await q(
            pool,
            "SELECT s.key, s.status, a.error FROM workflow_steps s LEFT JOIN workflow_step_attempts a ON a.step_id = s.id WHERE s.run_id = $1",
            [c.run_id],
          ),
        ).slice(0, 3000),
      );
    assert.equal(c.run_status, "COMPLETED", `${s}: ${JSON.stringify(c)}`);
    assert.ok(c.codeact_executions >= 1, `${s}: the workflow agent used CodeAct`);
    // Every evidence ref of the report resolves to a durable record for the run's owner.
    for (const ref of c.evidence_refs)
      assert.ok(await resolveCodeActEvidence(actor, ref), `${s}: ${ref} resolves`);
    const execIds = (
      await q<{ id: number }>(pool, "SELECT id FROM code_executions WHERE run_id = $1", [c.run_id])
    ).map((e) => Number(e.id));
    rows.push({
      scenario: s,
      A: { correct: a.correct, rca: a.rca, tool_calls: a.tool_calls, latency_ms: a.latency_ms },
      B: {
        correct: b.correct,
        rca: b.rca,
        codeact: b.codeact_executions,
        tool_calls: b.tool_calls,
        latency_ms: b.latency_ms,
      },
      C: {
        run_id: c.run_id,
        execution_ids: execIds,
        evidence_refs: c.evidence_refs,
        correct: c.correct,
        cause: c.answer?.cause,
        status: c.answer?.status,
        verification: c.verification,
        tool_calls: c.tool_calls,
        latency_ms: c.latency_ms,
      },
    });
    // The workflow arm is credited only for what the platform verified.
    const truth = task.reference!() as unknown as GroundTruth;
    assert.equal(c.rca.false_confirmation, false, `${s}: no false confirmation`);
    if (truth.unavailable.length) {
      assert.notEqual(c.verification?.status, "passed", `${s}: an outage cannot pass`);
      assert.deepEqual(c.verification?.missing_sources, ["trace"]);
    }
    assert.equal(c.correct, true, `${s}: ${JSON.stringify(c.grading)}`);
    assert.equal(b.correct, true, `${s}: CodeAct chat`);
  }
  console.log(`RCA-3ARM ${JSON.stringify({ sandbox, rows, workflow: summarizeWorkflowArm(wf) })}`);
  assert.equal(mutations, 0);
});

test("checkpoint/replay: re-executing the report from the persisted investigation gives the same verdict", async () => {
  const c = await workflowSample("provider-timeout");
  const before = await one<{ output: Record<string, unknown> }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key='report'",
    [c.run_id],
  );
  await reexecuteStep(c.run_id, "report", { by: "test" });
  for (let i = 0; i < 20 && !["COMPLETED", "FAILED"].includes((await getRun(c.run_id)).status); i++)
    if (!(await runOnce())) await new Promise((r) => setTimeout(r, 50));
  const after = await one<{ output: Record<string, unknown> }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key='report'",
    [c.run_id],
  );
  assert.deepEqual(after!.output.verification, before!.output.verification);
  assert.deepEqual(after!.output.confirmed_facts, before!.output.confirmed_facts);
});

// ------------------------------------------------------------------------------------------------ negative runs

/** A scripted agent that runs the reference program, then lets `tamper` change what it reports. */
const tampered = (s: Scenario, tamper: string) =>
  scriptedRcaAgent(taskOf(s)).replace(
    "  return {\n    summary:",
    `  ${tamper}\n  return {\n    summary:`,
  );

test("fabricated evidence fails verification and cannot be graded as confirmed", async () => {
  const c = await workflowSample(
    "provider-timeout",
    tampered("provider-timeout", `claims[0].source_ref = "codeact:999999:1";`),
  );
  assert.equal(c.verification?.status, "failed");
  assert.notEqual(c.answer?.status, "CONFIRMED");
});

test("an incorrect causal conclusion (the misleading pool warnings) is rejected", async () => {
  const s: Scenario = "misleading-warnings";
  const c = await workflowSample(
    s,
    tampered(
      s,
      `Object.assign(answer, { root_cause_service: "refund-worker", root_cause_operation: "refund.db.acquire", cause: "db_pool_saturation" });`,
    ),
  );
  assert.equal(c.correct, false);
  assert.equal(c.rca.misleading_signal_taken, true);
});

test("empty evidence cannot pass: a CONFIRMED root cause with no claims", async () => {
  const c = await workflowSample(
    "provider-timeout",
    `export default async () => ({ summary: "provider is slow", claims: [], hypotheses: [], missing_evidence: [],
      root_cause_assessment: { status: "CONFIRMED", confidence: "high", explanation: "trust me", supporting_claims: [] },
      rca_answer: { root_cause_service: "payment-provider", root_cause_operation: "provider.refund.http", cause: "provider_timeout",
        status: "CONFIRMED", affected_orders: null, missing_sources: [], next_actions: [] } });`,
  );
  assert.notEqual(c.verification?.status, "passed");
  assert.notEqual(c.answer?.status, "CONFIRMED");
  assert.equal(c.correct, false, "no correlation, nothing verified");
});

test("an unauthorized (mutating) tool stays blocked inside an investigation", async () => {
  const c = await workflowSample(
    "provider-timeout",
    scriptedRcaAgent(taskOf("provider-timeout")).replace(
      "export default async ({ call }) => {",
      `export default async ({ call }) => {
  const direct = await call("call_tool", { name: "rca.mutate", arguments: {} });
  const nested = JSON.parse(await call("execute_code", { code: 'return await platform.callTool("rca.mutate", {})' }));
  if (!/ERROR|refus|read-only|not allowed|denied/i.test(direct) || nested.ok) throw new Error("mutation was not refused");`,
    ),
  );
  assert.equal(c.run_status, "COMPLETED");
  assert.equal(mutations, 0);
});

test("cancellation stops the investigation and its CodeAct execution", async () => {
  useScript(
    `rca-hang-${Date.now()}`,
    `export default async ({ call }) => { await call("execute_code", { code: 'await platform.callTool("rca.slow", {}); return 1;' }); return null; };`,
  );
  const run = await withCodeActScope(true, () =>
    startRun({
      definitionKey,
      title: "RCA cancel",
      inputs: { request: workflowRequest(taskOf("provider-timeout")) },
      agentProvider: "codex",
      ownerId: owner.id,
    }),
  );
  runs.push(run.id);
  const worker = withCodeActScope(true, async () => {
    for (let i = 0; i < 3; i++) await runOnce();
  });
  let exec: { id: number; status: string } | undefined;
  for (let i = 0; i < 200 && !exec; i++) {
    exec = (
      await q<{ id: number; status: string }>(
        pool,
        "SELECT id, status FROM code_executions WHERE run_id=$1",
        [run.id],
      )
    )[0];
    if (!exec) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(exec, "the execution started");
  await cancelRun(run.id);
  await worker;
  assert.equal((await getRun(run.id)).status, "CANCELED");
  let final: string | undefined;
  for (let i = 0; i < 100; i++) {
    final = (await one<{ status: string }>(pool, "SELECT status FROM code_executions WHERE id=$1", [
      exec!.id,
    ]))!.status;
    if (final !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(final, "error", "the execution ended (canceled), not left running");
  config.codeAct.enabled = false;
});
