/** Execution decisions (`execution_decisions`, see src/workflow/decisions.ts) as the run view and inspector show them. */

export type DecisionAction =
  | "REUSE"
  | "RESUME"
  | "RESTORE"
  | "VERIFY_ONLY"
  | "REEXECUTE"
  | "FORCE_REEXECUTE"
  | "RECONCILE"
  | "SAFE_RETRY"
  | "REQUIRES_RECONCILIATION"
  | "HANDOFF"
  | "RECORD";

export interface Decision {
  id: number;
  step_id: number | null;
  step_key: string | null;
  attempt_id: number | null;
  generation: number | null;
  kind: string;
  action: DecisionAction;
  outcome: "planned" | "applied" | "rejected" | "failed";
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

export const DECISION_COLORS: Record<DecisionAction, string> = {
  REUSE: "var(--st-ok)",
  VERIFY_ONLY: "var(--st-ok)",
  RESUME: "var(--st-run)",
  SAFE_RETRY: "var(--st-run)",
  RESTORE: "var(--accent)",
  HANDOFF: "var(--accent)",
  REEXECUTE: "var(--st-wait)",
  FORCE_REEXECUTE: "var(--st-wait)",
  RECONCILE: "var(--st-err)",
  REQUIRES_RECONCILIATION: "var(--st-err)",
  RECORD: "var(--muted)",
};

export const COMPATIBILITY_COLORS: Record<string, string> = {
  compatible: "var(--st-ok)",
  legacy: "var(--muted)",
  unknown: "var(--muted)",
  stale_generation: "var(--st-idle)",
  invalidated: "var(--st-idle)",
  workspace_changed: "var(--st-err)",
};

/** The decision a DAG node shows: the newest applied (or rejected) one of the step's current generation. */
export function latestStepDecisions(
  decisions: Decision[] | undefined,
  steps: Array<{ id: number; key: string; generation: number }>,
) {
  const out: Record<string, Decision> = {};
  for (const s of steps) {
    const d = [...(decisions ?? [])]
      .reverse()
      .find(
        (x) =>
          x.step_id === s.id &&
          x.kind !== "checkpoint" &&
          x.outcome !== "planned" &&
          (x.generation == null || x.generation === s.generation),
      );
    if (d) out[s.key] = d;
  }
  return out;
}

const sumKnown = (values: Array<number | null | undefined>) => {
  const known = values.filter((v): v is number => v != null && Number.isFinite(Number(v)));
  return known.length ? known.reduce((a, b) => a + Number(b), 0) : null;
};

/** Run-level reuse figures from applied decisions; estimates stay null when no source reported usage. */
export function reuseSummary(decisions: Decision[] | undefined) {
  const applied = (decisions ?? []).filter((d) => d.outcome === "applied");
  const count = (kind: string, action?: DecisionAction) =>
    applied.filter((d) => d.kind === kind && (!action || d.action === action)).length;
  return {
    reused: count("replay", "REUSE") + count("review_reuse"),
    resumed: count("resume", "RESUME"),
    restored: count("restore"),
    recovered: count("recovery"),
    verificationReuse: count("verification_reuse"),
    contextReuse: count("context_reuse"),
    savedInvocations: sumKnown(applied.map((d) => d.saved_invocations)),
    savedTokens: sumKnown(applied.map((d) => d.saved_tokens)),
    savedMs: sumKnown(applied.map((d) => d.saved_ms)),
  };
}

export const bytes = (n?: number | null) =>
  n == null
    ? "—"
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A checkpoint as the step detail API returns it (src/workflow/checkpointView.ts). */
export interface CheckpointView {
  id: number;
  attempt_id: number | null;
  reason: string;
  kind: "recoverable" | "note";
  created_at: string;
  compatibility: string | null;
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

/** The harness_evidence artifact data (src/agent/harness/evidence.ts). */
export interface HarnessEvidence {
  stages?: Array<{ stage: string; ms: number; outcome: string }>;
  failure_code?: string | null;
  checkpoint?: { source?: string } | null;
  tool_calls?: { used: number; limit: number } | null;
  guarantees?: { unmet?: string[]; degraded?: string[] } | null;
}
