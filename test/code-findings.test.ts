import { test } from "node:test";
import assert from "node:assert/strict";
import { relatedReposOf, repoOf, scanFindings, titleOf } from "../src/workflow/codeFindings.ts";

const base = {
  id: "P1",
  kind: "PERFORMANCE",
  severity: "high",
  repo: "oms-api",
  file: "./app/order/create.go",
  line: 214,
  symbol: "CreateOrder",
  issue: "Line items are loaded once per item. More text.",
};
const fp = (f: object, selected = ["oms-api"]) => scanFindings([f], selected)[0].fingerprint;

test("the fingerprint ignores what drifts between scans: id, wording, line, severity, leading ./", () => {
  const a = fp(base);
  assert.equal(fp({ ...base, id: "X9", issue: "other words", line: 999, severity: "low" }), a);
  assert.equal(fp({ ...base, file: "app/order/create.go" }), a);
  assert.notEqual(fp({ ...base, symbol: "UpdateOrder" }), a);
  assert.notEqual(fp({ ...base, kind: "RELIABILITY" }), a);
  assert.notEqual(fp({ ...base, repo: "oms-background" }), a);
});

test("findings of one scan sharing an identity get distinct fingerprints, ordered by line", () => {
  const two = scanFindings(
    [
      { ...base, id: "B", line: 300 },
      { ...base, id: "A", line: 10 },
    ],
    ["oms-api"],
  );
  assert.notEqual(two[0].fingerprint, two[1].fingerprint);
  const again = scanFindings(
    [
      { ...base, id: "A2", line: 12 },
      { ...base, id: "B2", line: 310 },
    ],
    ["oms-api"],
  );
  assert.equal(again[0].fingerprint, two[1].fingerprint);
  assert.equal(again[1].fingerprint, two[0].fingerprint);
});

test("repo and related repos for assessments made before the agent named them", () => {
  const sel = ["oms-api", "oms-background"];
  const legacy = { issue: "x", evidence: "oms-background@9f3c2e1 worker.go:40 also in oms-api" };
  assert.equal(repoOf(legacy, sel), "oms-api");
  assert.equal(repoOf({ issue: "x", evidence: "worker.go" }, ["only"]), "only");
  assert.equal(repoOf({ issue: "x" }, sel), "");
  assert.deepEqual(relatedReposOf(legacy, "oms-api", sel), ["oms-background"]);
  assert.deepEqual(relatedReposOf({ related_repos: ["b"] }, "a", []), ["b"]);
});

test("titles are the agent's title or the issue's first sentence, kept short", () => {
  assert.equal(titleOf(base), "Line items are loaded once per item.");
  assert.equal(titleOf({ ...base, title: "N+1 queries" }), "N+1 queries");
  assert.ok(titleOf({ issue: "x".repeat(400) }).length <= 120);
});
