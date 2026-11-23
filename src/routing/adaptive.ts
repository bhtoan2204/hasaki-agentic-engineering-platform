import { pool, q, one, type Db } from "../db/pool.ts";
import { config } from "../config.ts";
import { HttpError } from "../http/error.ts";
import { AGENT_PROVIDERS, providerEnabled, type AgentProvider } from "../agent/provider.ts";
import { guaranteeCheck } from "../agent/providerCapabilities.ts";
import { isModelBlocked } from "../agent/modelPolicy.ts";
import { wilson } from "../eval/scoring.ts";

/**
 * Evaluation-driven routing: rank the provider/model/effort configurations that are ELIGIBLE for a step (deterministic
 * filters first: enabled, required execution guarantees, model policy, sensitive-work policy, health) by measured
 * PRODUCTION outcomes of the same step type (and workflow, when there is enough of it):
 *   verified = the platform's own verification passed (coding) / the step completed (analysis) — never the agent's word;
 *   reviewed = an independent verifier of the run passed; plus latency, tokens, known cost, retries, human rework.
 * Evaluation (benchmark) runs are excluded: synthetic results never stand in for production reliability. Too little
 * evidence → no change (existing defaults) and an explicit low-confidence decision. Explicit choices are never touched.
 */

export const ROUTING_VERSION = "adaptive-routing-1";
export type Preference = "quality_first" | "balanced" | "cost_first";

export interface OutcomeSample {
  provider: string;
  model: string | null;
  effort: string | null;
  workflow: string;
  stepType: string;
  verified: boolean;
  reviewed: boolean | null;
  latencyMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  costKnown: boolean;
  retries: number;
  human: boolean;
  failure: string | null;
  finishedAt: Date;
  runId: number;
}

