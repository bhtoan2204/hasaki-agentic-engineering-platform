import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { beginAttempt } from "../src/workflow/engine.ts";
import { createUser } from "../src/auth/users.ts";
import { integrateSubtasks } from "../src/workflow/executors/builtin.ts";
import { prepareBranch, mergeBranchInto, worktreePorcelain } from "../src/git.ts";
import { prepareWorkspace, workspacesOf, subtaskWorkspacesOf } from "../src/git/provider.ts";
import { subtaskBranchName } from "../src/workflow/branches.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";
import {
  validateExpansion,
  DEFAULT_LIMITS,
  type DecompositionPlan,
} from "../src/workflow/decomposition.ts";

before(async () => {
  await migrate();
});

after(async () => {
  await pool.end();
});

test("validateExpansion keeps parallel strategy when isolatedWorkspaces is true", () => {
  const plan: DecompositionPlan = {
    summary: "parallel plan",
    subtasks: [
      {
        id: "task-1",
        title: "Task 1",
        description: "Task 1 description",
        objective: "Obj 1",
        expected_output: "Out 1",
        acceptance_criteria: ["ac1"],
        target_repos: ["repo-a"],
        code_context: [],
        depends_on: [],
        permissions: [],
        risk: "low",
        complexity: "low",
        execution_strategy: "parallel",
        agent_role: "coder",
        testing: [],
        owned_files: ["src/a.ts"],
      },
      {
        id: "task-2",
        title: "Task 2",
        description: "Task 2 description",
        objective: "Obj 2",
        expected_output: "Out 2",
        acceptance_criteria: ["ac2"],
        target_repos: ["repo-a"],
        code_context: [],
        depends_on: [],
        permissions: [],
        risk: "low",
        complexity: "low",
        execution_strategy: "parallel",
        agent_role: "coder",
        testing: [],
        owned_files: ["src/b.ts"],
      },
    ],
  };

  const expanded = validateExpansion(plan, {
    existingKeys: [],
    allowedRepositories: ["repo-a"],
    limits: DEFAULT_LIMITS,
    isolatedWorkspaces: true,
  });

  assert.equal(expanded.errors.length, 0);
  assert.equal(expanded.subtasks[0].execution_strategy, "parallel");
  assert.equal(expanded.subtasks[1].execution_strategy, "parallel");
  assert.deepEqual(expanded.subtasks[1].depends_on, []);
});

test("integrateSubtasks integrates disjoint subtasks and detects file conflicts", async () => {
  const logs: string[] = [];
  const fakeCtx = (upstream: Record<string, any>) => ({
    input: { upstream },
    step: { config: {} },
    log: async (_kind: string, msg: string) => {
      logs.push(msg);
    },
  });

  // 1. Clean non-conflicting integration
  const cleanResult = await integrateSubtasks(
    fakeCtx({
      "subtask-1": { output: { modified_files: ["src/a.ts"] } },
      "subtask-2": { output: { modified_files: ["src/b.ts"] } },
    }) as any,
  );

  assert.equal(cleanResult.kind, "completed");
  if (cleanResult.kind === "completed") {
    const out = cleanResult.output as any;
    assert.equal(out.status, "integrated");
    assert.deepEqual(out.subtasks_integrated, ["subtask-1", "subtask-2"]);
  }

  // 2. Conflicting integration (both subtasks touched src/shared.ts)
  const conflictResult = await integrateSubtasks(
    fakeCtx({
      "subtask-1": { output: { modified_files: ["src/shared.ts", "src/a.ts"] } },
      "subtask-2": { output: { modified_files: ["src/shared.ts", "src/b.ts"] } },
    }) as any,
  );

  assert.equal(conflictResult.kind, "failed");
  if (conflictResult.kind === "failed") {
    const det = conflictResult.details as any;
    assert.match(conflictResult.error, /merge conflict/);
    assert.deepEqual(det?.conflicts[0].file, "src/shared.ts");
    assert.deepEqual(det?.conflicts[0].subtasks, ["subtask-1", "subtask-2"]);
  }
});

