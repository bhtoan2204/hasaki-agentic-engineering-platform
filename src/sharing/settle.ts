import { config } from "../config.ts";
import { one, pool } from "../db/pool.ts";
import { log } from "../logging.ts";
import { attemptRows, summarize } from "../report/cost.ts";
import type { SharedKind } from "./types.ts";
import { sharingHooks } from "./hooks.ts";
import { validUntil } from "./policy.ts";
import { isFullyRedacted, SCRUB_VERSION } from "./scrub.ts";
import { markReplaced } from "./stale.ts";
import { byId, expireDue, fail, publish, settleable, type PublishFacts } from "./repository.ts";
import { background } from "../workflow/background.ts";
import { ignoreError } from "../ignoreError.ts";

/**
 * What a finished run leaves for others: the snapshot of the analysis (scrubbed through the hook before it is stored). Null when
 * the run completed without the output the analysis is made of; the row is then failed, never published empty.
 */
export async function snapshotOf(kind: SharedKind, runId: number): Promise<unknown | null> {
  if (kind === "prod_error.bug_hunt") {
    const h = await one<{ report: unknown }>(
      pool,
      "SELECT report FROM bug_hunts WHERE run_id = $1",
      [runId],
    );
    return h?.report ?? null;
  }
  const step = kind === "code_assessment" ? "assess" : "report";
  const s = await one<{ output: unknown }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id = $1 AND key = $2 AND status = 'COMPLETED'",
    [runId, step],
  );
  return s?.output ?? null;
}

/** The kinds whose flag is on: each flag gates its own kinds, also in the reconcile task. */
export function enabledKinds(): SharedKind[] {
  return [
    ...(config.sharedResults.codeAssessment ? (["code_assessment"] as const) : []),
    ...(config.sharedResults.prodErrors
      ? (["prod_error.runtime_rca", "prod_error.bug_hunt"] as const)
      : []),
  ];
}

/**
 * Provenance of a finished run, from the run's own records (nothing is measured again): the tokens and cost the providers
 * reported (null when none was: never an invented 0), the run's wall time, and for a production error what the error group
 * showed at that moment, so the answer can say "analysed at N occurrences, now M" without analysing again.
 */
export async function factsOf(
  kind: SharedKind,
  runId: number,
  errorKey: string | null,
  now = new Date(),
): Promise<Omit<PublishFacts, "scrubVersion">> {
  const total = summarize(await attemptRows([runId])).total;
  const run = await one<{ ms: number | null }>(
    pool,
    "SELECT (extract(epoch FROM (COALESCE(finished_at, now()) - COALESCE(started_at, created_at))) * 1000)::bigint AS ms FROM workflow_runs WHERE id = $1",
    [runId],
  );
  const group = errorKey
    ? await one<{
        today_count: number;
        yesterday_count: number;
        last_at: Date | null;
        day: string;
      }>(
        pool,
        "SELECT today_count, yesterday_count, last_at, day::text AS day FROM prod_error_groups WHERE fingerprint = $1",
        [errorKey],
      )
    : null;
  const hasTokens = total.tokens.input + total.tokens.output > 0;
  return {
    validUntil: validUntil(kind, now),
    tokensIn: hasTokens ? total.tokens.input : null,
    tokensOut: hasTokens ? total.tokens.output : null,
    costUsd: total.cost_usd,
    durationMs: run?.ms == null ? null : Number(run.ms),
    observed: group
      ? {
          occurrences: {
            today_count: Number(group.today_count),
            yesterday_count: Number(group.yesterday_count),
            last_at: group.last_at,
            day: group.day,
          },
        }
      : null,
  };
}

/**
 * Reconcile task: settle running analyses whose run has ended (publish or fail), whose run is gone, or that outlived the
 * running timeout (a run stuck waiting forever must not block the key). Safe on every instance at once: each row is
 * settled by a guarded UPDATE (status = 'running'), so exactly one instance publishes it and notifies the waiters.
 * A timed-out row whose run later completes stays failed; the late result is not published (a new claim re-runs it).
 *
 * Failures: one that is the analysis's own (run failed, nothing produced, timeout) counts toward the key's backoff; a run
 * canceled by a person does not (the key is free at once).
 */
