import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReport, reportHash } from "../src/eval/reports.ts";
import {
  autonomyGate,
  computeAutonomyMetrics,
  AUTONOMY_EVAL_VERSION,
} from "../src/eval/autonomy.ts";
import { runAutonomySuite, suiteManifest, VARIANTS } from "../src/eval/autonomySuite.ts";

function autonomyReport(commit = "abc123") {
  const manifest = suiteManifest();
  const results = VARIANTS.slice(0, 2).map((v) => {
    const episodes = runAutonomySuite(v);
    const metrics = computeAutonomyMetrics(episodes);
    return { variant: v, metrics, gate: autonomyGate(metrics), episodes };
  });
  return {
    suite: manifest.version,
    metrics_version: AUTONOMY_EVAL_VERSION,
    manifest_hash: manifest.hash,
    commit,
    generated_at: "2026-11-01T00:00:00.000Z",
    evidence_kind: "control_plane",
    results,
  };
}

test("autonomy reports keep version, manifest, commit, per-variant metrics and gate; every episode becomes a result row", () => {
  const raw = autonomyReport();
  const r = normalizeReport(raw);
  assert.equal(r.kind, "autonomy");
  assert.deepEqual(
    [r.suite, r.suite_version, r.manifest_hash, r.commit_sha],
    [raw.suite, AUTONOMY_EVAL_VERSION, raw.manifest_hash, "abc123"],
  );
  assert.deepEqual(Object.keys(r.metrics), [VARIANTS[0].name, VARIANTS[1].name]);
  assert.equal(r.gate!.passed, true);
  assert.equal(r.rows.length, raw.results[0].episodes.length * 2);
  assert.equal(r.rows[0].candidate, VARIANTS[0].name);
  assert.equal(typeof r.rows[0].correct === "boolean" || r.rows[0].correct === null, true);
});

test("performance, benchmark and bench files are recognized with their provenance; anything else is refused", () => {
  const perf = normalizeReport({
    suite: "platform-performance-v1",
    fixture_version: 2,
    evidence_kind: "component_fixture_control",
    conditions: { harness_hash: "h1", node: "v22" },
    baseline: { revision: "base1" },
    candidate: { revision: "cand1" },
    samples: { baseline: [], candidate: [] },
    paired: { p50_ratio: 1.02 },
    limits: ["x"],
  });
  assert.deepEqual(
    [perf.kind, perf.suite_version, perf.manifest_hash, perf.commit_sha],
    ["performance", "2", "h1", "cand1"],
  );
  assert.deepEqual((perf.provenance as { baseline: unknown }).baseline, { revision: "base1" });

  const bench = normalizeReport(
    [
      {
        scenario: "s1",
        profile: "FAST",
        status: "COMPLETED",
        correct: true,
        wall_s: 10,
        cost_usd_est: 0.5,
        input_tokens: 10,
        output_tokens: 5,
      },
      { scenario: "s2", candidate: "claude-cli", status: "FAILED", correct: false },
      { scenario: "s3", skipped: true },
    ],
    { suite: "bench-v3" },
  );
  assert.deepEqual(
    bench.rows.map((x) => [x.suite, x.scenario, x.candidate, x.profile, x.tokens]),
    [
      ["bench-v3", "s1", "platform", "FAST", 15],
      ["bench-v3", "s2", "claude-cli", null, null],
    ],
  );

  const benchmark = normalizeReport({
    suite: { key: "backend-v1", version: 3, hash: "sh" },
    executions: [{ id: 7, configuration: { adapter: "reference" } }],
    comparison: { report: { verdict: "PASS" } },
  });
  assert.deepEqual(
    [
      benchmark.kind,
      benchmark.suite,
      benchmark.suite_version,
      (benchmark.metrics as { verdict: string }).verdict,
    ],
    ["benchmark", "backend-v1", "3", "PASS"],
  );

  assert.throws(() => normalizeReport({ hello: 1 }), /unrecognized/);
});

test("the content hash ignores key order and changes with content", () => {
  assert.equal(
    reportHash({ a: 1, b: { c: 2, d: [1, 2] } }),
    reportHash({ b: { d: [1, 2], c: 2 }, a: 1 }),
  );
  assert.notEqual(reportHash({ a: 1 }), reportHash({ a: 2 }));
});
