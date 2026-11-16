import { z } from "zod";
import { pool, q, one } from "../db/pool.ts";
import { wilson } from "./scoring.ts";
import { sha256 } from "./dataset.ts";
import {
  evaluationFilters,
  evaluationParams,
  evaluationSamplesCte,
  type EvaluationFilters,
} from "./analytics.ts";
import { handoffReadiness } from "../agent/handoff.ts";
import { resolveStepAgent } from "../agent/stepAgent.ts";
import { HttpError } from "../http/error.ts";
import type { Actor } from "../authz/access.ts";
export const RECOMMENDATION_VERSION = "controlled-evidence-v1";
export interface RecommendationSample {
  cohort: string;
  variant: string;
  category: string;
  plan: any[];
  samples: number;
  successes: number;
  tasks: number;
  evaluations: number;
  repetitions: number;
  stable_task_successes: number;
  median_ms: number | null;
  cost_known: number;
  cost_usd: number | null;
  evaluation_ids: number[];
  allowed_tools?: string[] | null;
}
/** Conservative clustered-sample thresholds; repeated tasks do not inflate independent task support. */
export function chooseRecommendation(rows: RecommendationSample[]) {
  const eligible = rows
    .filter((r) => r.samples >= 30 && r.tasks >= 10 && r.evaluations >= 2 && r.repetitions >= 2)
    .map((r) => ({ ...r, interval: wilson(r.stable_task_successes, r.tasks) }));
  // A distinct task succeeds only if every observed repetition passed the objective hard gates.
  const cohorts = new Map<string, typeof eligible>();
  for (const r of eligible) {
    const key = [r.cohort, r.variant, r.category].join("|");
    cohorts.set(key, [...(cohorts.get(key) ?? []), r]);
  }
  const conclusions = [];
  for (const group of cohorts.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.successes / b.samples - a.successes / a.samples);
    const [best, ...others] = group;
    if (best.interval && others.every((r) => r.interval && best.interval!.low > r.interval.high))
      conclusions.push(best);
  }
  if (conclusions.length !== 1)
    return {
      status: "INSUFFICIENT_EVIDENCE",
      label: "Insufficient evidence",
      confidence: "LOW",
      version: RECOMMENDATION_VERSION,
      reason:
        conclusions.length > 1
          ? "Multiple non-comparable cohorts; choose a specific cohort"
          : "Need at least two comparable routes, 30 trials, 10 distinct tasks, two completed evaluations, repeated cases and clearly separated uncertainty bounds",
      evidence: rows,
    };
  const best = conclusions[0];
  return {
    status: "RECOMMENDED",
    label: "Supported by controlled benchmark evidence",
    confidence: best.tasks >= 30 && best.evaluations >= 3 ? "HIGH" : "MEDIUM",
    version: RECOMMENDATION_VERSION,
    plan: best.plan,
    cohort: best.cohort,
    category: best.category,
    context_variant: best.variant,
    required_tools: best.allowed_tools ?? null,
    samples: best.samples,
    distinct_tasks: best.tasks,
    success_rate: best.successes / best.samples,
    median_ms: best.median_ms,
    cost_availability: !best.cost_known
      ? "Unknown"
      : best.cost_known < best.samples
        ? "Partial"
        : "Known",
    cost_per_verified_success:
      best.cost_known === best.samples && best.successes
        ? Number(best.cost_usd) / best.successes
        : null,
    interval: best.interval,
    evidence: rows,
  };
}
export async function recommendationEvidence(
  f: EvaluationFilters,
): Promise<RecommendationSample[]> {
  const rows = await q(
    pool,
    `${evaluationSamplesCte}
 ,trials AS (SELECT * FROM samples WHERE evidence_kind='controlled_live' AND workflow_status='COMPLETED' AND result_status IN('PASS','FAIL') AND correct IS NOT NULL AND configuration->'provider_sequence' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evaluation_case_runs pending LEFT JOIN eval_results er ON er.case_run_id=pending.id WHERE pending.evaluation_id=samples.evaluation_id AND (er.id IS NULL OR er.status='BLOCKED'))),
 task_outcomes AS (SELECT constraints_hash,context_variant,category,configuration->'provider_sequence' AS plan,task_id,bool_and(correct AND hard_gates_passed) AS stable FROM trials GROUP BY 1,2,3,4,5),
 grouped AS (
 SELECT constraints_hash AS cohort,context_variant AS variant,category,configuration->'provider_sequence' AS plan,
 count(*)::int AS samples,count(*) FILTER(WHERE correct AND hard_gates_passed)::int AS successes,count(DISTINCT task_id)::int AS tasks,count(DISTINCT evaluation_id)::int AS evaluations,
 count(DISTINCT repetition)::int AS repetitions,percentile_cont(0.5) WITHIN GROUP(ORDER BY COALESCE(completion_duration_ms,validator_duration_ms)) AS median_ms,
 count(cost_usd) FILTER(WHERE cost_known=phase_attempts)::int AS cost_known,sum(cost_usd)::double precision AS cost_usd,array_agg(DISTINCT evaluation_id ORDER BY evaluation_id) AS evaluation_ids
 , min((configuration->'allowed_tools')::text)::jsonb AS allowed_tools FROM trials GROUP BY 1,2,3,4)
 SELECT g.*,(SELECT count(*)::int FROM task_outcomes t WHERE t.constraints_hash=g.cohort AND t.context_variant=g.variant AND t.category=g.category AND t.plan=g.plan AND t.stable) AS stable_task_successes
 FROM grouped g ORDER BY 1,2,3 LIMIT 200`,
    evaluationParams({ ...f, all: false }),
  );
  return rows;
}
export const RecommendationRequest = z
  .object({
    category: z.string().trim().min(1).max(120),
    cohort: z.string().max(160).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    timezone: z.string().optional(),
  })
  .strict();
