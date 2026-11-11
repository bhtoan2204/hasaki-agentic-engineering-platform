import { existsSync } from "node:fs";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import pg from "pg";
import { currentUserId } from "../auth/execution.ts";
import { config } from "../config.ts";
import { pool, one } from "../db/pool.ts";
import {
  unsafeRelativePath,
  instanceDirectory,
  resolveRepoPath,
  validateCheckout,
  type LocalRepository,
} from "./paths.ts";
import { remoteGit } from "./git.ts";
import { repositoryRemote } from "./remote.ts";
import { overlapsLiveApplication } from "../platform/selfDevelopment.ts";

const exec = promisify(execFile);

/**
 * Advisory locks are held for the whole clone or fetch. That connection must not come from the
 * application pool: waiters and the clone would otherwise consume every client (including claimJob).
 * Idle clients do not keep the process alive.
 */
let repositoryPool: pg.Pool | undefined;
function lockPool() {
  return (repositoryPool ??= new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    idleTimeoutMillis: config.database.idleTimeoutMillis,
    keepAlive: true,
    allowExitOnIdle: true,
  }));
}

/** Session locks survive process concurrency and are released by PostgreSQL after a crash. No stale lockfiles. */
export async function repositoryLock<T>(
  repo: LocalRepository,
  action: () => Promise<T>,
): Promise<T> {
  const c = await lockPool().connect();
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

export async function prepareRepository(
  repo: LocalRepository,
  refresh = false,
  persistedPath?: string,
): Promise<string> {
  if (!repo.repository_url) return validateCheckout(repo); // Explicit local/benchmark and transitional legacy checkouts.
  const remote = repositoryRemote(repo.repository_url);
  return repositoryLock(repo, async () => {
    const path = persistedPath ?? resolveRepoPath(repo);
    if (overlapsLiveApplication(path))
      throw new Error(
        `Refusing to prepare ${repo.name}: the checkout overlaps the running application source tree`,
      );
    const sync = () =>
      remoteGit(
        remote.url,
        refresh
          ? [
              "fetch",
              "--no-recurse-submodules",
              "--",
              remote.url,
              "+refs/heads/*:refs/remotes/origin/*",
            ]
          : ["ls-remote", "--", remote.url, "HEAD"],
        path,
      );
    if (persistedPath) {
      await validateCheckout(repo, persistedPath);
      await sync();
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
          await remoteGit(remote.url, [
            "clone",
            "--no-recurse-submodules",
            "--",
            remote.url,
            staging,
          ]);
          await rename(staging, path);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      } else {
        await validateCheckout(repo);
        // Always authorize reuse, too: a different run owner must not inherit another member's access.
        await sync();
      }
      failures.delete(failureKey(repo));
      return await validateCheckout(repo);
    } catch (e) {
      failures.set(failureKey(repo), (e as Error).message);
      throw e;
    } finally {
      active.delete(key);
    }
  });
}

/** No clone, fetch or credential reads on ordinary metadata requests. Paths never leave this instance API. */
export async function workspaceStatus(repo: LocalRepository) {
  let status = repo.repository_url ? "not_cloned" : "not_configured";
  const key = String(repo.id);
  if (!repo.repository_url)
    return { instance_id: config.instanceId, repository_id: repo.id, status };
  if (active.has(key)) status = "cloning";
  else if (existsSync(join(resolveRepoPath(repo), ".git"))) {
    try {
      await validateCheckout(repo);
      status = "ready";
    } catch {
      status = "remote_mismatch";
    }
  }
  const failure = failures.get(failureKey(repo));
  if (failure && !["cloning", "remote_mismatch"].includes(status))
    status = /authentication|credentials|token/i.test(failure)
      ? "authentication_required"
      : "sync_failed";
  return { instance_id: config.instanceId, repository_id: repo.id, status };
}

export async function testRepositoryConnection(repo: LocalRepository) {
  if (!repo.repository_url) throw new Error("Repository URL is not configured");
  try {
    await remoteGit(repo.repository_url, ["ls-remote", "--", repo.repository_url, "HEAD"]);
    failures.delete(failureKey(repo));
    return { ok: true };
  } catch (e) {
    failures.set(failureKey(repo), (e as Error).message);
    throw e;
  }
}

/** Resume only persisted workspaces of this worker. Never infer ownership from another instance's filesystem. */
export async function checkoutForRun(
  repo: LocalRepository,
  runId: number,
): Promise<string | undefined> {
  const run = await one(
    pool,
    `SELECT r.worker_instance,r.allowed_repositories,w.path FROM workflow_runs r
    LEFT JOIN execution_workspaces w ON w.run_id=r.id AND w.repo=$2 WHERE r.id=$1`,
    [runId, repo.name],
  );
  if (run?.worker_instance !== config.instanceId || !run.allowed_repositories.includes(repo.name))
    throw new Error("Unauthorized run workspace");
  if (!run.path) return undefined;
  const rel = relative(await realpath(config.dataDir), await realpath(run.path));
  if (unsafeRelativePath(rel)) throw new Error("Run workspace escapes local dataDir");
  const common = (
    await exec("git", ["-C", run.path, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).stdout.trim();
  const primary = dirname(common);
  await validateCheckout(repo, primary);
  return primary;
}

/** Agent session directories are isolated by step. Repository worktrees remain run-local and coordinated by the engine. */
export async function runWorkingDirectory(runId: number, stepId?: number): Promise<string> {
  const run = await one(
    pool,
    `SELECT r.worker_instance,
    (SELECT s.cwd FROM agent_sessions s JOIN workflow_step_attempts a ON a.id=s.attempt_id
      WHERE a.run_id=r.id AND r.worker_instance=$2 AND ($3::bigint IS NULL OR (a.step_id=$3 AND a.effective_agent IS NOT NULL)) ORDER BY s.id DESC LIMIT 1) AS cwd
    FROM workflow_runs r WHERE r.id=$1`,
    [runId, config.instanceId, stepId ?? null],
  );
  if (run?.worker_instance !== config.instanceId)
    throw new Error("Assigned worker required for agent workspace");
  const path =
    run.cwd ??
    join(
      config.dataDir,
      "worktrees",
      instanceDirectory(config.instanceId),
      String(runId),
      stepId == null ? "agent" : `agent-${stepId}`,
    );
  const intended = relative(config.dataDir, path);
  if (unsafeRelativePath(intended))
    throw new Error("Agent workspace belongs to a different local layout");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const rel = relative(await realpath(config.dataDir), await realpath(path));
  if (unsafeRelativePath(rel)) throw new Error("Agent workspace escapes local dataDir");
  return path;
}
