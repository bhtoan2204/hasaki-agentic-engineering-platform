import type pg from "pg";
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { analysisContext } from "./context.ts";
import { bugHuntKey, codeAssessmentKey, runtimeRcaKey, type RepoAtCommit } from "./key.ts";
import { installationId } from "./scope.ts";
import { lookupOrStart, type LookupResult } from "./service.ts";
import type { SharedActor } from "./hooks.ts";
import { audit } from "../authz/access.ts";
import type { AnalysisContext } from "./context.ts";

/**
 * The three analyses wrapped by lookup-before-compute. Each returns null when sharing does not apply (its flag is off,
 * the key cannot be established, e.g. a repository's current commit is unknown, or the actor runs a personal copy of the
 * workflow, which is not the shared definition the key describes); the caller then does exactly what it did before. `start` is the caller's own run start, called inside the claim transaction.
 */
type Start = (tx: {
  client: pg.PoolClient;
  afterCommit: (cb: () => unknown) => void;
}) => Promise<number>;

const RCA_WORKFLOW = "production-incident-investigation";
const HUNT_WORKFLOW = "production-bug-hunt";
const ASSESS_WORKFLOW = "codebase-assessment";

/** What an analysis runs with, stored on its row. */
const provenanceOf = (ctx: AnalysisContext) => ({
  provider: ctx.providers.join(","),
  model: ctx.model,
  definitionVersion: ctx.workflow.version,
  rubricHash: ctx.rubricHash,
});

/** A force re-run starts a new version: record who asked, on the audit trail (the version's own row says it too). */
async function auditForce(x: { actor: SharedActor; force?: boolean }, r: LookupResult) {
  if (x.force && r.outcome === "forced")
    await audit(x.actor.id, "shared_analysis.force", "shared_analysis", String(r.analysis.id), {
      kind: r.analysis.kind,
      version: r.analysis.version,
      key: r.analysis.key,
    });
  return r;
}

const repoCommits = (commits: Record<string, string>): RepoAtCommit[] =>
  Object.entries(commits).map(([repo, commit]) => ({ repo, commit }));

export async function sharedCodeAssessment(x: {
  actor: SharedActor;
  focus: string;
  provider?: string;
  /** The base commit of every repository, as the run would read it; null when one cannot be established. */
  commits: Record<string, string> | null;
  force?: boolean;
  start: Start;
}): Promise<LookupResult | null> {
  if (!config.sharedResults.codeAssessment || !x.commits) return null;
  const ctx = await analysisContext(pool, ASSESS_WORKFLOW, x.provider, undefined, x.actor.id);
  if (ctx.personal) return null;
  const key = codeAssessmentKey({
    scope: await installationId(),
    repos: repoCommits(x.commits),
    focus: x.focus,
    ...ctx,
  });
  return auditForce(
    x,
    await lookupOrStart({
      key,
      actor: x.actor,
      scopeRepos: Object.keys(x.commits),
      force: x.force,
      provenance: provenanceOf(ctx),
      start: x.start,
    }),
  );
}

export async function sharedRuntimeRca(x: {
  actor: SharedActor;
  fingerprint: string;
  contract: string;
  provider?: string;
  force?: boolean;
  start: Start;
}): Promise<LookupResult | null> {
  if (!config.sharedResults.prodErrors) return null;
  const ctx = await analysisContext(pool, RCA_WORKFLOW, x.provider, undefined, x.actor.id);
  if (ctx.personal) return null;
  const key = runtimeRcaKey({
    scope: await installationId(),
    errorKey: x.fingerprint,
    contract: x.contract,
    ...ctx,
  });
  return auditForce(
    x,
    await lookupOrStart({
      key,
      actor: x.actor,
      errorKey: x.fingerprint,
      force: x.force,
      provenance: provenanceOf(ctx),
      start: x.start,
    }),
  );
}

export async function sharedBugHunt(x: {
  actor: SharedActor;
  fingerprint: string;
  provider?: string;
  commits: Record<string, string> | null;
  force?: boolean;
  start: Start;
}): Promise<LookupResult | null> {
  if (!config.sharedResults.prodErrors || !x.commits) return null;
  const ctx = await analysisContext(pool, HUNT_WORKFLOW, x.provider, undefined, x.actor.id);
  if (ctx.personal) return null;
  const key = bugHuntKey({
    scope: await installationId(),
    errorKey: x.fingerprint,
    repos: repoCommits(x.commits),
    ...ctx,
  });
  return auditForce(
    x,
    await lookupOrStart({
      key,
      actor: x.actor,
      errorKey: x.fingerprint,
      scopeRepos: Object.keys(x.commits),
      force: x.force,
      provenance: provenanceOf(ctx),
      start: x.start,
    }),
  );
}

/** What an API answer says about a shared analysis (freshness, who ran it, provenance): see view.ts. */
export { describeAnalysis as sharedView } from "./view.ts";
