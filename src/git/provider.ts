import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { prepareRepository, repositoryLock, checkoutForRun } from "../repos/workspaces.ts";
import { repositories, repositoryBaseBranch } from "../repos/service.ts";
import { requireRunRepositoryAccess } from "../repos/access.ts";
import { execution } from "../auth/execution.ts";
import { instanceDirectory } from "../repos/paths.ts";
import { enqueue as enqueueIndex } from "../codeIntelligence/indexer.ts";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { pool, q, one, type Db } from "../db/pool.ts";
import { openPullRequest, pullRequestState } from "../bitbucket.ts";
import { openGithubPullRequest, githubPullRequestState } from "../github.ts";
import { prepareBranch, pushBranch } from "../git.ts";
import { overlapsLiveApplication } from "../platform/selfDevelopment.ts";
import { validateCheckout } from "../repos/paths.ts";
import { branchFor, subtaskBranchName } from "../workflow/branches.ts";

const exec = promisify(execFile);

/** Cache shared by the worker install and the coding sandbox. The sandbox cannot reach the registry. */
export function npmCacheDir() {
  return join(config.dataDir, "npm-cache");
}

/** A failed `npm ci` leaves an empty node_modules. That is not an install. */
// Package managers write these only when an install completes; an interrupted install leaves packages without one.
export function nodeModulesReady(workspace: string) {
  const dir = join(workspace, "node_modules");
  return [".package-lock.json", ".modules.yaml", ".yarn-integrity"].some((marker) =>
    existsSync(join(dir, marker)),
  );
}

/**
 * A git worktree does not contain node_modules. The coding sandbox has no network, so the worker installs here.
 * Lifecycle scripts are not run: this executes for whatever repository the run was allowed to prepare.
 * Returns true when it actually installed.
 */
export async function installNodeDependencies(workspace: string): Promise<boolean> {
  if (!existsSync(join(workspace, "package.json")) || nodeModulesReady(workspace)) return false;
  const cache = npmCacheDir();
  await mkdir(cache, { recursive: true });
  const ci = existsSync(join(workspace, "package-lock.json"));
  const opts = {
    cwd: workspace,
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: cache },
  };
  const flags = ["--ignore-scripts", "--no-audit", "--no-fund"];
  try {
    await exec("npm", [ci ? "ci" : "install", ...flags], opts);
  } catch (e) {
    // The repository's own lock file is out of sync with package.json (npm ci EUSAGE): install from package.json
    // without reading or rewriting the lock, so the worktree stays clean.
    if (!ci || !/EUSAGE|in sync/.test(String((e as any).stderr ?? (e as Error).message))) throw e;
    await exec("npm", ["install", "--no-package-lock", ...flags], opts);
  }
  return true;
}

/**
 * Seam for Git hosting. Bitbucket and GitHub implement the same calls. Worktree management stays in src/git.ts.
 * Tests replace both hosts at once via setGitProvider.
 */
export interface GitProvider {
  name: string;
  /** Push `branch` from a worktree; must refuse dirty trees / branches without commits. Returns the commit list. */
  push(path: string, branch: string, base?: string): Promise<{ commits: string; note?: string }>;
  /** Idempotent: updates the open PR for source → target if there is one. */
  openOrUpdatePullRequest(pr: {
    repo: string;
    source: string;
    target: string;
    title: string;
    description: string;
    draft: boolean;
  }): Promise<{
    url: string;
    created: boolean;
    note: string;
  }>;
  /** Read-only lifecycle state of an existing PR (null: not a PR, e.g. a create-PR link). */
  pullRequestState?(pr: {
    repo: string;
    url: string;
  }): Promise<{ state: string; merged_at: string | null; merge_commit: string | null } | null>;
}

async function pushFromWorktree(path: string, branch: string, base?: string) {
  const row = await one(
    pool,
    "SELECT r.*, w.run_id AS workspace_run_id FROM repositories r JOIN execution_workspaces w ON w.repo=r.name WHERE w.path=$1",
    [path],
  );
  if (
    !row?.enabled ||
    !row.allowed_actions.includes("write") ||
    !row.allowed_actions.includes("pull_request")
  )
    throw new Error("Repository publication permission required");
  // Re-checked at the moment of writing: the run owner's own permission, never the credentials' reach.
  await requireRunRepositoryAccess(Number(row.workspace_run_id), row.name, "write");
  if (overlapsLiveApplication(path))
    throw new Error("Refusing to push from the running application checkout");
  await validateCheckout(row, path);
  await prepareRepository(row);
  return repositoryLock(row, () =>
    pushBranch(path, branch, base || row.default_branch || config.baseBranch),
  );
}

export const bitbucketProvider: GitProvider = {
  name: "bitbucket",
  push: (path, branch, base) => pushFromWorktree(path, branch, base),
  openOrUpdatePullRequest: (pr) =>
    openPullRequest(pr.repo, pr.source, pr.title, pr.description, {
      draft: pr.draft,
      dest: pr.target,
    }),
  pullRequestState: (pr) => pullRequestState(pr.repo, pr.url),
};

