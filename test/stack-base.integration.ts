import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q } from "../src/db/pool.ts";
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
import { dispatchPlatformTool, envFromExecution } from "../src/agent/platformTools.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { workspacesOf, workspaceBase } from "../src/git/provider.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";

const REPO = "stack-frontend";
let ownerId: number;
const runs: number[] = [];
let primary: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  ownerId = (
    await createUser({
      username: "stack-base-owner",
      password: "stack-base-password",
      role: "member",
    })
  ).id;
  primary = join(config.reposRoot, REPO);
  const origin = join(config.reposRoot, `${REPO}.git`);
  mkdirSync(primary, { recursive: true });
  git(primary, "init", "--bare", origin);
  git(primary, "init", "-b", "main");
  writeFileSync(join(primary, "README.md"), "# stack\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "initial");
  git(primary, "remote", "add", "origin", origin);
  git(primary, "push", "-u", "origin", "main");
  for (const [branch, file] of [
    ["u1-parent", "parent.txt"],
    ["u1-other", "other.txt"],
  ]) {
    git(primary, "checkout", "-b", branch, "main");
    writeFileSync(join(primary, file), branch);
    git(primary, "add", ".");
    git(primary, "commit", "-m", `work on ${branch}`);
    git(primary, "push", "-u", "origin", branch);
  }
  git(primary, "checkout", "main");
  await repositories.upsert(REPO, { projects: ["STACK"], default_branch: "main" });
  await definitions.create({
    key: "stack-base-coding",
    spec: {
      name: "Stack base",
      steps: [{ key: "implement", type: "coding_agent", config: { instructions: "Fix" } }],
    },
  });
});
afterEach(async () => {
  for (const id of runs.splice(0)) await cancelRun(id);
  await settleBackground();
});
after(async () => {
  await settleBackground();
  await pool.end();
});

async function live() {
  const run = await startRun({
    definitionKey: "stack-base-coding",
    ownerId,
    inputs: { project: "STACK" },
  });
  runs.push(run.id);
  await selectRepositories(run.id, [REPO]);
  const job = await claimJob("stack-base-worker", 120);
  assert.ok(job);
  const begun = await beginAttempt(job, "stack-base-worker");
  assert.ok(begun);
  const ctx = makeContext({ ...begun, signal: new AbortController().signal });
  const policy: PolicyContext = { mode: "coding", workspaces: [], baseBranch: "main" };
  return { run, env: envFromExecution(ctx, "coding", policy, newMetrics("fixture"), () => {}) };
}
const events = async (runId: number) =>
  (await q(pool, "SELECT content FROM workflow_events WHERE run_id = $1 ORDER BY id", [runId])).map(
    (r) => String(r.content),
  );
const tip = (branch: string) => git(primary, "rev-parse", `origin/${branch}`);

test("prepare_branch base: an existing worktree without commits moves onto the chosen branch and the run stacks on it", async () => {
  const { run, env } = await live();
  assert.match(await dispatchPlatformTool("prepare_branch", { repo: REPO }, env), /^Ready\./);
  const [w] = await workspacesOf(run.id);
  assert.equal(git(w.path, "rev-parse", "HEAD"), git(primary, "rev-parse", "main"));

  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: REPO, base: "u1-parent" }, env),
    /^Ready\./,
  );
  const [moved] = await workspacesOf(run.id);
  assert.equal(moved.path, w.path);
  assert.equal(moved.branch, w.branch, "the run keeps its own branch");
  assert.equal(git(moved.path, "rev-parse", "HEAD"), tip("u1-parent"));
  assert.equal(moved.created_from, tip("u1-parent"));
  assert.equal(git(moved.path, "status", "--porcelain"), "");
  const current = await getRun(run.id);
  assert.deepEqual(current.inputs?.branches, { [REPO]: "u1-parent" });
  assert.deepEqual(await workspaceBase(current, moved), {
    ref: "origin/u1-parent",
    target: "u1-parent",
  });
  assert.ok(
    (await events(run.id)).some((l) =>
      /moved the worktree without commits onto origin\/u1-parent/.test(l),
    ),
  );
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: REPO, base: "u1-parent" }, env),
    /^Ready\./,
  );
});

test("prepare_branch base: a worktree with work of its own is never moved, and the reason is recorded", async () => {
  const { run, env } = await live();
  await dispatchPlatformTool("prepare_branch", { repo: REPO }, env);
  const [w] = await workspacesOf(run.id);
  writeFileSync(join(w.path, "mine.txt"), "mine");
  git(w.path, "add", ".");
  git(w.path, "commit", "-m", "own work");
  const head = git(w.path, "rev-parse", "HEAD");
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: REPO, base: "u1-other" }, env),
    /^Ready\./,
  );
  assert.equal(git(w.path, "rev-parse", "HEAD"), head);
  assert.ok(
    (await events(run.id)).some((l) =>
      /has work of its own and cannot move onto origin\/u1-other/.test(l),
    ),
  );
});

test("prepare_branch base: a missing branch leaves the worktree alone; the default branch and unsafe names are refused", async () => {
  const { run, env } = await live();
  await dispatchPlatformTool("prepare_branch", { repo: REPO }, env);
  const [w] = await workspacesOf(run.id);
  const head = git(w.path, "rev-parse", "HEAD");
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: REPO, base: "no-such-branch" }, env),
    /^Ready\./,
  );
  assert.equal(git(w.path, "rev-parse", "HEAD"), head);
  assert.ok((await events(run.id)).some((l) => /origin\/no-such-branch does not exist/.test(l)));
  for (const base of ["main", "../etc", "-x", "a b"])
    assert.match(
      await dispatchPlatformTool("prepare_branch", { repo: REPO, base }, env),
      /^ERROR:/,
      base,
    );
});

test("prepare_branch base: before any worktree exists the run branch is cut from the chosen branch", async () => {
  const { run, env } = await live();
  assert.match(
    await dispatchPlatformTool("prepare_branch", { repo: REPO, base: "u1-parent" }, env),
    /^Ready\./,
  );
  const [w] = await workspacesOf(run.id);
  assert.equal(git(w.path, "rev-parse", "HEAD"), tip("u1-parent"));
  assert.notEqual(w.branch, "u1-parent");
});
