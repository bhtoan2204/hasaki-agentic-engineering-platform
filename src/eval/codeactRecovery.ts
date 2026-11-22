/**
 * Recovery accounting for CodeAct from observable execution sequences (no intent guessed from call counts).
 *
 * An episode starts at a failed `code.execute` (a failed execution, or a call the chat refused) and extends over
 * directly following failed `code.execute` calls. What ends it decides the outcome:
 * - a successful `code.execute` → `recovered` (after `attempts` further programs);
 * - a direct integration call (`tools.call`) → `fallback_direct`;
 * - nothing → `abandoned` (no attempt) or `recovery_failed` (attempts that never succeeded);
 * - a call that overlaps the failed one in time, or one that shows no recovery intent (any other tool) → `unknown`.
 * The final task outcome is graded separately and reported next to this.
 */
export interface ToolEvent {
  tool: string;
  /** The chat tool call's own status (a failed program still has an `ok` outer call). */
  status: string;
  started_at: number;
  finished_at: number;
  execution?: {
    id: number;
    ok: boolean;
    failure: { category: string; phase: string } | null;
    nested_failures: number;
  };
}
export type RecoveryOutcome =
  "recovered" | "recovery_failed" | "fallback_direct" | "abandoned" | "unknown";
export interface RecoveryEpisode {
  execution_ids: number[];
  categories: string[];
  attempts: number;
  outcome: RecoveryOutcome;
}
export interface RecoverySummary {
  execution_failures: number;
  recovery_attempts: number;
  recovered: number;
  recovery_failed: number;
  fallback_direct: number;
  abandoned: number;
  unknown: number;
  nested_failures_in_ok_executions: number;
  episodes: RecoveryEpisode[];
}

const failed = (e: ToolEvent) =>
  e.tool === "code.execute" && (e.status !== "ok" || e.execution?.ok === false);

export function classifyRecovery(events: ToolEvent[]): RecoverySummary {
  const ordered = [...events].sort((a, b) => a.started_at - b.started_at);
  const out: RecoverySummary = {
    execution_failures: ordered.filter(failed).length,
    recovery_attempts: 0,
    recovered: 0,
    recovery_failed: 0,
    fallback_direct: 0,
    abandoned: 0,
    unknown: 0,
    nested_failures_in_ok_executions: ordered
      .filter((e) => e.tool === "code.execute" && e.execution?.ok)
      .reduce((n, e) => n + (e.execution?.nested_failures ?? 0), 0),
    episodes: [],
  };
  for (let i = 0; i < ordered.length; i++) {
    if (!failed(ordered[i])) continue;
    const chain = [ordered[i]];
    let j = i + 1;
    while (
      j < ordered.length &&
      failed(ordered[j]) &&
      ordered[j].started_at >= chain.at(-1)!.finished_at
    )
      chain.push(ordered[j++]);
    const last = chain.at(-1)!;
    const next = ordered[j];
    let outcome: RecoveryOutcome;
    if (next && next.started_at < last.finished_at) outcome = "unknown";
    else if (!next) outcome = chain.length > 1 ? "recovery_failed" : "abandoned";
    else if (next.tool === "code.execute") {
      outcome = "recovered";
      chain.push(next);
      j++;
    } else if (next.tool === "tools.call") outcome = "fallback_direct";
    else outcome = "unknown";
    const failures = chain.filter(failed);
    const attempts = chain.length - 1;
    out.recovery_attempts += attempts;
    out[outcome]++;
    out.episodes.push({
      execution_ids: chain.map((e) => e.execution?.id).filter((x): x is number => x != null),
      categories: failures.map((e) => e.execution?.failure?.category ?? e.status),
      attempts,
      outcome,
    });
    i = j - 1;
  }
  return out;
}
