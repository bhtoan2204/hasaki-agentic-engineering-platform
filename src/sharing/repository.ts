import { one, q, json, type Db } from "../db/pool.ts";
import type { SharedKind } from "./types.ts";

/** One version of a shared analysis (shared_analyses, migrations 112 and 113). */
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
  /** The member who ran it (joined in the same query as the row; null for a deleted user). */
  created_by_name: string | null;
  trigger: string;
  provider: string | null;
  model: string | null;
  definition_version: number | null;
  rubric_hash: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  observed: Record<string, unknown> | null;
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

const COLUMNS = [
  "id",
  "kind",
  "key",
  "version",
  "status",
  "key_parts",
  "scope_repos",
  "error_key",
  "result",
  "source_run_id",
  "created_by",
  "trigger",
  "provider",
  "model",
  "definition_version",
  "rubric_hash",
  "tokens_in",
  "tokens_out",
  "cost_usd",
  "duration_ms",
  "observed",
  "started_at",
  "finished_at",
  "valid_until",
  "stale_reason",
  "failure",
  "attempts",
  "next_retry_at",
  "reuse_count",
  "last_reused_at",
]
  .map((c) => `a.${c}`)
  .join(", ");
const SELECT = `SELECT ${COLUMNS}, u.username AS created_by_name FROM shared_analyses a LEFT JOIN users u ON u.id = a.created_by`;

const num = (v: unknown) => (v == null ? null : Number(v));
const shape = (r: SharedRow | undefined) =>
  r
    ? {
        ...r,
        id: Number(r.id),
        source_run_id: num(r.source_run_id),
        created_by: num(r.created_by),
        created_by_name: r.created_by_name ?? null,
        tokens_in: num(r.tokens_in),
        tokens_out: num(r.tokens_out),
        cost_usd: num(r.cost_usd),
        duration_ms: num(r.duration_ms),
      }
    : null;

/** The current (highest) version of a key: one probe of shared_analyses_lookup, the member's name included. */
export async function latestVersion(db: Db, kind: SharedKind, key: string) {
  return shape(
    await one<SharedRow>(
      db,
      `${SELECT} WHERE a.kind = $1 AND a.key = $2 ORDER BY a.version DESC LIMIT 1`,
      [kind, key],
    ),
  );
}

export async function byId(db: Db, id: number) {
  return shape(await one<SharedRow>(db, `${SELECT} WHERE a.id = $1`, [id]));
}

export interface Provenance {
  provider: string | null;
  model: string | null;
  definitionVersion: number | null;
  rubricHash: string | null;
}

/**
 * Claim a key: the next version, status running. The partial unique index shared_analyses_one_running (and the
 * (kind, key, version) key) make a concurrent claim fail with 23505 instead of creating a second running row. The count of
 * failures in a row is carried over from a failed latest version, so the backoff keeps growing across claims.
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
    provenance: Provenance;
  },
) {
  const row = await one<{ id: number }>(
    db,
    `INSERT INTO shared_analyses (kind, key, version, status, key_parts, scope_repos, error_key, created_by, trigger,
                                  provider, model, definition_version, rubric_hash, attempts)
     VALUES ($1, $2, COALESCE((SELECT max(version) FROM shared_analyses WHERE kind = $1 AND key = $2), 0) + 1,
             'running', $3, $4, $5, $6, $7, $8, $9, $10, $11,
             COALESCE((SELECT CASE WHEN status = 'failed' THEN attempts ELSE 0 END FROM shared_analyses
                        WHERE kind = $1 AND key = $2 ORDER BY version DESC LIMIT 1), 0))
     RETURNING id`,
    [
      x.kind,
      x.key,
      json(x.keyParts),
      x.scopeRepos,
      x.errorKey,
      x.createdBy,
      x.trigger,
      x.provenance.provider,
      x.provenance.model,
      x.provenance.definitionVersion,
      x.provenance.rubricHash,
    ],
  );
  return (await byId(db, Number(row!.id)))!;
}

export async function attachRun(db: Db, id: number, runId: number) {
  await q(
    db,
    "UPDATE shared_analyses SET source_run_id = $2 WHERE id = $1 AND status = 'running'",
    [id, runId],
  );
}

/** A use: its row and the counters in one statement (a hit also counts as a reuse). */
export async function recordUse(
  db: Db,
  analysisId: number,
  userId: number,
  outcome: "hit" | "wait" | "miss" | "forced",
  tokensSaved: number | null = null,
) {
  await q(
    db,
    `WITH u AS (INSERT INTO shared_analysis_uses (analysis_id, user_id, outcome, tokens_saved) VALUES ($1, $2, $3, $4))
     UPDATE shared_analyses SET reuse_count = reuse_count + CASE WHEN $3 = 'hit' THEN 1 ELSE 0 END,
            last_reused_at = CASE WHEN $3 = 'hit' THEN now() ELSE last_reused_at END
      WHERE id = $1`,
    [analysisId, userId, outcome, tokensSaved],
  );
}

