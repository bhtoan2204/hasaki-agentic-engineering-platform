import { test } from "node:test";
import assert from "node:assert/strict";
import { slopReviewEvidence } from "../src/slop/review.ts";

const finding = (over: Record<string, unknown>) => ({
  rule: "silent-error",
  category: "error-handling",
  severity: "high",
  confidence: 0.9,
  kind: "deterministic",
  path: "app/a.go",
  line: 12,
  symbol: "Refund",
  snippet: "if err != nil {\n  return nil\n}",
  message: "error is dropped",
  fingerprint: "f1",
  status: "new",
  ...over,
});

test("slop review evidence lists only new or worsened findings, once per repo and fingerprint", () => {
  const text = slopReviewEvidence({
    implement: {
      output: {
        verification: {
          last: [
            {
              repo: "oms-api",
              slop: {
                findings: [
                  finding({}),
                  finding({ fingerprint: "f2", status: "existing" }),
                  finding({
                    fingerprint: "f3",
                    status: "worsened",
                    rule: "complexity",
                    path: "app/b.go",
                  }),
                ],
              },
            },
          ],
        },
      },
    },
    implement_retry: {
      output: { verification: { last: [{ repo: "oms-api", slop: { findings: [finding({})] } }] } },
    },
    plan: { output: { summary: "no verification here" } },
  });
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^- \[high\/silent-error\] oms-api:app\/a\.go:12 \(Refund\) — error is dropped$/,
  );
  assert.match(lines[1], /\[high\/complexity, worsened\] oms-api:app\/b\.go:12/);
  assert.match(text, /`if err != nil \{ return nil \}`/);
});

test("slop review evidence is empty without scanned new findings, and capped with a remainder line", () => {
  assert.equal(slopReviewEvidence({}), "");
  assert.equal(
    slopReviewEvidence({
      implement: { output: { verification: { last: [{ repo: "x", slop: null }] } } },
    }),
    "",
  );
  const many = Array.from({ length: 45 }, (_, i) => finding({ fingerprint: `f${i}` }));
  const text = slopReviewEvidence({
    implement: { output: { verification: { last: [{ repo: "r", slop: { findings: many } }] } } },
  });
  assert.equal(text.split("\n").filter((l) => l.startsWith("- [")).length, 40);
  assert.match(text, /- … 5 more not shown$/);
});
