import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditKnowledge,
  highImpact,
  textSimilarity,
  type AuditItem,
} from "../src/knowledge/audit.ts";
const item = (key: string, extra: Partial<AuditItem> = {}): AuditItem => ({
  key,
  title: key,
  content: "unique body " + key,
  category: "agent_skill",
  scope_type: "GLOBAL",
  applicability: { step_keys: ["implement"] },
  owner_id: null,
  ...extra,
});
const steps = [
  { key: "implement", type: "coding_agent" },
  { key: "test", type: "command" },
];
test("audit detects exact, near, conflict, command targets, truncated and excessive guidance", () => {
  const result = auditKnowledge({
    steps,
    items: [
      item("one", { id: 1, content: "same" }),
      item("two", { id: 2, content: "same" }),
      item("command", { applicability: { step_keys: ["test"] } }),
      item("truncated", { content: "x".repeat(60000) }),
      item("before", { content: "test-first" }),
      item("after", { content: "test-after" }),
    ],
  });
  for (const kind of [
    "exact_duplicate",
    "unreachable",
    "truncated_import",
    "excessive_context",
    "conflict",
  ])
    assert.ok(
      result.findings.some((f) => f.kind === kind),
      kind,
    );
  assert.equal(result.findings.find((f) => f.kind === "exact_duplicate")?.autoApply, true);
  assert.equal(textSimilarity("one two three four", "ONE two three four!"), 1);
});
test("audit keeps high impact, conflicts and private changes pending", () => {
  const u = { packs: 11, selected: 0, loaded: 0, truncated: 0 };
  assert.equal(highImpact(item("one"), u, 100), true);
  assert.equal(highImpact(item("one"), { ...u, packs: 10 }, 100), false);
  for (const extra of [
    { enforced: true },
    { category: "business_rule" },
    { category: "security_policy" },
    { owner_id: 3 },
  ]) {
    const report = auditKnowledge({
      steps,
      items: [
        item("one", { ...extra, content: "same" }),
        item("two", { ...extra, content: "same" }),
      ],
    });
    assert.equal(report.findings.find((f) => f.kind === "exact_duplicate")?.autoApply, false);
  }
});
test("absence in a window never proves unreachability", () => {
  const report = auditKnowledge({ steps, items: [item("one")], usage: {} });
  assert.equal(report.findings.find((f) => f.kind === "unused")?.classification, "suspected");
  assert.ok(!report.findings.some((f) => f.kind === "unreachable"));
});

test("audit keeps identical text with distinct scope coverage pending and reports native provenance and provider availability", () => {
  const report = auditKnowledge({
    steps,
    items: [
      item("repo-a", {
        content: "same",
        scope_type: "REPOSITORY",
        scope_ref: "a",
        metadata: {
          source: [{ repo: "a", path: ".cursor/rules/review.mdc", sha256: "raw-file-hash" }],
        },
      }),
      item("repo-b", { content: "same", scope_type: "REPOSITORY", scope_ref: "b" }),
    ],
    providerAvailability: { "repo-b": false },
    nativeSources: [{ repo: "a", path: ".cursor/rules/review.mdc", sha256: "raw-file-hash" }],
    missingPaths: { "repo-b": ["gone.md"] },
  });
  assert.equal(report.findings.find((f) => f.kind === "exact_duplicate")?.autoApply, false);
  for (const kind of ["native_duplicate_source", "provider_unavailable", "missing_path"])
    assert.ok(
      report.findings.some((f) => f.kind === kind),
      kind,
    );
});

test("audit separates semantic overlap, stale entries and usage waste", () => {
  const body =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
  const report = auditKnowledge({
    steps,
    items: [
      item("first", {
        title: "shared responsibility",
        content: body,
        superseded_by: "second",
        applicability: { step_keys: ["implement"], repos: ["gone"] },
      }),
      item("second", { title: "shared responsibility", content: body + " extra" }),
    ],
    repositories: ["present"],
    usage: { first: { selected: 1, packs: 1, loaded: 0, truncated: 3 } },
    roleFootprint: { coding_agent: { packs: 2, tokens: 500 } },
  });
  for (const kind of [
    "near_duplicate",
    "responsibility_overlap",
    "outdated",
    "missing_repository",
    "repeated_truncation",
  ])
    assert.ok(
      report.findings.some((f) => f.kind === kind),
      kind,
    );
  assert.equal(report.roleFootprint.coding_agent.tokens, 500);
  assert.ok(report.findings.every((f) => !f.autoApply));
});
