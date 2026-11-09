import { z } from "zod";
export const dimensions = [
  "functional",
  "regression",
  "requirements",
  "code_quality",
  "reliability",
  "efficiency",
] as const;
export const ScoringSchema = z.object({
  version: z.literal("objective-v1"),
  weights: z
    .object({
      functional: z.number().nonnegative(),
      regression: z.number().nonnegative(),
      requirements: z.number().nonnegative(),
      code_quality: z.number().nonnegative(),
      reliability: z.number().nonnegative(),
      efficiency: z.number().nonnegative(),
    })
    .refine(
      (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9,
      "Weights must sum to one",
    ),
});
export const defaultScoring = ScoringSchema.parse({
  version: "objective-v1",
  weights: {
    functional: 0.4,
    regression: 0.2,
    requirements: 0.15,
    code_quality: 0.1,
    reliability: 0.1,
    efficiency: 0.05,
  },
});
export interface Evidence {
  environment: boolean;
  authorized_changes: boolean | null;
  side_effects_blocked: boolean | null;
  security: boolean | null;
  syntax: boolean | null;
  regression_failed: number;
  required_passed: number;
  required_failed: number;
  hidden_passed: number;
  hidden_failed: number;
  expected_passed: number;
  expected_total: number;
  clarification_required: boolean;
  clarification_passed: boolean;
  duration_ms: number;
  runtime_budget_ms: number;
  retries: number;
  human_interventions: number;
  repository_correct: boolean | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  failure_class: string | null;
  details: Record<string, unknown>;
}
export function scoreEvidence(e: Evidence, scoring = defaultScoring) {
  ScoringSchema.parse(scoring);
  for (const key of [
    "cost_usd",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "duration_ms",
  ] as const) {
    const value = e[key];
    if (
      value !== null &&
      (!Number.isFinite(value) ||
        value < 0 ||
        (key.includes("tokens") && !Number.isInteger(value)))
    )
      throw new Error(`Invalid observed metric: ${key}`);
  }
  const hard_gates = {
    execution: !e.failure_class,
    environment: e.environment,
    authorized_changes: e.authorized_changes,
    external_side_effects: e.side_effects_blocked,
    security: e.security,
    behavior:
      e.expected_total > 0 &&
      e.expected_passed === e.expected_total &&
      e.required_failed === 0 &&
      e.hidden_failed === 0 &&
      e.syntax,
    clarification: !e.clarification_required || e.clarification_passed,
  };
  const values = {
    functional: e.expected_total ? e.expected_passed / e.expected_total : 0,
    regression: e.regression_failed === 0 ? 1 : 0,
    requirements: e.expected_total ? e.expected_passed / e.expected_total : 0,
    code_quality: e.syntax && e.security && e.authorized_changes ? 1 : 0,
    reliability:
      (!e.clarification_required || e.clarification_passed) && !e.failure_class
        ? 1
        : 0,
    efficiency: e.duration_ms <= e.runtime_budget_ms ? 1 : 0,
  };
  const score =
    Math.round(
      dimensions.reduce(
        (sum, key) => sum + values[key] * scoring.weights[key] * 100,
        0,
      ) * 100,
    ) / 100;
  const gates = Object.values(hard_gates).every(Boolean);
  return {
    hard_gates,
    hard_gates_passed: gates,
    quality_score: score,
    dimensions: Object.fromEntries(
      dimensions.map((key) => [
        key,
        {
          value: values[key],
          weight: scoring.weights[key],
          evidence:
            key === "efficiency"
              ? "Measured duration versus frozen time budget; cost/tokens are reported separately"
              : `Objective ${key} assertions; no LLM judge`,
        },
      ]),
    ),
    verdict:
      e.failure_class === "infrastructure" || !e.environment
        ? "BLOCKED"
        : gates
          ? "PASS"
          : "FAIL",
  };
}
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const quantile = (xs: number[], p: number) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)]
    : null;
export function wilson(success: number, n: number) {
  if (!n) return null;
  const z = 1.96,
    p = success / n,
    d = 1 + (z * z) / n,
    c = (p + (z * z) / (2 * n)) / d,
    h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return {
    low: Math.max(0, c - h),
    high: Math.min(1, c + h),
    method: "Wilson 95%",
    n,
  };
}
export interface ResultLike {
  scenario: string;
  status: string;
  correct: boolean | null;
  regression: boolean | null;
  hard_gates_passed: boolean | null;
  quality_score: number | string | null;
  data: any;
  cost_usd: number | string | null;
  tokens: number | string | null;
  wall_s: number | null;
  repairs: number;
  human_gates: number;
}
const sd = (xs: number[]) =>
  xs.length > 1
    ? Math.sqrt(
      xs.reduce((s, x) => s + (x - (mean(xs) ?? 0)) ** 2, 0) /
      (xs.length - 1),
    )
    : null;
