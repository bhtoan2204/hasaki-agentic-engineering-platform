import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correlate,
  detectFailures,
  detectSeries,
  robustZ,
  type ErrorSeries,
  type FindingKind,
} from "../src/radar/detect.ts";

/**
 * Seeded HOURLY fixtures (prod_error_observations.hourly). Scope of the numbers printed here: synthetic series built
 * by this file — a regression baseline for the detectors, not a claim about production precision.
 */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}
const NOW = new Date("2026-11-23T12:00:00Z");
const H = 3_600_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
/**
 * `baseHours` baseline hours at `base`/h (noise ±30%, zero hours omitted like the source does), then `recentHours`
 * hours at `recent`/h ending now. The latest scan's window is the recent hours.
 */
function series(
  name: string,
  base: number,
  recent: number,
  over: Partial<ErrorSeries> & { seed?: number; recentHours?: number; baseHours?: number } = {},
): ErrorSeries {
  const { seed, recentHours: rh, baseHours: bh, ...rest } = over;
  const r = rng(seed ?? name.length * 7919);
  const recentHours = rh ?? 3;
  const baseHours = bh ?? 168;
  const start = NOW.getTime() - (baseHours + recentHours) * H;
  const points = [];
  for (let i = 0; i < baseHours + recentHours; i++) {
    const rate = i < baseHours ? base : recent;
    const count = Math.round(rate * (1 + (r() - 0.5) * 0.6));
    if (count > 0) points.push({ at: new Date(start + i * H), count });
  }
  const covered = new Set<string>();
  for (let t = start; t <= NOW.getTime(); t += H) covered.add(day(t));
  return {
    fingerprint: name.padEnd(20, "0").slice(0, 20),
    service: `svc-${name}`,
    environment: "prod",
    level: "ERROR",
    signature: `${name} failed`,
    firstSeenAt: new Date(NOW.getTime() - 30 * 86_400_000),
    points,
    recentFrom: new Date(NOW.getTime() - recentHours * H),
    latestScanId: 99,
    coveredDays: [...covered],
    ...rest,
  };
}
const kinds = (s: ErrorSeries) => new Set(detectSeries(s, undefined, NOW).map((d) => d.kind));

test("robust baseline: one earlier outlier does not hide a later spike", () => {
  const base = [50, 52, 48, 400, 51, 49];
  assert.ok(robustZ(300, base) > 4);
  assert.ok(robustZ(60, base) < 4);
});

test("seeded hourly benchmark: injected regressions are found; stable, low-volume and long-window scans are not", () => {
  type Case = { s: ErrorSeries; expect: FindingKind[] };
  const cases: Case[] = [];
  for (let i = 0; i < 40; i++) {
    const v = [2, 8, 30, 120][i % 4];
    cases.push({ s: series(`stable${i}`, v, v, { seed: i + 1 }), expect: [] });
  }
  // A long manual scan (72 h window) over an unchanged rate: the window length must not look like a spike.
  for (let i = 0; i < 5; i++)
    cases.push({
      s: series(`long${i}`, 20, 20, { seed: 50 + i, recentHours: 72, baseHours: 96 }),
      expect: [],
    });
  // Low volume: ×5 but under minCount events in the recent window.
  for (let i = 0; i < 10; i++)
    cases.push({ s: series(`low${i}`, 0.5, 2.5, { seed: 100 + i }), expect: [] });
  for (let i = 0; i < 15; i++) {
    const b = [5, 15, 40][i % 3];
    cases.push({
      s: series(`spike${i}`, b, b * (3 + i), { seed: 200 + i }),
      expect: ["error_spike"],
    });
  }
  for (let i = 0; i < 5; i++)
    cases.push({
      s: series(`slow${i}`, 4, 40 + i * 10, { seed: 300 + i, level: "SLOW" }),
      expect: ["latency_regression"],
    });
  for (let i = 0; i < 5; i++)
    cases.push({
      s: series(`new${i}`, 0, 20 + i * 10, {
        seed: 400 + i,
        baseHours: 0,
        firstSeenAt: new Date(NOW.getTime() - 3 * H),
      }),
      expect: ["new_signature"],
    });
  for (let i = 0; i < 3; i++)
    cases.push({
      s: series(`retry${i}`, 5, 80, {
        seed: 500 + i,
        signature: `kafka consumer retry attempt 5 failed ${i}`,
      }),
      expect: ["error_spike", "retry_pattern"],
    });
  for (let i = 0; i < 2; i++)
    cases.push({
      s: series(`deploy${i}`, 6, 90, {
        seed: 600 + i,
        version: "pay:prod.2.abc1234",
        previousVersion: "pay:prod.1.def5678",
      }),
      expect: ["error_spike", "deploy_correlated"],
    });
  let tp = 0,
    fp = 0,
    fn = 0;
  const errors: string[] = [];
  for (const c of cases) {
    const got = kinds(c.s);
    for (const k of c.expect)
      if (got.has(k)) tp++;
      else {
        fn++;
        errors.push(`FN ${c.s.signature} ${k}`);
      }
    for (const k of got)
      if (!c.expect.includes(k)) {
        fp++;
        errors.push(`FP ${c.s.signature} ${k}`);
      }
  }
  const quiet = cases.filter((c) => !c.expect.length).length;
  console.log(
    `radar synthetic benchmark (fixture scope only): ${cases.length} series, precision ${(tp / (tp + fp || 1)).toFixed(2)}, recall ${(tp / (tp + fn || 1)).toFixed(2)}, false positives ${fp}/${quiet} quiet series`,
  );
  assert.deepEqual(errors, []);
});

