import { baseCommit, git } from "../codeIntelligence/git.ts";
import { repositoryBranch } from "./remote.ts";

export type BaseAlignment =
  { status: "aligned" | "moved"; commit: string } | { status: "skipped"; reason: string };

/**
 * Point a platform-managed primary checkout at the configured base branch (detached at the same commit the code index
 * uses as its base, via `baseCommit`).
 *
 * `git clone` checks out the remote HEAD (often `main`) and later syncs only fetch remote refs, so without this the
 * working tree stays on whatever the remote HEAD was at clone time. Chat source reads (`git ls-files`, file reads) use
 * that working tree, and the index overlay diffs it against the base, so files only on the base branch disappeared.
 *
 * Detached, not a local branch: a workflow worktree may hold the base branch's name, and Git refuses to check one
 * branch out twice. Never run on a run worktree, and never discards local changes: a dirty tree is left as it is.
 */
export async function alignCheckoutToBase(root: string, branch: string): Promise<BaseAlignment> {
  let target: string;
  try {
    target = await baseCommit(root, repositoryBranch(branch));
  } catch (e) {
    return { status: "skipped", reason: (e as Error).message };
  }
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "")).trim();
  const detached = await git(root, ["symbolic-ref", "-q", "HEAD"]).then(
    () => false,
    () => true,
  );
  if (head === target && detached) return { status: "aligned", commit: target };
  if ((await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim())
    return { status: "skipped", reason: "checkout has local changes" };
  try {
    // Not forced: Git refuses rather than overwrite untracked files the base branch also tracks.
    await git(root, ["checkout", "--quiet", "--detach", target]);
  } catch (e) {
    return { status: "skipped", reason: (e as Error).message.trim() };
  }
  return { status: "moved", commit: target };
}
