import { one, pool, q } from "../db/pool.ts";
import { outputLocale } from "../agent/language.ts";
import { parseAgentConfiguration, refreshEnvironmentDefaults } from "../agent/configuration.ts";
import { analysisContext, type AnalysisContext } from "./context.ts";
import { bugHuntKey, codeAssessmentKey, KeyError, type SharedKey } from "./key.ts";
import { validUntil } from "./policy.ts";
import { insertBackfilled, keyExists } from "./repository.ts";
import { installationId } from "./scope.ts";
import { isFullyRedacted, SCRUB_VERSION, scrubKeyParts, scrubResult } from "./scrub.ts";
import { factsOf, snapshotOf, enabledKinds } from "./settle.ts";
import type { SharedKind } from "./types.ts";

/**
 * Backfill (docs/shared-results/PLAN.md, section 7): publish existing completed runs as version 1 of their key, ONLY when
 * the key a request would build today is provably the run's own:
 *  - the run used the shared definition, at the version published today;
 *  - its frozen agent configuration resolves to today's model fingerprint;
 *  - the skills its steps pin had, when it started, the versions they have today;
 *  - every repository has the full commit the run analysed (source_revisions); a bug hunt has its incident.
 * Anything else is skipped and counted by reason. The runtime RCA is not backfilled: its verification contract is not
 * recorded on the run, and its results live 24 hours.
 *
 * Idempotent: a key that already has any row is never written (version 1 only, guarded in the INSERT). Batches go from the
 * newest run down, so the newest of several runs of one key wins; the cursor (the last run id handled) is saved after each
 * batch when applying, so a stopped backfill resumes where it was. Dry-run by default. Only kinds whose flag is on.
 */
export const BACKFILL_CURSOR = "shared_results.backfill_cursor";
const WORKFLOWS: Partial<Record<SharedKind, string>> = {
  code_assessment: "codebase-assessment",
  "prod_error.bug_hunt": "production-bug-hunt",
};

export interface BackfillOptions {
  apply?: boolean;
  batchSize?: number;
  maxBatches?: number;
  /** Forget the saved cursor and start again from the newest run (safe: written keys are skipped). */
  restart?: boolean;
}
export interface BackfillReport {
  apply: boolean;
  kinds: SharedKind[];
  scanned: number;
  inserted: number;
  skipped: Record<string, number>;
  cursor: number | null;
  done: boolean;
}

interface Candidate {
  id: number;
  definition_key: string;
  definition_version: number;
  shared_definition: boolean;
  agent_provider: string;
  agent_configuration: unknown;
  owner_id: number | null;
  inputs: Record<string, unknown>;
  selected_repositories: string[];
  source_revisions: Record<string, { commit?: string }> | null;
  output_locale: string | null;
  project: string;
  profile: string;
  started_at: Date | null;
  finished_at: Date | null;
  hunt_fingerprint: string | null;
}

class Skip extends Error {}
const skip = (reason: string): never => {
  throw new Skip(reason);
};

