import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { createUser } from "../src/auth/users.ts";
import {
  prepareWorkspace,
  recordWorkspace,
  removeWorkspace,
  LeaseLostError,
  restoreMissingWorkspaces,
  runWorkspaceConflict,
  WorkspaceConflictError,
} from "../src/git/provider.ts";
import { repositories } from "../src/repos/service.ts";
import { restoreConflictSkips } from "../src/agent/verify.ts";
import { removeWorktree } from "../src/git.ts";
import { runChanges } from "../src/git/changes.ts";
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

test("a deleted worktree is restored at the same path on the same branch, with its commits", async () => {
  const s = await scenario("RUNNING");
  try {
    const head = sh(s.holder, "rev-parse", "HEAD");
    writeFileSync(join(s.holder, "draft.txt"), "uncommitted\n");
    rmSync(s.holder, { recursive: true, force: true });
    assert.match(
      sh(s.repoPath, "worktree", "list", "--porcelain"),
      /prunable/,
      "git keeps the registration of the deleted directory",
    );
    const logs: string[] = [];
    assert.equal(
      await restoreMissingWorkspaces(s.old, [], { log: async (m) => void logs.push(m), en: true }),
      null,
    );
    assert.equal(sh(s.holder, "branch", "--show-current").trim(), s.branch);
    assert.equal(sh(s.holder, "rev-parse", "HEAD"), head);
    assert.equal(sh(s.holder, "show", "HEAD:work.txt"), "earlier run\n");
    assert.equal(existsSync(join(s.holder, "draft.txt")), false);
    assert.match(
      logs.join("\n"),
      new RegExp(
        `restored missing worktree ${s.name} at ${s.holder} on ${s.branch} .*uncommitted changes .* are lost`,
      ),
    );
    assert.doesNotMatch(sh(s.repoPath, "worktree", "list", "--porcelain"), /prunable/);
  } finally {
    await s.cleanup();
  }
});

test("a deleted worktree whose registration was already pruned is restored too", async () => {
  const s = await scenario("RUNNING");
  try {
    rmSync(s.holder, { recursive: true, force: true });
    sh(s.repoPath, "worktree", "prune");
    await restoreMissingWorkspaces(s.old, [], { log: async () => {}, en: true });
    assert.equal(sh(s.holder, "show", "HEAD:work.txt"), "earlier run\n");
  } finally {
    await s.cleanup();
  }
});

test("a deleted worktree whose branch is gone everywhere fails clearly and creates nothing", async () => {
  const s = await scenario("RUNNING");
  try {
    rmSync(s.holder, { recursive: true, force: true });
    sh(s.repoPath, "worktree", "prune");
    sh(s.repoPath, "branch", "-D", s.branch);
    const r = await restoreMissingWorkspaces(s.old, [], {
      log: async () => {},
      en: true,
      checkLive: async () => {},
    });
    assert.equal(r?.kind, "failed");
    assert.equal(r?.kind === "failed" && r.retryable, false);
    assert.match(
      r?.kind === "failed" ? r.error : "",
      new RegExp(
        `${s.name}: worktree .* no longer exists and could not be restored on ${s.branch}: .*does not exist locally or on origin`,
      ),
    );
    assert.equal(existsSync(s.holder), false);
    assert.equal(sh(s.repoPath, "branch", "--list", s.branch), "");
  } finally {
    await s.cleanup();
  }
});

test("a present worktree is left untouched by the restore", async () => {
  const s = await scenario("RUNNING");
  try {
    writeFileSync(join(s.holder, "draft.txt"), "uncommitted\n");
    const logs: string[] = [];
    assert.equal(
      await restoreMissingWorkspaces(s.old, [], { log: async (m) => void logs.push(m), en: true }),
      null,
    );
    assert.deepEqual(logs, []);
    assert.equal(sh(s.holder, "status", "--porcelain"), "?? draft.txt\n");
  } finally {
    await s.cleanup();
  }
});