export interface CandidateScore {
  provider: string;
  model: string | null;
  effort: string | null;
  n: number;
  verified_rate: number;
  verified_low: number;
  review_pass_rate: number | null;
  median_latency_ms: number | null;
  median_tokens: number | null;
  mean_known_cost_usd: number | null;
  cost_coverage: number;
  retry_rate: number;
  human_rate: number;
  top_failures: string[];
  score: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const keyOf = (s: { provider: string; model: string | null; effort: string | null }) =>
  `${s.provider}|${s.model ?? ""}|${s.effort ?? ""}`;

/** Production outcomes of finished agent/coding attempts (current attempt of each step generation). */
let cached: { at: number; key: string; samples: OutcomeSample[] } | null = null;
/** loadOutcomes with a short in-process cache (run starts must not each scan the telemetry view). */
export async function cachedOutcomes(ttlMs = 5 * 60_000) {
  if (cached && Date.now() - cached.at < ttlMs && cached.key === "all") return cached.samples;
  const samples = await loadOutcomes({});
  cached = { at: Date.now(), key: "all", samples };
  return samples;
}
export function clearOutcomeCache() {
  cached = null;
}

export async function loadOutcomes(
  opts: { stepType?: string; before?: Date; sinceDays?: number },
  db: Db = pool,
): Promise<OutcomeSample[]> {
  const rows = await q<{
    provider: string | null;
    model: string | null;
    effort: string | null;
    workflow: string;
    step_type: string;
    status: string;
    verified: boolean | null;
    reviewed: boolean | null;
    wall_ms: string | null;
    tokens: string | null;
    cost: string | null;
    cost_availability: string | null;
    retries: number | null;
    human: boolean;
    failure: string | null;
    finished_at: Date;
    run_id: number;
  }>(
    db,
    `SELECT COALESCE(a.agent_provider, t.provider) AS provider,
            COALESCE(a.agent_model, t.model) AS model,
            a.effective_agent->>'reasoning_effort' AS effort,
            r.definition_key AS workflow, s.type AS step_type, a.status,
            CASE WHEN s.type = 'coding_agent' THEN (a.output->'verification'->>'passed')::boolean
                 ELSE a.status = 'COMPLETED' END AS verified,
            (SELECT bool_or(v.output->>'verdict' = 'PASS') FROM workflow_steps v
              WHERE v.run_id = r.id AND (v.config->>'independent')::boolean IS TRUE AND v.status = 'COMPLETED') AS reviewed,
            t.wall_duration_ms AS wall_ms,
            COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0) AS tokens,
            t.reported_cost_usd AS cost, t.cost_availability,
            t.retries, s.generation > 1 AS human,
            t.normalized_failure_category AS failure,
            a.finished_at, r.id AS run_id
       FROM workflow_step_attempts a
       JOIN workflow_steps s ON s.id = a.step_id
       JOIN workflow_runs r ON r.id = a.run_id
       LEFT JOIN execution_attempt_telemetry t ON t.attempt_id = a.id
      WHERE s.type IN ('agent', 'coding_agent')
        -- An independent verifier's COMPLETED is not a verified outcome of the work it judged: not a routing sample.
        AND (s.config->>'independent') IS DISTINCT FROM 'true'
        AND a.status IN ('COMPLETED', 'FAILED') AND a.finished_at IS NOT NULL
        AND a.number = (SELECT max(x.number) FROM workflow_step_attempts x WHERE x.step_id = a.step_id AND x.generation = a.generation)
        AND ($1::text IS NULL OR s.type = $1)
        AND ($2::timestamptz IS NULL OR a.finished_at < $2)
        AND a.finished_at > now() - make_interval(days => $3)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)
      ORDER BY a.finished_at DESC LIMIT 20000`,
    [opts.stepType ?? null, opts.before ?? null, opts.sinceDays ?? 180],
  );
  return rows
    .filter((r) => r.provider)
    .map((r) => ({
      provider: r.provider!,
      model: r.model,
      effort: r.effort,
      workflow: r.workflow,
      stepType: r.step_type,
      verified: r.verified === true,
      reviewed: r.reviewed,
      latencyMs: r.wall_ms == null ? null : Number(r.wall_ms),
      tokens: r.tokens == null ? null : Number(r.tokens),
      costUsd: r.cost == null ? null : Number(r.cost),
      // Unknown cost is not zero cost.
      // Only fully reported cost is known: a partially priced attempt would look cheaper than it was.
      costKnown: r.cost != null && r.cost_availability === "reported",
      retries: Number(r.retries ?? 0),
      human: r.human,
      failure: r.failure,
      finishedAt: new Date(r.finished_at),
      runId: Number(r.run_id),
    }));
}

/** Score each configuration. Quality uses the Wilson lower bound (a few lucky runs cannot win). */
export function scoreCandidates(
  samples: OutcomeSample[],
  preference: Preference,
): CandidateScore[] {
  const groups = new Map<string, OutcomeSample[]>();
  for (const s of samples) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), s]);
  const scored = [...groups.values()].map((g) => {
    const n = g.length;
    const ok = g.filter((s) => s.verified).length;
    const reviewed = g.filter((s) => s.reviewed != null);
    const known = g.filter((s) => s.costKnown);
    const failures = new Map<string, number>();
    for (const s of g)
      if (!s.verified && s.failure) failures.set(s.failure, (failures.get(s.failure) ?? 0) + 1);
    return {
      provider: g[0].provider,
      model: g[0].model,
      effort: g[0].effort,
      n,
      verified_rate: ok / n,
      verified_low: wilson(ok, n)?.low ?? 0,
      review_pass_rate: reviewed.length
        ? reviewed.filter((s) => s.reviewed).length / reviewed.length
        : null,
      median_latency_ms: median(g.flatMap((s) => (s.latencyMs == null ? [] : [s.latencyMs]))),
      median_tokens: median(g.flatMap((s) => (s.tokens == null ? [] : [s.tokens]))),
      mean_known_cost_usd: known.length
        ? known.reduce((a, s) => a + (s.costUsd ?? 0), 0) / known.length
        : null,
      cost_coverage: known.length / n,
      retry_rate: g.filter((s) => s.retries > 0).length / n,
      human_rate: g.filter((s) => s.human).length / n,
      top_failures: [...failures.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([f]) => f),
      score: 0,
    };
  });
  const maxLatency = Math.max(1, ...scored.map((c) => c.median_latency_ms ?? 0));
  const maxTokens = Math.max(1, ...scored.map((c) => c.median_tokens ?? 0));
  const maxCost = Math.max(1e-9, ...scored.map((c) => c.mean_known_cost_usd ?? 0));
  for (const c of scored) {
    const quality = c.verified_low - 0.1 * c.human_rate - 0.05 * c.retry_rate;
    const latency = (c.median_latency_ms ?? maxLatency) / maxLatency;
    const tokens = (c.median_tokens ?? maxTokens) / maxTokens;
    // Unknown cost ranks as the most expensive, never as free.
    const cost =
      c.cost_coverage >= 0.8 && c.mean_known_cost_usd != null ? c.mean_known_cost_usd / maxCost : 1;
    c.score =
      preference === "quality_first"
        ? quality - 0.01 * latency
        : preference === "cost_first"
          ? quality - 0.25 * cost - 0.05 * tokens
          : quality - 0.08 * latency - 0.05 * tokens - 0.08 * cost;
  }
  return scored.sort((a, b) => b.score - a.score);
}

