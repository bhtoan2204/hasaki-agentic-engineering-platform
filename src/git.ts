import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { remoteGit } from "./repos/git.ts";
import { legacyBitbucketHttpsUrl, repositoryBranch } from "./repos/remote.ts";
import { resolveRepoPath, unsafeRelativePath } from "./repos/paths.ts";
import { promisify } from "node:util";
import { config } from "./config.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  if (["fetch", "push"].includes(args[0])) {
    const remote = legacyBitbucketHttpsUrl(
      (
        await exec("git", ["-C", cwd, "config", "--no-includes", "--get", "remote.origin.url"])
      ).stdout.trim(),
    );
    if (remote.startsWith("https://bitbucket.org/")) {
      // Use the validated explicit URL, not mutable pushurl or URL rewrite configuration.
      const safe = args.map((a) => (a === "origin" ? remote : a));
      return remoteGit(remote, safe, cwd);
    }
  }
  const { stdout } = await exec(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    { maxBuffer: 32 * 1024 * 1024 },
  );
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

export function taskDir(code: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(code) || [".", ".."].includes(code))
    throw new Error("Invalid workspace directory key");
  const dir = join(config.dataDir, "worktrees", code);
  mkdirSync(dir, { recursive: true });
  const rel = relative(realpathSync(config.dataDir), realpathSync(dir));
  if (unsafeRelativePath(rel))
    throw new Error("Worktree root escapes local dataDir; fix symlinks manually");
  return dir;
}

export interface PreparedBranch {
  repo: string;
  branch: string;
  path: string;
  createdFrom: string; // "existing local branch" | "origin/<branch>" | "origin/release/prod"
}

/**
 * Give the agent an isolated checkout of `branch` for `repo` via `git worktree`.
 * If the developer already has `branch` checked out in the primary tree, git cannot add a second worktree,
 * so this returns that checkout; workflow runs refuse it in `prepareWorkspace`.
 *  - branch already exists locally   -> worktree on it
 *  - branch exists only on origin    -> worktree tracking origin/<branch>
 *  - otherwise                       -> new branch from origin/<baseBranch>
 *
 * `relPath`: repo location relative to reposRoot when it differs from its name (e.g. "oms-src/oms-api").
 */
export async function prepareBranch(
  code: string,
  repo: string,
  branch = code,
  relPath = repo,
  opts: {
    mustExist?: boolean;
    checkoutPath?: string;
    workspacePath?: string;
    defaultBranch?: string;
    skipFetch?: boolean;
  } = {},
): Promise<PreparedBranch> {
  repositoryBranch(branch);
  const baseBranch = repositoryBranch(opts.defaultBranch || config.baseBranch);
  const repoPath = opts.checkoutPath ?? resolveRepoPath({ name: repo, path: relPath });
  if (!existsSync(join(repoPath, ".git"))) throw new Error(`repo not found: ${repoPath}`);
  const wt = opts.workspacePath ?? join(taskDir(code), repo);
  mkdirSync(join(wt, ".."), { recursive: true });
  const parent = relative(realpathSync(config.dataDir), realpathSync(join(wt, "..")));
  if (unsafeRelativePath(parent)) throw new Error("Worktree parent escapes local dataDir");

  if (existsSync(wt)) {
    const current = await git(wt, "branch", "--show-current");
    const inside = relative(realpathSync(config.dataDir), realpathSync(wt));
    if (unsafeRelativePath(inside)) throw new Error("Worktree escapes local dataDir");
    const primaryGit = await git(
      repoPath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const worktreeGit = await git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (primaryGit !== worktreeGit || current !== branch)
      throw new Error(
        `Existing worktree conflicts with ${repo}/${branch}; inspect it manually. No changes were made.`,
      );
    return { repo, branch, path: wt, createdFrom: "existing worktree" };
  }

  if (!opts.skipFetch) await git(repoPath, "fetch", "origin", "--prune");
  // Keep stale worktree registrations for explicit reconciliation; never prune during recovery.

  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    // If the developer has this branch checked out in the main tree, git refuses a second worktree: reuse theirs.
    const mainBranch = await git(repoPath, "branch", "--show-current");
    if (mainBranch === branch)
      return { repo, branch, path: repoPath, createdFrom: "developer's own checkout" };
    await git(repoPath, "worktree", "add", wt, branch);
    // Continuing an existing branch: catch up with origin when the local copy is only behind (never rewrites history).
    if (opts.mustExist && (await refExists(repoPath, `refs/remotes/origin/${branch}`)))
      await git(wt, "merge", "--ff-only", `origin/${branch}`).catch(() => {});
    return { repo, branch, path: wt, createdFrom: "existing local branch" };
  }
  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    await git(repoPath, "worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`);
    return { repo, branch, path: wt, createdFrom: `origin/${branch}` };
  }
  // An explicitly requested existing branch is never invented from the base.
  if (opts.mustExist)
    throw new Error(
      `${repo}: branch ${branch} does not exist locally or on origin — check the name (it is never created from ${config.baseBranch})`,
    );
  const base = `origin/${baseBranch}`;
  if (!(await refExists(repoPath, base))) throw new Error(`${repo}: base branch ${base} not found`);
  await git(repoPath, "worktree", "add", "--no-track", "-b", branch, wt, base);
  return { repo, branch, path: wt, createdFrom: base };
}

