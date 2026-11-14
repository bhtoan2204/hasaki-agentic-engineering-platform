import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories } from "../src/repos/service.ts";
import { indexRepository } from "../src/codeIntelligence/indexer.ts";
import { collectMicroEvidence } from "../src/workflow/microEvidence.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  getRun,
  finishAttempt,
  beginAttempt,
  cancelRun,
} from "../src/workflow/engine.ts";
import { claimJob, drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { humanApprovalExecutor } from "../src/workflow/executors/builtin.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
const repo = "micro-fixture";
let root: string;
let sessions = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  config.codeIntelligence.enabled = true;
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  root = join(config.reposRoot, repo);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(root, "src/label.ts"), 'export const label = "old";\n');
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  await repositories.upsert(repo, { projects: ["MICRO"] });
  await indexRepository(repo);
  const spec = TEMPLATES.find((t) => t.key === "micro-change")!.spec;
  await definitions.create({ key: "micro-fixture", spec });
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("coding_agent", {
    execute: async () => {
      sessions++;
      return {
        kind: "completed",
        output: { analysis: { summary: "local label" }, summary: "fixture change" },
      };
    },
  });
});
after(async () => {
  await settleBackground();
  setHandoffReadinessForTests(undefined);
  await pool.end();
});
const input = () => ({
  definitionKey: "micro-fixture",
  repositories: [repo],
  title: "Fix label typo",
  inputs: { risk: "low", files: ["src/label.ts"] },
});
test("indexed leaf change reaches PR approval with one coding session and MICRO persisted", async () => {
  const evidence = await collectMicroEvidence(repo, ["src/label.ts"], 0);
  assert.equal(evidence?.impactKnown, true);
  const run = await startRun(input());
  assert.equal(run.profile, "MICRO");
  await drain();
  const state = await getRun(run.id);
  assert.equal(sessions, 1);
  assert.equal(state.steps.find((s) => s.key === "approve_diff")!.status, "WAITING_APPROVAL");
  assert.equal(state.steps.filter((s) => s.type === "agent").length, 0);
  await cancelRun(run.id);
});
test("escalation checkpoints the same run and rejects duplicate completion without replaying work", async () => {
  const run = await startRun(input());
  const job = (await claimJob("micro-test", 60))!;
  const active = (await beginAttempt(job, "micro-test"))!;
  const request = {
    reason: "dependency impact is uncertain",
    risk: "unknown" as const,
    target: "STANDARD" as const,
    expectedRevision: 0,
  };
  await finishAttempt(job.id, job.fencing_token, active.attempt.id, {
    kind: "profile_escalation",
    request,
  });
  const state = await getRun(run.id);
  assert.equal(state.id, run.id);
  assert.equal(state.branch, run.branch);
  assert.equal(state.profile, "STANDARD");
  assert.equal(state.steps.find((s) => s.key === "self_review")!.config.independent, true);
  const retry = await finishAttempt(job.id, job.fencing_token, active.attempt.id, {
    kind: "profile_escalation",
    request,
  });
  assert.equal(retry.applied, false);
  const checkpoints = await q(
    pool,
    "SELECT * FROM workflow_checkpoints WHERE run_id=$1 AND reason='profile_transition'",
    [run.id],
  );
  assert.equal(checkpoints.length, 1);
  assert.equal(readFileSync(join(root, "src/label.ts"), "utf8"), 'export const label = "old";\n');
  await cancelRun(run.id);
});

