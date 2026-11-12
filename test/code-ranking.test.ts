import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeTier, rankCodeHits } from "../src/context/plan.ts";

const hit = (path: string, score: number, extra: object = {}) => ({
  repo: "r",
  path,
  score,
  via: "symbol" as const,
  ...extra,
});

test("rankCodeHits dedupes, keeps best score and merges evidence", () => {
  const out = rankCodeHits([hit("a.ts", 2, { line: 1 }), hit("a.ts", 5, { line: 1 }), hit("b.ts", 1)], {}, { limit: 10 });
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "a.ts");
  assert.equal(out[0].evidence.length, 2);
  assert.equal(out[0].confidence, 1);
});

test("rankCodeHits expands one dependency step with discounted score and respects limit", () => {
  const deps = { "r:a.ts": [{ repo: "r", path: "dep.ts" }] };
  const out = rankCodeHits([hit("a.ts", 4)], deps, { limit: 5 });
  const dep = out.find((h) => h.path === "dep.ts")!;
  assert.equal(dep.via, "dependency");
  assert.equal(dep.confidence, 0.5);
  assert.equal(rankCodeHits([hit("a.ts", 4)], deps, { limit: 1 }).length, 1);
});

test("knowledgeTier never promotes unverified memory to a rule", () => {
  assert.equal(knowledgeTier({ category: "task_memory", enforced: true }), "unverified_suggestion");
  assert.equal(knowledgeTier({ category: "task_memory", metadata: { trust: "approved" } }), "task_observation");
  assert.equal(knowledgeTier({ category: "business_rule", enforced: true }), "organizational_rule");
  assert.equal(knowledgeTier({ category: "agent_skill" }), "approved_knowledge");
});