/**
 * A backfilled analysis: version 1 of its key, valid, written only when the key has no row at all (so a re-run of the
 * backfill, or a key claimed since, is never touched). Returns the id, or null when the key already had a row.
 */
export async function insertBackfilled(
  db: Db,
  x: {
    kind: SharedKind;
    key: string;
    keyParts: Record<string, unknown>;
    scopeRepos: string[];
    errorKey: string | null;
    createdBy: number;
    provenance: Provenance;
    runId: number;
    result: unknown;
    startedAt: Date;
    finishedAt: Date;
    validUntil: Date;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    durationMs: number | null;
  },
) {
  const row = await one<{ id: number }>(
    db,
    `INSERT INTO shared_analyses (kind, key, version, status, key_parts, scope_repos, error_key, created_by, trigger,
                                  provider, model, definition_version, rubric_hash, source_run_id, result, started_at,
                                  finished_at, valid_until, tokens_in, tokens_out, cost_usd, duration_ms)
     SELECT $1, $2, 1, 'valid', $3, $4, $5, $6, 'backfill', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      WHERE NOT EXISTS (SELECT 1 FROM shared_analyses WHERE kind = $1 AND key = $2)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      x.kind,
      x.key,
      json(x.keyParts),
      x.scopeRepos,
      x.errorKey,
      x.createdBy,
      x.provenance.provider,
      x.provenance.model,
      x.provenance.definitionVersion,
      x.provenance.rubricHash,
      x.runId,
      json(x.result),
      x.startedAt,
      x.finishedAt,
      x.validUntil,
      x.tokensIn,
      x.tokensOut,
      x.costUsd,
      x.durationMs,
    ],
  );
  return row ? Number(row.id) : null;
}

export async function keyExists(db: Db, kind: SharedKind, key: string) {
  return !!(await one(db, "SELECT 1 FROM shared_analyses WHERE kind = $1 AND key = $2 LIMIT 1", [
    kind,
    key,
  ]));
}

/** The valid versions of one key, newest first (a re-run may be running or have failed beside them). */
export async function validVersions(db: Db, kind: SharedKind, key: string) {
  const rows = await q<SharedRow>(
    db,
    `${SELECT} WHERE a.kind = $1 AND a.key = $2 AND a.status = 'valid' ORDER BY a.version DESC LIMIT 5`,
    [kind, key],
  );
  return rows.map((r) => shape(r)!);
}

/** The valid analyses of one kind of one production error in this scope, newest first. */
export async function validForError(db: Db, errorKey: string, kind: SharedKind, scope: string) {
  const rows = await q<SharedRow>(
    db,
    `${SELECT} WHERE a.error_key = $1 AND a.kind = $2 AND a.key_parts->>'scope' = $3 AND a.status = 'valid'
      ORDER BY a.id DESC LIMIT 5`,
    [errorKey, kind, scope],
  );
  return rows.map((r) => shape(r)!);
}

/** The valid code assessments of exactly these repositories, focus, project and locale, newest first. */
export async function validForRepositories(
  db: Db,
  repos: string[],
  focus: string,
  scope: string,
  project = "",
  locale = "vi",
) {
  const rows = await q<SharedRow>(
    db,
    `${SELECT} WHERE a.kind = 'code_assessment' AND a.scope_repos = $1 AND COALESCE(a.key_parts->>'focus', '') = $2
                AND a.key_parts->>'scope' = $3 AND COALESCE(a.key_parts->>'project', '') = $4
                AND COALESCE(a.key_parts->>'locale', 'vi') = $5 AND a.status = 'valid'
      ORDER BY a.id DESC LIMIT 5`,
    [repos, focus, scope, project, locale],
  );
  return rows.map((r) => shape(r)!);
}

/** The latest version (any status) of each kind of analysis of one production error in this scope. */
export function latestForError(
  db: Db,
  errorKey: string,
  kinds: readonly SharedKind[],
  scope: string,
) {
  return q<SharedRow>(
    db,
    `${SELECT} WHERE a.id IN (
       SELECT DISTINCT ON (kind) id FROM shared_analyses
        WHERE error_key = $1 AND kind = ANY($2::text[]) AND key_parts->>'scope' = $3
        ORDER BY kind, id DESC)`,
    [errorKey, kinds, scope],
  );
}

/** The latest code assessment (any status, any commit) of exactly these repositories, focus, project and locale. */
export function latestForRepositories(
  db: Db,
  repos: string[],
  focus: string,
  scope: string,
  project = "",
  locale = "vi",
) {
  return one<SharedRow>(
    db,
    `${SELECT} WHERE a.kind = 'code_assessment' AND a.scope_repos = $1 AND COALESCE(a.key_parts->>'focus', '') = $2
                AND a.key_parts->>'scope' = $3 AND COALESCE(a.key_parts->>'project', '') = $4
                AND COALESCE(a.key_parts->>'locale', 'vi') = $5
      ORDER BY a.id DESC LIMIT 1`,
    [repos, focus, scope, project, locale],
  );
}

/** Running rows that can be settled now: their run ended, the run is gone, or they outlived the running timeout. */
export function settleable(
  db: Db,
  timeoutMinutes: number,
  limit: number,
  kinds: readonly SharedKind[],
) {
  return q<{
    id: number;
    kind: SharedKind;
    key: string;
    version: number;
    scope: string | null;
    error_key: string | null;
    source_run_id: number | null;
    run_status: string | null;
    timed_out: boolean;
  }>(
    db,
    `SELECT a.id, a.kind, a.key, a.version, a.key_parts->>'scope' AS scope, a.error_key, a.source_run_id, r.status AS run_status,
            a.started_at < now() - make_interval(mins => $1) AS timed_out
       FROM shared_analyses a LEFT JOIN workflow_runs r ON r.id = a.source_run_id
      WHERE a.status = 'running' AND a.kind = ANY($3::text[])
        AND (r.id IS NULL OR r.status IN ('COMPLETED', 'FAILED', 'CANCELED') OR a.started_at < now() - make_interval(mins => $1))
      ORDER BY a.id LIMIT $2`,
    [timeoutMinutes, limit, kinds],
  );
}

export interface PublishFacts {
  validUntil: Date;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  observed: Record<string, unknown> | null;
  /** The scrub policy version the result went through (scrub.ts), recorded in key_parts. */
  scrubVersion: number;
}

/**
 * Publish a running row (false when it is no longer running: another instance settled it first). The older valid versions of
 * the same key become superseded in the SAME statement, so readers always have exactly one valid version and a force
 * re-run replaces the previous one only when its own result exists.
 */
export async function publish(db: Db, id: number, result: unknown, facts: PublishFacts) {
  const rows = await q<{ n: number }>(
    db,
    `WITH upd AS (
       UPDATE shared_analyses SET status = 'valid', result = $2, finished_at = now(), valid_until = $3,
              tokens_in = $4, tokens_out = $5, cost_usd = $6, duration_ms = $7, observed = $8,
              key_parts = key_parts || jsonb_build_object('scrub_version', $9::int)
        WHERE id = $1 AND status = 'running' RETURNING kind, key, version),
     sup AS (
       UPDATE shared_analyses o SET status = 'superseded' FROM upd
        WHERE o.kind = upd.kind AND o.key = upd.key AND o.version < upd.version AND o.status = 'valid')
     SELECT count(*)::int AS n FROM upd`,
    [
      id,
      json(result),
      facts.validUntil,
      facts.tokensIn,
      facts.tokensOut,
      facts.costUsd,
      facts.durationMs,
      json(facts.observed),
      facts.scrubVersion,
    ],
  );
  const ok = (rows[0]?.n ?? 0) > 0;
  if (ok) await q(db, "SELECT pg_notify('shared_analysis', $1)", [String(id)]);
  return ok;
}

/**
 * Fail a running row. A failure that counts (the analysis itself failed or timed out) adds to the failures in a row and sets
 * the backoff; one that does not (the run was canceled by a person) leaves the count alone and the key free at once.
 */
export async function fail(
  db: Db,
  id: number,
  failure: Record<string, unknown>,
  penalty: { counts: boolean; capMinutes: number },
) {
  const rows = await q(
    db,
    penalty.counts
      ? `UPDATE shared_analyses SET status = 'failed', failure = $2, finished_at = now(), attempts = attempts + 1,
                next_retry_at = now() + make_interval(mins => LEAST($3::int, (2 ^ LEAST(attempts + 1, 30))::int))
          WHERE id = $1 AND status = 'running' RETURNING id`
      : `UPDATE shared_analyses SET status = 'failed', failure = $2, finished_at = now(), next_retry_at = NULL
          WHERE id = $1 AND status = 'running' RETURNING id`,
    penalty.counts ? [id, json(failure), penalty.capMinutes] : [id, json(failure)],
  );
  if (rows.length) await q(db, "SELECT pg_notify('shared_analysis', $1)", [String(id)]);
  return rows.length > 0;
}

/**
 * Valid rows of the same subject as the published `row` (same kind, repositories, error, focus/project/locale and model
 * identity, so another provider's or model's result is another subject while a configuration change still replaces the
 * same model) under another key, published BEFORE it: of two publications of one subject only the older one can be
 * replaced by the newer one, never the other way round.
 */
export function olderOfSubject(db: Db, row: SharedRow, modelIdentity: string) {
  return q<{ id: number; key: string; version: number; key_parts: Record<string, unknown> }>(
    db,
    `SELECT id, key, version, key_parts FROM shared_analyses
      WHERE kind = $1 AND status = 'valid' AND key <> $2 AND scope_repos = $3 AND error_key IS NOT DISTINCT FROM $4
        AND key_parts->>'scope' = $5
        AND ($1 <> 'code_assessment' OR (
          COALESCE(key_parts->>'focus', '') = $6
          AND COALESCE(key_parts->>'project', '') = $9
          AND COALESCE(key_parts->>'locale', 'vi') = $10
        ))
        AND split_part(key_parts->>'model', '#', 1) = $7
        AND finished_at < $8`,
    [
      row.kind,
      row.key,
      row.scope_repos,
      row.error_key,
      row.key_parts.scope,
      row.key_parts.focus ?? "",
      modelIdentity,
      row.finished_at,
      row.key_parts.project ?? "",
      row.key_parts.locale ?? "vi",
    ],
  );
}

export async function markStale(db: Db, id: number, reason: string) {
  const rows = await q(
    db,
    "UPDATE shared_analyses SET status = 'stale', stale_reason = $2 WHERE id = $1 AND status = 'valid' RETURNING id",
    [id, reason],
  );
  return rows.length > 0;
}

/** Valid rows past their end become stale ("ttl"); bounded, safe on every instance. */
export function expireDue(db: Db, limit: number, kinds: readonly SharedKind[]) {
  return q<{ id: number; kind: SharedKind; key: string; version: number; scope: string | null }>(
    db,
    `UPDATE shared_analyses SET status = 'stale', stale_reason = 'ttl'
      WHERE id IN (SELECT id FROM shared_analyses WHERE status = 'valid' AND valid_until IS NOT NULL AND valid_until <= now()
                      AND kind = ANY($2::text[])
                    ORDER BY valid_until LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, key, version, key_parts->>'scope' AS scope`,
    [limit, kinds],
  );
}
