import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, reachableIds } from "../scripts/govulncheck-gate.ts";
import { check, summarize } from "../scripts/coverage-check.ts";

test("govulncheck gate: only called vulnerabilities count, allowlisted ones pass", () => {
  const stream = [
    '{"config":{"protocol_version":"v1.0.0"}}',
    '{"osv":{"id":"GO-1"}}',
    '{"finding":{"osv":"GO-1","trace":[{"module":"m","package":"p"}]}}',
    '{"finding":{"osv":"GO-2","trace":[{"module":"m","package":"p","function":"F"}]}}',
    '{"finding":{"osv":"GO-3","trace":[{"module":"m","function":"G"}]}}',
  ].join("\n");
  assert.deepEqual(reachableIds(stream), ["GO-2", "GO-3"]);
  const allow = [
    { id: "GO-2", reason: "r", expires: "2027-01-01" },
    { id: "GO-9", reason: "r", expires: "2026-01-01" },
  ];
  assert.deepEqual(evaluate(["GO-2", "GO-3"], allow, "2026-11-26"), {
    failures: ["GO-3"],
    expired: ["GO-9"],
    stale: ["GO-9"],
  });
});

test("coverage check: per-directory floors on an lcov report", () => {
  const lcov = [
    "SF:/repo/src/auth/a.ts",
    "LF:10",
    "LH:9",
    "BRF:4",
    "BRH:2",
    "end_of_record",
    "SF:/repo/src/auth/b.ts",
    "LF:10",
    "LH:9",
    "BRF:4",
    "BRH:4",
    "end_of_record",
    "SF:/repo/src/other/c.ts",
    "LF:100",
    "LH:0",
    "BRF:0",
    "BRH:0",
    "end_of_record",
  ].join("\n");
  const counts = summarize(lcov, ["src/auth", "src/authz"]);
  assert.deepEqual(counts["src/auth"].lines, [18, 20]);
  assert.deepEqual(counts["src/auth"].branches, [6, 8]);
  assert.deepEqual(check(counts, { "src/auth": { lines: 90, branches: 75 } }), []);
  assert.equal(check(counts, { "src/auth": { lines: 91, branches: 75 } }).length, 1);
  assert.deepEqual(check(counts, { "src/authz": { lines: 1, branches: 1 } }), [
    "src/authz: no coverage data",
  ]);
});
