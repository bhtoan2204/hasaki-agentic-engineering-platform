/**
 * Evidence-driven investigation workflow (M4), end to end through the real engine: the `incident-investigation`
 * template, the scheduler, the agent harness with the Codex provider path (fake `codex` CLI scripting the agent's tool
 * use through the platform's real MCP bridge and broker), CodeAct in the OS sandbox composing fixture SigNoz/Splunk
 * tools with code intelligence, the harness's provenance + evidence normalization, and the deterministic
 * `evidence_report` step. Scenario: refund timeouts at payment-gateway caused by the provider's refund call, with a
 * misleading DB-pool signal and SigNoz unavailable for refund-worker. All data is fake.
 */
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { startPlatformGo } from "./fixtures/platformGo.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { startRun, getRun, cancelRun, reexecuteStep } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { integrationExecutor } from "../src/workflow/executors/builtin.ts";
import { agentExecutor } from "../src/agent/harness/executor.ts";
import { registerIntegrationTool } from "../src/agent/toolRegistry.ts";
import { indexRepository } from "../src/codeIntelligence/indexer.ts";
import { probeIsolation } from "../src/agent/isolation.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { resolveCodeActEvidence } from "../src/codeact/surfaces.ts";
import { registerEvaluationTools } from "../src/eval/codeactTasks.ts";

