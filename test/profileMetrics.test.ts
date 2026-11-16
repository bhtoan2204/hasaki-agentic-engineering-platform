import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeProfiles, matchedBenchmark } from "../src/workflow/profileMetrics.ts";
const sample = {
  fixture: "label",
  repetition: 1,
  base: "abc",
  provider: "fixture",
  model: "fixture",
  cache: "cold",
  checks: ["acceptance"],
  initialProfile: "MICRO" as const,
  finalProfile: "MICRO" as const,
  wallMs: 10,
  queueMs: 1,
  invocations: 1,
  tokens: null,
  contextTokens: 100,
  verificationMs: 2,
  correct: true,
  expectedProfile: null,
};
test("missing provider telemetry stays unknown and escalation is not a false classification", () => {
  const [result] = summarizeProfiles([{ ...sample, finalProfile: "STANDARD" }]);
  assert.equal(result.escalationRate, 1);
  assert.equal(result.classificationAccuracy, null);
  assert.equal(result.tokens.median, null);
});
test("matched benchmarks refuse missing comparisons and compare actual provided measurements", () => {
  assert.throws(() => matchedBenchmark([sample]), /matched/);
  const rows = ["MICRO", "FAST", "STANDARD"].flatMap((profile, i) =>
    Array.from({ length: 3 }, (_, n) => ({
      ...sample,
      initialProfile: profile as "MICRO" | "FAST" | "STANDARD",
      finalProfile: profile as "MICRO" | "FAST" | "STANDARD",
      repetition: n + 1,
      wallMs: 10 + i * 10,
    })),
  );
  const matched = Array.from({ length: 20 }, (_, i) =>
    rows.map((row) => ({ ...row, fixture: `fixture-${i}` })),
  ).flat();
  assert.equal(matchedBenchmark(matched).profiles.length, 3);
});
