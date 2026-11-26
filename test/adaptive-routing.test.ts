import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRoute,
  differenceInterval,
  eligibility,
  replayEvaluation,
  scoreCandidates,
  type OutcomeSample,
} from "../src/routing/adaptive.ts";
import { config } from "../src/config.ts";

const T0 = new Date("2026-10-01T00:00:00Z").getTime();
let seq = 0;
/** n samples of one configuration with a given verified rate (deterministic: the first k succeed). */
function samples(
  provider: string,
  n: number,
  rate: number,
  over: Partial<OutcomeSample> = {},
  startDay = 0,
): OutcomeSample[] {
  const ok = Math.round(n * rate);
  return Array.from({ length: n }, (_, i) => ({
    provider,
    model: null,
    effort: null,
    workflow: "bug-investigation",
    stepType: "coding_agent",
    executed: true,
    verified: i < ok,
    reviewed: i < ok,
    latencyMs: 60_000,
    tokens: 50_000,
    costUsd: 1,
    costKnown: true,
    retries: 0,
    human: false,
    failure: i < ok ? null : "verification_failed",
    finishedAt: new Date(T0 + (startDay + i / n) * 86_400_000 + seq++),
    runId: seq,
    ...over,
  }));
}
const route = (s: OutcomeSample[], over: Partial<Parameters<typeof decideRoute>[0]> = {}) =>
  decideRoute({
    samples: s,
    stepType: "coding_agent",
    workflow: "bug-investigation",
    defaultProvider: "claude",
    eligible: ["claude", "codex", "copilot"],
    excluded: [],
    preference: "balanced",
    minSamples: 10,
    ...over,
  });

test("sparse evidence keeps the existing default and says so", () => {
  const d = route([...samples("claude", 4, 0.5), ...samples("codex", 5, 1)]);
  assert.equal(d.applied, false);
  assert.equal(d.confidence, "insufficient");
  assert.match(d.reason, /insufficient evidence/);
});

test("a configuration with clearly better verified outcomes is chosen, with its evidence and estimate", () => {
  const d = route([...samples("claude", 40, 0.55), ...samples("codex", 40, 0.95)]);
  assert.equal(d.applied, true);
  assert.equal(d.chosen!.provider, "codex");
  assert.equal(d.confidence, "high");
  assert.ok(d.evidence[0].n === 40 && d.evidence[0].verified_low > 0.8);
  assert.equal(d.estimate!.verified_rate, 0.95);
  // Reproducible: the same inputs give the same decision.
  assert.deepEqual(
    route([...samples("claude", 40, 0.55), ...samples("codex", 40, 0.95)]).chosen,
    d.chosen,
  );
});

test("cost-first never trades verified quality for price; unknown cost is not free", () => {
  const cheapButWorse = [
    ...samples("claude", 40, 0.9, { costUsd: 2 }),
    ...samples("copilot", 40, 0.6, { costUsd: 0.1 }),
  ];
  const d = route(cheapButWorse, { preference: "cost_first" });
  assert.notEqual(
    d.chosen?.provider,
    "copilot",
    "a lower verified rate is never bought with a lower price",
  );
  const unknown = scoreCandidates(
    [
      ...samples("claude", 30, 0.9, { costUsd: 1 }),
      ...samples("codex", 30, 0.9, { costUsd: null, costKnown: false }),
    ],
    "cost_first",
  );
  assert.equal(unknown[0].provider, "claude", "known cost beats unknown cost at equal quality");
  assert.equal(unknown.find((c) => c.provider === "codex")!.cost_coverage, 0);
});

test("ineligible providers are never chosen, whatever their history", () => {
  const d = route([...samples("claude", 40, 0.5), ...samples("cursor", 60, 1)], {
    eligible: ["claude", "codex"],
  });
  assert.notEqual(d.chosen?.provider, "cursor");
  const saved = { ...config.agent.enabledProviders };
  config.agent.enabledProviders = { ...saved, cursor: false };
  try {
    const e = eligibility({
      stepType: "coding_agent",
      complexity: "HIGH_RISK",
      isolation: { enforce: true, runtimeAvailable: true },
    });
    assert.ok(e.excluded.some((x) => x.provider === "cursor" && /disabled/.test(x.reason)));
    for (const p of e.eligible)
      assert.ok(config.routing.sensitiveProviders.includes(p), `${p} allowed for HIGH_RISK`);
    for (const x of e.excluded.filter((x) => x.provider !== "cursor"))
      assert.match(x.reason, /HIGH_RISK|guarantees/);
  } finally {
    config.agent.enabledProviders = saved;
  }
});

test("a negligible difference keeps the default (no claim without a measured improvement)", () => {
  const d = route([...samples("claude", 40, 0.9), ...samples("codex", 40, 0.925)]);
  assert.equal(d.applied, false);
});

