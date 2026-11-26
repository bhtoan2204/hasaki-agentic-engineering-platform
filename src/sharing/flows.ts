import type pg from "pg";
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { analysisContext } from "./context.ts";
import { bugHuntKey, codeAssessmentKey, runtimeRcaKey, type RepoAtCommit } from "./key.ts";
import { installationId } from "./scope.ts";
import { lookupOrStart, type LookupResult } from "./service.ts";
import type { SharedActor } from "./hooks.ts";
import type { SharedRow } from "./repository.ts";

/**
 * The three analyses wrapped by lookup-before-compute. Each returns null when sharing does not apply (its flag is off,
 * or the key cannot be established, e.g. a repository's current commit is unknown); the caller then does exactly what it
 * did before. `start` is the caller's own run start, called inside the claim transaction.
 */
type Start = (tx: {
  client: pg.PoolClient;
  afterCommit: (cb: () => unknown) => void;
}) => Promise<number>;

const RCA_WORKFLOW = "production-incident-investigation";
const HUNT_WORKFLOW = "production-bug-hunt";
const ASSESS_WORKFLOW = "codebase-assessment";

const repoCommits = (commits: Record<string, string>): RepoAtCommit[] =>
  Object.entries(commits).map(([repo, commit]) => ({ repo, commit }));

export async function sharedCodeAssessment(x: {
  actor: SharedActor;
  focus: string;
  provider?: string;
  /** The base commit of every repository, as the run would read it; null when one cannot be established. */
  commits: Record<string, string> | null;
  start: Start;
}): Promise<LookupResult | null> {
  if (!config.sharedResults.codeAssessment || !x.commits) return null;
  const ctx = await analysisContext(pool, ASSESS_WORKFLOW, x.provider);
  const key = codeAssessmentKey({
    scope: await installationId(),
    repos: repoCommits(x.commits),
    focus: x.focus,
    ...ctx,
  });
  return lookupOrStart({ key, actor: x.actor, scopeRepos: Object.keys(x.commits), start: x.start });
}

export async function sharedRuntimeRca(x: {
  actor: SharedActor;
  fingerprint: string;
  contract: string;
  provider?: string;
  start: Start;
}): Promise<LookupResult | null> {
  if (!config.sharedResults.prodErrors) return null;
  const ctx = await analysisContext(pool, RCA_WORKFLOW, x.provider);
  const key = runtimeRcaKey({
    scope: await installationId(),
    errorKey: x.fingerprint,
    contract: x.contract,
    ...ctx,
  });
  return lookupOrStart({ key, actor: x.actor, errorKey: x.fingerprint, start: x.start });
}

export async function sharedBugHunt(x: {
  actor: SharedActor;
  fingerprint: string;
  provider?: string;
  commits: Record<string, string> | null;
  start: Start;
}): Promise<LookupResult | null> {
  if (!config.sharedResults.prodErrors || !x.commits) return null;
  const ctx = await analysisContext(pool, HUNT_WORKFLOW, x.provider);
  const key = bugHuntKey({
    scope: await installationId(),
    errorKey: x.fingerprint,
    repos: repoCommits(x.commits),
    ...ctx,
  });
  return lookupOrStart({
    key,
    actor: x.actor,
    errorKey: x.fingerprint,
    scopeRepos: Object.keys(x.commits),
    start: x.start,
  });
}

/**
 * What an API answer says about a shared analysis. The source run id is only given to the member who started it (runs stay
 * owner-only); the result is only included on a hit (the access check already passed).
 */
export function sharedView(r: LookupResult, actor: SharedActor) {
  const a = r.analysis as SharedRow;
  const own = a.created_by === actor.id;
  return {
    outcome: r.outcome,
    analysis_id: a.id,
    kind: a.kind,
    version: a.version,
    status: a.status,
    created_by: a.created_by,
    started_at: a.started_at,
    finished_at: a.finished_at,
    reuse_count: a.reuse_count,
    ...(own && a.source_run_id ? { run_id: a.source_run_id } : {}),
    ...(r.outcome === "hit" ? { result: a.result } : {}),
  };
}