test("detection latency: a step change is found in the first scan after onset; a plateau becomes the baseline", () => {
  assert.ok(kinds(series("onset", 10, 80, { recentHours: 1 })).has("error_spike"));
  const plateau = series("plateau", 10, 80, { recentHours: 3, baseHours: 168 });
  plateau.points = plateau.points.map((p) =>
    p.at.getTime() > NOW.getTime() - 120 * H ? { ...p, count: 80 } : p,
  );
  assert.ok(
    !kinds(plateau).has("error_spike"),
    "five days at the new level: the hourly baseline caught up",
  );
});

test("recurrence: quiet covered days between active days are episodes; a steady low rate is not recurring", () => {
  assert.ok(!kinds(series("steady", 0.4, 0.4, { seed: 9 })).has("recurring_incident"));
  const flappy = series("flappy", 0, 6);
  flappy.points = [];
  for (let d = 6; d >= 0; d--)
    if (d % 2 === 0)
      for (let h = 0; h < 4; h++)
        flappy.points.push({ at: new Date(NOW.getTime() - d * 86_400_000 - h * H), count: 5 });
  flappy.points.sort((a, b) => a.at.getTime() - b.at.getTime());
  flappy.recentFrom = new Date(NOW.getTime() - 4 * H);
  assert.ok(kinds(flappy).has("recurring_incident"));
  const reopened = series("reo", 0, 2, {
    reopenedAt: new Date(NOW.getTime() - 86_400_000),
    baseHours: 0,
  });
  assert.ok(kinds(reopened).has("recurring_incident"));
});

test("correlation: kinds of one signature merge into a single finding; same service links as related", () => {
  const a = detectSeries(
    series("x", 5, 90, {
      signature: "retry attempt 3 failed",
      service: "pay",
      version: "v2",
      previousVersion: "v1",
    }),
    undefined,
    NOW,
  );
  const b = detectSeries(series("y", 5, 90, { service: "pay" }), undefined, NOW);
  const f = correlate([...a, ...b]);
  assert.equal(f.length, 2, "one finding per signature, not per detector");
  const x = f.find((d) => d.signature.startsWith("retry"))!;
  assert.ok(
    x.kinds.includes("error_spike") &&
      x.kinds.includes("retry_pattern") &&
      x.kinds.includes("deploy_correlated"),
  );
  assert.equal(x.related.length, 1);
});

test("persistent workflow and CI failures need several distinct runs", () => {
  const d = detectFailures([
    {
      scope: "workflow",
      key: "bug:test",
      label: "bug / test",
      signature: "go: module not found",
      runs: [1, 2, 3],
      lastAt: NOW,
    },
    {
      scope: "workflow",
      key: "bug:pr",
      label: "bug / pr",
      signature: "x",
      runs: [4, 4, 4],
      lastAt: NOW,
    },
    {
      scope: "ci",
      key: "oms-api",
      label: "oms-api",
      signature: "CI_FAILED",
      runs: [7, 8, 9, 10],
      lastAt: NOW,
    },
  ]);
  assert.deepEqual(d.map((x) => x.kind).sort(), ["ci_failures", "workflow_failures"]);
});
