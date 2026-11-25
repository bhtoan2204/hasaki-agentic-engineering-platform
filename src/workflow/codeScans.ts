import { config } from "../config.ts";
import { one, pool } from "../db/pool.ts";
import { requireRepositoryAccess } from "../repos/access.ts";
import { trackingRef } from "../repos/freshness.ts";
import { prepareRepository } from "../repos/workspaces.ts";

const TERMINAL = ["COMPLETED", "FAILED", "CANCELED"];

/**
 * The base commit each repository is at now, as a run would analyse it: access checked for the actor, reuse
 * authorized against the remote and a stale base fetched (prepareRepository). Null when one cannot be established.
 */
export async function currentBaseCommits(
  actorId: number,
  repos: string[],
): Promise<Record<string, string> | null> {
  const commits: Record<string, string> = {};
  for (const name of repos) {
    const { repository } = await requireRepositoryAccess(actorId, name);
    const path = await prepareRepository(repository).catch(() => null);
    const commit = path
      ? await trackingRef(path, repository.default_branch || config.baseBranch)
      : null;
    if (!commit) return null;
    commits[name] = commit;
  }
  return commits;
}

export type ScanReuse =
  | { reused: "running"; run_id: number }
  | { reused: "same_commits"; run_id: number; commits: Record<string, string> };

/**
 * An assessment of the same repositories and focus that makes a new one pointless: one still running, or a completed
 * one whose analysed base commits (workflow_runs.source_revisions) are every repository's current base commit.
 */
export async function reusableScan(
  ownerId: number,
  repos: string[],
  focus: string,
  commitsNow: (repos: string[]) => Promise<Record<string, string> | null>,
): Promise<ScanReuse | null> {
  const sorted = [...new Set(repos)].sort();
  const last = await one<{
    id: number;
    status: string;
    assess_status: string;
    source_revisions: Record<string, { commit?: string }> | null;
  }>(
    pool,
    `SELECT r.id, r.status, a.status AS assess_status, r.source_revisions
       FROM workflow_runs r JOIN workflow_steps a ON a.run_id = r.id AND a.key = 'assess'
      WHERE r.definition_key = 'codebase-assessment' AND r.owner_id = $1
        AND ARRAY(SELECT unnest(r.selected_repositories) ORDER BY 1) = $2::text[]
        AND COALESCE(r.inputs->>'focus', '') = $3
        AND r.status <> 'CANCELED'
      ORDER BY r.id DESC LIMIT 1`,
    [ownerId, sorted, focus],
  );
  if (!last) return null;
  if (!TERMINAL.includes(last.status)) return { reused: "running", run_id: last.id };
  if (last.status !== "COMPLETED" || last.assess_status !== "COMPLETED") return null;
  const commits = await commitsNow(sorted);
  if (!commits) return null;
  const same = sorted.every((repo) => last.source_revisions?.[repo]?.commit === commits[repo]);
  return same ? { reused: "same_commits", run_id: last.id, commits } : null;
}