export interface RoutingDecision {
  version: string;
  source: "adaptive_routing";
  applied: boolean;
  preference: Preference;
  step_type: string;
  workflow: string;
  scope: "workflow" | "step_type";
  eligible: string[];
  excluded: Array<{ provider: string; reason: string }>;
  chosen: { provider: string; model: string | null; reasoning_effort: string | null } | null;
  default_provider: string;
  confidence: "high" | "medium" | "low" | "insufficient";
  evidence: CandidateScore[];
  estimate: {
    verified_rate: number | null;
    median_latency_ms: number | null;
    mean_known_cost_usd: number | null;
  } | null;
  reason: string;
}

/** Deterministic eligibility: enabled, execution guarantees for the step's mode, sensitive-work policy. */
export function eligibility(input: {
  stepType: string;
  complexity: string | null;
  isolation: { enforce: boolean; runtimeAvailable: boolean };
}) {
  const mode = input.stepType === "coding_agent" ? "coding" : "analysis";
  const eligible: string[] = [];
  const excluded: Array<{ provider: string; reason: string }> = [];
  for (const p of AGENT_PROVIDERS) {
    if (!providerEnabled(p)) excluded.push({ provider: p, reason: "disabled in Settings" });
    else if (input.complexity === "HIGH_RISK" && !config.routing.sensitiveProviders.includes(p))
      excluded.push({ provider: p, reason: "no approved security policy for HIGH_RISK work" });
    else {
      const g = guaranteeCheck(p as AgentProvider, mode, null, input.isolation);
      if (input.isolation.enforce && g.unmet.length)
        excluded.push({
          provider: p,
          reason: `missing required guarantees: ${g.unmet.join(", ")}`,
        });
      else eligible.push(p);
    }
  }
  return { eligible, excluded };
}

/**
 * The routing decision for one step. Workflow-specific evidence is used when it is sufficient for at least two
 * configurations, otherwise evidence of the same step type across workflows. A winner must clear the minimum sample
 * size and beat the default configuration's lower bound; ties or thin data keep the default.
 */
