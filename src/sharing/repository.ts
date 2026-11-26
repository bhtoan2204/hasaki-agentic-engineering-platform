import { one, q, json, type Db } from "../db/pool.ts";
import type { SharedKind } from "./types.ts";

/** One version of a shared analysis (shared_analyses, migration 112). */
export interface SharedRow {
  id: number;
  kind: SharedKind;
  key: string;
  version: number;
  status: "running" | "valid" | "stale" | "failed" | "superseded";
  key_parts: Record<string, unknown>;
  scope_repos: string[];
  error_key: string | null;
  result: unknown;
  source_run_id: number | null;
  created_by: number | null;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  valid_until: Date | null;
  stale_reason: string | null;
  failure: unknown;
  attempts: number;
  next_retry_at: Date | null;
  reuse_count: number;
  last_reused_at: Date | null;
}

const COLUMNS = `id, kind, key, version, status, key_parts, scope_repos, error_key, result, source_run_id, created_by, trigger,
  started_at, finished_at, valid_until, stale_reason, failure, attempts, next_retry_at, reuse_count, last_reused_at`;
const shape = (r: SharedRow | undefined) =>
  r
    ? {
        ...r,
        id: Number(r.id),
        source_run_id: r.source_run_id == null ? null : Number(r.source_run_id),
        created_by: r.created_by == null ? null : Number(r.created_by),
      }
    : null;

/** The current (highest) version of a key: one probe of shared_analyses_lookup. */
export async function latestVersion(db: Db, kind: SharedKind, key: string) {
  return shape(
    await one<SharedRow>(
      db,
      `SELECT ${COLUMNS} FROM shared_analyses WHERE kind = $1 AND key = $2 ORDER BY version DESC LIMIT 1`,
      [kind, key],
    ),
  );
}

export async function byId(db: Db, id: number) {
  return shape(
    await one<SharedRow>(db, `SELECT ${COLUMNS} FROM shared_analyses WHERE id = $1`, [id]),
  );
}

/**
 * Claim a key: the next version, status running. The partial unique index shared_analyses_one_running (and the
 * (kind, key, version) key) make a concurrent claim fail with 23505 instead of creating a second running row.
 */
export async function insertRunning(
  db: Db,
  x: {
    kind: SharedKind;
    key: string;
    keyParts: Record<string, unknown>;
    scopeRepos: string[];
    errorKey: string | null;
    createdBy: number;
    trigger: string;
  },
) {
  return shape(
    await one<SharedRow>(
      db,
      `INSERT INTO shared_analyses (kind, key, version, status, key_parts, scope_repos, error_key, created_by, trigger)
       VALUES ($1, $2, COALESCE((SELECT max(version) FROM shared_analyses WHERE kind = $1 AND key = $2), 0) + 1,
               'running', $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [x.kind, x.key, json(x.keyParts), x.scopeRepos, x.errorKey, x.createdBy, x.trigger],
    ),
  )!;
}

export async function attachRun(db: Db, id: number, runId: number) {
  await q(
    db,
    "UPDATE shared_analyses SET source_run_id = $2 WHERE id = $1 AND status = 'running'",
    [id, runId],
  );
}

/** A hit: one use row and the counters, in one statement. */
export async function recordUse(
  db: Db,
  analysisId: number,
  userId: number,
  outcome: "hit" | "wait" | "miss" | "forced",
) {
  await q(
    db,
    `WITH u AS (INSERT INTO shared_analysis_uses (analysis_id, user_id, outcome) VALUES ($1, $2, $3))
     UPDATE shared_analyses SET reuse_count = reuse_count + CASE WHEN $3 = 'hit' THEN 1 ELSE 0 END,
            last_reused_at = CASE WHEN $3 = 'hit' THEN now() ELSE last_reused_at END
      WHERE id = $1`,
    [analysisId, userId, outcome],
  );
}

/** Running rows that can be settled now: their run ended, the run is gone, or they outlived the running timeout. */
export function settleable(db: Db, timeoutMinutes: number, limit: number) {
  return q<{
    id: number;
    kind: SharedKind;
    source_run_id: number | null;
    run_status: string | null;
    timed_out: boolean;
  }>(
    db,
    `SELECT a.id, a.kind, a.source_run_id, r.status AS run_status,
            a.started_at < now() - make_interval(mins => $1) AS timed_out
       FROM shared_analyses a LEFT JOIN workflow_runs r ON r.id = a.source_run_id
      WHERE a.status = 'running'
        AND (r.id IS NULL OR r.status IN ('COMPLETED', 'FAILED', 'CANCELED') OR a.started_at < now() - make_interval(mins => $1))
      ORDER BY a.id LIMIT $2`,
    [timeoutMinutes, limit],
  );
}

/** Publish or fail a running row; false when it is no longer running (another instance settled it first). */
export async function finish(
  db: Db,
  id: number,
  outcome:
    { status: "valid"; result: unknown } | { status: "failed"; failure: Record<string, unknown> },
) {
  const rows = await q(
    db,
    outcome.status === "valid"
      ? `UPDATE shared_analyses SET status = 'valid', result = $2, finished_at = now() WHERE id = $1 AND status = 'running' RETURNING id`
      : `UPDATE shared_analyses SET status = 'failed', failure = $2, finished_at = now(), attempts = attempts + 1
          WHERE id = $1 AND status = 'running' RETURNING id`,
    [id, json(outcome.status === "valid" ? outcome.result : outcome.failure)],
  );
  if (rows.length) await q(db, "SELECT pg_notify('shared_analysis', $1)", [String(id)]);
  return rows.length > 0;
}
