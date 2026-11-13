import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { planExternalSkills, applyExternalSkills } from "../src/knowledge/externalImport.ts";
import {
  resolveKnowledge,
  compareCandidates,
  type KnowledgeCandidate,
  type ResolutionContext,
} from "../src/knowledge/resolve.ts";
import { isMandatory, planKnowledge } from "../src/context/plan.ts";
import { renderCodebaseMap, indexedCodebaseMap } from "../src/knowledge/codebaseMap.ts";
import { remediateKnowledgeAudit } from "../src/knowledge/auditRemediation.ts";
import { rollbackProposal } from "../src/knowledge/proposals.ts";
import { loadKnowledgeAudit } from "../src/knowledge/auditLoader.ts";
import { createUser } from "../src/auth/users.ts";
import type { AuditItem } from "../src/knowledge/audit.ts";

before(() => migrate());
after(() => pool.end());
const ctx: ResolutionContext = {
  organization: "",
  project: "",
  repositories: [],
  workflowKey: "pilot",
  stepKey: "implement",
  stepType: "coding_agent",
  text: "fix",
  explicit: [],
};
const candidate = (key: string, more: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
  key,
  title: key,
  category: "agent_skill",
  scope_type: "GLOBAL",
  scope_ref: "",
  conflict_key: "same",
  priority: 0,
  enforced: false,
  version: 1,
  content: key,
  applicability: { step_keys: ["implement"] },
  metadata: {},
  ...more,
});
test("Ponytail import validates pinned hashes, scans adapted sources, and defaults off", async () => {
  const root = resolve(import.meta.dirname, "../skills/external");
  const plan = planExternalSkills(root);
  assert.deepEqual(plan.rejected, []);
  const ponytail = plan.candidates.filter(
    (i) => i.key === "skill.ext.ponytail" || i.key === "skill.ext.ponytail-review",
  );
  assert.equal(ponytail.length, 2);
  for (const p of ponytail) {
    assert.equal(
      (p.metadata?.origin as Record<string, unknown>).commit,
      "7801d061243d7b753bad0e0b3c057cd250b11755",
    );
    assert.doesNotMatch(
      p.content,
      /shortcut:|\/ponytail|\blite\b|\bultra\b|Trivial changes need none/,
    );
    assert.match(p.content, /TDD and verification skills/);
  }
  assert.match(
    readFileSync(resolve(root, "NOTICE.md"), "utf8"),
    /brainstorming and receiving-code-review/,
  );
  await applyExternalSkills({ ...plan, candidates: ponytail, supersedes: [] });
  const candidates = await knowledge.candidates(pool);
  assert.equal(
    resolveKnowledge(candidates, ctx).applied.filter((k) => k.metadata.pilot === "ponytail").length,
    0,
  );
  for (const stepKey of ["implement", "fix", "refactor"])
    assert.equal(
      resolveKnowledge(candidates, {
        ...ctx,
        stepKey,
        explicit: ["skill.ext.ponytail"],
      }).applied.some((k) => k.key === "skill.ext.ponytail"),
      true,
    );
  for (const stepKey of ["analyze", "test"])
    assert.equal(
      resolveKnowledge(candidates, {
        ...ctx,
        stepKey,
        explicit: ["skill.ext.ponytail"],
      }).applied.some((k) => k.key === "skill.ext.ponytail"),
      false,
    );
  assert.equal(
    resolveKnowledge(candidates, {
      ...ctx,
      stepType: "command",
      explicit: ["skill.ext.ponytail"],
    }).applied.some((k) => k.key === "skill.ext.ponytail"),
    false,
  );
});
test("precedence protects invariants and shares mandatory disclosure", () => {
  const skill = candidate("skill", { priority: 100 });
  const mandatory = candidate("mandatory", { metadata: { mandatory: true } });
  const invariant = candidate("invariant", { category: "business_rule" });
  assert.ok(compareCandidates(invariant, mandatory) < 0);
  assert.ok(compareCandidates(mandatory, skill) < 0);
  const k = { ...invariant, reason: "GLOBAL scope" };
  assert.equal(isMandatory(k), true);
  assert.equal(
    planKnowledge([k], { requestText: "", stepType: "agent", inlineTokens: 0, indexSize: 0 })[0]
      .disclosure,
    "inline",
  );
  assert.equal(isMandatory({ ...k, category: "task_memory", metadata: {} }), false);
});
test("codebase map bounds exported top-level symbols and omits missing index", async () => {
  const map = renderCodebaseMap(
    [
      {
        repository: "repo",
        file_path: "service.go",
        symbol_name: "Public",
        signature: "func Public()",
        parent_symbol: null,
      },
      {
        repository: "repo",
        file_path: "service.ts",
        symbol_name: "Internal",
        signature: "class Internal",
        parent_symbol: null,
      },
      {
        repository: "repo",
        file_path: "service.ts",
        symbol_name: "exported",
        signature: "function exported()",
        parent_symbol: null,
        exported: true,
      },
    ],
    100,
  );
  assert.ok(map.length <= 100);
  assert.match(map, /Public/);
  assert.match(map, /exported/);
  assert.doesNotMatch(map, /Internal/);
  assert.equal(await indexedCodebaseMap(["missing"], -1, 2000), "");
});
test("audit proposal auto-apply and rollback preserve duplicate state and history; high impact stays pending", async () => {
  for (const key of ["audit-old", "audit-new", "audit-protected"])
    await knowledge.create({
      key,
      title: key,
      category: "agent_skill",
      scope_type: "GLOBAL",
      content: "identical audited body",
      applicability: { step_keys: ["implement"] },
      enforced: key.endsWith("protected"),
    });
  const rows = (await knowledge.list()).filter((i) => i.key.startsWith("audit-"));
  const report = await remediateKnowledgeAudit(
    {
      items: rows.filter((r) => r.key !== "audit-protected") as AuditItem[],
      steps: [{ key: "implement", type: "coding_agent" }],
    },
    { autoApply: true },
  );
  assert.equal(report.proposals.length, 1);
  assert.equal(report.proposals[0].status, "approved");
  const duplicate = await knowledge.get("audit-new");
  assert.equal(duplicate.enabled, false);
  assert.equal(duplicate.superseded_by_item.key, "audit-old");
  await rollbackProposal(report.proposals[0].proposalId, { by: "test" });
  assert.equal((await knowledge.get("audit-new")).enabled, true);
  assert.equal((await knowledge.get("audit-new")).superseded_by, null);
  const pending = await remediateKnowledgeAudit(
    {
      items: rows as AuditItem[],
      steps: [{ key: "implement", type: "coding_agent" }],
      usage: { "audit-new": { selected: 0, packs: 11, loaded: 0, truncated: 0 } },
      totalPacks: 100,
    },
    { autoApply: true },
  );
  assert.ok(pending.proposals.every((p) => p.status === "pending"));
  assert.equal((await knowledge.get("audit-protected")).enabled, true);
});
test("revert appends version and audit excludes other owners' private keys and content", async () => {
  const owner = await createUser({
    username: "audit-owner",
    password: "audit-pass-123",
    role: "member",
  });
  await knowledge.create({
    key: "audit-private-secret-key",
    title: "private",
    category: "agent_skill",
    scope_type: "GLOBAL",
    content: "private body not shared",
    ownerId: owner.id,
  });
  await knowledge.update("audit-old", { content: "changed" });
  const before = await knowledge.get("audit-old");
  await knowledge.revert("audit-old", 1, null, "admin");
  const after = await knowledge.get("audit-old");
  assert.equal(after.current_version, before.current_version + 1);
  assert.equal(after.versions[0].content, "identical audited body");
  const report = await loadKnowledgeAudit();
  assert.ok(report.privateAggregates!.ownership.private >= 1);
  assert.doesNotMatch(JSON.stringify(report), /audit-private-secret-key|private body not shared/);
});