export function decideRoute(input: {
  samples: OutcomeSample[];
  stepType: string;
  workflow: string;
  defaultProvider: string;
  eligible: string[];
  excluded: Array<{ provider: string; reason: string }>;
  preference: Preference;
  minSamples: number;
}): RoutingDecision {
  const usable = (xs: OutcomeSample[]) =>
    xs.filter(
      (s) =>
        s.stepType === input.stepType &&
        input.eligible.includes(s.provider) &&
        !(s.model && isModelBlocked(s.model)),
    );
  const wf = usable(input.samples.filter((s) => s.workflow === input.workflow));
  const enough = (xs: OutcomeSample[]) =>
    scoreCandidates(xs, input.preference).filter((c) => c.n >= input.minSamples).length >= 2;
  const scope: RoutingDecision["scope"] = enough(wf) ? "workflow" : "step_type";
  const pool_ = scope === "workflow" ? wf : usable(input.samples);
  const ranked = scoreCandidates(pool_, input.preference);
  const qualified = ranked.filter((c) => c.n >= input.minSamples);
  const base = {
    version: ROUTING_VERSION,
    source: "adaptive_routing" as const,
    preference: input.preference,
    step_type: input.stepType,
    workflow: input.workflow,
    scope,
    eligible: input.eligible,
    excluded: input.excluded,
    default_provider: input.defaultProvider,
    evidence: ranked.slice(0, 6),
  };
  if (qualified.length < 2)
    return {
      ...base,
      applied: false,
      chosen: null,
      confidence: "insufficient",
      estimate: null,
      reason: `insufficient evidence: ${qualified.length} configuration(s) with ≥${input.minSamples} production samples; existing defaults kept`,
    };
  const best = qualified[0];
  const incumbent = qualified.find((c) => c.provider === input.defaultProvider);
  const same = !!incumbent && keyOf(best) === keyOf(incumbent);
  // Never trade verified quality away: the winner's lower bound must stay within 2 points of the incumbent's.
  const qualityOk = !incumbent || best.verified_low >= incumbent.verified_low - 0.02;
  // Act only on a measured difference: clearly better quality, or equal quality and clearly cheaper/faster.
  // Without a measured incumbent there is nothing to beat: the winner must at least clear the pooled verified rate of
  // all measured configurations of this scope (never a switch to a configuration that is merely "least bad").
  const pooled = pool_.length ? pool_.filter((x) => x.verified).length / pool_.length : 1;
  const qualityGain = incumbent
    ? best.verified_low > incumbent.verified_rate
    : best.verified_low >= pooled;
  const knownCost = (c: CandidateScore) => (c.cost_coverage >= 0.8 ? c.mean_known_cost_usd : null);
  const cheaper =
    !!incumbent &&
    knownCost(best) != null &&
    knownCost(incumbent) != null &&
    knownCost(best)! <= 0.8 * knownCost(incumbent)!;
  const faster =
    !!incumbent &&
    best.median_latency_ms != null &&
    incumbent.median_latency_ms != null &&
    best.median_latency_ms <= 0.8 * incumbent.median_latency_ms;
  const efficiencyGain = input.preference !== "quality_first" && qualityOk && (cheaper || faster);
  const margin = best.score - (qualified[1]?.score ?? 0);
  const confidence: RoutingDecision["confidence"] =
    best.n >= input.minSamples * 3 && margin > 0.05 ? "high" : margin > 0.02 ? "medium" : "low";
  const apply = !same && qualityOk && (qualityGain || efficiencyGain);
  return {
    ...base,
    applied: apply,
    chosen: apply
      ? { provider: best.provider, model: best.model, reasoning_effort: best.effort }
      : null,
    confidence,
    estimate: {
      verified_rate: best.verified_rate,
      median_latency_ms: best.median_latency_ms,
      mean_known_cost_usd: best.mean_known_cost_usd,
    },
    reason: same
      ? "the default configuration is already the best measured one"
      : !qualityOk
        ? "the best-scoring alternative would lower verified quality; default kept"
        : !apply
          ? "the measured difference is not significant (quality within the confidence interval, no ≥20% cost or latency gain); default kept"
          : `${qualityGain ? "higher verified quality" : cheaper ? "≥20% lower known cost at equal quality" : "≥20% lower latency at equal quality"}: ${best.provider}${best.model ? `/${best.model}` : ""} ranks first for ${input.preference} on ${best.n} ${scope === "workflow" ? input.workflow : input.stepType} samples`,
  };
}

export async function routingPreference(ownerId: number, db: Db = pool) {
  return one<{ enabled: boolean; preference: Preference; min_samples: number }>(
    db,
    "SELECT enabled, preference, min_samples FROM adaptive_routing_preferences WHERE owner_id=$1",
    [ownerId],
  );
}
export async function saveRoutingPreference(ownerId: number, input: Record<string, unknown>) {
  const preference = String(input.preference ?? "balanced");
  if (!["quality_first", "balanced", "cost_first"].includes(preference))
    throw new HttpError(400, "preference must be quality_first, balanced or cost_first");
  const min = input.min_samples == null ? 10 : Number(input.min_samples);
  if (!Number.isInteger(min) || min < 3)
    throw new HttpError(400, "min_samples must be an integer ≥ 3");
  const row = await one(
    pool,
    `INSERT INTO adaptive_routing_preferences(owner_id,enabled,preference,min_samples) VALUES($1,$2,$3,$4)
     ON CONFLICT(owner_id) DO UPDATE SET enabled=$2,preference=$3,min_samples=$4,updated_at=now() RETURNING *`,
    [ownerId, input.enabled === true, preference, min],
  );
  await q(
    pool,
    "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'routing.preference.save','routing',$2,$3)",
    [
      ownerId,
      String(ownerId),
      JSON.stringify({ enabled: input.enabled === true, preference, min_samples: min }),
    ],
  );
  return row;
}

