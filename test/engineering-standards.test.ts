import { test, after } from "node:test";
import assert from "node:assert/strict";
import { KNOWLEDGE_SEEDS } from "../src/knowledge/service.ts";
import { resolveKnowledge, type KnowledgeCandidate } from "../src/knowledge/resolve.ts";
import { skillAvailability } from "../src/knowledge/external.ts";
import { planKnowledge } from "../src/context/plan.ts";
import { buildSystemAppend } from "../src/agent/stepPrompt.ts";
import { AGENT_PROVIDERS } from "../src/agent/provider.ts";
import { pool } from "../src/db/pool.ts";
import type { ResolvedContext } from "../src/workflow/context.ts";
import type { RunRow, StepRow } from "../src/workflow/types.ts";

after(() => pool.end());

const STANDARDS = ["minimal-comments", "codebase-gardening"];
const candidate = (key: string): KnowledgeCandidate => {
  const seed = KNOWLEDGE_SEEDS.find((s) => s.key === key)!;
  return {
    ...seed,
    category: seed.category as KnowledgeCandidate["category"],
    scope_type: "GLOBAL",
    scope_ref: "",
    conflict_key: seed.conflict_key ?? null,
    priority: 0,
    enforced: false,
    version: 1,
    content: seed.content,
    applicability: seed.applicability ?? {},
    metadata: seed.metadata ?? {},
  };
};
const standards = STANDARDS.map(candidate);
const filler: KnowledgeCandidate = {
  ...standards[0],
  key: "big-relevant-standard",
  title: "Implement return shipment window",
  conflict_key: null,
  applicability: {},
  metadata: {},
  content: "return shipment window ".repeat(2000),
};
const resolve = (stepKey: string, stepType: string) =>
  resolveKnowledge([...standards, candidate("reuse-first-development"), filler], {
    organization: "hasaki",
    project: "oms",
    repositories: ["oms"],
    workflowKey: "bug-investigation",
    stepKey,
    stepType,
    text: "implement return shipment window",
    explicit: [],
  }).applied;
const keys = (applied: KnowledgeCandidate[]) => applied.map((k) => k.key);

test("each standard is one Knowledge item, applied to implementation, refactoring and review steps only", () => {
  for (const key of STANDARDS) {
    assert.equal(KNOWLEDGE_SEEDS.filter((s) => s.key === key).length, 1);
    for (const [step, type] of [
      ["implement", "coding_agent"],
      ["fix", "coding_agent"],
      ["refactor", "coding_agent"],
      ["review", "agent"],
      ["self_review", "agent"],
    ])
      assert.ok(keys(resolve(step, type)).includes(key), `${key} on ${step}`);
    for (const step of ["analyze", "root_cause", "plan"])
      assert.ok(!keys(resolve(step, "agent")).includes(key), `${key} not on ${step}`);
  }
});

test("standards point to each other instead of repeating instructions", () => {
  const lines = (k: KnowledgeCandidate) =>
    k.content
      .split("\n")
      .map((l) => l.replace(/^[-\s]+/, "").trim())
      .filter((l) => l.length > 30);
  const all = [...standards, candidate("reuse-first-development")];
  for (const a of all)
    for (const b of all)
      if (a !== b)
        for (const l of lines(a)) assert.ok(!b.content.includes(l), `${a.key} repeats ${b.key}`);
  assert.match(standards[1].content, /reuse-first-development/);
  assert.match(standards[1].content, /minimal-comments/);
});

test("the standards are inline within the normal and MICRO budgets, and index lines when the budget is spent", () => {
  const applied = resolve("implement", "coding_agent");
  const tiers = (inlineTokens: number) => {
    const plan = planKnowledge(applied, {
      requestText: "implement return shipment window",
      stepType: "coding_agent",
      inlineTokens,
      indexSize: 12,
    });
    return STANDARDS.map((k) => plan.find((d) => d.key === k)?.disclosure);
  };
  assert.deepEqual(tiers(8000), ["inline", "inline"]);
  assert.deepEqual(tiers(3000), ["inline", "inline"]);
  assert.deepEqual(tiers(0), ["index", "index"]);
});

test("every coding provider gets the same standards text in its system prompt", () => {
  for (const [stepKey, type, mode] of [
    ["implement", "coding_agent", "coding"],
    ["review", "agent", "analysis"],
  ] as const) {
    const applied = resolve(stepKey, type);
    const ctx: ResolvedContext = {
      snapshot_id: 1,
      hash: "fixture",
      project: "oms",
      repositories: ["oms"],
      knowledge: applied,
      overridden: [],
      disclosure: planKnowledge(applied, {
        requestText: "fixture",
        stepType: type,
        inlineTokens: 8000,
        indexSize: 12,
      }),
      upstream: { plan: {}, text: {} },
      requestText: "fixture",
      fileRefs: [],
    };
    const step = { id: 1, key: stepKey, name: stepKey, type, config: {} } as unknown as StepRow;
    let first: string | undefined;
    for (const provider of AGENT_PROVIDERS) {
      const prompt = buildSystemAppend(
        {
          id: 1,
          definition_key: "bug-investigation",
          branch: "fix",
          allowed_repositories: ["oms"],
          selected_repositories: ["oms"],
          agent_provider: provider,
          output_locale: "en",
        } as RunRow,
        step,
        ctx,
        mode,
      );
      for (const k of standards) {
        assert.ok(skillAvailability(k.metadata, provider).available, `${k.key} on ${provider}`);
        assert.equal(prompt.split(k.content).length - 1, 1, `${k.key} once for ${provider}`);
      }
      first ??= prompt;
      assert.equal(prompt, first, `${stepKey}: identical prompt for ${provider}`);
    }
  }
});