export const githubProvider: GitProvider = {
  name: "github",
  push: (path, branch, base) => pushFromWorktree(path, branch, base),
  openOrUpdatePullRequest: (pr) =>
    openGithubPullRequest(pr.repo, pr.source, pr.title, pr.description, {
      draft: pr.draft,
      dest: pr.target,
    }),
  pullRequestState: (pr) => githubPullRequestState(pr.repo, pr.url),
};

/** When set, tests and benchmarks handle every host. Production dispatches by repository provider. */
let override: GitProvider | null = null;
export const gitProvider = () => override ?? bitbucketProvider;
export function gitProviderFor(provider?: string | null): GitProvider {
  if (override) return override;
  return provider === "github" ? githubProvider : bitbucketProvider;
}
/** Replace the provider for every host (tests and benchmarks). Pass bitbucketProvider to restore production dispatch. */
export function setGitProvider(p: GitProvider) {
  override = p === bitbucketProvider ? null : p;
}

/** Filesystem-safe worktree directory key for a branch ("wf/run-12" → "wf_run-12"). */
export const workspaceKey = (branch: string) => branch.replace(/[^A-Za-z0-9._-]/g, "_");

export interface Workspace {
  repo: string;
  branch: string;
  path: string;
  created_from: string;
}

export interface PrepareWorkspaceOptions {
  /** When set, allocate a worktree and branch that no other step of this run shares. */
  subtaskId?: string | null;
}

function remoteWorkspacePath(
  reg: { id: number; repository_url?: string | null },
  runId: number,
  subtaskId: string | null,
) {
  if (!reg.repository_url) return undefined;
  return join(
    config.dataDir,
    "worktrees",
    instanceDirectory(config.instanceId),
    String(runId),
    ...(subtaskId ? ["subtasks", subtaskId] : []),
    String(reg.id),
  );
}

/**
 * Create (or reuse) one worktree for `repo` and record it. Never touches reposRoot checkouts.
 * `subtaskId` cuts a branch from the run workspace so two coding steps cannot check out the same branch.
 */
export async function prepareWorkspace(
  run: { id: number; branch: string; inputs?: Record<string, any> | null },
  repo: string,
  checkLive?: () => Promise<void>,
  opts: PrepareWorkspaceOptions = {},
): Promise<Workspace> {
  await checkLive?.();
  const subtaskId = opts.subtaskId ?? null;
  if (subtaskId) subtaskBranchName("placeholder", subtaskId);
  const owner = await one(
    pool,
    "SELECT worker_instance,allowed_repositories,owner_id FROM workflow_runs WHERE id = $1",
    [run.id],
  );
  if (owner?.worker_instance !== config.instanceId)
    throw new Error("Workspaces may only be prepared by the assigned instance");
  const reg = await repositories.get(repo);
  if (!reg?.enabled || !reg.allowed_actions.includes("write"))
    throw new Error("Repository write permission required");
  if (!owner.allowed_repositories.includes(repo)) throw new Error("Repository outside run scope");
  const principal = execution.getStore();
  if (principal && Number(owner.owner_id) !== principal.userId)
    throw new Error("Run owner mismatch");
  // A worktree is where the agent writes: the owner needs write permission now, not only at run creation.
  await requireRunRepositoryAccess(run.id, repo, "write");
  const checkout = await prepareRepository(reg, true, await checkoutForRun(reg, run.id));
  const created = await repositoryLock(reg, async () => {
    await checkLive?.();
    const currentOwner = await one(
      pool,
      "SELECT worker_instance,allowed_repositories FROM workflow_runs WHERE id=$1",
      [run.id],
    );
    if (
      currentOwner?.worker_instance !== config.instanceId ||
      !currentOwner.allowed_repositories.includes(repo)
    )
      throw new Error("Run assignment changed during repository preparation");
    const current = await repositories.get(repo);
    if (!current?.enabled || !current.allowed_actions.includes("write"))
      throw new Error("Repository write permission required");
    const parent = await prepareLockedWorkspace(run, repo, current, checkout, null);
    if (!subtaskId) return [parent];
    return [parent, await prepareLockedWorkspace(run, repo, current, checkout, subtaskId)];
  });
  for (const w of created) await installNodeDependencies(w.path);
  if (codeIntelligenceEnabled()) await enqueueIndex(repo, run.id).catch(() => {});
  return created[created.length - 1];
}