// ---------------------------------------------------------------- offline replay (A/B against the defaults)

/**
 * Time-split replay without leakage: the policy is learned only from outcomes BEFORE the cutoff and judged on outcomes
 * AFTER it. A counterfactual is observable only where the test sample used the configuration the policy would have
 * chosen, so the report compares the observed outcomes of "policy-agreeing" test samples with those of the default
 * configuration, with Wilson intervals — and claims an improvement only when the intervals do not overlap.
 */
export function replayEvaluation(input: {
  samples: OutcomeSample[];
  cutoff: Date;
  defaults: Record<string, string>;
  eligible: string[];
  preference: Preference;
  minSamples: number;
}) {
  const train = input.samples.filter((s) => s.finishedAt < input.cutoff);
  const test = input.samples.filter((s) => s.finishedAt >= input.cutoff);
  const report: Record<string, unknown>[] = [];
  for (const stepType of [...new Set(test.map((s) => s.stepType))]) {
    const decision = decideRoute({
      samples: train,
      stepType,
      workflow: "",
      defaultProvider: input.defaults[stepType] ?? "claude",
      eligible: input.eligible,
      excluded: [],
      preference: input.preference,
      minSamples: input.minSamples,
    });
    const inStep = test.filter((s) => s.stepType === stepType);
    const summarize = (xs: OutcomeSample[]) => {
      const ok = xs.filter((s) => s.verified).length;
      const known = xs.filter((s) => s.costKnown);
      return {
        n: xs.length,
        verified_rate: xs.length ? ok / xs.length : null,
        verified_ci: wilson(ok, xs.length),
        median_latency_ms: median(xs.flatMap((s) => (s.latencyMs == null ? [] : [s.latencyMs]))),
        mean_known_cost_usd: known.length
          ? known.reduce((a, s) => a + (s.costUsd ?? 0), 0) / known.length
          : null,
        cost_coverage: xs.length ? known.length / xs.length : 0,
      };
    };
    const defaultArm = summarize(
      inStep.filter((s) => s.provider === (input.defaults[stepType] ?? "claude")),
    );
    const chosen = decision.chosen;
    const policyArm = chosen
      ? summarize(
          inStep.filter(
            (s) =>
              keyOf(s) ===
              keyOf({
                provider: chosen.provider,
                model: chosen.model,
                effort: chosen.reasoning_effort,
              }),
          ),
        )
      : defaultArm;
    const improved =
      !!chosen &&
      !!policyArm.verified_ci &&
      !!defaultArm.verified_ci &&
      policyArm.verified_ci.low > defaultArm.verified_ci.high;
    const worse =
      !!chosen &&
      !!policyArm.verified_ci &&
      !!defaultArm.verified_ci &&
      policyArm.verified_ci.high < defaultArm.verified_ci.low;
    report.push({
      step_type: stepType,
      train_samples: train.filter((s) => s.stepType === stepType).length,
      test_samples: inStep.length,
      decision: {
        applied: decision.applied,
        chosen,
        confidence: decision.confidence,
        reason: decision.reason,
      },
      default_arm: defaultArm,
      policy_arm: policyArm,
      // Observational, not a controlled experiment: configurations were historically chosen per task, so an
      // "improvement" is an association on the samples that happened to use the chosen configuration.
      verdict: !chosen
        ? "NO_CHANGE"
        : improved
          ? "IMPROVED_OBSERVED"
          : worse
            ? "WORSE_OBSERVED"
            : "NOT_SIGNIFICANT",
      caveat:
        "observational replay: outcomes of samples that used the chosen configuration vs the default provider's; task mix is not controlled",
    });
  }
  return {
    version: ROUTING_VERSION,
    cutoff: input.cutoff.toISOString(),
    preference: input.preference,
    results: report,
  };
}
