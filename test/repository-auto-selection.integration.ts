import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  selectRepositories,
  beginAttempt,
  cancelRun,
  getRun,
} from "../src/workflow/engine.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { makeContext } from "../src/workflow/executors/registry.ts";
import { settleBackground } from "../src/workflow/background.ts";
import {
  dispatchPlatformTool,
  envFromExecution,
  envFromDatabase,
} from "../src/agent/platformTools.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { workspacesOf } from "../src/git/provider.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { setSharedAccess } from "../src/repos/access.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";

let ownerId: number;
const runs: number[] = [];
const primary = "auto-gateway",
  extra = "auto-background",
  third = "auto-worker";
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  ownerId = (
    await createUser({
      username: "auto-repo-owner",
      password: "auto-repo-password",
      role: "member",
    })
  ).id;
  for (const name of [primary, extra, third]) {
    const path = join(config.reposRoot, name);
    const origin = join(config.reposRoot, `${name}.git`);
    mkdirSync(path, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
    git("init", "--bare", origin);
    git("init", "-b", "main");
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    git("add", ".");
    git("commit", "-m", "initial");
    git("remote", "add", "origin", origin);
    git("push", "-u", "origin", "main");
    await repositories.upsert(name, { projects: ["AUTO"], default_branch: "main" });
  }
  await repositories.upsert("auto-foreign", { projects: ["FOREIGN"] });
  for (const type of ["coding_agent", "agent"] as const) {
    await definitions.create({
      key: `auto-repo-${type}`,
      spec: {
        name: "Automatic repository selection",
        steps: [{ key: "implement", type, config: { instructions: "Implement the fix" } }],
      },
    });
  }
});
afterEach(async () => {
  for (const id of runs.splice(0)) await cancelRun(id);
  const repo = await repositories.get(extra);
  assert.ok(repo);
  await setSharedAccess(repo, "pull_request");
  await settleBackground();
});
after(async () => {
  await settleBackground();
  await pool.end();
});

async function live(mode: "coding" | "analysis" = "coding") {
  const run = await startRun({
    definitionKey: `auto-repo-${mode === "coding" ? "coding_agent" : "agent"}`,
    ownerId,
    inputs: { project: "AUTO" },
  });
  runs.push(run.id);
  await selectRepositories(run.id, [primary]);
  const job = await claimJob("auto-repo-worker", 120);
  assert.ok(job);
  const begun = await beginAttempt(job, "auto-repo-worker");
  assert.ok(begun);
  const ctx = makeContext({ ...begun, signal: new AbortController().signal });
  const policy: PolicyContext = { mode, workspaces: [], baseBranch: "main" };
  const env = envFromExecution(ctx, mode, policy, newMetrics("fixture"), () => {});
  return { ctx, env, job, policy };
}

test("prepare_branch selects an allowed repository, creates its worktree and persists it without asking", async () => {
  const { ctx, env, policy } = await live();
  assert.deepEqual(env.selected, [primary]);
  const result = await dispatchPlatformTool("prepare_branch", { repo: extra }, env);
  assert.match(result, /^Ready\./);
  assert.deepEqual((await getRun(env.runId)).selected_repositories, [primary, extra]);
  assert.deepEqual(ctx.run.selected_repositories, [primary, extra]);
  const trees = await workspacesOf(env.runId);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].repo, extra);
  assert.ok(policy.workspaces.includes(trees[0].path));
  assert.match(await dispatchPlatformTool("prepare_branch", { repo: extra }, env), /^Ready\./);
  assert.equal(
    (
      await q(
        pool,
        "SELECT id FROM workflow_events WHERE run_id=$1 AND content LIKE 'automatically selected repository%'",
        [env.runId],
      )
    ).length,
    1,
  );
  assert.equal(
    (await q(pool, "SELECT id FROM workflow_questions WHERE run_id=$1", [env.runId])).length,
    0,
  );
  const fresh = await envFromDatabase({
    runId: env.runId,
    stepId: env.stepId,
    attemptId: env.attemptId,
  });
  assert.deepEqual(fresh.selected, [primary, extra]);
});

test("concurrent preparation from separate bridge environments preserves both additions", async () => {
  const { env } = await live();
  const other = await envFromDatabase({
    runId: env.runId,
    stepId: env.stepId,
    attemptId: env.attemptId,
  });
  const results = await Promise.all([
    dispatchPlatformTool("prepare_branch", { repo: extra }, env),
    dispatchPlatformTool("prepare_branch", { repo: third }, other),
  ]);
  for (const result of results) assert.match(result, /^Ready\./);
  assert.deepEqual(
    (await getRun(env.runId)).selected_repositories.sort(),
    [primary, extra, third].sort(),
  );
});

test("a repository outside the run scope cannot be selected or prepared", async () => {
  const { env } = await live();
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: "auto-foreign" }, env),
    /^ERROR:.*outside run scope/,
  );
  assert.deepEqual((await getRun(env.runId)).selected_repositories, [primary]);
  assert.equal((await workspacesOf(env.runId)).length, 0);
});

test("a repository with revoked write permission cannot be automatically selected", async () => {
  const { env } = await live();
  const repo = await repositories.get(extra);
  assert.ok(repo);
  await setSharedAccess(repo, "read");
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: extra }, env),
    /^ERROR:.*insufficient for write/,
  );
  assert.deepEqual((await getRun(env.runId)).selected_repositories, [primary]);
  assert.equal((await workspacesOf(env.runId)).length, 0);
});

test("analysis attempts cannot expand selection", async () => {
  const { env } = await live("analysis");
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: extra }, env),
    /^ERROR:.*only available in coding steps/,
  );
  assert.deepEqual((await getRun(env.runId)).selected_repositories, [primary]);
});

test("open questions block automatic selection", async () => {
  const { env } = await live();
  await env.ask([{ question: "Which business rule applies?" }]);
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: extra }, env),
    /^ERROR:.*waiting for answers/,
  );
  assert.deepEqual((await getRun(env.runId)).selected_repositories, [primary]);
});

test("a fenced attempt cannot expand selection", async () => {
  const { env, job } = await live();
  await q(pool, "UPDATE workflow_jobs SET fencing_token=fencing_token+1 WHERE id=$1", [job.id]);
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: extra }, env),
    /^ERROR:.*fenced/,
  );
  assert.deepEqual((await getRun(env.runId)).selected_repositories, [primary]);
  assert.equal(
    (
      await one<{ n: number }>(
        pool,
        "SELECT count(*)::int AS n FROM execution_workspaces WHERE run_id=$1",
        [env.runId],
      )
    )?.n,
    0,
  );
});