export async function backfillSharedResults(opts: BackfillOptions = {}): Promise<BackfillReport> {
  const apply = opts.apply === true;
  const kinds = enabledKinds().filter((k) => WORKFLOWS[k]);
  const report: BackfillReport = {
    apply,
    kinds,
    scanned: 0,
    inserted: 0,
    skipped: {},
    cursor: null,
    done: false,
  };
  if (!kinds.length) return { ...report, done: true };
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 100, 1000));
  const maxBatches = opts.maxBatches ?? Infinity;
  const scope = await installationId();
  const workflows = kinds.map((k) => WORKFLOWS[k]!);
  const current = new Map<string, Promise<AnalysisContext>>();
  // Keys handled in this pass (a dry-run writes nothing, so the database cannot tell it a key is already taken).
  const seen = new Set<string>();
  const today = (workflow: string, provider: string, profile: string) => {
    const k = `${workflow}|${provider}|${profile}`;
    if (!current.has(k))
      current.set(k, analysisContext(pool, workflow, provider, undefined, undefined, { profile }));
    return current.get(k)!;
  };
  if (opts.restart && apply)
    await q(pool, "DELETE FROM settings WHERE key = $1", [BACKFILL_CURSOR]);
  let cursor = opts.restart
    ? null
    : Number(
        (
          await one<{ value: string }>(pool, "SELECT value FROM settings WHERE key = $1", [
            BACKFILL_CURSOR,
          ])
        )?.value ?? NaN,
      ) || null;
  for (let batch = 0; batch < maxBatches; batch++) {
    const runs = await q<Candidate>(
      pool,
      `SELECT r.id, r.definition_key, v.version AS definition_version, d.owner_id IS NULL AS shared_definition,
              r.agent_provider, r.agent_configuration, r.owner_id, r.inputs, r.selected_repositories, r.source_revisions,
              r.output_locale, COALESCE(w.project, r.inputs->>'project', '') AS project, r.profile,
              r.started_at, r.finished_at, h.fingerprint AS hunt_fingerprint
         FROM workflow_runs r
         JOIN workflow_definition_versions v ON v.id = r.definition_version_id
         JOIN workflow_definitions d ON d.id = v.definition_id
         LEFT JOIN work_items w ON w.id = r.work_item_id
         LEFT JOIN bug_hunts h ON h.run_id = r.id
        WHERE r.status = 'COMPLETED' AND r.definition_key = ANY($1::text[]) AND ($2::bigint IS NULL OR r.id < $2)
        ORDER BY r.id DESC LIMIT $3`,
      [workflows, cursor, batchSize],
    );
    if (!runs.length) {
      report.done = true;
      break;
    }
    for (const run of runs) {
      report.scanned++;
      try {
        const id = await backfillRun(run);
        if (id) report.inserted++;
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        report.skipped[e.message] = (report.skipped[e.message] ?? 0) + 1;
      }
    }
    cursor = Number(runs[runs.length - 1].id);
    if (runs.length < batchSize) {
      report.done = true;
      break;
    }
    if (apply)
      await q(
        pool,
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [BACKFILL_CURSOR, String(cursor)],
      );
  }
  // Clear the cursor once a full pass reaches the end so subsequent runs pick up newly completed runs and newly enabled flags.
  if (apply && report.done) await q(pool, "DELETE FROM settings WHERE key = $1", [BACKFILL_CURSOR]);
  report.cursor = cursor;
  return report;

  /** One run: the id written (or, dry-run, true when it would be), never a partial write. */
  async function backfillRun(run: Candidate): Promise<number | boolean | null> {
    const kind = (Object.keys(WORKFLOWS) as SharedKind[]).find(
      (k) => WORKFLOWS[k] === run.definition_key,
    )!;
    if (run.owner_id == null) skip("no_owner");
    if (!run.shared_definition) skip("personal_definition");
    if (!run.agent_configuration || !run.started_at || !run.finished_at) skip("not_recorded");
    const until = validUntil(kind, new Date(run.finished_at!));
    if (until.getTime() <= Date.now()) skip("expired");
    const now = await today(run.definition_key, run.agent_provider, run.profile);
    if (run.definition_version !== now.workflow.version) skip("definition_changed");
    let then: AnalysisContext;
    try {
      then = await analysisContext(
        pool,
        run.definition_key,
        run.agent_provider,
        {
          version: run.definition_version,
          configuration: refreshEnvironmentDefaults(parseAgentConfiguration(run.agent_configuration)),
          startedAt: new Date(run.started_at!),
        },
        undefined,
        { profile: run.profile },
      );
    } catch {
      return skip("not_recorded");
    }
    if (then.model !== now.model) skip("model_changed");
    if (JSON.stringify(then.pinned) !== JSON.stringify(now.pinned)) skip("rubric_changed");
    const repos = [...new Set(run.selected_repositories)].sort();
    if (!repos.length) skip("no_repositories");
    const commits = repos.map((repo) => ({
      repo,
      commit: run.source_revisions?.[repo]?.commit ?? "",
    }));
    let key: SharedKey;
    try {
      key =
        kind === "code_assessment"
          ? codeAssessmentKey({
              scope,
              repos: commits,
              focus: typeof run.inputs?.focus === "string" ? run.inputs.focus : "",
              project: run.project,
              outputLocale: outputLocale({ output_locale: run.output_locale }),
              ...now,
            })
          : bugHuntKey({
              scope,
              errorKey: run.hunt_fingerprint ?? skip("no_incident"),
              repos: commits,
              ...now,
            });
    } catch (e) {
      if (e instanceof KeyError) return skip("commits_unknown");
      throw e;
    }
    if (seen.has(key.key) || (await keyExists(pool, kind, key.key))) skip("exists");
    const snapshot = await snapshotOf(kind, Number(run.id));
    if (snapshot == null) skip("no_result");
    let result: unknown;
    try {
      result = scrubResult(kind, snapshot);
    } catch {
      return skip("scrub_failed");
    }
    if (result == null || isFullyRedacted(result)) skip("scrub_failed");
    seen.add(key.key);
    if (!apply) return true;
    const facts = await factsOf(kind, Number(run.id), null);
    const id = await insertBackfilled(pool, {
      kind,
      key: key.key,
      keyParts: { ...scrubKeyParts(key.parts), scrub_version: SCRUB_VERSION },
      scopeRepos: repos,
      errorKey: kind === "code_assessment" ? null : run.hunt_fingerprint,
      createdBy: run.owner_id!,
      provenance: {
        provider: now.providers.join(","),
        model: now.model,
        definitionVersion: now.workflow.version,
        rubricHash: now.rubricHash,
      },
      runId: Number(run.id),
      result,
      startedAt: new Date(run.started_at!),
      finishedAt: new Date(run.finished_at!),
      validUntil: until,
      tokensIn: facts.tokensIn,
      tokensOut: facts.tokensOut,
      costUsd: facts.costUsd,
      durationMs: facts.durationMs,
    });
    return id ?? skip("exists");
  }
}
