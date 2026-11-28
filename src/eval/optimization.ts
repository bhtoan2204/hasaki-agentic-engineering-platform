import { config } from "../config.ts";
import { z } from "zod";
import { q, one, withTx, type Db } from "../db/pool.ts";
import { pool } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { RECOMMENDATION_VERSION, recommendationDetail } from "./recommendations.ts";
import { parseAgentProvider, providerEnabled } from "../agent/provider.ts";
import { providerCapabilities } from "../agent/providerCapabilities.ts";
import { type AgentConfiguration } from "../agent/configuration.ts";
import { resolveStepAgent, type StepAgentConfig } from "../agent/stepAgent.ts";
import { handoffReadiness } from "../agent/handoff.ts";
import type { WorkflowSpec } from "../workflow/types.ts";
const Policy = z
  .object({
    recommendation_id: z.number().int().positive(),
    category: z.string().min(1).max(120),
    step_type: z.enum(["agent", "coding_agent"]).default("coding_agent"),
    enabled: z.boolean().default(false),
    allow_unknown_cost: z.boolean().default(false),
  })
  .strict();
export async function saveOptimizationPolicy(owner: number, raw: unknown) {
  const input = Policy.parse(raw),
    rec = await recommendationDetail(input.recommendation_id, owner);
  if (input.category !== rec.category)
    throw new HttpError(400, "Policy category must match recommendation evidence");
  if (
    input.enabled &&
    (rec.version !== RECOMMENDATION_VERSION ||
      rec.decision.status !== "RECOMMENDED" ||
      !["MEDIUM", "HIGH"].includes(rec.decision.confidence) ||
      rec.decision.plan?.length !== 1 ||
      new Date(rec.expires_at).getTime() <= Date.now())
  )
    throw new HttpError(
      409,
      "Only current, supported single-provider recommendations may influence future defaults",
    );
  return withTx(async (c) => {
    const row = await one(
      c,
      `INSERT INTO agent_optimization_policies(owner_id,category,step_type,recommendation_id,enabled,allow_unknown_cost) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(owner_id,category,step_type) DO UPDATE SET recommendation_id=excluded.recommendation_id,enabled=excluded.enabled,allow_unknown_cost=excluded.allow_unknown_cost,updated_at=now() RETURNING *`,
      [
        owner,
        input.category,
        input.step_type,
        input.recommendation_id,
        input.enabled,
        input.allow_unknown_cost,
      ],
    );
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'optimization.policy.updated','optimization',$2,$3)",
      [owner, String(row.id), JSON.stringify(input)],
    );
    return row;
  });
}
export async function optimizationPolicies(owner: number) {
  return q(pool, "SELECT * FROM agent_optimization_policies WHERE owner_id=$1 ORDER BY id", [
    owner,
  ]);
}
/** New-run defaults only. Explicit run/step/model choices and all permission/verification settings remain authoritative. */
export async function applyOptimizationDefaults(
  db: Db,
  owner: number,
  spec: WorkflowSpec,
  inputs: Record<string, unknown>,
  explicitProvider: boolean,
  profile: "MICRO" | "FAST" | "STANDARD" | "DEEP" = "STANDARD",
  complexity: string | null = null,
  defaultProvider: string | null = null,
  workflow = "",
  agentConfiguration?: AgentConfiguration,
) {
  const category = typeof inputs.task_category === "string" ? inputs.task_category : null;
  const graph = structuredClone(spec);
  const decisions: Array<Record<string, unknown>> = [];
  // A provider chosen for the run is an explicit override: neither recommendations nor routing change it.
  if (explicitProvider) return { graph, decisions };
  if (!category) {
    await applyAdaptiveRouting(
      db,
      owner,
      graph,
      decisions,
      profile,
      complexity,
      defaultProvider,
      workflow,
      agentConfiguration,
    );
    return { graph, decisions };
  }
  const policies = await q(
    db,
    `SELECT p.*,r.version,r.evidence_hash,r.decision,r.expires_at,r.owner_id AS recommendation_owner FROM agent_optimization_policies p JOIN agent_recommendations r ON r.id=p.recommendation_id WHERE p.owner_id=$1 AND p.category=$2 AND p.enabled`,
    [owner, category],
  );
  for (const step of graph.steps) {
    const original = step.config as Record<string, unknown> & {
      agent?: StepAgentConfig;
      delegation?: { enabled?: boolean };
    };
    if (original.agent?.provider || original.model || original.codex_model) continue;
    const p = policies.find((p) => p.step_type === step.type);
    if (!p) continue;
    const provenance: Record<string, unknown> = {
      policy_id: p.id,
      recommendation_id: p.recommendation_id,
      recommendation_version: p.version,
      evidence_hash: p.evidence_hash,
      category,
      applied: false,
    };
    try {
      if (
        p.recommendation_owner !== owner ||
        p.version !== RECOMMENDATION_VERSION ||
        new Date(p.expires_at).getTime() <= Date.now() ||
        p.decision.status !== "RECOMMENDED" ||
        p.decision.plan?.length !== 1
      )
        throw new Error("Recommendation is stale or unsupported");
      if (p.decision.cost_availability !== "Known" && !p.allow_unknown_cost)
        throw new Error("Unknown cost not authorized by optimization policy");
      const agent = p.decision.plan[0];
      if (!providerEnabled(agent.provider))
        throw new Error(`Provider ${agent.provider} is disabled in Settings`);
      // Sensitive (HIGH_RISK) work is only routed to providers with an approved security policy.
      if (complexity === "HIGH_RISK" && !config.routing.sensitiveProviders.includes(agent.provider))
        throw new Error(
          `HIGH_RISK task: provider ${agent.provider} has no approved security policy for sensitive work (allowed: ${config.routing.sensitiveProviders.join(", ")})`,
        );
      const cfg = {
        ...original,
        agent: {
          ...original.agent,
          provider: agent.provider,
          model: agent.model ?? null,
          reasoning_effort: agent.reasoning_effort ?? null,
        },
      };
      const effective = resolveStepAgent(
        { agent_provider: "claude", profile, agent_configuration: agentConfiguration },
        { ...step, config: cfg },
      )!;
      if (
        (!agent.provider || !providerCapabilities(agent.provider).guarantees.delegation) &&
        original.delegation?.enabled
      )
        throw new Error("Delegation permission cannot be enforced by target provider");
      const ready = await handoffReadiness(effective);
      if (!ready.ok) throw new Error(ready.error ?? "Provider unavailable");
      provenance.applied = true;
      provenance.provider = effective.provider;
      provenance.model = effective.model;
      step.config = cfg;
    } catch (error) {
      provenance.reason = (error as Error).message;
    }
    step.config.optimization_decision = provenance;
    decisions.push({ step_key: step.key, ...provenance });
  }
  await applyAdaptiveRouting(
    db,
    owner,
    graph,
    decisions,
    profile,
    complexity,
    defaultProvider,
    workflow,
    agentConfiguration,
  );
  return { graph, decisions };
}

