import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import type { TurnResult } from "../turn.ts";
import { config } from "../../../config.ts";
import { q, pool } from "../../../db/pool.ts";
import { budgetsForRun } from "../../../report/cost.ts";
import { GUARANTEES } from "../../providerCapabilities.ts";

/**
 * Budget gate inside the attempt. Run and work-item spend is projected before the job is queued and charged after the
 * attempt; here the attempt gets its tool-call budget and the spend it may still report before another turn starts.
 * A scope whose overrun the developer already acknowledged is not limited again.
 */
export async function budgetStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, provider, policy, effective } = s;
  policy.toolBudget = {
    calls: 0,
    limit: effective.max_tool_calls ?? config.agent.maxToolCalls ?? 400,
    exhausted: false,
  };
  const budgets = await budgetsForRun(ctx.run.id).catch(() => null);
  const acknowledged = new Set(
    (
      await q<{ scope: string }>(
        pool,
        "SELECT data->>'scope' AS scope FROM workflow_events WHERE run_id = $1 AND kind = 'budget' AND data->>'level' IN ('exceeded', 'preflight_projected') AND COALESCE(data->>'action', 'pause') = 'pause'",
        [ctx.run.id],
      ).catch(() => [])
    ).map((e) => e.scope),
  );
  const open = (
    [
      ["run", budgets?.run],
      ["work_item", budgets?.work_item],
    ] as const
  ).filter(([scope, line]) => line?.limit_usd != null && !acknowledged.has(scope));
  const remaining = open.map(([, line]) => line!.limit_usd! - line!.used_usd);
  const least = remaining.length ? Math.min(...remaining) : null;
  s.budget = {
    action: config.costBudget.action,
    acknowledged: [...acknowledged] as Array<"run" | "work_item">,
    // An overrun at attempt start is the engine's (pre-queue and post-attempt) to report; only "pause" stops a turn.
    remainingUsd: config.costBudget.action === "pause" && least != null && least > 0 ? least : null,
    scopes: open.map(([scope]) => scope),
    enforcement: GUARANTEES[provider].includes("reported_cost")
      ? "between_turns"
      : "preflight_only",
  };
}

/** Maps a turn the budgets stopped onto the step result: a cost stop pauses for the developer, a tool stop fails. */
export function budgetStop(s: LifecycleState, result: TurnResult): ExecResult | null {
  if (result.failure === "BUDGET_EXHAUSTED")
    return {
      kind: "waiting_input",
      questions: [
        {
          question: `Cost budget reached during this step: ${result.text}. Raise the budget and continue?`,
          options: ["Continue with a raised budget"],
        },
      ],
      checkpoint: {
        workspaces: s.policy.workspaces,
        mode: s.mode,
        budget: s.budget,
        ...(s.rounds?.length ? { verification: { rounds: s.rounds } } : {}),
      },
    };
  if (s.policy.toolBudget?.exhausted && !s.submitted)
    return {
      kind: "failed",
      retryable: false,
      error: `the agent used its tool budget of ${s.policy.toolBudget.limit} calls without submitting a result`,
      details: { failure_code: "TOOL_BUDGET_EXHAUSTED" },
    };
  return null;
}