export async function settleSharedAnalyses(limit = 50) {
  const kinds = enabledKinds();
  if (!kinds.length) return 0;
  const hooks = sharingHooks();
  const cap = config.sharedResults.retryCapMinutes;
  let settled = 0;
  for (const r of await settleable(
    pool,
    config.sharedResults.runningTimeoutMinutes,
    limit,
    kinds,
  )) {
    const id = Number(r.id);
    const runId = r.source_run_id == null ? null : Number(r.source_run_id);
    let why: string | null = null;
    const failWith = (reason: string, counts: boolean, extra: Record<string, unknown> = {}) => {
      why = reason;
      return fail(pool, id, { reason, run_id: runId, ...extra }, { counts, capMinutes: cap });
    };
    let settledRow = false;
    try {
      let ok: boolean;
      if (runId == null || r.run_status == null) ok = await failWith("run missing", true);
      else if (r.run_status === "COMPLETED") {
        const row = r.kind === "prod_error.runtime_rca" ? await byId(pool, id) : null;
        if (
          r.kind === "prod_error.runtime_rca" &&
          (!row || row.created_by == null || !(await hooks.canRead(row, { id: row.created_by })))
        ) {
          ok = await failWith("creator lacks access", false);
        } else {
          const snapshot = await snapshotOf(r.kind, runId);
          if (snapshot == null) ok = await failWith("completed without a result", true);
          else {
            // Scrubbed before it is written; a scrub that throws or redacts the whole result publishes nothing.
            let scrubbed: unknown;
            try {
              scrubbed = hooks.scrub(r.kind, snapshot);
            } catch {
              scrubbed = undefined;
            }
            if (scrubbed == null || isFullyRedacted(scrubbed))
              ok = await failWith("scrub failed", true);
            else
              ok = await publish(pool, id, scrubbed, {
                ...(await factsOf(r.kind, runId, r.error_key)),
                scrubVersion: SCRUB_VERSION,
              });
          }
        }
      } else if (r.run_status === "CANCELED") ok = await failWith("run canceled", false);
      else if (r.run_status === "FAILED") ok = await failWith("run failed", true);
      else ok = await failWith("timeout", true, { run_status: r.run_status });
      if (ok) {
        settledRow = true;
        settled++;
        hooks.observe({
          kind: r.kind,
          outcome: why ? "failed" : "published",
          analysisId: id,
          version: Number(r.version),
          runId,
          actorId: null,
          key: r.key,
          scope: r.scope,
          ...(why ? { reason: why } : {}),
        });
        // Older results of this subject that this one replaces become stale now, not when the run was claimed. In the
        // background: it may ask git, and settling must not wait for it.
        if (!why)
          background("shared stale", async () => {
            const row = await byId(pool, id);
            if (row) await markReplaced(row).catch(ignoreError("shared.stale"));
          });
      }
    } catch (e) {
      log.warn(`shared result settle failed: analysis=${id} run=${runId ?? "-"}`, e);
      if (!settledRow) {
        try {
          if (
            await fail(
              pool,
              id,
              { reason: "settle error", run_id: runId },
              { counts: true, capMinutes: cap },
            )
          ) {
            settled++;
            hooks.observe({
              kind: r.kind,
              outcome: "failed",
              analysisId: id,
              version: Number(r.version),
              runId,
              actorId: null,
              key: r.key,
              scope: r.scope,
              reason: "settle error",
            });
          }
        } catch (fe) {
          log.warn(`shared result settle fallback failed: analysis=${id}`, fe);
        }
      }
    }
  }
  return settled;
}

/** Valid results past their end become stale (reason "ttl"). Returns how many. */
export async function expireSharedAnalyses(limit = 200) {
  const kinds = enabledKinds();
  if (!kinds.length) return 0;
  const hooks = sharingHooks();
  const rows = await expireDue(pool, limit, kinds);
  for (const r of rows) {
    try {
      hooks.observe({
        kind: r.kind,
        outcome: "expired",
        analysisId: Number(r.id),
        version: Number(r.version),
        runId: null,
        actorId: null,
        key: r.key,
        scope: r.scope,
        reason: "ttl",
      });
    } catch (e) {
      log.warn(`shared result expire observe failed: analysis=${r.id}`, e);
    }
  }
  return rows.length;
}

/** The reconcile task: settle, then expire (expiry always runs even if settling throws). */
export async function sharedResultsMaintenance() {
  try {
    await settleSharedAnalyses();
  } catch (e) {
    log.warn("shared results settle pass failed", e);
  }
  try {
    await expireSharedAnalyses();
  } catch (e) {
    log.warn("shared results expiry pass failed", e);
  }
}
