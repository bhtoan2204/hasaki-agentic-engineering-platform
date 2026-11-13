import { z } from "zod";
import { AGENT_PROVIDERS } from "../agent/provider.ts";
import {
  DecompositionPlan,
  SubtaskSpec,
  validateExpansion,
  type ExpansionContext,
} from "../workflow/decomposition.ts";

export const decisionSchemas = {
  provider_selection: z
    .object({
      provider: z.enum(AGENT_PROVIDERS),
      model: z.string().min(1),
      effort: z.string().min(1),
      explanation: z.string().min(1).max(2000),
    })
    .strict(),
  reasoning_effort: z
    .object({ effort: z.enum(["low", "medium", "high"]), explanation: z.string().min(1).max(2000) })
    .strict(),
  workflow_routing: z
    .object({
      profile: z.enum(["FAST", "STANDARD", "DEEP"]),
      explanation: z.string().min(1).max(2000),
    })
    .strict(),
  decomposition: z
    .object({
      decompose: z.boolean(),
      explanation: z.string().min(1).max(2000),
      plan: DecompositionPlan.extend({ subtasks: z.array(SubtaskSpec.strict()).min(1).max(20) })
        .strict()
        .nullable(),
    })
    .strict(),
  recovery: z
    .object({
      action: z.enum(["retry", "adjust_context", "replan", "switch_provider", "human", "stop"]),
      explanation: z.string().min(1).max(2000),
    })
    .strict(),
  feedback: z
    .object({
      route: z.enum(["reimplement", "replan", "rediscover", "restart"]),
      architecture_change: z.boolean(),
      scope_change: z.boolean(),
      requirement_change: z.boolean(),
      full_review: z.boolean(),
      reasons: z.array(z.string().max(1000)).max(5),
    })
    .strict(),
  repository_ranking: z
    .array(
      z
        .object({
          repo: z.string().min(1),
          score: z.number().min(0).max(10),
          reasons: z.array(z.string().max(1000)).max(5),
        })
        .strict(),
    )
    .max(100),
  test_recovery: z
    .object({
      kind: z.enum(["rerun", "fix", "accept_baseline", "stop", "unclear"]),
      instructions: z.string().max(4000).optional(),
      confirmed: z.boolean().optional(),
      question: z.string().max(2000).optional(),
    })
    .strict(),
};
export type DecisionType = keyof typeof decisionSchemas;
export type DecisionOutput<K extends DecisionType> = z.infer<(typeof decisionSchemas)[K]>;
export interface DecisionConstraints {
  permittedAgents?: Array<{
    provider: string;
    model: string;
    efforts: string[];
    available: boolean;
  }>;
  agentOverride?: { provider?: string; model?: string; effort?: string };
  allowedRepositories?: string[];
  allowedProfiles?: string[];
  allowedActions?: string[];
  supportedEfforts?: string[];
  baselineAcceptanceConfirmed?: boolean;
  expansion?: ExpansionContext;
}
/** These checks constrain recommendations; callers must still use the existing state/permission/graph gates. */
export function validateConstraints(
  type: DecisionType,
  value: unknown,
  c: DecisionConstraints = {},
) {
  if (type === "provider_selection") {
    const v = decisionSchemas.provider_selection.parse(value);
    const allowed = c.permittedAgents?.find(
      (a) =>
        a.available &&
        a.provider === v.provider &&
        a.model === v.model &&
        a.efforts.includes(v.effort),
    );
    if (!allowed)
      throw new Error("Decision rejected: agent is not explicitly permitted and available");
    for (const k of ["provider", "model", "effort"] as const)
      if (c.agentOverride?.[k] && c.agentOverride[k] !== v[k])
        throw new Error("Decision rejected: user agent override");
  }
  if (
    type === "reasoning_effort" &&
    !c.supportedEfforts?.includes(decisionSchemas.reasoning_effort.parse(value).effort)
  )
    throw new Error("Decision rejected: unsupported effort");
  if (
    type === "reasoning_effort" &&
    c.agentOverride?.effort &&
    c.agentOverride.effort !== decisionSchemas.reasoning_effort.parse(value).effort
  )
    throw new Error("Decision rejected: user effort override");
  if (
    type === "workflow_routing" &&
    !c.allowedProfiles?.includes(decisionSchemas.workflow_routing.parse(value).profile)
  )
    throw new Error("Decision rejected: profile policy");
  if (
    type === "recovery" &&
    !c.allowedActions?.includes(decisionSchemas.recovery.parse(value).action)
  )
    throw new Error("Decision rejected: recovery action policy");
  if (type === "repository_ranking") {
    const v = decisionSchemas.repository_ranking.parse(value);
    if (
      v.some((r) => !c.allowedRepositories?.includes(r.repo)) ||
      new Set(v.map((r) => r.repo)).size !== v.length
    )
      throw new Error("Decision rejected: repository scope or duplicate");
  }
  if (type === "decomposition") {
    const v = decisionSchemas.decomposition.parse(value);
    if (v.decompose !== (v.plan !== null))
      throw new Error("Decision rejected: decomposition plan mismatch");
    if (
      v.plan?.subtasks.some((s) => s.target_repos.some((r) => !c.allowedRepositories?.includes(r)))
    )
      throw new Error("Decision rejected: decomposition scope");
    if (v.plan && c.expansion) {
      const checked = validateExpansion(v.plan, c.expansion);
      if (checked.errors.length)
        throw new Error(`Decision rejected by DAG validation: ${checked.errors.join("; ")}`);
    }
  }
  if (type === "test_recovery") {
    const v = decisionSchemas.test_recovery.parse(value);
    if (v.kind === "accept_baseline" && (!c.baselineAcceptanceConfirmed || !v.confirmed))
      throw new Error("Decision rejected: baseline exception requires explicit human confirmation");
  }
}
