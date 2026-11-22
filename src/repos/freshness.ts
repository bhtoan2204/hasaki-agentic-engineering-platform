/**
 * Base-branch freshness of a checkout, before an agent reads it. The remote's commit for the base branch is compared
 * with the local remote-tracking ref; only when they differ is the remote fetched (remote-tracking refs only: no
 * reset, rebase or checkout here, so local work is never touched). Callers supply how to ask the remote and how to
 * fetch, so authenticated remotes keep their transport and local remotes use plain Git.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await exec("git", ["-C", cwd, ...args], { timeout: 60_000, maxBuffer: 4 << 20 })).stdout.trim();

export interface Freshness {
  branch: string;
  /** origin/<branch> before and after the check. */
  before: string | null;
  after: string | null;
  /** The remote's commit for the branch (null: unknown, e.g. no remote). */
  remote: string | null;
  fetched: boolean;
  /** "current": local ref matches the remote; "refreshed": it did after a fetch; "stale": still behind; "unknown". */
  status: "current" | "refreshed" | "stale" | "unknown";
}

export const trackingRef = (path: string, branch: string) =>
  git(path, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`]).catch(
    () => null,
  );

/** `git ls-remote` output for one ref → its commit. */
export const lsRemoteCommit = (out: string, branch: string) =>
  out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] ?? null;

export async function ensureFreshBase(
  path: string,
  branch: string,
  remote: { lsRemote: () => Promise<string>; fetch: () => Promise<unknown> },
): Promise<Freshness> {
  const before = await trackingRef(path, branch);
  const head = lsRemoteCommit(await remote.lsRemote(), branch);
  if (!head)
    return { branch, before, after: before, remote: null, fetched: false, status: "unknown" };
  if (head === before)
    return { branch, before, after: before, remote: head, fetched: false, status: "current" };
  await remote.fetch();
  const after = await trackingRef(path, branch);
  return {
    branch,
    before,
    after,
    remote: head,
    fetched: true,
    status: after === head ? "refreshed" : "stale",
  };
}

/** Local remotes (no platform-managed URL): plain `git ls-remote origin` / `git fetch origin`. */
export async function ensureFreshLocalBase(
  path: string,
  branch: string,
): Promise<Freshness | null> {
  if (!(await git(path, ["remote"]).catch(() => "")).split("\n").includes("origin")) return null;
  return ensureFreshBase(path, branch, {
    lsRemote: () => git(path, ["ls-remote", "origin", `refs/heads/${branch}`]),
    fetch: () => git(path, ["fetch", "--no-recurse-submodules", "origin", "--prune"]),
  });
}

/** Last freshness result per checkout path (read by the harness preflight for evidence; process-local). */
export const lastFreshness = new Map<string, Freshness>();
