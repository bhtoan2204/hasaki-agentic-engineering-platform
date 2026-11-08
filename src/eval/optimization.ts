import { z } from "zod";
import { q, one, withTx, type Db } from "../db/pool.ts";
import { pool } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { RECOMMENDATION_VERSION, recommendationDetail } from "./recommendations.ts";
import { resolveStepAgent } from "../agent/stepAgent.ts";
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
  if (input.category !== rec.category) throw new HttpError(400, "Policy category must match recommendation evidence");
  if (
    input.enabled &&
    (rec.version !== RECOMMENDATION_VERSION ||
      rec.decision.status !== "RECOMMENDED" ||
      !["MEDIUM", "HIGH"].includes(rec.decision.confidence) ||
      rec.decision.plan?.length !== 1 ||
      new Date(rec.expires_at).getTime() <= Date.now())
  )
    throw new HttpError(409, "Only current, supported single-provider recommendations may influence future defaults");
  return withTx(async (c) => {
    const row = await one(
      c,
      `INSERT INTO agent_optimization_policies(owner_id,category,step_type,recommendation_id,enabled,allow_unknown_cost) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(owner_id,category,step_type) DO UPDATE SET recommendation_id=excluded.recommendation_id,enabled=excluded.enabled,allow_unknown_cost=excluded.allow_unknown_cost,updated_at=now() RETURNING *`,
      [owner, input.category, input.step_type, input.recommendation_id, input.enabled, input.allow_unknown_cost],
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
  return q(pool, "SELECT * FROM agent_optimization_policies WHERE owner_id=$1 ORDER BY id", [owner]);
}
/** New-run defaults only. Explicit run/step/model choices and all permission/verification settings remain authoritative. */
export async function applyOptimizationDefaults(
  db: Db,
  owner: number,
  spec: WorkflowSpec,
  inputs: Record<string, unknown>,
  explicitProvider: boolean,
  profile: "FAST" | "STANDARD" | "DEEP" = "STANDARD",
) {
  const category = typeof inputs.task_category === "string" ? inputs.task_category : null;
  const graph = structuredClone(spec);
  const decisions: any[] = [];
  if (!category || explicitProvider) return { graph, decisions };
  const policies = await q(
    db,
    `SELECT p.*,r.version,r.evidence_hash,r.decision,r.expires_at,r.owner_id AS recommendation_owner FROM agent_optimization_policies p JOIN agent_recommendations r ON r.id=p.recommendation_id WHERE p.owner_id=$1 AND p.category=$2 AND p.enabled`,
    [owner, category],
  );
  for (const step of graph.steps) {
    const original = step.config as Record<string, any>;
    if (original.agent?.provider || original.model || original.codex_model) continue;
    const p = policies.find((p) => p.step_type === step.type);
    if (!p) continue;
    const provenance: any = {
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
      const cfg = {
        ...original,
        agent: {
          ...original.agent,
          provider: agent.provider,
          model: agent.model ?? null,
          reasoning_effort: agent.reasoning_effort ?? null,
        },
      };
      const effective = resolveStepAgent({ agent_provider: "claude", profile }, { ...step, config: cfg })!;
      if (agent.provider !== "claude" && original.delegation?.enabled)
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
  return { graph, decisions };
}
