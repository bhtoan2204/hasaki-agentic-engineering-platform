import type { ExecResult } from "../../workflow/types.ts";
import type { LifecycleState } from "./state.ts";

/** What the harness itself observed for one attempt, persisted as the `harness_evidence` artifact. */
export function harnessEvidence(s: LifecycleState, result: ExecResult | undefined) {
  const { ctx } = s;
  const pack = ctx.context?.contextPack;
  return {
    version: 1,
    provider: s.provider ?? null,
    mode: s.mode,
    outcome: result?.kind ?? "error",
    failure_code:
      result?.kind === "failed"
        ? ((result.details as { failure_code?: string } | undefined)?.failure_code ?? null)
        : null,
    stages: s.trace,
    guarantees: s.guarantees ?? null,
    tool_calls: s.policy?.toolBudget
      ? { used: s.policy.toolBudget.calls, limit: s.policy.toolBudget.limit }
      : null,
    cost: {
      reported_usd: s.metrics?.cost_usd ?? null,
      remaining_budget_usd: s.budget?.remainingUsd ?? null,
      enforcement: s.budget?.enforcement ?? null,
    },
    repairs: (s.rounds ?? []).map((r) => ({
      kind: "verify",
      round: r.round,
      passed: r.passed,
      signature: r.signature,
    })),
    checkpoint: {
      source: s.checkpointSource ?? "fresh",
      session_id: s.resume?.sessionId ?? null,
      from_attempt: s.resume?.fromAttempt ?? null,
    },
    context_pack: pack
      ? {
          tokens: pack.estimated_tokens,
          reused_from_pack: pack.retrieval_cache?.reused_from_pack ?? null,
        }
      : null,
    execution_contract_revision: ctx.input?.execution_contract?.provenance?.revision ?? null,
  };
}

export type HarnessEvidence = ReturnType<typeof harnessEvidence>;
