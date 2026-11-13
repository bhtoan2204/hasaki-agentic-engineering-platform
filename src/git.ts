import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { remoteGit } from "./repos/git.ts";
import {
  canonicalizeDetectedUrl,
  legacyBitbucketHttpsUrl,
  repositoryBranch,
  repositoryRemote,
} from "./repos/remote.ts";
import { resolveRepoPath, unsafeRelativePath } from "./repos/paths.ts";
import { overlapsLiveApplication } from "./platform/selfDevelopment.ts";
import { promisify } from "node:util";
import { config } from "./config.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  if (["fetch", "push"].includes(args[0])) {
    const raw = (
      await exec("git", ["-C", cwd, "config", "--no-includes", "--get", "remote.origin.url"])
    ).stdout.trim();
    const remote = canonicalizeDetectedUrl(legacyBitbucketHttpsUrl(raw)) ?? "";
    if (remote.startsWith("https://bitbucket.org/") || remote.startsWith("https://github.com/")) {
      // Use the validated explicit URL, not mutable pushurl or URL rewrite configuration.
      const canonical = repositoryRemote(remote).url;
      const safe = args.map((a) => (a === "origin" ? canonical : a));
      return remoteGit(canonical, safe, cwd);
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
    /** Cut a new branch from this existing branch instead of the base (stacked on a parent task's branch). */
    from?: string;
  } = {},
): Promise<PreparedBranch> {
  repositoryBranch(branch);
  const baseBranch = repositoryBranch(opts.defaultBranch || config.baseBranch);
  const repoPath = opts.checkoutPath ?? resolveRepoPath({ name: repo, path: relPath });
  if (overlapsLiveApplication(repoPath))
    throw new Error(
      "Refusing to run Git operations against the running application checkout. Workflows use an isolated clone and worktree.",
    );
  if (!existsSync(join(repoPath, ".git"))) throw new Error(`repo not found: ${repoPath}`);
  const wt = opts.workspacePath ?? join(taskDir(code), repo);
  if (overlapsLiveApplication(wt))
    throw new Error("Refusing to place a worktree inside the running application checkout");
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
      throw new Error(
        `${repo}: branch ${branch} is checked out in the primary checkout. Workflows do not write that tree; use another branch or move the checkout.`,
      );
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
  if (opts.from) {
    repositoryBranch(opts.from);
    const local = await refExists(repoPath, `refs/heads/${opts.from}`);
    const remote = await refExists(repoPath, `refs/remotes/origin/${opts.from}`);
    if (!local && !remote)
      throw new Error(
        `${repo}: branch ${opts.from} does not exist locally or on origin — check the name (nothing was created)`,
      );
    // Unpushed parent work counts: start from the local branch unless origin has moved past it.
    const start =
      local &&
      (!remote ||
        (await git(repoPath, "merge-base", "--is-ancestor", `origin/${opts.from}`, opts.from).then(
          () => true,
          () => false,
        )))
        ? opts.from
        : `origin/${opts.from}`;
    await git(repoPath, "worktree", "add", "--no-track", "-b", branch, wt, start);
    return { repo, branch, path: wt, createdFrom: start };
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

/**
 * Preserve uncommitted work (staged, unstaged, untracked) as a commit under `ref` without touching the worktree, the
 * index or any branch: a temporary index is filled and written as a tree. Returns null when the worktree is clean.
 */
export async function snapshotUncommitted(path: string, ref: string, message: string) {
  if (!ref.startsWith("refs/platform/"))
    throw new Error(`snapshot ref must be under refs/platform/: ${ref}`);
  const dirty = await git(path, "status", "--porcelain");
  if (!dirty) return null;
  const dir = mkdtempSync(join(tmpdir(), "snapshot-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const run = async (...args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", path, ...args], { env })
    ).stdout.trim();
  try {
    await run("read-tree", "HEAD");
    await run("add", "-A");
    const tree = await run("write-tree");
    const commit = await run("commit-tree", tree, "-p", "HEAD", "-m", message);
    await run("update-ref", ref, commit);
    return {
      ref,
      commit,
      files: dirty
        .split("\n")
        .map((l) => l.slice(3))
        .filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Uncommitted paths in a worktree. Empty when the tree matches HEAD. */
export async function worktreePorcelain(path: string): Promise<string> {
  return git(path, "status", "--porcelain");
}

/**
 * Unregister and delete a clean worktree under dataDir. Its branch stays, so the worktree can be prepared again.
 * Returns why it was kept instead, or null once removed.
 */
export async function removeWorktree(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const checked = await releasableWorktree(path);
  if (typeof checked === "string") return checked;
  await git(checked.primary, "worktree", "remove", path);
  return null;
}

/** Move a clean worktree under dataDir to `to` (reused by another run). Returns why it was not moved, or null. */
export async function moveWorktree(path: string, to: string): Promise<string | null> {
  const checked = await releasableWorktree(path);
  if (typeof checked === "string") return checked;
  if (existsSync(to)) return `${to} already exists`;
  if (unsafeRelativePath(relative(config.dataDir, to)) || overlapsLiveApplication(to))
    return "target is outside the platform's worktree storage";
  await git(checked.primary, "worktree", "move", path, to);
  return null;
}

const IN_PROGRESS_MARKERS = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["sequencer", "cherry-pick or revert"],
  ["BISECT_LOG", "bisect"],
] as const;

async function worktreeState(path: string): Promise<{ common: string; inProgress: string | null }> {
  const [common, ...markers] = (
    await git(
      path,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      ...IN_PROGRESS_MARKERS.flatMap(([marker]) => ["--git-path", marker]),
    )
  ).split("\n");
  const i = markers.findIndex((at) => existsSync(at));
  return { common, inProgress: i < 0 ? null : `${IN_PROGRESS_MARKERS[i][1]} in progress` };
}

export async function releasableWorktree(path: string): Promise<{ primary: string } | string> {
  const inside = relative(realpathSync(config.dataDir), realpathSync(path));
  if (unsafeRelativePath(inside) || overlapsLiveApplication(path))
    return "outside the platform's worktree storage";
  const { common, inProgress } = await worktreeState(path);
  const primary = join(common, "..");
  if (realpathSync(primary) === realpathSync(path)) return "primary checkout, not a worktree";
  if (inProgress) return inProgress;
  if (await worktreePorcelain(path)) return "uncommitted changes";
  return { primary };
}

/** The linked worktree (never the primary checkout) that has `branch` checked out, and whether its directory is gone. */
export async function branchWorktree(
  repoPath: string,
  branch: string,
): Promise<{ path: string; missing: boolean } | null> {
  repositoryBranch(branch);
  const found = (await listWorktrees(repoPath)).find((w) => w.branch === branch);
  return found ? { path: found.path, missing: !existsSync(found.path) } : null;
}

/** Linked worktrees (the primary checkout excluded) as git spells their paths; `branch` is null when detached. */
async function listWorktrees(repoPath: string): Promise<{ path: string; branch: string | null }[]> {
  const blocks = (await git(repoPath, "worktree", "list", "--porcelain")).split(/\n\s*\n/).slice(1);
  return blocks.flatMap((block) => {
    const lines = block.split("\n");
    const path = lines[0].replace(/^worktree /, "");
    const head = lines.find((l) => l.startsWith("branch refs/heads/"));
    return path ? [{ path, branch: head ? head.slice("branch refs/heads/".length) : null }] : [];
  });
}

const resolvedPath = (path: string) => {
  for (const resolve of [
    () => realpathSync(path),
    () => join(realpathSync(dirname(path)), basename(path)),
  ])
    try {
      return resolve();
    } catch {
      /* missing: try the parent */
    }
  return path;
};

/** The registered worktree (any branch or detached) whose path resolves to `path`, as git spells it. */
export async function registeredWorktreeAt(repoPath: string, path: string): Promise<string | null> {
  const target = resolvedPath(path);
  return (await listWorktrees(repoPath)).find((w) => resolvedPath(w.path) === target)?.path ?? null;
}

/** Drop the registration of a worktree whose directory no longer exists (nothing on disk is deleted). */
export async function unregisterMissingWorktree(repoPath: string, path: string) {
  if (existsSync(path)) throw new Error(`${path} still exists`);
  if (
    unsafeRelativePath(relative(config.dataDir, path)) &&
    unsafeRelativePath(relative(resolvedPath(config.dataDir), path))
  )
    throw new Error("outside the platform's worktree storage");
  await git(repoPath, "worktree", "remove", "--force", path);
}

/**
 * Merge `branch` into the worktree at `path`. A conflict aborts the merge and leaves the worktree as it was.
 * The commit identity is local to this command so integration does not depend on the machine's git config.
 */
export async function mergeBranchInto(path: string, branch: string): Promise<void> {
  repositoryBranch(branch);
  if (await worktreePorcelain(path))
    throw new Error(`worktree ${path} has uncommitted changes`);
  try {
    await git(
      path,
      "-c",
      "user.name=platform",
      "-c",
      "user.email=platform@local",
      "merge",
      "--no-ff",
      "--no-edit",
      branch,
    );
  } catch (e) {
    await git(path, "merge", "--abort").catch(() => {});
    throw new Error(
      `merge of ${branch} failed: ${String((e as Error).message ?? e).split("\n")[0]}`,
    );
  }
}