test("Ponytail consolidates existing reuse guidance and map sources through resolver", () => {
  const ponytail = candidate("skill.ext.ponytail", {
    conflict_key: "engineering.reuse",
    priority: 10,
    metadata: { pilot: "ponytail" },
  });
  const reuse = candidate("reuse-first-development", { conflict_key: null });
  const map = candidate("map-legacy", {
    title: "Codebase map",
    conflict_key: null,
    category: "repository_convention",
  });
  const resolved = resolveKnowledge([reuse, ponytail, map], { ...ctx, explicit: [ponytail.key] });
  assert.deepEqual(
    resolved.applied.map((k) => k.key),
    [ponytail.key],
  );
  assert.ok(resolved.overridden.some((k) => k.key === reuse.key && k.reason === "conflict"));
  assert.ok(resolved.overridden.some((k) => k.key === map.key && k.reason === "superseded"));
});

test("audit refuses stale canonical proposals without losing either item", async () => {
  for (const key of ["stale-old", "stale-new"])
    await knowledge.create({
      key,
      title: key,
      category: "agent_skill",
      scope_type: "GLOBAL",
      content: "same stale body",
      applicability: { step_keys: ["implement"] },
    });
  const items = (await knowledge.list()).filter((i) => i.key.startsWith("stale-"));
  const result = await remediateKnowledgeAudit({
    items: items as AuditItem[],
    steps: [{ key: "implement", type: "coding_agent" }],
  });
  await knowledge.update("stale-old", { content: "canonical changed" });
  const { approveProposal } = await import("../src/knowledge/proposals.ts");
  await assert.rejects(
    approveProposal(result.proposals[0].proposalId, { by: "system:knowledge-audit" }),
    /canonical item changed/,
  );
  assert.equal((await knowledge.get("stale-new")).enabled, true);
});

test("reverting identical historical text still appends a version", async () => {
  const old = await knowledge.get("audit-old");
  await knowledge.revert("audit-old", 1, null, "admin");
  assert.equal((await knowledge.get("audit-old")).current_version, old.current_version + 1);
});