test("workflow-specific evidence is preferred when sufficient, else the step type across workflows", () => {
  const generic = [
    ...samples("claude", 30, 0.6, { workflow: "other" }),
    ...samples("codex", 30, 0.95, { workflow: "other" }),
  ];
  assert.equal(route(generic).scope, "step_type");
  const specific = [...generic, ...samples("claude", 20, 0.95), ...samples("codex", 20, 0.5)];
  const d = route(specific);
  assert.equal(d.scope, "workflow");
  assert.notEqual(d.chosen?.provider, "codex", "workflow evidence overrides the generic trend");
});

test("offline replay: time-split (no leakage) A/B against the default reports IMPROVED only when significant", () => {
  const train = [...samples("claude", 60, 0.55, {}, 0), ...samples("codex", 60, 0.95, {}, 0)];
  const testSet = [...samples("claude", 60, 0.5, {}, 20), ...samples("codex", 60, 0.95, {}, 20)];
  const report = replayEvaluation({
    samples: [...train, ...testSet],
    cutoff: new Date(T0 + 10 * 86_400_000),
    defaults: { coding_agent: "claude" },
    eligible: ["claude", "codex"],
    preference: "balanced",
    minSamples: 10,
  });
  const r = report.results[0] as {
    train_samples: number;
    test_samples: number;
    verdict: string;
    policy_arm: { n: number };
    default_arm: { n: number };
  };
  assert.equal(r.train_samples, 120, "only pre-cutoff outcomes train the policy");
  assert.equal(r.test_samples, 120);
  assert.equal(r.verdict, "IMPROVED_OBSERVED");
  assert.match((report.results[0] as { caveat: string }).caveat, /observational/);
  console.log(
    `routing replay: policy ${JSON.stringify((report.results[0] as { policy_arm: unknown }).policy_arm)} vs default ${JSON.stringify((report.results[0] as { default_arm: unknown }).default_arm)}`,
  );
  // When the training period favoured codex but the test period does not, the replay must not claim a gain.
  const drift = replayEvaluation({
    samples: [
      ...train,
      ...samples("claude", 60, 0.9, {}, 20),
      ...samples("codex", 60, 0.88, {}, 20),
    ],
    cutoff: new Date(T0 + 10 * 86_400_000),
    defaults: { coding_agent: "claude" },
    eligible: ["claude", "codex"],
    preference: "balanced",
    minSamples: 10,
  });
  assert.notEqual((drift.results[0] as { verdict: string }).verdict, "IMPROVED_OBSERVED");
});

test("equal verified quality and clearly lower known cost: chosen only once non-inferiority is shown, never for quality-first", () => {
  // 40 vs 40 at 90%: the interval of the difference is far wider than the 5-point margin — equality is not shown.
  const thin = [
    ...samples("claude", 40, 0.9, { costUsd: 2 }),
    ...samples("codex", 40, 0.9, { costUsd: 0.8 }),
  ];
  const kept = route(thin, { preference: "cost_first" });
  assert.equal(kept.applied, false);
  assert.match(kept.reason, /not shown non-inferior/);
  assert.ok(kept.non_inferiority!.correctness!.low < -0.05);
  const s = [
    ...samples("claude", 400, 0.9, { costUsd: 2 }),
    ...samples("codex", 400, 0.9, { costUsd: 0.8 }),
  ];
  const cost = route(s, { preference: "cost_first" });
  assert.equal(cost.chosen?.provider, "codex");
  assert.match(cost.reason, /lower known cost/);
  assert.equal(cost.non_inferiority!.non_inferior, true);
  assert.equal(cost.non_inferiority!.superior, false);
  assert.ok(cost.non_inferiority!.correctness!.low > -0.05);
  assert.equal(route(s, { preference: "quality_first" }).applied, false);
});

test("without a measured incumbent, nothing is switched: non-inferiority cannot be tested", () => {
  // codex and copilot are eligible and measured; the default (claude) has too few samples to compare against.
  const d = route([
    ...samples("claude", 5, 1),
    ...samples("codex", 10, 0.3),
    ...samples("copilot", 10, 0.2),
  ]);
  assert.equal(d.applied, false, d.reason);
  const strong = route([
    ...samples("claude", 5, 1),
    ...samples("codex", 40, 0.95),
    ...samples("copilot", 40, 0.4),
  ]);
  // Previously a strong alternative replaced an unmeasured default. Without a measured incumbent there is no baseline
  // to be non-inferior to, so the sparse-data fallback (existing defaults) applies.
  assert.equal(strong.applied, false);
  assert.equal(strong.confidence, "insufficient");
  assert.match(strong.reason, /incumbent configuration claude has 5 sample/);
});

