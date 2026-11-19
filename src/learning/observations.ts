import { createHash } from "node:crypto";
import { pool, q, one, json, type Db } from "../db/pool.ts";
import { redactSecrets } from "../integrations/redact.ts";

/**
 * Append-only outcome observations (outcome_observations). One row per distinct observed fact, deduplicated by an
 * immutable source reference, so effect retries, restarts and repeated polls add nothing. A later fact about the same
 * subject (a PR merged after "ready", a regression reported after "merged") appends a row that supersedes the earlier
 * one — contradictory evidence is kept, never deleted. Merge is recorded as human acceptance, not as correctness, and
 * no observation is ever inferred from silence (no regression report is not a "no regression" row).
 */

export const OBSERVATION_KINDS = [
  "run_completed",
  "run_failed",
  "run_canceled",
  "tests_passed",
  "tests_failed",
  "review_passed",
  "review_failed",
  "pr_opened",
  "pr_ci_failed",
  "pr_changes_requested",
  "pr_ready",
  "pr_merged",
  "pr_closed",
  "regression_reported",
  "rollback_reported",
  "human_feedback",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** Facts about one subject that replace each other as "current" (older rows stay, linked by supersedes). */
const FAMILY: Record<ObservationKind, string> = {
  run_completed: "run",
  run_failed: "run",
  run_canceled: "run",
  tests_passed: "tests",
  tests_failed: "tests",
  review_passed: "review",
  review_failed: "review",
  pr_opened: "pr",
  pr_ci_failed: "pr",
  pr_changes_requested: "pr",
  pr_ready: "pr",
  pr_merged: "pr",
  pr_closed: "pr",
  regression_reported: "production",
  rollback_reported: "production",
  human_feedback: "feedback",
};

export interface Observation {
  kind: ObservationKind;
  sourceType: "platform" | "provider" | "manual";
  sourceRef: string;
  /** What the fact is about (run:<id>, pr:<id>): rows of the same subject and family supersede each other. */
  subject: string;
  runId?: number | null;
  workItemId?: number | null;
  ownerId?: number | null;
  repo?: string | null;
  commitSha?: string | null;
  policyVersions?: Record<string, string> | null;
  verified: boolean;
  evidence?: Record<string, unknown>;
  observedAt?: Date;
  recordedBy?: string;
}

/** Idempotent append. Returns the row id, or null when the same source reference was already recorded. */
export async function recordObservation(o: Observation, db: Db = pool) {
  const prior = await one<{ id: number }>(
    db,
    `SELECT id FROM outcome_observations WHERE evidence->>'subject' = $1 AND evidence->>'family' = $2 AND source_ref <> $3
      ORDER BY observed_at DESC, id DESC LIMIT 1`,
    [o.subject, FAMILY[o.kind], o.sourceRef],
  );
  const row = await one<{ id: number }>(
    db,
    `INSERT INTO outcome_observations (kind, source_type, source_ref, run_id, work_item_id, owner_id, repo, commit_sha,
       policy_versions, verified, evidence, observed_at, recorded_by, supersedes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, now()),$13,$14)
     ON CONFLICT (source_type, source_ref) DO NOTHING RETURNING id`,
    [
      o.kind,
      o.sourceType,
      o.sourceRef,
      o.runId ?? null,
      o.workItemId ?? null,
      o.ownerId ?? null,
      o.repo ?? null,
      o.commitSha ?? null,
      o.policyVersions ? json(o.policyVersions) : null,
      o.verified,
      json(
        JSON.parse(
          redactSecrets(
            JSON.stringify({ ...(o.evidence ?? {}), subject: o.subject, family: FAMILY[o.kind] }),
          ),
        ),
      ),
      o.observedAt ?? null,
      o.recordedBy ?? "platform",
      prior?.id ?? null,
    ],
  );
  return row?.id ?? null;
}

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/**
 * Platform-derived observations of a finished run, from its own records and the derived outcome ladder: the run status,
 * the test and review rungs bound to the final heads, and every PR it opened. Idempotent per fact.
 */
export async function observeRun(runId: number, db: Db = pool) {
  const run = await one<{
    id: number;
    status: string;
    owner_id: number | null;
    work_item_id: number | null;
    policy_versions: Record<string, string> | null;
    outcome: {
      ladder?: Record<string, { state: string; evidence: string | null }>;
      repositories?: Array<{ repo: string; commit: string }>;
    } | null;
    finished_at: string | null;
  }>(
    db,
    "SELECT id, status, owner_id, work_item_id, policy_versions, outcome, finished_at FROM workflow_runs WHERE id = $1",
    [runId],
  );
  if (!run || !["COMPLETED", "FAILED", "CANCELED"].includes(run.status)) return [];
  const base = {
    runId,
    workItemId: run.work_item_id,
    ownerId: run.owner_id,
    policyVersions: run.policy_versions,
    observedAt: run.finished_at ? new Date(run.finished_at) : undefined,
  };
  const ids: Array<number | null> = [];
  const kind =
    run.status === "COMPLETED"
      ? "run_completed"
      : run.status === "FAILED"
        ? "run_failed"
        : "run_canceled";
  ids.push(
    await recordObservation(
      {
        ...base,
        kind,
        sourceType: "platform",
        sourceRef: `run:${runId}:${run.status}`,
        subject: `run:${runId}`,
        verified: true,
      },
      db,
    ),
  );
  const ladder = run.outcome?.ladder ?? {};
  const heads = Object.fromEntries(
    (run.outcome?.repositories ?? []).map((r) => [r.repo, r.commit]),
  );
  for (const [rung, pass, fail] of [
    ["tests_passed", "tests_passed", "tests_failed"],
    ["review_passed", "review_passed", "review_failed"],
  ] as const) {
    const st = ladder[rung]?.state;
    if (st !== "proven" && st !== "not_reached") continue;
    ids.push(
      await recordObservation(
        {
          ...base,
          kind: st === "proven" ? pass : fail,
          sourceType: "platform",
          sourceRef: `run:${runId}:${rung}:${st}:${hash(heads)}`,
          subject: `run:${runId}`,
          commitSha: Object.values(heads)[0] ?? null,
          verified: true,
          evidence: { heads, ladder_evidence: ladder[rung]?.evidence ?? null },
        },
        db,
      ),
    );
  }
  for (const pr of await q<{
    id: number;
    repo: string;
    created: boolean;
    published_sha: string | null;
    created_at: string;
  }>(
    db,
    "SELECT id, repo, created, published_sha, created_at FROM pull_requests WHERE run_id = $1 AND created",
    [runId],
  ))
    ids.push(
      await recordObservation(
        {
          ...base,
          kind: "pr_opened",
          sourceType: "platform",
          sourceRef: `pr:${pr.id}:opened`,
          subject: `pr:${pr.id}`,
          repo: pr.repo,
          commitSha: pr.published_sha,
          verified: true,
          observedAt: new Date(pr.created_at),
        },
        db,
      ),
    );
  return ids.filter((x): x is number => x != null);
}

const PR_KIND: Record<string, ObservationKind | undefined> = {
  READY_FOR_HUMAN_MERGE: "pr_ready",
  CI_FAILED: "pr_ci_failed",
  CHANGES_REQUESTED: "pr_changes_requested",
  MERGED: "pr_merged",
  CLOSED: "pr_closed",
};

/** A PR lifecycle transition read from the Git host (task 06). One row per state and head commit. */
export async function observePullRequest(
  pr: { id: number; repo: string; run_id: number | null },
  lifecycle: string,
  head: string | null,
  reasons: string[],
  db: Db = pool,
) {
  const kind = PR_KIND[lifecycle];
  if (!kind || !pr.run_id) return null;
  const run = await one<{ owner_id: number | null; work_item_id: number | null }>(
    db,
    "SELECT owner_id, work_item_id FROM workflow_runs WHERE id = $1",
    [pr.run_id],
  );
  return recordObservation(
    {
      kind,
      sourceType: "provider",
      sourceRef: `pr:${pr.id}:${kind}:${head ?? "unknown"}`,
      subject: `pr:${pr.id}`,
      runId: pr.run_id,
      workItemId: run?.work_item_id ?? null,
      ownerId: run?.owner_id ?? null,
      repo: pr.repo,
      commitSha: head,
      // Merge is human acceptance, recorded as such — never as proof that the change is correct.
      verified: true,
      evidence: {
        reasons: reasons.slice(0, 5),
        ...(kind === "pr_merged" ? { meaning: "human acceptance, not proof of correctness" } : {}),
      },
    },
    db,
  );
}

/**
 * A person reports a later regression/rollback or gives feedback on a run. Recorded with who said it; not verified by
 * the platform (provenance says so). A regression supersedes the run's production-family status, not its history.
 */
export async function observeManual(
  i: {
    runId: number;
    kind: "regression_reported" | "rollback_reported" | "human_feedback";
    note: string;
    by: string;
    ref?: string;
  },
  db: Db = pool,
) {
  const run = await one<{ owner_id: number | null; work_item_id: number | null }>(
    db,
    "SELECT owner_id, work_item_id FROM workflow_runs WHERE id = $1",
    [i.runId],
  );
  if (!run) throw new Error("run not found");
  const note = redactSecrets(String(i.note ?? "")).slice(0, 2000);
  return recordObservation(
    {
      kind: i.kind,
      sourceType: "manual",
      sourceRef: `manual:${i.runId}:${i.kind}:${i.ref ? String(i.ref).slice(0, 100) : hash([i.by, note])}`,
      subject: `run:${i.runId}`,
      runId: i.runId,
      workItemId: run.work_item_id,
      ownerId: run.owner_id,
      verified: false,
      evidence: { note, reported_by: i.by },
      recordedBy: i.by,
    },
    db,
  );
}

/** Current (not superseded) observations of a run, newest first. */
export function currentObservations(runId: number, db: Db = pool) {
  return q<{
    id: number;
    kind: ObservationKind;
    source_type: string;
    verified: boolean;
    evidence: Record<string, unknown>;
    observed_at: string;
  }>(
    db,
    `SELECT o.id, o.kind, o.source_type, o.verified, o.evidence, o.observed_at FROM outcome_observations o
      WHERE o.run_id = $1 AND NOT EXISTS (SELECT 1 FROM outcome_observations n WHERE n.supersedes = o.id)
      ORDER BY o.observed_at DESC, o.id DESC`,
    [runId],
  );
}
