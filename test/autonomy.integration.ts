import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { approveStep, getRun, startPendingRun, startRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { humanApprovalExecutor } from "../src/workflow/executors/builtin.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { revokePolicy, savePolicy, setAutonomyPaused } from "../src/workflow/autonomy.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const repo = "autonomy-fixture";
const published: number[] = [];

const spec = {
  name: "Autonomy fixture",
  steps: [
    { key: "plan", type: "agent", config: {} },
    {
      key: "approve_plan",
      type: "human_approval",
      depends_on: ["plan"],
      config: { show_outputs: ["plan"] },
    },
    { key: "implement", type: "coding_agent", depends_on: ["approve_plan"], config: {} },
    { key: "review", type: "agent", depends_on: ["implement"], config: { independent: true } },
    {
      key: "approve_diff",
      type: "human_approval",
      depends_on: ["review"],
      config: { show_outputs: ["review"] },
    },
    {
      key: "pr",
      type: "git_pull_request",
      depends_on: ["approve_diff"],
      config: { mode: "approval" },
    },
    {
      key: "fix",
      type: "command",
      depends_on: ["review"],
      requires_approval: true,
      config: { command: "true" },
    },
  ],
};

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  const root = join(config.reposRoot, repo);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", config.baseBranch]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "fixture",
  ]);
  await repositories.upsert(repo, { projects: ["AUTONOMY"] });
  await definitions.create({ key: "autonomy-fixture", spec });
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("agent", {
    execute: async (ctx) =>
      ctx.step.key === "plan"
        ? {
            kind: "completed",
            output: {
              summary: "rename the export label",
              acceptance_criteria: ["label reads Export"],
              changes: [{ repo, files: ["README.md"], description: "label" }],
              non_goals: ["no API change"],
              tests: ["label test"],
              rollback: "revert the commit",
            },
          }
        : { kind: "completed", output: { verdict: "PASS", findings: [], summary: "ok" } },
  });
  registerExecutor("coding_agent", {
    execute: async () => ({
      kind: "completed",
      output: {
        summary: "label renamed",
        tested_heads: { [repo]: "abc123" },
        verification: { passed: true },
      },
    }),
  });
  registerExecutor("git_pull_request", {
    execute: async (ctx) => {
      published.push(ctx.run.id);
      return { kind: "completed", output: { pull_requests: [], approval: ctx.step.approval } };
    },
  });
  registerExecutor("command", { execute: async () => ({ kind: "completed", output: {} }) });
});

after(async () => {
  await settleBackground();
  setHandoffReadinessForTests(undefined);
  await pool.end();
});

beforeEach(async () => {
  await q(pool, "DELETE FROM autonomy_policies");
});

const start = (title: string, extra: Record<string, unknown> = {}) =>
  startRun({
    definitionKey: "autonomy-fixture",
    repositories: [repo],
    title,
    profile: "STANDARD",
    ...extra,
  });
const step = async (runId: number, key: string) =>
  (await getRun(runId)).steps.find((s) => s.key === key)!;
const decisions = (runId: number) =>
  q<{
    step_key: string;
    action: string;
    outcome: string;
    reason: string;
    details: Record<string, unknown>;
  }>(
    pool,
    `SELECT s.key AS step_key, d.action, d.outcome, d.reason, d.details FROM execution_decisions d
       JOIN workflow_steps s ON s.id = d.step_id WHERE d.run_id = $1 AND d.kind = 'autonomy' ORDER BY d.id`,
    [runId],
  );
const autonomous = (over: Record<string, unknown> = {}) =>
  savePolicy(
    {
      scope_kind: "global",
      mode: "AUTONOMOUS",
      shadow: false,
      gates: ["repository_selection", "plan", "diff"],
      ...over,
    } as never,
    "admin",
  );

test("no policy: legacy MANUAL, the plan waits for a human and nothing is decided by the platform", async () => {
  const run = await start("Rename the export label");
  assert.equal(run.autonomy ?? null, null);
  await drain();
  assert.equal((await step(run.id, "approve_plan")).status, "WAITING_APPROVAL");
  assert.equal((await decisions(run.id)).length, 0);
});