/**
 * Evaluation-driven routing (routing/adaptive.ts) for the agent steps nothing else configured: no explicit agent or
 * model, no benchmark-recommendation policy applied. Opt-in per owner; every considered step records its decision.
 */
async function applyAdaptiveRouting(
  db: Db,
  owner: number,
  graph: WorkflowSpec,
  decisions: Array<Record<string, unknown>>,
  profile: "MICRO" | "FAST" | "STANDARD" | "DEEP",
  complexity: string | null,
  defaultProvider: string | null,
  workflow: string,
  agentConfiguration?: AgentConfiguration,
) {
  const { routingPreference, cachedOutcomes, eligibility, decideRoute } =
    await import("../routing/adaptive.ts");
  const pref = await routingPreference(owner, db);
  if (!pref?.enabled) return;
  const steps = graph.steps.filter((step) => {
    const c = step.config as Record<string, unknown> & { agent?: StepAgentConfig };
    return (
      ["agent", "coding_agent"].includes(step.type) &&
      !c.agent?.provider &&
      // An explicit step model or effort is a choice routing must not replace.
      !c.agent?.model &&
      !c.agent?.reasoning_effort &&
      !c.model &&
      !c.codex_model &&
      // A step a benchmark-recommendation policy already decided on (applied or not) keeps that single decision.
      !c.optimization_decision
    );
  });
  if (!steps.length) return;
  // Read outside the run-start transaction (pool, cached): it is a heavy read-only aggregate.
  const samples = await cachedOutcomes();
  const { isolationEnforced } = await import("../agent/isolation.ts");
  const enforce = config.isolation.mode === "enforce";
  const isolation = { enforce, runtimeAvailable: enforce ? await isolationEnforced() : false };
  for (const step of steps) {
    const { eligible, excluded } = eligibility({ stepType: step.type, complexity, isolation });
    const current = resolveStepAgent(
      {
        agent_provider: defaultProvider ?? undefined,
        profile,
        agent_configuration: agentConfiguration,
      },
      step,
    );
    const fallback = current?.provider ?? "claude";
    const decision = decideRoute({
      samples,
      stepType: step.type,
      workflow,
      defaultProvider: fallback,
      // The exact configuration the step would otherwise run with (provider, configured model and effort).
      incumbent: {
        provider: fallback,
        model: current?.model ?? null,
        effort: current?.reasoning_effort ?? null,
      },
      eligible,
      excluded,
      preference: pref.preference,
      minSamples: pref.min_samples,
    });
    const original = step.config as Record<string, unknown> & {
      agent?: StepAgentConfig;
      delegation?: { enabled?: boolean };
    };
    if (decision.applied && decision.chosen) {
      try {
        const chosenProvider = parseAgentProvider(decision.chosen.provider);
        if (
          (!chosenProvider || !providerCapabilities(chosenProvider).guarantees.delegation) &&
          original.delegation?.enabled
        )
          throw new Error("Delegation permission cannot be enforced by target provider");
        const cfg = {
          ...original,
          agent: {
            ...original.agent,
            provider: decision.chosen.provider as StepAgentConfig["provider"],
            model: decision.chosen.model ?? null,
            reasoning_effort: decision.chosen.reasoning_effort ?? null,
          },
        };
        const effective = resolveStepAgent(
          { agent_provider: fallback, profile, agent_configuration: agentConfiguration },
          { ...step, config: cfg },
        )!;
        const ready = await handoffReadiness(effective);
        if (!ready.ok) throw new Error(ready.error ?? "Provider unavailable");
        step.config = cfg;
      } catch (error) {
        decision.applied = false;
        decision.reason = `chosen configuration not usable now (${(error as Error).message}); default kept`;
      }
    }
    step.config.routing_decision = decision as unknown as Record<string, unknown>;
    decisions.push({ step_key: step.key, ...decision });
  }
}