test("beginAttempt admits concurrent independent subtasks and serializes conflicting steps", async () => {
  const user = await createUser({ username: `user-${Date.now()}`, password: "password12345", role: "member" });
  const key = `conc-test-${Date.now()}`;
  const def = await definitions.create({
    key,
    spec: {
      name: key,
      steps: [
        { key: "step-1", type: "coding_agent", config: { concurrent: true, scope: { owned_files: ["a.ts"] } } },
        { key: "step-2", type: "coding_agent", config: { concurrent: true, scope: { owned_files: ["b.ts"] } } },
        { key: "step-conflict", type: "coding_agent", config: { concurrent: true, scope: { owned_files: ["a.ts"] } } },
      ],
    },
  });
  const versionId = def!.versions[0].id;

  const run = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_runs (definition_key, definition_version_id, title, graph, branch, status, worker_instance, owner_id, allowed_repositories)
     VALUES ($1, $2, 'Conc Run', '{"steps": [{"key": "step-1", "depends_on": []}, {"key": "step-2", "depends_on": []}, {"key": "step-conflict", "depends_on": []}]}'::jsonb, 'test-branch', 'RUNNING', $3, $4, '{"repo-a"}') RETURNING id`,
    [key, versionId, config.instanceId, user.id],
  ))!;

  // Step 1: concurrent subtask with owned_files: ["a.ts"]
  const step1 = (await one<{ id: number; generation: number }>(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, config, subtask_id)
     VALUES ($1, 'step-1', 'coding_agent', 'Subtask 1', 0, 'READY', 1,
             '{"concurrent": true, "isolated_workspace": true, "scope": {"owned_files": ["a.ts"]}}'::jsonb, 'subtask-1')
     RETURNING id, generation`,
    [run.id],
  ))!;

  // Step 2: concurrent subtask with owned_files: ["b.ts"]
  const step2 = (await one<{ id: number; generation: number }>(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, config, subtask_id)
     VALUES ($1, 'step-2', 'coding_agent', 'Subtask 2', 1, 'READY', 1,
             '{"concurrent": true, "isolated_workspace": true, "scope": {"owned_files": ["b.ts"]}}'::jsonb, 'subtask-2')
     RETURNING id, generation`,
    [run.id],
  ))!;

  // Step 3: conflicting subtask with overlapping owned_files: ["a.ts"]
  const stepConflict = (await one<{ id: number; generation: number }>(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, config, subtask_id)
     VALUES ($1, 'step-conflict', 'coding_agent', 'Subtask Conflict', 2, 'READY', 1,
             '{"concurrent": true, "isolated_workspace": true, "scope": {"owned_files": ["a.ts"]}}'::jsonb, 'subtask-conflict')
     RETURNING id, generation`,
    [run.id],
  ))!;

  const job1 = (await one<any>(
    pool,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, status, fencing_token, lease_owner, lease_expires_at)
     VALUES ($1, $2, 1, 'job-1', 'running', 1, $3, now() + interval '30 seconds') RETURNING *`,
    [run.id, step1.id, config.instanceId],
  ))!;

  const job2 = (await one<any>(
    pool,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, status, fencing_token, lease_owner, lease_expires_at)
     VALUES ($1, $2, 1, 'job-2', 'running', 1, $3, now() + interval '30 seconds') RETURNING *`,
    [run.id, step2.id, config.instanceId],
  ))!;

  const jobConflict = (await one<any>(
    pool,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, status, fencing_token, lease_owner, lease_expires_at)
     VALUES ($1, $2, 1, 'job-conflict', 'running', 1, $3, now() + interval '30 seconds') RETURNING *`,
    [run.id, stepConflict.id, config.instanceId],
  ))!;

  // 1. Begin attempt for Step 1 -> admitted
  const begun1 = await beginAttempt(job1, "worker-1");
  assert.ok(begun1, "Step 1 is admitted");
  assert.equal(begun1.step.key, "step-1");

  // 2. Begin attempt for Step 2 concurrently while Step 1 is RUNNING -> admitted (disjoint files)
  const begun2 = await beginAttempt(job2, "worker-2");
  assert.ok(begun2, "Step 2 is admitted concurrently with Step 1");
  assert.equal(begun2.step.key, "step-2");

  // 3. A coding step that would share the run worktree is refused even when its files do not overlap.
  const stepShared = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, config)
     VALUES ($1, 'step-shared', 'coding_agent', 'Shared', 3, 'READY', 1,
             '{"concurrent": true, "scope": {"owned_files": ["c.ts"]}}'::jsonb)
     RETURNING id`,
    [run.id],
  ))!;
  const jobShared = (await one<any>(
    pool,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, status, fencing_token, lease_owner, lease_expires_at)
     VALUES ($1, $2, 1, 'job-shared', 'running', 1, $3, now() + interval '30 seconds') RETURNING *`,
    [run.id, stepShared.id, config.instanceId],
  ))!;
  const begunShared = await beginAttempt(jobShared, "worker-shared");
  assert.equal(begunShared, null, "A step without its own worktree is not admitted beside a writer");

  // 4. isolated_workspace without a subtask id cannot name a distinct worktree.
  const stepUnnamed = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_steps (run_id, key, type, name, position, status, generation, config)
     VALUES ($1, 'step-unnamed', 'coding_agent', 'Unnamed', 4, 'READY', 1,
             '{"concurrent": true, "isolated_workspace": true, "scope": {"owned_files": ["d.ts"]}}'::jsonb)
     RETURNING id`,
    [run.id],
  ))!;
  const jobUnnamed = (await one<any>(
    pool,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, status, fencing_token, lease_owner, lease_expires_at)
     VALUES ($1, $2, 1, 'job-unnamed', 'running', 1, $3, now() + interval '30 seconds') RETURNING *`,
    [run.id, stepUnnamed.id, config.instanceId],
  ))!;
  assert.equal(await beginAttempt(jobUnnamed, "worker-unnamed"), null);

  // 5. Begin attempt for Step Conflict while Step 1 is RUNNING -> refused (file overlap on a.ts)
  const begunConflict = await beginAttempt(jobConflict, "worker-3");
  assert.equal(begunConflict, null, "Step Conflict is refused and requeued due to overlapping owned files");

  // Verify jobConflict status was reset to queued
  const requeued = await one<any>(pool, "SELECT status, lease_owner FROM workflow_jobs WHERE id = $1", [jobConflict.id]);
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.lease_owner, null);

  await q(pool, "DELETE FROM workflow_runs WHERE id = $1", [run.id]);
});

test("prepareWorkspace gives each subtask its own worktree and integration merges them", async () => {
  const stamp = Date.now();
  const name = `subprep-${stamp}`;
  const repoPath = join(config.reposRoot, name);
  const origin = join(config.reposRoot, `${name}.git`);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Sub",
    GIT_AUTHOR_EMAIL: "sub@example.com",
    GIT_COMMITTER_NAME: "Sub",
    GIT_COMMITTER_EMAIL: "sub@example.com",
  };
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
  execFileSync("git", ["init", "-q", "--bare", "-b", config.baseBranch, origin]);
  mkdirSync(repoPath, { recursive: true });
  sh(repoPath, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(repoPath, "README.md"), "seed\n");
  sh(repoPath, "add", "README.md");
  sh(repoPath, "commit", "-qm", "seed");
  sh(repoPath, "remote", "add", "origin", origin);
  sh(repoPath, "push", "-q", "origin", config.baseBranch);

  const repo = (await repositories.upsert(name, {}))!;
  const admin = await createUser({
    username: `sub-admin-${stamp}`,
    password: "password12345",
    role: "admin",
  });
  const user = await createUser({
    username: `sub-user-${stamp}`,
    password: "password12345",
    role: "member",
  });
  await setRepositoryAccess(repo, user.id, "write", admin.id);
  const key = `subprep-def-${stamp}`;
  const def = await definitions.create({
    key,
    spec: { name: key, steps: [{ key: "code", type: "coding_agent" }] },
  });
  const branch = `run-subprep-${stamp}`;
  const run = (await one<{ id: number; branch: string }>(
    pool,
    `INSERT INTO workflow_runs (definition_key, definition_version_id, title, graph, branch, status, worker_instance, owner_id, allowed_repositories)
     VALUES ($1, $2, 'subprep', '{"steps":[]}'::jsonb, $3, 'RUNNING', $4, $5, $6) RETURNING id, branch`,
    [key, def!.versions[0].id, branch, config.instanceId, user.id, [name]],
  ))!;
  const paths: string[] = [repoPath, origin];
  try {
    const parent = await prepareWorkspace(run, name);
    const a = await prepareWorkspace(run, name, undefined, { subtaskId: "task-a" });
    const b = await prepareWorkspace(run, name, undefined, { subtaskId: "task-b" });
    paths.push(parent.path, a.path, b.path);
    assert.equal(a.branch, subtaskBranchName(parent.branch, "task-a"));
    assert.equal(b.branch, subtaskBranchName(parent.branch, "task-b"));
    assert.notEqual(a.path, parent.path);
    assert.notEqual(b.path, parent.path);
    assert.notEqual(a.path, b.path);
    const again = await prepareWorkspace(run, name, undefined, { subtaskId: "task-a" });
    assert.equal(again.path, a.path);
    assert.deepEqual(
      (await workspacesOf(run.id)).map((w) => w.path),
      [parent.path],
    );
    assert.equal((await subtaskWorkspacesOf(run.id)).length, 2);

    writeFileSync(join(a.path, "a.ts"), "a\n");
    sh(a.path, "add", "a.ts");
    sh(a.path, "commit", "-qm", "a");
    writeFileSync(join(b.path, "b.ts"), "b\n");
    sh(b.path, "add", "b.ts");
    sh(b.path, "commit", "-qm", "b");
    await mergeBranchInto(parent.path, a.branch);
    await mergeBranchInto(parent.path, b.branch);
    assert.equal(sh(parent.path, "show", "HEAD:a.ts"), "a\n");
    assert.equal(sh(parent.path, "show", "HEAD:b.ts"), "b\n");
    assert.equal(await worktreePorcelain(parent.path), "");

    const clashA = await prepareBranch(`clash-a-${stamp}`, name, `${branch}--clash-a`, name, {
      skipFetch: true,
      from: branch,
      defaultBranch: config.baseBranch,
    });
    const clashB = await prepareBranch(`clash-b-${stamp}`, name, `${branch}--clash-b`, name, {
      skipFetch: true,
      from: branch,
      defaultBranch: config.baseBranch,
    });
    paths.push(clashA.path, clashB.path);
    writeFileSync(join(clashA.path, "README.md"), "from a\n");
    sh(clashA.path, "add", "README.md");
    sh(clashA.path, "commit", "-qm", "clash a");
    writeFileSync(join(clashB.path, "README.md"), "from b\n");
    sh(clashB.path, "add", "README.md");
    sh(clashB.path, "commit", "-qm", "clash b");
    await mergeBranchInto(parent.path, clashA.branch);
    await assert.rejects(mergeBranchInto(parent.path, clashB.branch), /merge of/);
    assert.equal(await worktreePorcelain(parent.path), "");
  } finally {
    await q(pool, "DELETE FROM workflow_runs WHERE id = $1", [run.id]).catch(() => {});
    for (const p of paths) rmSync(p, { recursive: true, force: true });
  }
});
