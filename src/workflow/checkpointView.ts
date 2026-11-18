/**
 * Read-only presentation of execution checkpoints for the run view and step inspector. Recoverable checkpoints carry a
 * validated execution envelope (executor return and the wait/approval/handoff pauses); everything else is an
 * observation note. Compatibility is judged from rows already loaded: it never inspects git or mutates state, so
 * "compatible" means no incompatibility was detected (dispatch still runs the full binding and workspace checks).
 */

export const RECOVERABLE_REASONS = [
  "executor_returned",
  "waiting_input",
  "waiting_approval",
  "provider_handoff",
] as const;

export type CheckpointCompatibility =
  "compatible" | "stale_generation" | "invalidated" | "workspace_changed" | "legacy" | "unknown";

export interface CheckpointRowInput {
  id: number;
  attempt_id: number | null;
  reason: string;
  data?: Record<string, unknown> | null;
  execution?: {
    version?: number;
    milestone?: string;
    binding?: {
      attempt_id?: number;
      generation?: number;
      snapshot_id?: number | null;
      context_hash?: string | null;
    };
    workspace_fingerprint?: string | null;
    workspace_unavailable?: boolean;
    workspace_artifact_id?: number | null;
    verification?: { digest: string; artifact_ids: number[] } | null;
    artifact_ids?: number[];
    completed_actions?: string[];
  } | null;
  created_at: string | Date;
}

export interface CheckpointView {
  id: number;
  attempt_id: number | null;
  reason: string;
  kind: "recoverable" | "note";
  created_at: string;
  compatibility: CheckpointCompatibility | null;
  note: string | null;
  evidence: {
    workspace: {
      fingerprint: string | null;
      unavailable: boolean;
      artifact_id: number | null;
      bytes: number | null;
    } | null;
    context: { snapshot_id: number | null; context_hash: string | null } | null;
    verification: { digest: string; artifact_ids: number[]; passed: boolean | null } | null;
    completed_actions: string[];
  } | null;
}

export const isRecoverable = (reason: string) =>
  (RECOVERABLE_REASONS as readonly string[]).includes(reason);

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));

/** One checkpoint row as the UI shows it; secrets and the stored result are never part of the view. */
export function checkpointView(
  row: CheckpointRowInput,
  ctx: {
    stepGeneration: number;
    attempts: Array<{
      id: number;
      generation: number;
      invalidated_at?: unknown;
      metrics?: { verification?: { passed?: boolean } } | null;
    }>;
    artifacts: Array<{ id: number; size?: number | string | null }>;
    /** Applied reconcile decisions of the step (workspace drift detected at dispatch), with their time. */
    reconciledAt: Array<{ created_at: string | Date }>;
  },
): CheckpointView {
  const recoverable = isRecoverable(row.reason);
  const created = iso(row.created_at);
  const note =
    typeof row.data?.note === "string"
      ? row.data.note.slice(0, 500)
      : typeof row.data?.message === "string"
        ? row.data.message.slice(0, 500)
        : null;
  if (!recoverable)
    return {
      id: row.id,
      attempt_id: row.attempt_id,
      reason: row.reason,
      kind: "note",
      created_at: created,
      compatibility: null,
      note,
      evidence: null,
    };

  const e = row.execution;
  const attempt = ctx.attempts.find((a) => a.id === row.attempt_id);
  let compatibility: CheckpointCompatibility;
  if (!e) compatibility = "legacy";
  else if (e.version !== 1 || !attempt) compatibility = "unknown";
  else if (attempt.invalidated_at) compatibility = "invalidated";
  else if ((e.binding?.generation ?? attempt.generation) !== ctx.stepGeneration)
    compatibility = "stale_generation";
  else if (
    ctx.reconciledAt.some((d) => new Date(d.created_at).getTime() >= new Date(created).getTime())
  )
    compatibility = "workspace_changed";
  else compatibility = "compatible";

  const artifact =
    e?.workspace_artifact_id != null
      ? ctx.artifacts.find((a) => a.id === e.workspace_artifact_id)
      : undefined;
  return {
    id: row.id,
    attempt_id: row.attempt_id,
    reason: row.reason,
    kind: "recoverable",
    created_at: created,
    compatibility,
    note,
    evidence: e
      ? {
          workspace: {
            fingerprint: e.workspace_fingerprint ?? null,
            unavailable: !!e.workspace_unavailable,
            artifact_id: e.workspace_artifact_id ?? null,
            bytes: artifact?.size != null ? Number(artifact.size) : null,
          },
          context: e.binding
            ? {
                snapshot_id: e.binding.snapshot_id ?? null,
                context_hash: e.binding.context_hash ?? null,
              }
            : null,
          verification: e.verification
            ? {
                digest: e.verification.digest,
                artifact_ids: e.verification.artifact_ids ?? [],
                passed: attempt?.metrics?.verification?.passed ?? null,
              }
            : null,
          completed_actions: e.completed_actions ?? [],
        }
      : null,
  };
}

/** Newest recoverable checkpoint of the step's current generation, if any. */
export function latestRecoverable(views: CheckpointView[]) {
  return (
    [...views]
      .reverse()
      .find(
        (v) =>
          v.kind === "recoverable" &&
          v.compatibility !== "invalidated" &&
          v.compatibility !== "stale_generation",
      ) ?? null
  );
}