test("restore: a stale registration at the same path on another spelling or detached HEAD is dropped, others kept", async () => {
  const s = await scenario("RUNNING");
  const alias = join(config.dataDir, "worktrees", `alias-${s.name}`);
  const other = join(config.dataDir, "worktrees", `other-${s.name}`);
  try {
    symlinkSync(join(s.holder, ".."), alias);
    const aliased = join(alias, s.name);
    await recordWorkspace(s.old.id, {
      repo: s.name,
      branch: s.branch,
      path: aliased,
      created_from: config.baseBranch,
    });
    sh(s.holder, "checkout", "-q", "--detach");
    sh(s.repoPath, "worktree", "add", "-q", "--detach", other, config.baseBranch);
    rmSync(s.holder, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    assert.equal(
      await restoreMissingWorkspaces(s.old, [], { log: async () => {}, en: true }),
      null,
    );
    assert.equal(sh(aliased, "branch", "--show-current").trim(), s.branch);
    assert.equal(sh(s.holder, "show", "HEAD:work.txt"), "earlier run\n");
    const list = sh(s.repoPath, "worktree", "list", "--porcelain");
    assert.match(
      list,
      new RegExp(`worktree ${other}\\n`),
      "other missing registrations are not pruned",
    );
  } finally {
    rmSync(alias, { force: true });
    sh(s.repoPath, "worktree", "prune");
    await s.cleanup();
  }
});

test("restore: a release the developer approved is honoured, and fenced-out attempts create nothing", async () => {
  const s = await scenario("FAILED");
  const path = join(config.dataDir, "worktrees", `new-${s.name}`, s.name);
  try {
    await recordWorkspace(s.run.id, {
      repo: s.name,
      branch: s.branch,
      path,
      created_from: config.baseBranch,
    });
    for (const liveChecks of [0, 1]) {
      let calls = 0;
      await assert.rejects(
        restoreMissingWorkspaces(s.run, [], {
          log: async () => {},
          en: true,
          approvedReleases: [s.holder],
          checkLive: async () => {
            if (calls++ >= liveChecks) throw new Error("attempt is no longer live");
          },
        }),
        (e) =>
          e instanceof LeaseLostError &&
          e.message === "attempt is no longer live" &&
          (e.cause as Error).message === "attempt is no longer live",
        "a lost lease propagates like on the platform-tool path, not as a non-retryable restore failure",
      );
    }
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(s.holder), true);

    const asked = await restoreMissingWorkspaces(s.run, [], { log: async () => {}, en: true });
    assert.equal(asked?.kind, "waiting_input", "the developer is asked, the step does not fail");
    assert.deepEqual(
      asked?.kind === "waiting_input" &&
        (asked.checkpoint as { workspace_conflict: Array<{ holder_path: string }> })
          .workspace_conflict[0].holder_path,
      s.holder,
    );
    assert.equal(existsSync(path), false);
    const skipped = restoreConflictSkips(asked);
    assert.deepEqual(
      [...skipped.keys()],
      [s.name],
      "after submit only the conflicted repo is skipped (verification and scope), nothing is re-asked",
    );
    assert.match(skipped.get(s.name)!, new RegExp(`conflict .*tests not run: .*${s.holder}`));
    assert.equal(restoreConflictSkips(null).size, 0);

    let live = 0;
    const restored = await restoreMissingWorkspaces(s.run, [], {
      log: async () => {},
      en: true,
      approvedReleases: [s.holder],
      checkLive: async () => void live++,
    });
    assert.equal(restored, null);
    assert.ok(live > 0, "fencing is checked");
    assert.equal(sh(path, "branch", "--show-current").trim(), s.branch);
    assert.equal(sh(path, "show", "HEAD:work.txt"), "earlier run\n");
    assert.equal(existsSync(s.holder), false);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
    await s.cleanup();
  }
});