test("escalation preserves workspace bytes, commits, session, artifacts and context snapshots", async () => {
  const { recordWorkspace } = await import("../src/git/provider.ts");
  const { makeContext } = await import("../src/workflow/executors/registry.ts");
  const run = await startRun(input());
  const job = (await claimJob("micro-preserve", 60))!;
  const active = (await beginAttempt(job, "micro-preserve"))!;
  const workspace = join(config.dataDir, `micro-workspace-${run.id}`);
  git(root, "worktree", "add", "-b", run.branch, workspace);
  await recordWorkspace(run.id, {
    repo,
    path: workspace,
    branch: run.branch,
    created_from: "fixture",
  });
  writeFileSync(join(workspace, "src/label.ts"), 'export const label = "new";\n');
  const head = git(workspace, "rev-parse", "HEAD");
  const ctx = makeContext({ ...active, signal: new AbortController().signal });
  const artifact = await ctx.artifact("text", "preserved evidence", "checkpoint evidence");
  await q(
    pool,
    "INSERT INTO agent_sessions(attempt_id,session_id,cwd,provider) VALUES($1,'micro-session',$2,$3)",
    [active.attempt.id, workspace, active.attempt.agent_provider],
  );
  await finishAttempt(job.id, job.fencing_token, active.attempt.id, {
    kind: "profile_escalation",
    request: {
      target: "DEEP",
      risk: "high",
      reason: "new business risk discovered",
      expectedRevision: 0,
    },
  });
  const state = await getRun(run.id);
  assert.equal(state.profile, "DEEP");
  assert.equal(git(workspace, "rev-parse", "HEAD"), head);
  assert.equal(
    readFileSync(join(workspace, "src/label.ts"), "utf8"),
    'export const label = "new";\n',
  );
  assert.equal(
    (await q(pool, "SELECT id FROM workflow_artifacts WHERE id=$1", [artifact])).length,
    1,
  );
  assert.equal(
    (await q(pool, "SELECT id FROM context_snapshots WHERE id=$1", [active.context.snapshot_id]))
      .length,
    1,
  );
  assert.equal(
    (
      await q(pool, "SELECT session_id FROM agent_sessions WHERE attempt_id=$1", [
        active.attempt.id,
      ])
    )[0].session_id,
    "micro-session",
  );
  assert.deepEqual(state.steps.find((s) => s.key === "implement")!.depends_on, [
    "approve_profile_scope",
  ]);
  await cancelRun(run.id);
});

test("a transition persistence failure rolls back the graph and pauses with its checkpoint intact", async () => {
  const run = await startRun(input());
  const job = (await claimJob("micro-rollback", 60))!;
  const active = (await beginAttempt(job, "micro-rollback"))!;
  await q(
    pool,
    `CREATE FUNCTION micro_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='profile_transition' THEN RAISE EXCEPTION 'simulated checkpoint failure'; END IF; RETURN NEW; END $$`,
  );
  await q(
    pool,
    "CREATE TRIGGER micro_checkpoint_failure BEFORE INSERT ON workflow_checkpoints FOR EACH ROW EXECUTE FUNCTION micro_checkpoint_failure()",
  );
  try {
    await finishAttempt(job.id, job.fencing_token, active.attempt.id, {
      kind: "profile_escalation",
      request: {
        target: "STANDARD",
        risk: "unknown",
        reason: "scope needs reconciliation",
        expectedRevision: 0,
      },
    });
    const state = await getRun(run.id);
    assert.equal(state.profile, "MICRO");
    assert.equal(state.steps.find((s) => s.key === "implement")!.status, "WAITING_INPUT");
    assert.equal(
      state.steps.some((s) => s.key === "profile_scope_plan"),
      false,
    );
    assert.equal(
      (
        await q(
          pool,
          "SELECT id FROM workflow_checkpoints WHERE run_id=$1 AND reason='waiting_input'",
          [run.id],
        )
      ).length,
      1,
    );
  } finally {
    await q(pool, "DROP TRIGGER micro_checkpoint_failure ON workflow_checkpoints");
    await q(pool, "DROP FUNCTION micro_checkpoint_failure()");
    await cancelRun(run.id);
  }
});

test("escalation tool fences later writes and an interrupted provider retains the requested risk reassessment", async () => {
  const { makeContext } = await import("../src/workflow/executors/registry.ts");
  const { envFromExecution, dispatchPlatformTool, attemptIsLive } =
    await import("../src/agent/platformTools.ts");
  const run = await startRun(input());
  const job = (await claimJob("micro-tool", 60))!;
  const active = (await beginAttempt(job, "micro-tool"))!;
  const ctx = makeContext({ ...active, signal: new AbortController().signal });
  const policy = {
    mode: "coding" as const,
    workspaces: [],
    baseBranch: config.baseBranch,
    micro: { files: ["src/label.ts"], calls: 0, limit: 20, exhausted: false },
  };
  let submitted: Record<string, unknown> | undefined;
  const env = envFromExecution(
    ctx,
    "coding",
    policy,
    { skills_loaded: [], knowledge_searches: [], integration_calls: [] },
    (output) => {
      submitted = output;
    },
  );
  const response = await dispatchPlatformTool(
    "escalate_profile",
    { target: "FAST", risk: "low", reason: "authorization dependency discovered" },
    env,
  );
  assert.match(response, /checkpoint recorded/);
  assert.ok(submitted?.profile_escalation);
  assert.equal((await attemptIsLive(active.attempt.id, job.fencing_token)).ok, false);
  await finishAttempt(job.id, job.fencing_token, active.attempt.id, {
    kind: "failed",
    error: "execution timeout after escalation checkpoint",
    retryable: false,
  });
  assert.equal((await getRun(run.id)).profile, "DEEP");
  await cancelRun(run.id);
});