async function prepareLockedWorkspace(
  run: { id: number; branch: string; inputs?: Record<string, any> | null },
  repo: string,
  reg: { id: number; path?: string | null; repository_url?: string | null; default_branch?: string | null },
  checkout: string,
  subtaskId: string | null,
): Promise<Workspace> {
  const saved = await one<{ path: string; branch: string }>(
    pool,
    `SELECT path, branch FROM execution_workspaces
     WHERE run_id=$1 AND repo=$2 AND subtask_id IS NOT DISTINCT FROM $3`,
    [run.id, repo, subtaskId],
  );
  // A prepared workspace keeps its branch (runs started before stacking stay on the parent branch they continued).
  let target: { branch: string; existing: boolean; parent?: string };
  if (saved?.branch) target = { branch: saved.branch, existing: true };
  else if (!subtaskId) target = branchFor(run, repo);
  else {
    const parent = await one<{ branch: string }>(
      pool,
      "SELECT branch FROM execution_workspaces WHERE run_id=$1 AND repo=$2 AND subtask_id IS NULL",
      [run.id, repo],
    );
    if (!parent?.branch) throw new Error("Run workspace is required before a subtask worktree");
    target = {
      branch: subtaskBranchName(parent.branch, subtaskId),
      existing: false,
      parent: parent.branch,
    };
  }
  const workspacePath = saved?.path ?? remoteWorkspacePath(reg, run.id, subtaskId);
  if (workspacePath) await mkdir(join(workspacePath, ".."), { recursive: true, mode: 0o700 });
  const b = await prepareBranch(
    subtaskId ? workspaceKey(target.branch) : workspaceKey(run.branch),
    repo,
    target.branch,
    reg.path || repo,
    {
      mustExist: target.existing,
      from: target.parent,
      checkoutPath: checkout,
      workspacePath,
      defaultBranch: reg.default_branch ?? undefined,
      skipFetch: !!reg.repository_url,
    },
  );
  if (b.path === checkout)
    throw new Error(
      `${repo}: branch is checked out in the primary checkout; switch it before continuing`,
    );
  const workspace = { repo, branch: b.branch, path: b.path, created_from: b.createdFrom };
  await recordWorkspace(run.id, workspace, pool, subtaskId);
  return workspace;
}

export async function recordWorkspace(
  runId: number,
  w: Workspace,
  db: Db = pool,
  subtaskId: string | null = null,
) {
  if (subtaskId) {
    await q(
      db,
      `INSERT INTO execution_workspaces (run_id, repo, branch, path, created_from, subtask_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, repo, subtask_id) WHERE subtask_id IS NOT NULL
       DO UPDATE SET path = excluded.path, branch = excluded.branch, created_from = excluded.created_from`,
      [runId, w.repo, w.branch, w.path, w.created_from, subtaskId],
    );
    return;
  }
  await q(
    db,
    `INSERT INTO execution_workspaces (run_id, repo, branch, path, created_from)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, repo) WHERE subtask_id IS NULL
     DO UPDATE SET path = excluded.path, branch = excluded.branch, created_from = excluded.created_from`,
    [runId, w.repo, w.branch, w.path, w.created_from],
  );
}

/** Run-level worktrees only. Subtask checkouts are not the integration or pull-request target. */
export function workspacesOf(runId: number, db: Db = pool) {
  return q<Workspace>(
    db,
    `SELECT repo, branch, path, created_from FROM execution_workspaces
     WHERE run_id = $1 AND subtask_id IS NULL ORDER BY repo`,
    [runId],
  );
}

export function allWorkspacesOf(runId: number, db: Db = pool) {
  return q<Workspace & { subtask_id: string | null }>(
    db,
    `SELECT repo, branch, path, created_from, subtask_id FROM execution_workspaces
     WHERE run_id = $1 ORDER BY repo, subtask_id NULLS FIRST`,
    [runId],
  );
}

export function subtaskWorkspacesOf(runId: number, db: Db = pool) {
  return q<Workspace & { subtask_id: string }>(
    db,
    `SELECT repo, branch, path, created_from, subtask_id FROM execution_workspaces
     WHERE run_id = $1 AND subtask_id IS NOT NULL ORDER BY repo, subtask_id`,
    [runId],
  );
}

/**
 * Where a workspace's own work starts (`ref`, for scope and patch comparisons) and where its PR goes (`target`): the
 * parent branch of a stacked run while that branch is unmerged, else the repository's default branch.
 */
export async function workspaceBase(
  run: { branch: string; inputs?: Record<string, any> | null },
  w: { repo: string; branch: string; path: string },
): Promise<{ ref: string; target: string }> {
  const fallback = await repositoryBaseBranch(w.repo).catch(() => config.baseBranch);
  const def = { ref: `origin/${fallback}`, target: fallback };
  const parent = branchFor(run, w.repo).parent;
  if (!parent || parent === w.branch) return def;
  const ok = (...args: string[]) =>
    exec("git", ["-C", w.path, ...args]).then(
      () => true,
      () => false,
    );
  if (!(await ok("rev-parse", "--verify", "-q", `refs/remotes/origin/${parent}`)))
    return (await ok("rev-parse", "--verify", "-q", `refs/heads/${parent}`))
      ? { ref: parent, target: fallback }
      : def;
  return (await ok("merge-base", "--is-ancestor", `origin/${parent}`, `origin/${fallback}`))
    ? def
    : { ref: `origin/${parent}`, target: parent };
}
