/** Severity v2 (rates per hour, first seen): the vectors are shared with go/internal/proderrors/severity_test.go. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { assessV2, DEFAULT_THRESHOLDS, isCrash, isMoney } from "../src/prodErrors/severity.ts";

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../go/internal/proderrors/testdata/severity-vectors.json"),
    "utf8",
  ),
) as Array<{
  name: string;
  input: {
    level: string;
    signature: string;
    sample: string;
    today: number;
    yesterday: number;
    baseline: boolean;
    windowHours: number;
    baselineHours: number;
    firstSeenAgeHours: number | null;
  };
  expect: { severity: string; reasons: string[] };
}>;

test("severity v2 vectors (shared with the Go port)", () => {
  assert.ok(vectors.length >= 20);
  for (const v of vectors) {
    const r = assessV2(v.input, DEFAULT_THRESHOLDS);
    assert.equal(r.severity, v.expect.severity, `severity: ${v.name}`);
    assert.deepEqual(r.reasons, v.expect.reasons, `reasons: ${v.name}`);
  }
});

test("the default thresholds are the decided ones (Q-1, Q-2)", () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    heavyRate: 40,
    chronicHigh: 200,
    spikeRatio: 3,
    spikeMinRate: 6,
    minNewCount: 5,
    minWindowHours: 1,
    minSampleCount: 20,
    newWithinHours: 24,
  });
});

test("classification is exported once for scan and Radar", () => {
  assert.equal(isCrash("panic: boom"), true);
  assert.equal(isMoney("duplicate payment callback"), true);
});