const REPO = "payments-svc";
const bin = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const root = process.env.TEST_ROOT!;
let owner: PublicUser;
let platformGo: Awaited<ReturnType<typeof startPlatformGo>> | undefined;
let mutations = 0;
let sandbox = "os-sandbox";
const runs: number[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();

/** The CodeAct program the scripted agent runs: Stage A–C in one bounded execution. */
const PROGRAM = `
  const gw = (await platform.callTool("eval.traces", { service: "payment-gateway", operation: "gateway.refund", min_duration_ms: 5000 })).spans;
  const orders = [...new Set(gw.map((s) => s.order_id))];
  const provider = await platform.callTool("eval.traces", { service: "payment-provider", min_duration_ms: 5000, order_ids: orders });
  const pool = await platform.callTool("eval.logs", { service: "refund-worker", contains: "db pool saturated", order_ids: orders });
  let workerTraces = "ok";
  try { await platform.callTool("eval.traces", { service: "refund-worker" }); } catch (e) { workerTraces = e.message; }
  const sym = await platform.callTool("platform.get_symbol", { symbol: "ProviderRefund", repositories: ["${REPO}"] });
  const d = sym.definitions[0];
  return { orders: orders.length, provider_ops: [...new Set(provider.spans.map((s) => s.operation))],
           db_overlap: pool.events.length, worker_traces: workerTraces,
           def: { file: d.file_path, start: d.line_range[0], end: d.line_range[1], commit: d.snapshot.commit } };`;

/** Writes a fake-codex script module and returns its path. */
function script(name: string, body: string) {
  const path = join(root, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}
const correctScript = () =>
  script(
    "investigate-correct",
    `export default async ({ call }) => {
  const mutation = await call("call_tool", { name: "inc.publish", arguments: { topic: "refunds" } });
  const r = JSON.parse(await call("execute_code", { code: ${JSON.stringify(PROGRAM)} }));
  if (!r.ok) return { summary: "CodeAct failed: " + r.error, claims: [], hypotheses: [], next_steps: [], mutation };
  const ref = (seq) => r.calls.find((c) => c.seq === seq)?.ref ?? null;
  const v = r.value;
  return {
    summary: "Refund timeouts at payment-gateway: the provider refund call is slow for every slow refund; the DB pool warning does not overlap.",
    mutation,
    codeact: { evidence: r.evidence, evidence_status: r.evidence_status, sources: Object.keys(r.sources ?? {}) },
    claims: [
      { id: "F1", claim: v.orders + " orders have gateway.refund spans >= 5000 ms", classification: "OBSERVED_FACT", source_type: "trace",
        source_ref: ref(1), observed: { pointer: "/spans", count: v.orders }, verification_status: "verified", confidence: "high" },
      { id: "F2", claim: "for those orders provider.refund.http is slow too", classification: "OBSERVED_FACT", source_type: "trace",
        source_ref: ref(2), observed: { pointer: "/spans/0/operation", equals: "provider.refund.http" }, verification_status: "verified", confidence: "high" },
      { id: "F3", claim: "no refund-worker db pool saturation for those orders", classification: "OBSERVED_FACT", source_type: "production_log",
        source_ref: ref(3), observed: { pointer: "/events", count: 0 }, verification_status: "verified", confidence: "high" },
      { id: "K1", claim: "ProviderRefund performs the provider refund call", classification: "CODE_FACT", repository: "${REPO}",
        file_path: v.def.file, line_range: v.def.start + "-" + v.def.end, commit: v.def.commit, verification_status: "verified", confidence: "medium" },
      { id: "R1", claim: "refund timeouts come from provider.refund.http latency (ProviderRefund), not from the DB pool", classification: "CONFIRMED_ROOT_CAUSE",
        supports: ["F1", "F2", "F3", "K1"], verification_status: "verified", confidence: "high" },
      { id: "H1", claim: "the provider is rate limiting refunds", classification: "HYPOTHESIS", confidence: "low", verification_status: "unverified" },
    ],
    root_cause_assessment: { status: "CONFIRMED", confidence: "high", explanation: "Every slow gateway refund has a slow provider refund span; DB pool warnings do not overlap.", supporting_claims: ["R1", "F2"] },
    hypotheses: ["raising the gateway timeout: a mitigation, not a cause", "provider rate limiting: unverified"],
    missing_evidence: ["refund-worker traces: " + v.worker_traces],
    next_steps: ["ask the provider for refund latency on the cited orders", "check ProviderRefund's client timeout and retry policy"],
  };
};
`,
  );
const wrongScript = () =>
  script(
    "investigate-wrong",
    `export default async ({ call }) => {
  const r = JSON.parse(await call("execute_code", { code: ${JSON.stringify(PROGRAM)} }));
  const ref = (seq) => r.calls.find((c) => c.seq === seq)?.ref ?? null;
  return {
    summary: "The DB pool is saturated; raise the gateway timeout.",
    claims: [
      { id: "W1", claim: "7 slow refund orders had db pool saturation", classification: "OBSERVED_FACT", source_type: "production_log",
        source_ref: ref(3), observed: { pointer: "/events", count: 7 }, verification_status: "verified", confidence: "high" },
      { id: "W2", claim: "the gateway timeout is 1 s", classification: "OBSERVED_FACT", source_type: "trace",
        source_ref: "codeact:999999:1", verification_status: "verified", confidence: "high" },
      { id: "W3", claim: "DB pool saturation causes the refund timeouts", classification: "CONFIRMED_ROOT_CAUSE",
        supports: ["W1", "W2"], verification_status: "verified", confidence: "high" },
    ],
    root_cause_assessment: { status: "CONFIRMED", confidence: "high", explanation: "pool saturation", supporting_claims: ["W3"] },
    hypotheses: [], missing_evidence: [], next_steps: ["increase the gateway timeout"],
  };
};
`,
  );
const hangScript = () =>
  script(
    "investigate-hang",
    `export default async ({ call }) => {
  await call("execute_code", { code: 'await platform.callTool("inc.slow", {}); return 1;' });
  return null;
};
`,
  );

before(async () => {
  await migrate();
  platformGo = await startPlatformGo();
  await shareAllRepositoriesForTests();
  owner = await createUser({
    username: `inc-${Date.now()}`,
    password: "incident-pass",
    role: "member",
  });
  const repoRoot = join(config.reposRoot, REPO);
  mkdirSync(join(repoRoot, "provider"), { recursive: true });
  mkdirSync(join(repoRoot, "gateway"), { recursive: true });
  writeFileSync(
    join(repoRoot, "provider/client.go"),
    "package provider\n\n// ProviderRefund calls the payment provider's refund API.\nfunc ProviderRefund(order string) error {\n\treturn nil\n}\n",
  );
  writeFileSync(
    join(repoRoot, "gateway/refund.go"),
    'package gateway\n\nimport "payments/provider"\n\nfunc HandleRefund(order string) error { return provider.ProviderRefund(order) }\n',
  );
  git(repoRoot, "init", "-q", "-b", config.baseBranch);
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-qm", "fixture");
  git(
    repoRoot,
    "update-ref",
    `refs/remotes/origin/${config.baseBranch}`,
    git(repoRoot, "rev-parse", "HEAD"),
  );
  await repositories.upsert(REPO, {
    projects: ["PAY"],
    description: "payment gateway and provider client",
    services: ["payment-gateway"],
  });
  config.codeIntelligence.enabled = true;
  await indexRepository(REPO);
  await knowledge.create({
    key: "refund-idempotency",
    title: "Refund idempotency",
    category: "business_rule",
    content:
      "A refund is idempotent per order; never retry a provider refund without the idempotency key.",
    scope_type: "PROJECT",
    scope_ref: "PAY",
    ownerId: owner.id,
  });
  registerEvaluationTools();
  registerIntegrationTool({
    name: "inc.publish",
    summary: "fixture mutation",
    description: "A mutating tool (must never run from this workflow)",
    input: z.object({ topic: z.string() }),
    readOnly: false,
    available: () => true,
    handler: async () => {
      mutations++;
      return { published: true };
    },
  });
  registerIntegrationTool({
    name: "inc.slow",
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
  const template = TEMPLATES.find((t) => t.key === "incident-investigation")!;
  await definitions.create({ key: "incident-investigation", spec: template.spec });
  registerExecutor("agent", agentExecutor);
  registerExecutor("integration", integrationExecutor);
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.FAKE_CODEX_LOG = join(root, "incident-codex.jsonl");
  process.env.FAKE_CODEX_MODE = "script";
  config.codeAct.enabled = true;
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
  config.codeAct.enabled = false;
  setCodeActLauncherForTests(undefined);
  for (const key of ["CODEX_BIN", "FAKE_CODEX_LOG", "FAKE_CODEX_MODE", "FAKE_CODEX_SCRIPT"])
    delete process.env[key];
  platformGo?.stop();
  await settleBackground();
  await pool.end();
});

async function start(scriptPath: string) {
  process.env.FAKE_CODEX_SCRIPT = scriptPath;
  const run = await startRun({
    definitionKey: "incident-investigation",
    title: "Refund timeouts at payment-gateway",
    inputs: { request: "Why do payment refunds time out at payment-gateway?", project: "PAY" },
    agentProvider: "codex",
    ownerId: owner.id,
  });
  runs.push(run.id);
  return run.id;
}
async function drive(runId: number, max = 10) {
  for (let i = 0; i < max; i++) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 50));
  }
  return (await getRun(runId)).status;
}
const outputOf = async (runId: number, key: string) =>
  (await one(pool, "SELECT status, output FROM workflow_steps WHERE run_id=$1 AND key=$2", [
    runId,
    key,
  ])) as {
    status: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- step outputs are JSON read back from the database
    output: Record<string, any>;
  };

test("refund timeout: the workflow collects, correlates, diagnoses and verifies an evidence-backed root cause", async () => {
  const runId = await start(correctScript());
  assert.equal(await drive(runId), "COMPLETED");
  const inv = await outputOf(runId, "investigate");
  // Stage A–C ran as one bounded CodeAct execution through the real dispatchers, cited by durable refs.
  assert.equal(inv.output.codeact.evidence_status, "complete");
  assert.deepEqual(inv.output.codeact.sources.sort(), ["code_intelligence", "integration"]);
  for (const ref of inv.output.codeact.evidence)
    assert.ok(await resolveCodeActEvidence({ ...owner, active: true }, ref), `${ref} resolves`);
  // Only authorized tools: the mutating tool was refused in this read-only step and never ran.
  assert.match(inv.output.mutation, /ERROR|refus|read-only|not allowed|denied/i);
  assert.equal(mutations, 0);
  // The harness verified provenance itself.
  const byId = Object.fromEntries(inv.output.claims.map((c: { id: string }) => [c.id, c]));
  assert.equal(byId.F1.provenance.status, "VERIFIED_BY_PLATFORM");
  assert.equal(byId.F1.provenance.verifies, "observation");
  assert.equal(byId.K1.provenance.verifies, "location", JSON.stringify(byId.K1));
  assert.equal(inv.output.root_cause_assessment.status, "CONFIRMED");

  const report = await outputOf(runId, "report");
  const r = report.output;
  console.log(`M4-REPORT ${JSON.stringify({ run_id: runId, sandbox, report: r })}`);
  assert.equal(r.verification.failures.length, 0, JSON.stringify(r.verification));
  assert.equal(r.verification.status, "incomplete", "SigNoz was unavailable for refund-worker");
  assert.ok(
    r.missing_evidence.some((m: string) => /refund-worker traces: SigNoz unavailable/.test(m)),
  );
  assert.deepEqual(r.confirmed_facts.map((c: { id: string }) => c.id).sort(), ["F1", "F2", "F3", "K1"]);
  assert.equal(r.root_cause.status, "CONFIRMED");
  assert.match(r.source_locations[0], /payments-svc:provider\/client\.go:\d+-\d+@[0-9a-f]{12}/);
  assert.deepEqual(
    r.hypotheses.map((h: { id: string }) => h.id),
    ["H1"],
    "hypotheses stay hypotheses",
  );
  assert.ok(r.root_cause_candidates.some((c: string) => /mitigation, not a cause/.test(c)));
  assert.equal(r.production_changes, "none");
  for (const ref of r.evidence_refs)
    assert.ok(await resolveCodeActEvidence({ ...owner, active: true }, ref), ref);

  // Checkpoint/replay: re-executing the deterministic report from the persisted investigation gives the same verdict.
  await reexecuteStep(runId, "report", { by: "test" });
  assert.equal(await drive(runId), "COMPLETED");
  const again = await outputOf(runId, "report");
  assert.equal(again.output.verification.status, r.verification.status);
  assert.deepEqual(again.output.confirmed_facts, r.confirmed_facts);
});

test("a deliberately wrong conclusion is caught: contradicted observations, fabricated refs, root cause lowered", async () => {
  const runId = await start(wrongScript());
  assert.equal(await drive(runId), "COMPLETED");
  const r = (await outputOf(runId, "report")).output;
  console.log(
    `M4-WRONG ${JSON.stringify({ run_id: runId, verification: r.verification, root_cause: r.root_cause })}`,
  );
  assert.equal(r.verification.status, "failed");
  const reasons = r.verification.failures.map((f: { reason: string }) => f.reason).join("\n");
  assert.match(reasons, /has 0 items at \/events, not 7/);
  assert.match(reasons, /codeact:999999:1 is not a recorded CodeAct call of this run/);
  assert.match(reasons, /unsupported conclusion lowered/);
  assert.notEqual(r.root_cause.status, "CONFIRMED");
  assert.deepEqual(r.confirmed_facts, []);
  assert.deepEqual(r.contradicted_claims.map((c: { id: string }) => c.id).sort(), ["W1", "W2"]);
});

test("cancelling the run during evidence collection stops the program and the run", async () => {
  const runId = await start(hangScript());
  const driving = drive(runId, 3);
  for (let i = 0; i < 200; i++) {
    const exec = await one(pool, "SELECT id FROM code_executions WHERE run_id = $1", [runId]);
    if (exec) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  await cancelRun(runId);
  await driving;
  assert.equal((await getRun(runId)).status, "CANCELED");
  for (let i = 0; i < 100; i++) {
    const exec = await one(pool, "SELECT status FROM code_executions WHERE run_id = $1", [runId]);
    if (exec?.status !== "running") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const exec = await one(
    pool,
    "SELECT status, error_category FROM code_executions WHERE run_id = $1",
    [runId],
  );
  assert.deepEqual([exec.status, exec.error_category], ["error", "canceled"]);
  const calls = await q(
    pool,
    "SELECT tool FROM code_execution_calls WHERE execution_id IN (SELECT id FROM code_executions WHERE run_id = $1)",
    [runId],
  );
  assert.ok(calls.every((c) => c.tool === "inc.slow"));
});
