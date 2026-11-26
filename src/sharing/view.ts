import { one, pool } from "../db/pool.ts";
import { retryState } from "./policy.ts";
import type { SharedActor } from "./hooks.ts";
import type { SharedRow } from "./repository.ts";
import type { LookupResult } from "./service.ts";

/**
 * What the API tells a caller about a shared analysis (step 7 renders it): how old it is, who ran it and with what, how
 * often it was reused, what holds a failed one back, and, for a production error, the occurrences now next to the occurrences when it was
 * analysed (the error group is updated by every scan; the analysis is not re-run for that).
 *
 * The source run id is only given to the member who started it (runs stay owner-only); the result only on a hit (the
 * access check has passed by then).
 */
export async function describeAnalysis(r: LookupResult, actor: SharedActor, now = new Date()) {
  const a = r.analysis as SharedRow;
  const own = a.created_by === actor.id;
  const published = a.finished_at && a.status !== "failed" ? a.finished_at : null;
  const retry = retryState(a, now);
  return {
    outcome: r.outcome,
    analysis_id: a.id,
    kind: a.kind,
    version: a.version,
    status: a.status,
    freshness: {
      analysed_at: published,
      age_seconds: published
        ? Math.max(0, Math.round((now.getTime() - published.getTime()) / 1000))
        : null,
      valid_until: a.valid_until,
      expired: a.valid_until ? a.valid_until.getTime() <= now.getTime() : false,
      stale_reason: a.stale_reason,
    },
    run_by: {
      id: a.created_by,
      name: a.created_by_name ?? (own ? (actor.username ?? null) : null),
    },
    provenance: {
      trigger: a.trigger,
      started_at: a.started_at,
      finished_at: a.finished_at,
      duration_ms: a.duration_ms,
      provider: a.provider,
      model: a.model,
      definition_version: a.definition_version,
      rubric_hash: a.rubric_hash,
      tokens_in: a.tokens_in,
      tokens_out: a.tokens_out,
      cost_usd: a.cost_usd,
      key: a.key,
    },
    reuse: { count: a.reuse_count, last_at: a.last_reused_at },
    ...(a.status === "failed" || retry.state !== "none"
      ? {
          failure: {
            attempts: a.attempts,
            reason: (a.failure as { reason?: string } | null)?.reason ?? null,
            retry_at: retry.state === "backoff" ? retry.retryAt : null,
            exhausted: retry.state === "exhausted",
          },
        }
      : {}),
    ...(a.error_key ? { occurrences: await occurrences(a) } : {}),
    ...(own && a.source_run_id ? { run_id: a.source_run_id } : {}),
    ...(r.outcome === "hit" ? { result: a.result } : {}),
  };
}

/** The error group's counters now and as they were when the analysis ran. */
async function occurrences(a: SharedRow) {
  const now = await one<{
    today_count: number;
    yesterday_count: number;
    last_at: Date | null;
    day: string;
  }>(
    pool,
    "SELECT today_count, yesterday_count, last_at, day::text AS day FROM prod_error_groups WHERE fingerprint = $1",
    [a.error_key],
  );
  const then =
    (
      a.observed as {
        occurrences?: { today_count: number; last_at: string | null; day: string };
      } | null
    )?.occurrences ?? null;
  return {
    at_analysis: then,
    now: now
      ? {
          today_count: Number(now.today_count),
          yesterday_count: Number(now.yesterday_count),
          last_at: now.last_at,
          day: now.day,
        }
      : null,
    // Counts are per scan window (day): a difference means something only for the same day.
    new_since_analysis:
      then && now && then.day === now.day
        ? Math.max(0, Number(now.today_count) - then.today_count)
        : null,
  };
}
