import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeTier,
  rankCodeHits,
  rankRetrievedCode,
  planKnowledge,
  tierNotice,
} from "../src/context/plan.ts";

const hit = (path: string, score: number, extra: object = {}) => ({
  repo: "r",
  path,
  score,
  via: "symbol" as const,
  ...extra,
});

test("rankCodeHits dedupes, keeps best score and merges evidence", () => {
  const out = rankCodeHits(
    [hit("a.ts", 2, { line: 1 }), hit("a.ts", 5, { line: 1 }), hit("b.ts", 1)],
    {},
    { limit: 10 },
  );
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
  assert.equal(
    knowledgeTier({ category: "task_memory", metadata: { memory: { trust: "approved" } } }),
    "task_observation",
  );
  assert.equal(knowledgeTier({ category: "business_rule", enforced: true }), "organizational_rule");
  assert.equal(knowledgeTier({ category: "agent_skill" }), "approved_knowledge");
});

test("rankRetrievedCode dedupes hits, expands one dependency step and labels confidence and evidence", () => {
  const rawHit = (path: string, confidence: number) => ({
    repository: "svc",
    file_path: path,
    line_range: [1, 5],
    qualified_name: `${path}.fn`,
    confidence,
  });
  const out = rankRetrievedCode(
    { hits: [rawHit("a.ts", 0.9), rawHit("a.ts", 0.5), rawHit("b.ts", 0.4)] },
    [
      {
        repository: "svc",
        file_path: "a.ts",
        candidate_definitions: [{ repository: "svc", file_path: "dep.ts" }],
      },
    ],
  );
  const paths = out.hits.map((h: any) => h.file_path);
  assert.deepEqual(paths, ["a.ts", "dep.ts", "b.ts"]);
  assert.equal(paths.filter((p: string) => p === "a.ts").length, 1);
  const dep = out.hits.find((h: any) => h.file_path === "dep.ts");
  assert.match(dep.evidence[0], /dependency of svc:a.ts/);
  assert.ok(out.hits.every((h: any) => h.rank_confidence > 0 && h.rank_confidence <= 1));
});

test("unverified task memory is never inline or mandatory, even when enforced or assigned", () => {
  const mem = {
    key: "memory.x",
    title: "observation",
    category: "task_memory",
    content: "something",
    reason: "assigned to step",
    enforced: true,
    metadata: { memory: { trust: "unverified" }, load: "inline" },
  };
  const plan = planKnowledge([mem], {
    requestText: "x",
    stepType: "agent",
    inlineTokens: 1000,
    indexSize: 5,
  });
  assert.notEqual(plan[0].disclosure, "inline");
});

test("dedupe keeps the strongest duplicate's metadata, regardless of input order", () => {
  for (const order of [
    [0.9, 0.5],
    [0.5, 0.9],
  ]) {
    const out = rankRetrievedCode(
      {
        hits: order.map((c) => ({
          repository: "svc",
          file_path: "a.ts",
          line_range: [1, 5],
          qualified_name: "fn",
          confidence: c,
          snippet: `snippet-${c}`,
        })),
      },
      [],
    );
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0].snippet, "snippet-0.9");
    assert.equal(out.hits[0].confidence, 0.9);
  }
});

test("only unverified observations carry the explicit unverified notice", () => {
  assert.match(tierNotice("unverified_suggestion")!, /quan sát chưa xác minh/);
  assert.equal(tierNotice("organizational_rule"), undefined);
  assert.equal(
    tierNotice(knowledgeTier({ category: "task_memory", metadata: {} })) !== undefined,
    true,
  );
});

test("unverified task memory always stays at the index tier, even when the index is full", () => {
  const doc = (key: string, category: string, metadata: object = {}) => ({
    key,
    title: key,
    category,
    content: "text",
    reason: "applies",
    metadata,
  });
  const items = [
    doc("a", "reference_doc", { load: "on_demand", description: "request words" }),
    doc("b", "reference_doc", { load: "on_demand", description: "request words" }),
    doc("memory.x", "task_memory", { memory: { trust: "unverified" }, load: "on_demand" }),
  ];
  const plan = planKnowledge(items, {
    requestText: "request words",
    stepType: "agent",
    inlineTokens: 1000,
    indexSize: 1,
  });
  assert.equal(plan.find((p) => p.key === "memory.x")!.disclosure, "index");
  assert.equal(plan.filter((p) => p.disclosure === "index" && p.key !== "memory.x").length, 1);
});

test("verified and approved task memory (production metadata.memory.trust) is a task observation, not unverified", () => {
  for (const trust of ["verified", "approved"])
    assert.equal(
      knowledgeTier({ category: "task_memory", metadata: { memory: { trust } } }),
      "task_observation",
    );
  assert.equal(
    knowledgeTier({ category: "task_memory", metadata: { memory: { trust: "unverified" } } }),
    "unverified_suggestion",
  );
  assert.equal(knowledgeTier({ category: "task_memory", metadata: {} }), "unverified_suggestion");
  assert.equal(
    tierNotice(
      knowledgeTier({ category: "task_memory", metadata: { memory: { trust: "verified" } } }),
    ),
    undefined,
  );
});