export async function createRecommendation(actor: Actor, raw: unknown) {
  const input = RecommendationRequest.parse(raw);
  const url = new URL("http://local/?category=" + encodeURIComponent(input.category));
  if (input.cohort) url.searchParams.set("cohort", input.cohort);
  for (const key of ["from", "to", "timezone"] as const)
    if (input[key]) url.searchParams.set(key, input[key]);
  const filters = evaluationFilters(actor, url);
  const evidence = await recommendationEvidence(filters);
  let decision: any = chooseRecommendation(evidence);
  if (decision.status === "RECOMMENDED") {
    const readiness = await Promise.all(
      decision.plan.map(async (agent: any) => {
        try {
          const a = resolveStepAgent(
            { agent_provider: agent.provider },
            {
              type: "coding_agent",
              config: {
                agent: { ...agent, allowed_tools: decision.required_tools },
              },
            },
          )!;
          return { provider: agent.provider, ...(await handoffReadiness(a)) };
        } catch (error) {
          return {
            provider: agent.provider,
            ok: false,
            error: (error as Error).message,
          };
        }
      }),
    );
    decision = { ...decision, availability: readiness };
    if (readiness.some((r) => !r.ok))
      decision = {
        ...decision,
        status: "UNAVAILABLE",
        label: "Evidence supports a route that is currently unavailable",
        confidence: "LOW",
      };
  }
  return one(
    pool,
    "INSERT INTO agent_recommendations(owner_id,version,category,cohort_hash,evidence_hash,filters,decision) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [
      actor.id,
      RECOMMENDATION_VERSION,
      input.category,
      decision.cohort ?? input.cohort ?? null,
      sha256(JSON.stringify(evidence)),
      JSON.stringify(filters),
      JSON.stringify(decision),
    ],
  );
}
export async function recommendationDetail(id: number, owner: number) {
  const row = await one(pool, "SELECT * FROM agent_recommendations WHERE id=$1 AND owner_id=$2", [
    id,
    owner,
  ]);
  if (!row) throw new HttpError(404, "Recommendation not found");
  return row;
}