test("worktree cleanup keeps dirty worktrees and ones with a git operation in progress, saying why", async () => {
  const s = await scenario("COMPLETED");
  try {
    writeFileSync(join(s.holder, "scratch.txt"), "wip\n");
    assert.equal(await removeWorktree(s.holder), "uncommitted changes");
    assert.equal(
      (await runWorkspaceConflict(s.run, s.name, s.repoPath))?.reason,
      "uncommitted changes",
    );
    rmSync(join(s.holder, "scratch.txt"));

    sh(s.repoPath, "checkout", "-q", "-b", "side", config.baseBranch);
    writeFileSync(join(s.repoPath, "side.txt"), "side\n");
    sh(s.repoPath, "add", "side.txt");
    sh(s.repoPath, "commit", "-qm", "side");
    sh(s.holder, "merge", "-q", "--no-ff", "--no-commit", "side");
    assert.equal(await removeWorktree(s.holder), "merge in progress");
    sh(s.holder, "merge", "--abort");

    assert.throws(() => sh(s.holder, "rebase", "-q", "--exec", "false", "HEAD~1"));
    assert.equal(sh(s.holder, "status", "--porcelain"), "", "clean tree, rebase stopped");
    assert.equal(await removeWorktree(s.holder), "rebase in progress");
    sh(s.holder, "rebase", "--abort");

    sh(s.repoPath, "checkout", "-q", "side");
    writeFileSync(join(s.repoPath, "work.txt"), "side wins\n");
    sh(s.repoPath, "add", "work.txt");
    sh(s.repoPath, "commit", "-qm", "conflicting side");
    sh(s.repoPath, "checkout", "-q", config.baseBranch);
    assert.throws(() => sh(s.holder, "cherry-pick", "side"));
    sh(s.holder, "checkout", "-q", "--ours", "work.txt");
    sh(s.holder, "add", "work.txt");
    assert.equal(sh(s.holder, "status", "--porcelain"), "", "clean tree, cherry-pick stopped");
    assert.equal(await removeWorktree(s.holder), "cherry-pick in progress");
    const conflict = await runWorkspaceConflict(s.run, s.name, s.repoPath);
    assert.equal(conflict?.release, "never", "not offered for release when the move would refuse");
    assert.equal(conflict?.reason, "cherry-pick in progress");
    sh(s.holder, "cherry-pick", "--abort");
    assert.ok(existsSync(s.holder), "kept worktrees stay in place");

    assert.equal(await removeWorktree(s.holder), null);
    assert.equal(existsSync(s.holder), false);
  } finally {
    await s.cleanup();
  }
});

test("a run's committed changes stay readable after cleanup removed its worktree", async () => {
  const s = await scenario("COMPLETED");
  try {
    const ws = { repo: s.name, branch: s.branch, path: s.holder, created_from: config.baseBranch };
    assert.equal(await removeWorkspace(s.old.id, { ...ws, subtask_id: null }), null);
    assert.equal(existsSync(s.holder), false);
    // A later run reuses the shared branch at the same path and commits on it.
    sh(s.repoPath, "worktree", "add", "-q", s.holder, s.branch);
    writeFileSync(join(s.holder, "later.txt"), "later run\n");
    sh(s.holder, "add", "later.txt");
    sh(s.holder, "commit", "-qm", "later run work");
    const [repo] = (await runChanges(s.old.id)).repos;
    assert.ok("commits" in repo && repo.exists, "changes read at the recorded head");
    assert.deepEqual(
      repo.commits.map((c) => c.subject),
      ["earlier run work"],
    );
    assert.deepEqual(
      repo.files.map((f) => f.path),
      ["work.txt"],
    );
    assert.match(repo.diff, /\+earlier run/);
    assert.equal(repo.status, "", "a removed worktree had nothing uncommitted");

    await q(pool, "UPDATE execution_workspaces SET removed_head = $2 WHERE run_id = $1", [
      s.old.id,
      "0".repeat(40),
    ]);
    const [broken] = (await runChanges(s.old.id)).repos;
    assert.equal(broken.exists, false, "an unreadable head is not shown as commits");
  } finally {
    await s.cleanup();
  }
});

test("a removed worktree without a recorded head shows no changes, not the shared branch tip", async () => {
  const s = await scenario("COMPLETED");
  try {
    assert.equal(await removeWorktree(s.holder), null);
    const [repo] = (await runChanges(s.old.id)).repos;
    assert.equal(repo.exists, false);
  } finally {
    await s.cleanup();
  }
});
