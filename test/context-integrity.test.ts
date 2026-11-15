import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codeRetrievalKey,
  budgetContextPack,
  ContextBudgetError,
  type ContextEntry,
} from "../src/context/pack.ts";
import { scoreKnowledge } from "../src/context/plan.ts";

test("codeRetrievalKey v3 incorporates selected repos and index snapshot, ignoring ordering", () => {
  const base = {
    ownerId: 1,
    runId: 100,
    allowed: ["repo-b", "repo-a"],
    query: "auth jwt verification",
    repos: { "repo-a": "sha1:base1", "repo-b": "sha2:base2" },
    indexVersion: "v1",
  };

  const key1 = codeRetrievalKey({
    ...base,
    selected: ["repo-b", "repo-a"],
    indexSnapshot: "snap-123",
  });

  const key2 = codeRetrievalKey({
    ...base,
    selected: ["repo-a", "repo-b"],
    indexSnapshot: "snap-123",
  });

  assert.equal(key1, key2, "selected repos order should not affect key");

  const keyDifferentSnapshot = codeRetrievalKey({
    ...base,
    selected: ["repo-a", "repo-b"],
    indexSnapshot: "snap-456",
  });
  assert.notEqual(key1, keyDifferentSnapshot, "different indexSnapshot must produce different key");

  const keyDifferentSelected = codeRetrievalKey({
    ...base,
    selected: ["repo-a"],
    indexSnapshot: "snap-123",
  });
  assert.notEqual(key1, keyDifferentSelected, "different selected repos must produce different key");
});

test("budgetContextPack preserves mandatory required entries and throws ContextBudgetError if budget is exceeded", () => {
  const mandatoryEntry: ContextEntry = {
    id: "mandatory_execution_contract",
    section: "requirements",
    body: JSON.stringify({
      approved_plan: "plan...",
      acceptance_criteria: ["AC1", "AC2"],
      selected_repositories: ["repo-a"],
      required_tests: ["test/a.test.ts"],
    }),
    priority: 1000,
    required: true,
    provenance: {
      source_id: "run:100:contract",
      version: 1,
      timestamp: new Date().toISOString(),
      visibility: "owner",
      relevance: "mandatory contract",
      state: "snapshot",
    },
    trust: "curated_rule",
  };

  const optionalEntry: ContextEntry = {
    id: "knowledge:10:v1",
    section: "knowledge",
    body: "Some optional rule or context",
    priority: 100,
    required: false,
    provenance: {
      source_id: "knowledge:10",
      version: 1,
      timestamp: new Date().toISOString(),
      visibility: "shared",
      relevance: "optional",
      state: "snapshot",
    },
    trust: "approved_knowledge",
  };

  const pack = budgetContextPack(
    { pack_id: 1, snapshot_id: 1, token_measurement: "character_estimate_not_provider_usage", budget_tokens: 10000 },
    [mandatoryEntry, optionalEntry],
  );
  assert.equal(pack.entries.length, 2);
  assert.ok(pack.entries.some((e) => e.id === "mandatory_execution_contract"));

  assert.throws(
    () =>
      budgetContextPack(
        { pack_id: 1, snapshot_id: 1, token_measurement: "character_estimate_not_provider_usage", budget_tokens: 10 },
        [mandatoryEntry],
      ),
    (err: unknown) => err instanceof ContextBudgetError,
  );
});

test("scoreKnowledge discounts agent skills not applicable to current step type", () => {
  const matchingSkill = {
    key: "skill.tdd",
    title: "Test-Driven Development",
    content: "Write tests first",
    category: "agent_skill",
    reason: "skill",
    scope_type: "GLOBAL",
    metadata: {
      description: "TDD workflow",
      applicable_steps: ["coding_agent"],
    },
  };

  const unmatchingSkill = {
    key: "skill.architecture-audit",
    title: "Architecture Audit",
    content: "Audit architecture",
    category: "agent_skill",
    reason: "skill",
    scope_type: "GLOBAL",
    metadata: {
      description: "Architecture audit workflow",
      applicable_steps: ["review", "analysis"],
    },
  };

  const request = "Run test driven development and architecture audit";
  const scoreMatching = scoreKnowledge(matchingSkill as any, request, "coding_agent");
  const scoreUnmatching = scoreKnowledge(unmatchingSkill as any, request, "coding_agent");

  assert.ok(scoreMatching.score > scoreUnmatching.score, "non-applicable step skill should be discounted");
});
