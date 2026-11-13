import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { createUser } from "../src/auth/users.ts";
import {
  prepareWorkspace,
  recordWorkspace,
  runWorkspaceConflict,
  WorkspaceConflictError,
} from "../src/git/provider.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";

before(async () => {
  await migrate();
});

after(async () => {
  await pool.end();
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ws",
  GIT_AUTHOR_EMAIL: "ws@example.com",
  GIT_COMMITTER_NAME: "Ws",
  GIT_COMMITTER_EMAIL: "ws@example.com",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });

let seq = 0;
/** A repository whose `branch` is checked out in a worktree recorded for an earlier run of `status`. */
async function scenario(status: string, opts: { sameOwner?: boolean } = {}) {
  const stamp = `${Date.now()}-${++seq}`;
  const name = `wsrec-${stamp}`;
  const repoPath = join(config.reposRoot, name);
  const origin = join(config.reposRoot, `${name}.git`);
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
    username: `ws-admin-${stamp}`,
    password: "password12345",
    role: "admin",
  });
  const user = await createUser({
    username: `ws-user-${stamp}`,
    password: "password12345",
    role: "member",
  });
  const other = await createUser({
    username: `ws-other-${stamp}`,
    password: "password12345",
    role: "member",
  });
  await setRepositoryAccess(repo, user.id, "write", admin.id);
  const key = `wsrec-def-${stamp}`;
  const def = await definitions.create({
    key,
    spec: { name: key, steps: [{ key: "code", type: "coding_agent" }] },
  });
  const branch = `u1-REQ-${stamp}`;
  const insertRun = (runStatus: string, ownerId: number) =>
    one<{ id: number; branch: string }>(
      pool,
      `INSERT INTO workflow_runs (definition_key, definition_version_id, title, graph, branch, status, worker_instance, owner_id, allowed_repositories)
       VALUES ($1, $2, 'wsrec', '{"steps":[]}'::jsonb, $3, $4, $5, $6, $7) RETURNING id, branch`,
      [key, def!.versions[0].id, branch, runStatus, config.instanceId, ownerId, [name]],
    );
  const old = (await insertRun(status, opts.sameOwner === false ? other.id : user.id))!;
  // The earlier run's worktree lives at its own per-run path, as remote repositories get.
  const holder = join(config.dataDir, "worktrees", `old-${stamp}`, name);
  mkdirSync(join(holder, ".."), { recursive: true });
  sh(repoPath, "worktree", "add", "-q", "-b", branch, holder, config.baseBranch);
  writeFileSync(join(holder, "work.txt"), "earlier run\n");
  sh(holder, "add", "work.txt");
  sh(holder, "commit", "-qm", "earlier run work");
  await recordWorkspace(old.id, {
    repo: name,
    branch,
    path: holder,
    created_from: config.baseBranch,
  });
  const run = (await insertRun("RUNNING", user.id))!;
  const cleanup = async () => {
    await q(pool, "DELETE FROM workflow_runs WHERE id = ANY($1)", [[old.id, run.id]]);
    for (const p of [repoPath, origin, join(holder, "..")])
      rmSync(p, { recursive: true, force: true });
  };
  return { name, repoPath, branch, holder, old, run, cleanup };
}

test("a clean worktree of a canceled run of the same owner is reused automatically (run #96/#97 regression)", async () => {
  const s = await scenario("CANCELED");
  try {
    const conflict = await runWorkspaceConflict(s.run, s.name, s.repoPath);
    assert.equal(conflict?.release, "auto");
    assert.equal(conflict?.holder_run_id, s.old.id);
    const logs: string[] = [];
    const w = await prepareWorkspace(s.run, s.name, undefined, {
      log: async (m) => void logs.push(m),
    });
    assert.equal(w.branch, s.branch);
    assert.notEqual(w.path, s.holder);
    assert.equal(existsSync(s.holder), false, "moved, not copied");
    assert.equal(
      sh(w.path, "show", "HEAD:work.txt"),
      "earlier run\n",
      "the earlier commits are kept",
    );
    assert.match(logs.join("\n"), /reconciled worktree .* \(run #\d+ is canceled\)/);
    assert.equal(await runWorkspaceConflict(s.run, s.name, s.repoPath), null);
  } finally {
    await s.cleanup();
  }
});

test("a failed run's worktree is released only after a structured approval", async () => {
  const s = await scenario("FAILED");
  try {
    const conflict = await runWorkspaceConflict(s.run, s.name, s.repoPath);
    assert.equal(conflict?.release, "approval");
    await assert.rejects(prepareWorkspace(s.run, s.name), (e: unknown) => {
      assert.ok(e instanceof WorkspaceConflictError);
      assert.match(e.message, /already checked out/, "classified as a workspace failure");
      assert.match(e.message, /do not ask_user/);
      return true;
    });
    assert.equal(existsSync(s.holder), true, "nothing changed without approval");
    const w = await prepareWorkspace(s.run, s.name, undefined, { approvedReleases: [s.holder] });
    assert.equal(sh(w.path, "branch", "--show-current").trim(), s.branch);
    assert.equal(existsSync(s.holder), false);
  } finally {
    await s.cleanup();
  }
});

test("another owner's finished run needs approval too", async () => {
  const s = await scenario("CANCELED", { sameOwner: false });
  try {
    assert.equal((await runWorkspaceConflict(s.run, s.name, s.repoPath))?.release, "approval");
  } finally {
    await s.cleanup();
  }
});

test("dirty or running holders are never released, even when approved", async () => {
  const dirty = await scenario("CANCELED");
  try {
    writeFileSync(join(dirty.holder, "wip.txt"), "uncommitted\n");
    const conflict = await runWorkspaceConflict(dirty.run, dirty.name, dirty.repoPath);
    assert.equal(conflict?.release, "never");
    assert.match(conflict!.reason, /uncommitted/);
    await assert.rejects(
      prepareWorkspace(dirty.run, dirty.name, undefined, { approvedReleases: [dirty.holder] }),
      WorkspaceConflictError,
    );
    assert.equal(existsSync(join(dirty.holder, "wip.txt")), true, "uncommitted work untouched");
  } finally {
    await dirty.cleanup();
  }
  const running = await scenario("RUNNING");
  try {
    const conflict = await runWorkspaceConflict(running.run, running.name, running.repoPath);
    assert.equal(conflict?.release, "never");
    assert.match(conflict!.reason, /still running/);
  } finally {
    await running.cleanup();
  }
});

test("a holder whose directory is gone is unregistered and the worktree prepared fresh", async () => {
  const s = await scenario("FAILED");
  try {
    rmSync(s.holder, { recursive: true, force: true });
    assert.equal((await runWorkspaceConflict(s.run, s.name, s.repoPath))?.release, "auto");
    const w = await prepareWorkspace(s.run, s.name);
    assert.equal(sh(w.path, "show", "HEAD:work.txt"), "earlier run\n");
    assert.doesNotMatch(sh(s.repoPath, "worktree", "list", "--porcelain"), new RegExp(`old-`));
  } finally {
    await s.cleanup();
  }
});

test("a worktree outside the platform's storage is never touched", async () => {
  const s = await scenario("CANCELED");
  const outside = join(config.reposRoot, `${s.name}-manual`);
  try {
    sh(s.repoPath, "worktree", "move", s.holder, outside);
    const conflict = await runWorkspaceConflict(s.run, s.name, s.repoPath);
    assert.equal(conflict?.release, "never");
    assert.match(conflict!.reason, /not a platform-managed worktree/);
    await assert.rejects(prepareWorkspace(s.run, s.name), WorkspaceConflictError);
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    await s.cleanup();
  }
});
