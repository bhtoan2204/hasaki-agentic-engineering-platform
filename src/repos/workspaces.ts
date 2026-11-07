import { existsSync } from "node:fs";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative } from "node:path";
import { currentUserId } from "../auth/execution.ts";
import { config } from "../config.ts";
import { pool, one } from "../db/pool.ts";
import { unsafeRelativePath, instanceDirectory, resolveRepoPath, validateCheckout, type LocalRepository } from "./paths.ts";
import { remoteGit } from "./git.ts";
import { repositoryRemote } from "./remote.ts";

/** Session locks survive process concurrency and are released by PostgreSQL after a crash. No stale lockfiles. */
export async function repositoryLock<T>(repo: LocalRepository, action: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const key = `repository:${config.instanceId}:${repo.id ?? repo.name}`;
  try {
    await c.query("SET lock_timeout='180s'");
    await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
    return await action();
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => {});
    await c.query("RESET lock_timeout").catch(() => {});
    c.release();
  }
}
const active = new Set<string>();
const failures = new Map<string, string>();
const failureKey = (repo: LocalRepository) => `${repo.id}:${currentUserId() ?? "service"}`;

export async function prepareRepository(repo: LocalRepository, refresh = false, persistedPath?: string): Promise<string> {
  if (!repo.repository_url) return validateCheckout(repo); // Explicit local/benchmark and transitional legacy checkouts.
  const remote = repositoryRemote(repo.repository_url);
  return repositoryLock(repo, async () => {
    const path = persistedPath ?? resolveRepoPath(repo);
    if (persistedPath) {
      await validateCheckout(repo, persistedPath);
      await remoteGit(remote.url, refresh ? ["fetch", "--no-recurse-submodules", "--", remote.url, "+refs/heads/*:refs/remotes/origin/*"] : ["ls-remote", "--", remote.url, "HEAD"], path);
      return path;
    }
    const key = String(repo.id);
    active.add(key);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const rel = relative(await realpath(config.dataDir), await realpath(dirname(path)));
      if (unsafeRelativePath(rel)) throw new Error("Checkout directory escapes local dataDir");
      if (!existsSync(path)) {
        // Only a reserved staging directory is removed; never remove an existing checkout.
        const staging = join(dirname(path), "clone.partial");
        await rm(staging, { recursive: true, force: true });
        try {
          await remoteGit(remote.url, ["clone", "--no-recurse-submodules", "--", remote.url, staging]);
          await rename(staging, path);
        } finally { await rm(staging, { recursive: true, force: true }); }
      } else {
        await validateCheckout(repo);
        // Always authorize reuse, too: a different run owner must not inherit another member's access.
        await remoteGit(remote.url, refresh ? ["fetch", "--no-recurse-submodules", "--", remote.url, "+refs/heads/*:refs/remotes/origin/*"] : ["ls-remote", "--", remote.url, "HEAD"], path);
      }
      failures.delete(failureKey(repo));
      return await validateCheckout(repo);
    } catch (e) {
      failures.set(failureKey(repo), (e as Error).message);
      throw e;
    } finally { active.delete(key); }
  });
}

/** No clone, fetch or credential reads on ordinary metadata requests. Paths never leave this instance API. */
export async function workspaceStatus(repo: LocalRepository) {
  let status = repo.repository_url ? "not_cloned" : "not_configured";
  const key = String(repo.id);
  if (!repo.repository_url) return { instance_id: config.instanceId, repository_id: repo.id, status };
  if (active.has(key)) status = "cloning";
  else if (existsSync(join(resolveRepoPath(repo), ".git"))) {
    try { await validateCheckout(repo); status = "ready"; }
    catch { status = "remote_mismatch"; }
  }
  const failure = failures.get(failureKey(repo));
  if (failure && !["cloning", "remote_mismatch"].includes(status)) status = /authentication|credentials|token/i.test(failure) ? "authentication_required" : "sync_failed";
  return { instance_id: config.instanceId, repository_id: repo.id, status };
}

export async function testRepositoryConnection(repo: LocalRepository) {
  if (!repo.repository_url) throw new Error("Repository URL is not configured");
  try {
    await remoteGit(repo.repository_url, ["ls-remote", "--", repo.repository_url, "HEAD"]);
    failures.delete(failureKey(repo));
    return { ok: true };
  } catch (e) { failures.set(failureKey(repo), (e as Error).message); throw e; }
}

/** Resume only persisted workspaces of this worker. Never infer ownership from another instance's filesystem. */
export async function checkoutForRun(repo: LocalRepository, runId: number): Promise<string | undefined> {
  const run = await one(pool, "SELECT worker_instance,allowed_repositories FROM workflow_runs WHERE id=$1", [runId]);
  if (run?.worker_instance !== config.instanceId || !run.allowed_repositories.includes(repo.name)) throw new Error("Unauthorized run workspace");
  const saved = await one(pool, "SELECT path FROM execution_workspaces WHERE run_id=$1 AND repo=$2", [runId, repo.name]);
  if (!saved) return undefined;
  const rel = relative(await realpath(config.dataDir), await realpath(saved.path));
  if (unsafeRelativePath(rel)) throw new Error("Run workspace escapes local dataDir");
  const common = (await promisify(execFile)("git", ["-C", saved.path, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const primary = dirname(common);
  await validateCheckout(repo, primary);
  return primary;
}

/** All agent providers share the same run-local working directory. Retain recorded session cwd on resume. */
export async function runWorkingDirectory(runId: number): Promise<string> {
  const run = await one(pool, "SELECT worker_instance FROM workflow_runs WHERE id=$1", [runId]);
  if (run?.worker_instance !== config.instanceId) throw new Error("Assigned worker required for agent workspace");
  const session = await one(pool, "SELECT s.cwd FROM agent_sessions s JOIN workflow_step_attempts a ON a.id=s.attempt_id WHERE a.run_id=$1 ORDER BY s.id DESC LIMIT 1", [runId]);
  const path = session?.cwd ?? join(config.dataDir, "worktrees", instanceDirectory(config.instanceId), String(runId), "agent");
  const intended = relative(config.dataDir, path);
  if (unsafeRelativePath(intended)) throw new Error("Agent workspace belongs to a different local layout");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const rel = relative(await realpath(config.dataDir), await realpath(path));
  if (unsafeRelativePath(rel)) throw new Error("Agent workspace escapes local dataDir");
  return path;
}
