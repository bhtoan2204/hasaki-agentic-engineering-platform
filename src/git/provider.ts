import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { prepareRepository, repositoryLock, checkoutForRun } from "../repos/workspaces.ts";
import { repositories } from "../repos/service.ts";
import { execution } from "../auth/execution.ts";
import { instanceDirectory } from "../repos/paths.ts";
import { enqueue as enqueueIndex } from "../codeIntelligence/indexer.ts";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { pool, q, one, type Db } from "../db/pool.ts";
import { openPullRequest } from "../bitbucket.ts";
import { prepareBranch, pushBranch } from "../git.ts";
import { validateCheckout } from "../repos/paths.ts";
import { branchFor } from "../workflow/branches.ts";

/**
 * Seam for Git hosting. Bitbucket is the only implementation today; a GitHub provider would implement the
 * same two calls. Worktree management stays provider-independent (src/git.ts).
 */
export interface GitProvider {
  name: string;
  /** Push `branch` from a worktree; must refuse dirty trees / branches without commits. Returns the commit list. */
  push(path: string, branch: string): Promise<{ commits: string; note?: string }>;
  /** Idempotent: updates the open PR for source → target if there is one. */
  openOrUpdatePullRequest(pr: { repo: string; source: string; target: string; title: string; description: string; draft: boolean }): Promise<{
    url: string;
    created: boolean;
    note: string;
  }>;
}

export const bitbucketProvider: GitProvider = {
  name: "bitbucket",
  push: async (path, branch) => {
    const row = await one(pool, "SELECT r.* FROM repositories r JOIN execution_workspaces w ON w.repo=r.name WHERE w.path=$1", [path]);
    if (!row?.enabled || !row.allowed_actions.includes("write") || !row.allowed_actions.includes("pull_request")) throw new Error("Repository publication permission required");
    await validateCheckout(row, path);
    await prepareRepository(row);
    return repositoryLock(row, () => pushBranch(path, branch, row.default_branch || config.baseBranch));
  },
  openOrUpdatePullRequest: (pr) => openPullRequest(pr.repo, pr.source, pr.title, pr.description, { draft: pr.draft, dest: pr.target }),
};

let current: GitProvider = bitbucketProvider;
export const gitProvider = () => current;
/** Replace the provider (tests, or a future GitHub provider chosen by config). */
export function setGitProvider(p: GitProvider) {
  current = p;
}

/** Filesystem-safe worktree directory key for a branch ("wf/run-12" → "wf_run-12"). */
export const workspaceKey = (branch: string) => branch.replace(/[^A-Za-z0-9._-]/g, "_");

export interface Workspace {
  repo: string;
  branch: string;
  path: string;
  created_from: string;
}

/** Create (or reuse) the run's isolated worktree for `repo` and record it. Never touches reposRoot checkouts. */
export async function prepareWorkspace(run: { id: number; branch: string; inputs?: Record<string, any> | null }, repo: string, checkLive?: () => Promise<void>): Promise<Workspace> {
  await checkLive?.();
  const owner = await one(pool, "SELECT worker_instance,allowed_repositories,owner_id FROM workflow_runs WHERE id = $1", [run.id]);
  if (owner?.worker_instance !== config.instanceId) throw new Error("Workspaces may only be prepared by the assigned instance");
  const reg = await repositories.get(repo);
  if (!reg?.enabled || !reg.allowed_actions.includes("write")) throw new Error("Repository write permission required");
  if (!owner.allowed_repositories.includes(repo)) throw new Error("Repository outside run scope");
  const principal = execution.getStore();
  if (principal && owner.owner_id !== principal.userId) throw new Error("Run owner mismatch");
  const checkout = await prepareRepository(reg, true, await checkoutForRun(reg, run.id));
  const target = branchFor(run, repo);
  // Preserve persisted workspaces for resumable runs. New remote workspaces use stable IDs.
  const saved = await one<{ path: string }>(pool, "SELECT path FROM execution_workspaces WHERE run_id=$1 AND repo=$2", [run.id, repo]);
  const workspacePath = saved?.path ?? (reg.repository_url ? join(config.dataDir, "worktrees", instanceDirectory(config.instanceId), String(run.id), String(reg.id)) : undefined);
  if (workspacePath) await mkdir(join(workspacePath, ".."), { recursive: true, mode: 0o700 });
  const b = await repositoryLock(reg, async () => {
    await checkLive?.();
    const currentOwner = await one(pool, "SELECT worker_instance,allowed_repositories FROM workflow_runs WHERE id=$1", [run.id]);
    if (currentOwner?.worker_instance !== config.instanceId || !currentOwner.allowed_repositories.includes(repo)) throw new Error("Run assignment changed during repository preparation");
    const current = await repositories.get(repo);
    if (!current?.enabled || !current.allowed_actions.includes("write")) throw new Error("Repository write permission required");
    return prepareBranch(workspaceKey(run.branch), repo, target.branch, reg.path || repo, {
      mustExist: target.existing, checkoutPath: checkout, workspacePath, defaultBranch: reg.default_branch, skipFetch: !!reg.repository_url,
    });
  });
  await checkLive?.();
  if (b.path === checkout) throw new Error(`${repo}: branch is checked out in the primary checkout; switch it before continuing`);
  await recordWorkspace(run.id, { repo, branch: b.branch, path: b.path, created_from: b.createdFrom });
  if (codeIntelligenceEnabled()) await enqueueIndex(repo, run.id).catch(() => { });
  return { repo, branch: b.branch, path: b.path, created_from: b.createdFrom };
}

export async function recordWorkspace(runId: number, w: Workspace, db: Db = pool) {
  await q(
    db,
    `INSERT INTO execution_workspaces (run_id, repo, branch, path, created_from) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, repo) DO UPDATE SET path = excluded.path, branch = excluded.branch`,
    [runId, w.repo, w.branch, w.path, w.created_from],
  );
}

export function workspacesOf(runId: number, db: Db = pool) {
  return q<Workspace>(db, "SELECT repo, branch, path, created_from FROM execution_workspaces WHERE run_id = $1 ORDER BY repo", [runId]);
}