export async function pushBranch(path: string, branch: string, baseBranch = config.baseBranch) {
  repositoryBranch(branch);
  repositoryBranch(baseBranch);
  const dirty = await git(path, "status", "--porcelain");
  if (dirty) throw new Error(`uncommitted changes in ${path}, commit them first:\n${dirty}`);
  const ahead = await git(path, "rev-list", "--count", `origin/${baseBranch}..${branch}`);
  if (ahead === "0") throw new Error(`${branch} has no commits ahead of ${baseBranch}`);
  let note: string | undefined;
  try {
    await git(path, "push", "-u", "origin", branch);
  } catch (e) {
    if (!/non-fast-forward|fetch first|\[rejected\]/.test((e as Error).message)) throw e;
    note = await rewriteOwnBranch(path, branch, e as Error);
  }
  return {
    commits: await git(path, "log", "--format=%h %s", `origin/${baseBranch}..${branch}`),
    note,
  };
}

/**
 * The remote branch diverged from the local one. That is expected when an agent intentionally rewrote the run's own
 * branch after an earlier push (e.g. a re-execution dropped a commit). Re-push only when the remote tip is a state this
 * worktree's branch itself had (in its reflog): then nobody else added commits on top, and --force-with-lease pinned to
 * that exact tip makes the overwrite atomic. Commits from anyone else always stop the push.
 */
async function rewriteOwnBranch(path: string, branch: string, original: Error) {
  await git(path, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const remoteTip = await git(path, "rev-parse", `refs/remotes/origin/${branch}`);
  const own = (await git(path, "reflog", "show", "--format=%H", `refs/heads/${branch}`))
    .split("\n")
    .includes(remoteTip);
  if (!own) {
    const foreign = await git(
      path,
      "log",
      "--format=%h %an: %s",
      `${branch}..refs/remotes/origin/${branch}`,
    );
    throw new Error(
      `remote ${branch} has commits this worktree never had, so it was not overwritten. Integrate or remove them manually:\n${foreign}\n\n${original.message}`,
    );
  }
  const dropped = await git(path, "log", "--format=%h %s", `${branch}..${remoteTip}`);
  await git(path, "push", "-u", `--force-with-lease=${branch}:${remoteTip}`, "origin", branch);
  return `branch history was rewritten locally; replaced remote ${remoteTip.slice(0, 9)} (lease-protected). Commits removed from the remote branch:\n${dropped}`;
}
