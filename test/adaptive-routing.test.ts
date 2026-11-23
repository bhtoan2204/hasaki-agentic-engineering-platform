import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRoute,
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

test("equal verified quality and clearly lower known cost: chosen for cost-first/balanced, not for quality-first", () => {
  const s = [
    ...samples("claude", 40, 0.9, { costUsd: 2 }),
    ...samples("codex", 40, 0.9, { costUsd: 0.8 }),
  ];
  const cost = route(s, { preference: "cost_first" });
  assert.equal(cost.chosen?.provider, "codex");
  assert.match(cost.reason, /lower known cost/);
  assert.equal(route(s, { preference: "quality_first" }).applied, false);
});

test("without a measured default, a weak configuration is never chosen just for being the best of the rest", () => {
  // codex and copilot are eligible and measured; the default (claude) has too few samples to compare against.
  const d = route([
    ...samples("claude", 5, 1),
    ...samples("codex", 10, 0.3),
    ...samples("copilot", 10, 0.2),
  ]);
  assert.equal(d.applied, false, d.reason);
  assert.notEqual(
    d.confidence,
    "insufficient",
    "decided by the quality floor, not by missing data",
  );
  const strong = route([
    ...samples("claude", 5, 1),
    ...samples("codex", 40, 0.95),
    ...samples("copilot", 40, 0.4),
  ]);
  assert.equal(strong.chosen?.provider, "codex", "a clearly strong configuration still wins");
});