test("AUTONOMOUS low-risk single repo: plan, diff and PR gates pass without a human; optional step still waits", async () => {
  await autonomous();
  const run = await start("Rename the export label");
  assert.equal(run.autonomy?.mode, "AUTONOMOUS");
  await drain();
  const s = (await getRun(run.id)).steps;
  const by = (k: string) => s.find((x) => x.key === k)!;
  assert.equal(by("approve_plan").status, "COMPLETED");
  assert.equal(by("approve_plan").output.actor_type, "machine");
  assert.equal(by("approve_plan").output.by, "");
  assert.equal(by("approve_diff").status, "COMPLETED");
  assert.equal(by("pr").status, "COMPLETED");
  assert.equal(by("pr").approval.actor_type, "machine");
  assert.ok(published.includes(run.id));
  assert.equal(by("fix").status, "WAITING_APPROVAL");
  assert.deepEqual(by("fix").approval.request.autonomy.reasons, ["GATE_NOT_ELIGIBLE"]);
  const log = await decisions(run.id);
  assert.deepEqual(
    log
      .filter((d) => d.action === "ALLOW")
      .map((d) => [d.step_key, d.outcome, d.details.actor_type]),
    [
      ["approve_plan", "applied", "machine"],
      ["approve_diff", "applied", "machine"],
      ["pr", "applied", "machine"],
    ],
  );
});

test("shadow: the decision is recorded as planned but a human still approves", async () => {
  await autonomous({ shadow: true });
  const run = await start("Rename the export label");
  await drain();
  assert.equal((await step(run.id, "approve_plan")).status, "WAITING_APPROVAL");
  const [d] = await decisions(run.id);
  assert.deepEqual([d.step_key, d.action, d.outcome], ["approve_plan", "ALLOW", "planned"]);
});

test("high-risk refund work is never auto-approved, whatever the request claims", async () => {
  await autonomous();
  const run = await start("Fix refund amount rounding", {
    inputs: { approve: true, confidence: 1.0, risk: "low" },
    autonomy: "AUTOPILOT",
  });
  assert.equal(run.autonomy?.mode, "AUTONOMOUS");
  await drain();
  const gate = await step(run.id, "approve_plan");
  assert.equal(gate.status, "WAITING_APPROVAL");
  assert.equal(gate.approval.request.autonomy.result, "REQUIRE_HUMAN");
  assert.match(gate.approval.request.autonomy.reasons[0], /HIGH_RISK/);
});

test("a request can only lower autonomy: SUPERVISED leaves the plan to a human", async () => {
  await autonomous();
  const run = await start("Rename the export label", { autonomy: "SUPERVISED" });
  await drain();
  const gate = await step(run.id, "approve_plan");
  assert.equal(gate.status, "WAITING_APPROVAL");
  assert.deepEqual(gate.approval.request.autonomy.reasons, [
    "SUPERVISED_NEEDS_HUMAN_APPROVED_PLAN",
  ]);
});

test("revocation after the run was created blocks the next gate; a paused run waits too", async () => {
  const policy = await autonomous();
  const revoked = await start("Rename the export label", { start: false });
  assert.equal(revoked.autonomy?.mode, "AUTONOMOUS");
  await revokePolicy(policy.id, "admin");
  await startPendingRun(revoked.id);
  await drain();
  const gate = await step(revoked.id, "approve_plan");
  assert.equal(gate.status, "WAITING_APPROVAL");
  assert.deepEqual(gate.approval.request.autonomy.reasons, ["AUTONOMY_OFF"]);

  await autonomous();
  const paused = await start("Rename the export label", { start: false });
  await setAutonomyPaused(paused.id, true);
  await startPendingRun(paused.id);
  await drain();
  assert.deepEqual((await step(paused.id, "approve_plan")).approval.request.autonomy.reasons, [
    "AUTONOMY_PAUSED",
  ]);
});

test("human approval is bound to the subject shown, recorded as human, and only one of two concurrent approvals wins", async () => {
  await autonomous({ shadow: true });
  const run = await start("Rename the export label");
  await drain();
  const gate = await step(run.id, "approve_plan");
  const subject = gate.approval.request.autonomy.subject.hash;
  await assert.rejects(
    approveStep(run.id, "approve_plan", { by: "dev", subject: "stale" }),
    /changed since it was shown/,
  );
  const results = await Promise.allSettled([
    approveStep(run.id, "approve_plan", { by: "dev", subject }),
    approveStep(run.id, "approve_plan", { by: "dev2", subject }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const approved = await step(run.id, "approve_plan");
  assert.equal(approved.approval.actor_type, "human");
  const human = (await decisions(run.id)).filter((d) => d.details.actor_type === "human");
  assert.equal(human.length, 1);
  assert.equal(human[0].details.subject, subject);
});