export function aggregateResults(rows: ResultLike[], expected: number) {
  const completed = rows.filter(
    (r) => r.correct !== null && r.status !== "BLOCKED",
  );
  const successes = completed.filter((r) => r.correct === true).length;
  const evidence = completed
    .map((r) => r.data?.evidence)
    .filter(Boolean) as Evidence[];
  const nums = (key: keyof Evidence) =>
    evidence
      .map((e) => e[key])
      .filter(
        (x): x is number =>
          typeof x === "number" && Number.isFinite(x) && x >= 0,
      );
  const scores = completed
    .map((r) => Number(r.quality_score))
    .filter(
      (v, i) => completed[i].quality_score !== null && Number.isFinite(v),
    );
  const costs = nums("cost_usd");
  return {
    expected,
    recorded: rows.length,
    graded: completed.length,
    successes,
    success_rate: completed.length ? successes / completed.length : null,
    success_interval: wilson(successes, completed.length),
    hard_gate_pass_rate: completed.length
      ? completed.filter((r) => r.hard_gates_passed).length / completed.length
      : null,
    mean_score: mean(scores),
    score_sample_sd: sd(scores),
    duration_sample_sd_ms: sd(nums("duration_ms")),
    average_context_chars: mean(
      evidence
        .map((e) => Number(e.details.context_size))
        .filter(Number.isFinite),
    ),
    first_correct_file_median_ms: quantile(
      evidence
        .map((e) => e.details.timings as Record<string, unknown>)
        .filter(Boolean)
        .map((t) => t.first_correct_file_ms)
        .filter((x): x is number => typeof x === "number"),
      0.5,
    ),
    median_score: quantile(scores, 0.5),
    median_duration_ms: quantile(nums("duration_ms"), 0.5),
    p95_duration_ms: quantile(nums("duration_ms"), 0.95),
    cost_per_success:
      costs.length === completed.length && successes > 0
        ? costs.reduce((a, b) => a + b, 0) / successes
        : null,
    cost_known: costs.length,
    average_input_tokens: mean(nums("input_tokens")),
    average_output_tokens: mean(nums("output_tokens")),
    token_samples: nums("input_tokens").length,
    retry_rate: completed.length
      ? completed.filter((r) => r.repairs > 0).length / completed.length
      : null,
    human_intervention_rate: completed.length
      ? completed.filter((r) => r.human_gates > 0).length / completed.length
      : null,
    regression_rate: completed.length
      ? completed.filter((r) => r.regression === true).length / completed.length
      : null,
    repository_accuracy:
      nums("duration_ms").length &&
        evidence.some((e) => typeof e.repository_correct === "boolean")
        ? evidence.filter((e) => e.repository_correct === true).length /
        evidence.filter((e) => typeof e.repository_correct === "boolean")
          .length
        : null,
    blocked: rows.filter((r) => r.status === "BLOCKED").length,
  };
}
export const PolicySchema = z.object({
  minimum_pairs: z.number().int().min(2).max(100).default(10),
  success_tolerance: z.number().min(0).max(1).default(0),
  latency_ratio: z.number().min(1).max(10).default(1.5),
  cost_ratio: z.number().min(1).max(10).default(1.5),
  minimum_repetitions: z.number().int().min(2).max(10).default(2),
});
export function compareResults(
  baseline: ResultLike[],
  candidate: ResultLike[],
  expected: number,
  critical: Set<string>,
  policy = PolicySchema.parse({}),
) {
  const a = aggregateResults(baseline, expected),
    b = aggregateResults(candidate, expected);
  const byKey = new Map(
    baseline.map((r) => [`${r.scenario}:${r.data?.repetition}`, r]),
  );
  const pairs = candidate.map((c) => ({
    task: c.scenario,
    repetition: c.data?.repetition,
    baseline: byKey.get(`${c.scenario}:${c.data?.repetition}`) ?? null,
    candidate: c,
  }));
  const warnings: string[] = [];
  let fail = false;
  for (const p of pairs) {
    if (!p.baseline) continue;
    if (
      (critical.has(p.task) && p.candidate.correct === false) ||
      (p.baseline.correct === true && p.candidate.correct === false)
    ) {
      fail = true;
      warnings.push(`Quality regression: ${p.task} repetition ${p.repetition}`);
    }
    if (
      p.candidate.data?.evidence?.security === false ||
      p.candidate.data?.evidence?.authorized_changes === false
    ) {
      fail = true;
      warnings.push(`Critical security/authorization failure: ${p.task}`);
    }
  }
  if (
    a.success_rate !== null &&
    b.success_rate !== null &&
    b.success_rate < a.success_rate - policy.success_tolerance
  ) {
    fail = true;
    warnings.push("Success rate below permitted tolerance");
  }
  if (
    a.median_duration_ms &&
    b.median_duration_ms &&
    b.median_duration_ms > a.median_duration_ms * policy.latency_ratio
  )
    warnings.push("Latency regression exceeds configured ratio");
  if (
    a.cost_per_success !== null &&
    b.cost_per_success !== null &&
    b.cost_per_success > a.cost_per_success * policy.cost_ratio
  )
    warnings.push("Cost increase exceeds configured ratio");
  if (a.cost_known < a.graded || b.cost_known < b.graded)
    warnings.push(
      "Cost comparison is unknown for runs without actual provider usage",
    );
  const reps = new Map<string, Set<number>>();
  for (const p of pairs) {
    if (p.baseline && p.candidate.correct !== null) {
      const set = reps.get(p.task) ?? new Set();
      set.add(p.repetition);
      reps.set(p.task, set);
    }
  }
  const incomplete =
    baseline.length !== expected ||
    candidate.length !== expected ||
    pairs.some((p) => !p.baseline) ||
    [...reps.values()].some((s) => s.size < policy.minimum_repetitions) ||
    pairs.length < policy.minimum_pairs;
  const blocked = a.blocked > 0 || b.blocked > 0;
  return {
    verdict: fail
      ? "FAIL"
      : blocked
        ? "BLOCKED"
        : incomplete
          ? "INCONCLUSIVE"
          : "PASS",
    baseline: a,
    candidate: b,
    pairs,
    warnings,
    sample_note: `${pairs.length} task/repetition pairs; repeated tasks are not independent samples. No model superiority claim follows from fixture controls.`,
  };
}
