import { pool, q, one, json, insertDeferred, type Db } from "../db/pool.ts";
import { redactSecrets } from "../integrations/redact.ts";

/**
 * Execution decision log (`execution_decisions`): every replay, recovery and reuse decision, planned or applied, with
 * its reason, source attempt, latency and estimated savings. Recording never changes what the engine decides.
 */

export const DECISION_KINDS = [
  "replay",
  "recovery",
  "resume",
  "restore",
  "reconcile",
  "verification_reuse",
  "context_reuse",
  "review_reuse",
  "checkpoint",
  "autonomy",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Replay actions (see replay.ts) plus the recovery and record actions. */
export const DECISION_ACTIONS = [
  "REUSE",
  "RESUME",
  "RESTORE",
  "VERIFY_ONLY",
  "REEXECUTE",
  "FORCE_REEXECUTE",
  "RECONCILE",
  "SAFE_RETRY",
  "REQUIRES_RECONCILIATION",
  "HANDOFF",
  "RECORD",
  "ALLOW",
  "DENY",
  "REQUIRE_HUMAN",
  "COLLECT_EVIDENCE",
  "REPLAN",
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export type DecisionOutcome = "planned" | "applied" | "rejected" | "failed";

/** Estimated work a reuse avoided; null where the source attempt reported nothing (unknown, not zero). */
export interface Savings {
  invocations: number | null;
  tokens: number | null;
  cost_usd: number | null;
}

export interface Decision {
  runId: number;
  stepId?: number | null;
  attemptId?: number | null;
  generation?: number | null;
  kind: DecisionKind;
  action: DecisionAction;
  outcome: DecisionOutcome;
  reason?: string;
  sourceAttemptId?: number | null;
  latencyMs?: number | null;
  checkpointBytes?: number | null;
  saved?: Savings | null;
  savedMs?: number | null;
  details?: Record<string, unknown>;
}

const finite = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Inside withTx the row is written with the transaction (deferred insert); otherwise at once. */
export async function recordDecision(db: Db, d: Decision) {
  await insertDeferred(
    db,
    "execution_decisions",
    [
      "run_id",
      "step_id",
      "attempt_id",
      "generation",
      "kind",
      "action",
      "outcome",
      "reason",
      "source_attempt_id",
      "latency_ms",
      "checkpoint_bytes",
      "saved_invocations",
      "saved_tokens",
      "saved_cost_usd",
      "saved_ms",
      "details",
    ],
    [
      d.runId,
      d.stepId ?? null,
      d.attemptId ?? null,
      d.generation ?? null,
      d.kind,
      d.action,
      d.outcome,
      redactSecrets(d.reason ?? "").slice(0, 2000),
      d.sourceAttemptId ?? null,
      finite(d.latencyMs),
      finite(d.checkpointBytes),
      finite(d.saved?.invocations),
      finite(d.saved?.tokens),
      finite(d.saved?.cost_usd),
      finite(d.savedMs),
      json(JSON.parse(redactSecrets(JSON.stringify(d.details ?? {})))),
    ],
  );
}

/** Best-effort recording outside a transaction: observability never fails the execution it describes. */
export function noteDecision(d: Decision) {
  return recordDecision(pool, d).catch((error) =>
    console.error(`execution decision not recorded: ${(error as Error).message}`),
  );
}

/** What the source attempt reported (provider sessions, tokens, cost): the estimate of what reusing it avoided. */
export async function savingsFrom(
  db: Db,
  sourceAttemptId: number | null | undefined,
): Promise<Savings | null> {
  if (!sourceAttemptId) return null;
  const row = await one<{
    invocations: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost: number | null;
  }>(
    db,
    `SELECT provider_invocations AS invocations, input_tokens, output_tokens, reported_cost_usd AS cost
       FROM execution_attempt_telemetry WHERE attempt_id = $1`,
    [sourceAttemptId],
  ).catch(() => null);
  if (!row) return null;
  const tokens =
    row.input_tokens == null && row.output_tokens == null
      ? null
      : Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
  return {
    invocations: finite(row.invocations),
    tokens: finite(tokens),
    cost_usd: finite(row.cost),
  };
}

export interface DecisionView {
  id: number;
  step_id: number | null;
  step_key: string | null;
  attempt_id: number | null;
  generation: number | null;
  kind: DecisionKind;
  action: DecisionAction;
  outcome: DecisionOutcome;
  reason: string;
  source_attempt_id: number | null;
  latency_ms: number | null;
  checkpoint_bytes: number | null;
  saved_invocations: number | null;
  saved_tokens: number | null;
  saved_cost_usd: number | null;
  saved_ms: number | null;
  details: Record<string, unknown>;
  created_at: string;
}

/** Decisions of a run (optionally one step), oldest first; bounded. */
export function decisionsOf(runId: number, stepId?: number | null, db: Db = pool) {
  return q<DecisionView>(
    db,
    `SELECT d.id, d.step_id, s.key AS step_key, d.attempt_id, d.generation, d.kind, d.action, d.outcome, d.reason,
            d.source_attempt_id, d.latency_ms, d.checkpoint_bytes, d.saved_invocations, d.saved_tokens,
            d.saved_cost_usd, d.saved_ms, d.details, d.created_at
       FROM execution_decisions d LEFT JOIN workflow_steps s ON s.id = d.step_id
      WHERE d.run_id = $1 AND ($2::bigint IS NULL OR d.step_id = $2)
      ORDER BY d.id LIMIT 2000`,
    [runId, stepId ?? null],
  );
}
