import { pool, one, q, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { requireRunRepositoryAccess } from "../repos/access.ts";
import { repositories, repositoryReference } from "../repos/service.ts";
import { gitProviderFor } from "./provider.ts";
import type { PullRequestRef } from "./model.ts";

/**
 * Human-triggered pull/merge request actions. No agent tool and no engine path calls these: merging stays a
 * decision of the run owner, re-checked at the moment of the action against their own repository permission and
 * the host's mergeability, approvals and required pipeline. The host still enforces protected branches.
 */

async function load(actorId: number, id: number, db: Db) {
  const pr = await one<{
    id: number;
    run_id: number;
    owner_id: number | null;
    repo: string;
    url: string;
    state: string | null;
  }>(
    db,
    `SELECT p.*, r.owner_id FROM pull_requests p JOIN workflow_runs r ON r.id = p.run_id WHERE p.id = $1`,
    [id],
  );
  if (!pr) throw new HttpError(404, "Pull request not found");
  if (Number(pr.owner_id) !== actorId)
    throw new HttpError(
      403,
      "Only the owner of the run that opened this pull request can act on it",
    );
  await requireRunRepositoryAccess(Number(pr.run_id), pr.repo, "pull_request", db);
  const reg = await repositories.get(pr.repo, db);
  if (!reg) throw new HttpError(404, "Repository not registered");
  const provider = gitProviderFor(reg.provider);
  const ref: PullRequestRef = {
    repo: repositoryReference(reg),
    url: pr.url,
    remoteUrl: reg.repository_url ?? null,
  };
  return { pr, reg, provider, ref };
}

const unsupported = (provider: string, what: string) =>
  new HttpError(501, `${what} is not supported for ${provider} repositories`);

/** Mergeability and CI of one pull request, for the UI and reviewers. Read-only. */
export async function pullRequestStatus(actorId: number, id: number, db: Db = pool) {
  const { provider, ref } = await load(actorId, id, db);
  const readiness = provider.mergeReadiness ? await provider.mergeReadiness(ref) : null;
  const pipelines = provider.pipelines
    ? await provider.pipelines({ repo: ref.repo, remoteUrl: ref.remoteUrl, url: ref.url })
    : null;
  return { provider: provider.name, readiness, pipelines: pipelines?.pipelines ?? null };
}

export async function mergePullRequestAction(actorId: number, id: number, db: Db = pool) {
  const { pr, reg, provider, ref } = await load(actorId, id, db);
  if (!provider.mergePullRequest) throw unsupported(provider.name, "Merging from the platform");
  if (pr.state && pr.state !== "OPEN")
    throw new HttpError(409, `Pull request is ${String(pr.state).toLowerCase()}`);
  const result = await provider.mergePullRequest(ref, {
    deleteSourceBranch: reg.delete_source_branch === true,
  });
  if (!result.merged)
    throw new HttpError(409, `Merge refused: ${result.reasons.join("; ") || "not mergeable"}`);
  await q(
    db,
    "UPDATE pull_requests SET state = 'MERGED', merged_at = now(), merge_commit = $2, state_checked_at = now() WHERE id = $1",
    [id, result.merge_commit],
  );
  return { merged: true, merge_commit: result.merge_commit, url: pr.url };
}

export async function closePullRequestAction(actorId: number, id: number, db: Db = pool) {
  const { pr, provider, ref } = await load(actorId, id, db);
  if (!provider.closePullRequest) throw unsupported(provider.name, "Closing from the platform");
  const result = await provider.closePullRequest(ref);
  if (result.state === "DECLINED")
    await q(
      db,
      "UPDATE pull_requests SET state = 'DECLINED', state_checked_at = now() WHERE id = $1",
      [id],
    );
  return { state: result.state, url: pr.url };
}
