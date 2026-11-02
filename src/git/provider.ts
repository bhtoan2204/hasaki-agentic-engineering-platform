import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q, one, type Db } from "../db/pool.ts";
import { openPullRequest } from "../bitbucket.ts";
import { prepareBranch, pushBranch } from "../git.ts";

/**
 * Seam for Git hosting. Bitbucket is the only implementation today; a GitHub provider would implement the
 * same two calls. Worktree management stays provider-independent (src/git.ts).
 */
export interface GitProvider {
  name: string;
  /** Push `branch` from a worktree; must refuse dirty trees / branches without commits. Returns the commit list. */
  push(path: string, branch: string): Promise<{ commits: string }>;
  /** Idempotent: updates the open PR for source → target if there is one. */
  openOrUpdatePullRequest(pr: { repo: string; source: string; target: string; title: string; description: string; draft: boolean }): Promise<{
    url: string;
    created: boolean;
    note: string;
  }>;
}

export const bitbucketProvider: GitProvider = {
  name: "bitbucket",
  push: (path, branch) => pushBranch(path, branch),
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
export async function prepareWorkspace(run: { id: number; branch: string }, repo: string): Promise<Workspace> {
  const reg = await one<{ path: string }>(pool, "SELECT path FROM repositories WHERE name = $1", [repo]);
  const rel = reg?.path || repo;
  const b = await prepareBranch(workspaceKey(run.branch), repo, run.branch, rel);
  if (b.path === join(config.reposRoot, rel)) {
    // Legacy prepareBranch reuses the developer's checkout when it is on the task branch. Workflows never edit
    // the primary checkout: refuse instead.
    throw new Error(`${repo}: branch ${run.branch} is checked out in your primary checkout; switch it to another branch first`);
  }
  await recordWorkspace(run.id, { repo, branch: b.branch, path: b.path, created_from: b.createdFrom });
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

export function findWorkspace(runId: number, repo: string) {
  return one<Workspace>(pool, "SELECT repo, branch, path, created_from FROM execution_workspaces WHERE run_id = $1 AND repo = $2", [runId, repo]);
}
