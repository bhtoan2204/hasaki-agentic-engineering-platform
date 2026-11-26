import { config } from "../config.ts";
import { one, pool } from "../db/pool.ts";
import { attemptRows, summarize } from "../report/cost.ts";
import type { SharedKind } from "./types.ts";
import { sharingHooks } from "./hooks.ts";
import { validUntil } from "./policy.ts";
import { expireDue, fail, publish, settleable, type PublishFacts } from "./repository.ts";

/**
 * What a finished run leaves for others: the snapshot of the analysis (step 5 scrubs it through the hook). Null when
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

const enabled = () => config.sharedResults.prodErrors || config.sharedResults.codeAssessment;

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
): Promise<PublishFacts> {
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
  if (!enabled()) return 0;
  const hooks = sharingHooks();
  const cap = config.sharedResults.retryCapMinutes;
  let settled = 0;
  for (const r of await settleable(pool, config.sharedResults.runningTimeoutMinutes, limit)) {
    const id = Number(r.id);
    const runId = r.source_run_id == null ? null : Number(r.source_run_id);
    let published = false;
    let ok: boolean;
    if (runId == null || r.run_status == null)
      ok = await fail(
        pool,
        id,
        { reason: "run missing", run_id: runId },
        { counts: true, capMinutes: cap },
      );
    else if (r.run_status === "COMPLETED") {
      const snapshot = await snapshotOf(r.kind, runId);
      if (snapshot == null)
        ok = await fail(
          pool,
          id,
          { reason: "completed without a result", run_id: runId },
          { counts: true, capMinutes: cap },
        );
      else {
        ok = await publish(
          pool,
          id,
          hooks.scrub(r.kind, snapshot),
          await factsOf(r.kind, runId, r.error_key),
        );
        published = ok;
      }
    } else if (r.run_status === "CANCELED")
      ok = await fail(
        pool,
        id,
        { reason: "run canceled", run_id: runId },
        { counts: false, capMinutes: cap },
      );
    else if (r.run_status === "FAILED")
      ok = await fail(
        pool,
        id,
        { reason: "run failed", run_id: runId },
        { counts: true, capMinutes: cap },
      );
    else
      ok = await fail(
        pool,
        id,
        { reason: "timeout", run_id: runId, run_status: r.run_status },
        { counts: true, capMinutes: cap },
      );
    if (ok) {
      settled++;
      hooks.observe({
        kind: r.kind,
        outcome: published ? "published" : "failed",
        analysisId: id,
        version: null,
        runId,
        actorId: null,
      });
    }
  }
  return settled;
}

/** Valid results past their end become stale (reason "ttl"). Returns how many. */
export async function expireSharedAnalyses(limit = 200) {
  if (!enabled()) return 0;
  return expireDue(pool, limit);
}

/** The reconcile task: settle, then expire. */
export async function sharedResultsMaintenance() {
  await settleSharedAnalyses();
  await expireSharedAnalyses();
}
