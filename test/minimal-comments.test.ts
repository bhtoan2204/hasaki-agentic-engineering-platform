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

const seed = KNOWLEDGE_SEEDS.find((s) => s.key === "minimal-comments")!;
const policy: KnowledgeCandidate = {
  ...seed,
  category: "coding_standard",
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
const filler: KnowledgeCandidate = {
  ...policy,
  key: "big-relevant-standard",
  title: "Implement return shipment window",
  conflict_key: null,
  applicability: {},
  metadata: {},
  content: "return shipment window ".repeat(2000),
};
const resolve = (stepKey: string, stepType: string) =>
  resolveKnowledge([policy, filler], {
    organization: "hasaki",
    project: "oms",
    repositories: ["oms"],
    workflowKey: "bug-investigation",
    stepKey,
    stepType,
    text: "implement return shipment window",
    explicit: [],
  });

test("the comment policy is one Knowledge item, applied to implementation, refactoring and review steps only", () => {
  assert.equal(KNOWLEDGE_SEEDS.filter((s) => /comment/i.test(s.key)).length, 1);
  for (const [key, type] of [
    ["implement", "coding_agent"],
    ["fix", "coding_agent"],
    ["refactor", "coding_agent"],
    ["review", "agent"],
    ["self_review", "agent"],
  ])
    assert.ok(
      resolve(key, type).applied.some((k) => k.key === "minimal-comments"),
      key,
    );
  for (const key of ["analyze", "root_cause", "plan"])
    assert.ok(!resolve(key, "agent").applied.some((k) => k.key === "minimal-comments"), key);
});

test("the comment policy is inline within the normal and MICRO budgets, and an index line when the budget is spent", () => {
  const applied = resolve("implement", "coding_agent").applied;
  const tier = (inlineTokens: number) =>
    planKnowledge(applied, {
      requestText: "implement return shipment window",
      stepType: "coding_agent",
      inlineTokens,
      indexSize: 12,
    }).find((d) => d.key === "minimal-comments")?.disclosure;
  assert.equal(tier(8000), "inline");
  assert.equal(tier(3000), "inline");
  assert.equal(tier(0), "index");
});

test("every coding provider gets the same policy text in its system prompt", () => {
  const applied = resolve("implement", "coding_agent").applied;
  const ctx: ResolvedContext = {
    snapshot_id: 1,
    hash: "fixture",
    project: "oms",
    repositories: ["oms"],
    knowledge: applied,
    overridden: [],
    disclosure: planKnowledge(applied, {
      requestText: "fixture",
      stepType: "coding_agent",
      inlineTokens: 8000,
      indexSize: 12,
    }),
    upstream: { plan: {}, text: {} },
    requestText: "fixture",
    fileRefs: [],
  };
  const step = {
    id: 1,
    key: "implement",
    name: "Implement",
    type: "coding_agent",
    config: {},
  } as unknown as StepRow;
  let first: string | undefined;
  for (const provider of AGENT_PROVIDERS) {
    assert.ok(skillAvailability(policy.metadata, provider).available, provider);
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
      "coding",
    );
    assert.ok(prompt.includes(seed.content), provider);
    assert.equal(prompt.split("Prefer self-documenting code").length - 1, 1, `${provider}: once`);
    first ??= prompt;
    assert.equal(prompt, first, `${provider}: identical prompt`);
  }
});
