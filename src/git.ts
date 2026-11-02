import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function refExists(cwd: string, ref: string) {
  try {
    await git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

/** Repos the agent may work in for a given task project. */
export function allowedRepos(project: string): string[] {
  const mapped = Object.entries(config.projects).find(([k]) => k.toLowerCase() === project.toLowerCase())?.[1];
  if (mapped) return mapped.filter((r) => existsSync(join(config.reposRoot, r, ".git")));
  return readdirSync(config.reposRoot).filter((r) => existsSync(join(config.reposRoot, r, ".git")));
}

export function taskDir(code: string) {
  const dir = join(config.dataDir, "worktrees", code);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface PreparedBranch {
  repo: string;
  branch: string;
  path: string;
  createdFrom: string; // "existing local branch" | "origin/<branch>" | "origin/release/prod"
}

/**
 * Give the agent an isolated checkout of `branch` for `repo`.
 * We use `git worktree` so the developer's own checkout (and any uncommitted work in it) is never touched.
 *  - branch already exists locally   -> worktree on it
 *  - branch exists only on origin    -> worktree tracking origin/<branch>
 *  - otherwise                       -> new branch from origin/<baseBranch>
 */
/** `relPath`: repo location relative to reposRoot when it differs from its name (e.g. "oms-src/oms-api"). */
export async function prepareBranch(code: string, repo: string, branch = code, relPath = repo): Promise<PreparedBranch> {
  const repoPath = join(config.reposRoot, relPath);
  if (!existsSync(join(repoPath, ".git"))) throw new Error(`repo not found: ${repoPath}`);
  const wt = join(taskDir(code), repo);

  if (existsSync(wt)) {
    const current = await git(wt, "branch", "--show-current");
    if (current !== branch) await git(wt, "checkout", branch);
    return { repo, branch, path: wt, createdFrom: "existing worktree" };
  }

  await git(repoPath, "fetch", "origin", "--prune");
  await git(repoPath, "worktree", "prune");

  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    // If the developer has this branch checked out in the main tree, git refuses a second worktree: reuse theirs.
    const mainBranch = await git(repoPath, "branch", "--show-current");
    if (mainBranch === branch) return { repo, branch, path: repoPath, createdFrom: "developer's own checkout" };
    await git(repoPath, "worktree", "add", wt, branch);
    return { repo, branch, path: wt, createdFrom: "existing local branch" };
  }
  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    await git(repoPath, "worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`);
    return { repo, branch, path: wt, createdFrom: `origin/${branch}` };
  }
  const base = `origin/${config.baseBranch}`;
  if (!(await refExists(repoPath, base))) throw new Error(`${repo}: base branch ${base} not found`);
  await git(repoPath, "worktree", "add", "--no-track", "-b", branch, wt, base);
  return { repo, branch, path: wt, createdFrom: base };
}

export async function pushBranch(path: string, branch: string) {
  const dirty = await git(path, "status", "--porcelain");
  if (dirty) throw new Error(`uncommitted changes in ${path}, commit them first:\n${dirty}`);
  const ahead = await git(path, "rev-list", "--count", `origin/${config.baseBranch}..${branch}`);
  if (ahead === "0") throw new Error(`${branch} has no commits ahead of ${config.baseBranch}`);
  await git(path, "push", "-u", "origin", branch);
  return { commits: await git(path, "log", "--format=%h %s", `origin/${config.baseBranch}..${branch}`) };
}
