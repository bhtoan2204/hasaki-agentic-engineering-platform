/**
 * RCA benchmark through the real Chat harness (P1): every incident's ground truth is derivable from its tools alone
 * (the reference plan, run against the read-only rca.* tools, is graded correct), and the paired Direct vs CodeAct run
 * produces reproducible accuracy, false-confirmation and cost metrics with the deterministic simulated provider.
 * Simulated provider: this measures the benchmark and harness, not a model.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { callTool } from "../src/agent/toolRegistry.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import { gradeRca, rcaTasks, SCENARIOS, type GroundTruth } from "../src/eval/rcaIncidents.ts";
import {
  runEvaluation,
  simulatedPolicy,
  summarize,
  renderMarkdown,
} from "../src/eval/codeactEffect.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
let user: PublicUser;

before(async () => {
  await migrate();
  user = await createUser({
    username: `rca-${Date.now()}`,
    password: "rca-bench-pass",
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

test("every incident's ground truth is supported by its own observations (3 seeds × 10 scenarios)", async () => {
  const tasks = rcaTasks([1, 2, 3]);
  assert.equal(tasks.length, 30);
  for (const t of tasks) {
    const derived = await t.plan(async (name, args) => {
      const r = await callTool(name, args, {
        runId: null,
        allowedRepositories: [],
        mode: "analysis",
      });
      if (!r.ok) throw new Error(r.error ?? `${name} failed`);
      return r.result;
    });
    const g = gradeRca(t.reference!() as unknown as GroundTruth, derived);
    assert.equal(g.correct, true, `${t.id}: ${JSON.stringify(g.diagnostics)}`);
  }
});

test("rca.* tools are read-only and an unknown incident is an error, not data", async () => {
  rcaTasks([1]);
  const r = await callTool(
    "rca.logs",
    { incident: "INC-nope-0" },
    { runId: null, allowedRepositories: [], mode: "analysis" },
  );
  assert.equal(r.ok, false);
});

test("paired Direct vs CodeAct on the RCA suite (simulated provider): reproducible accuracy and cost metrics", async () => {
  const suite = rcaTasks([1]);
  const run = await runEvaluation(
    { repetitions: 1, suite },
    {
      actor: { ...user, active: true },
      provider: "claude",
      runnerFor: (t) => simulatedPolicy(t),
      turnTimeoutMs: 60_000,
    },
  );
  assert.equal(run.stopped, null);
  assert.equal(run.samples.length, 2 * SCENARIOS.length);
  const report = summarize(run.samples, {
    level: "fixture-simulated-provider",
    sandbox: "plain-process",
    provider: "simulated",
    model: null,
  });
  console.log(
    `RCA-REPORT ${JSON.stringify({ variants: report.variants, per_task: report.per_task, capability: report.capability_check })}`,
  );
  console.log(renderMarkdown(report));
  assert.equal(report.capability_check.valid, true);
  // The reference program run through CodeAct is exact on every incident; nothing is falsely confirmed.
  assert.equal(report.variants.codeact.correct, SCENARIOS.length);
  assert.equal(report.variants.codeact.rca_dimensions?.false_confirmation, 0);
  assert.ok(
    run.samples.every((s) => s.rca && s.answer),
    "raw grading diagnostics are kept per sample",
  );
  const outage = run.samples.find(
    (s) => s.task_id.includes("partial-outage") && s.variant === "codeact",
  )!;
  assert.deepEqual((outage.answer as { missing_sources: string[] }).missing_sources, [
    "rca.traces",
  ]);
});