test("analysis steps: completion is not correctness — completed analysis never supports a quality switch", () => {
  const analysis = (provider: string, n: number) =>
    samples(provider, n, 1, { stepType: "agent", verified: null, reviewed: null });
  const d = route([...analysis("claude", 60), ...analysis("codex", 60)], { stepType: "agent" });
  assert.equal(d.applied, false);
  assert.equal(d.confidence, "insufficient");
  assert.match(d.reason, /completion is not counted as correct/);
  const c = scoreCandidates(analysis("codex", 60), "balanced")[0];
  assert.equal(c.execution_rate, 1, "execution success is still reported");
  assert.equal(c.n_verified, 0, "…separately from correctness, which is unknown");
});

test("the exact incumbent configuration is compared, not the best configuration of the same provider", () => {
  // The step runs claude with the provider-default model; a different claude model and codex have better records.
  const s = [
    ...samples("claude", 60, 0.6),
    ...samples("claude", 60, 0.97, { model: "claude-opus" }),
    ...samples("codex", 60, 0.9),
  ];
  const d = route(s, { incumbent: { provider: "claude", model: null, effort: null } });
  assert.equal(
    d.non_inferiority!.incumbent,
    "claude",
    "baseline = the configured incumbent (60% correct)",
  );
  assert.equal(d.applied, true);
  assert.deepEqual(d.chosen, { provider: "claude", model: "claude-opus", reasoning_effort: null });
  assert.equal(d.non_inferiority!.superior, true);
  // When the incumbent IS the strong model, nothing else is better.
  const same = route(s, { incumbent: { provider: "claude", model: "claude-opus", effort: null } });
  assert.equal(same.applied, false);
  assert.match(same.reason, /already the best/);
  // Effort is part of the identity too.
  const effort = route(
    [
      ...samples("codex", 60, 0.95, { effort: "high" }),
      ...samples("codex", 60, 0.5, { effort: "low" }),
    ],
    { incumbent: { provider: "codex", model: null, effort: "low" }, eligible: ["codex"] },
  );
  assert.deepEqual(effort.chosen, { provider: "codex", model: null, reasoning_effort: "high" });
});

test("execution success is a separate non-inferiority gate: correct-when-finished but often failing is not equal", () => {
  const s = [
    ...samples("claude", 400, 0.9, { costUsd: 2 }),
    ...samples("codex", 400, 0.9, { costUsd: 0.5 }),
    // codex also crashed 120 times without producing anything to verify (correctness unknown, not counted as wrong).
    ...samples("codex", 120, 0, {
      executed: false,
      verified: null,
      failure: "PROVIDER_ERROR",
      costUsd: 0.5,
    }),
  ];
  const d = route(s, { preference: "cost_first" });
  assert.equal(d.applied, false);
  assert.match(d.reason, /execution success Δ/);
  assert.ok(d.non_inferiority!.correctness!.low > -0.05, "correctness alone would have passed");
});

test("independent review is a separate gate when both sides have enough reviews", () => {
  const s = [
    ...samples("claude", 400, 0.9, { costUsd: 2 }),
    ...samples("codex", 400, 0.9, { costUsd: 0.5 }).map((x, i) => ({
      ...x,
      reviewed: i % 2 === 0,
    })),
  ];
  const d = route(s, { preference: "cost_first" });
  assert.equal(d.applied, false);
  assert.equal(d.non_inferiority!.review_assessed, true);
  assert.match(d.reason, /independent review Δ/);
  // Too few reviews: not assessed (reported), and does not block on its own.
  const few = s.map((x) => ({
    ...x,
    reviewed:
      x.provider === "codex" && x.runId % 50 === 0
        ? false
        : x.provider === "codex"
          ? null
          : x.reviewed,
  }));
  const e = route(few, { preference: "cost_first" });
  assert.equal(e.non_inferiority!.review_assessed, false);
  assert.equal(e.applied, true);
});

test("difference interval (Newcombe): contains the difference, narrows with n, matches published values", () => {
  // Newcombe (1998) example: 56/70 vs 48/80 → difference 0.2, 95% CI [0.0524, 0.3339] (method 10).
  const i = differenceInterval(56, 70, 48, 80)!;
  assert.ok(Math.abs(i.diff - 0.2) < 1e-9);
  assert.ok(
    Math.abs(i.low - 0.0524) < 0.001 && Math.abs(i.high - 0.3339) < 0.001,
    JSON.stringify(i),
  );
  const small = differenceInterval(36, 40, 36, 40)!;
  const large = differenceInterval(360, 400, 360, 400)!;
  assert.ok(small.low < large.low && large.low < 0 && large.high > 0);
  assert.equal(differenceInterval(0, 0, 1, 1), null);
});
