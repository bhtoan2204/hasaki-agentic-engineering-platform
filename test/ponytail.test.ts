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
  const ponytail = candidate("skill.ext.ponytail", {
    priority: 200,
    metadata: { pilot: "ponytail" },
  });
  const explicit = [ponytail.key, skill.key, mandatory.key, invariant.key];
  assert.deepEqual(
    resolveKnowledge([ponytail, skill, mandatory, invariant], { ...ctx, explicit }).applied.map(
      (k) => k.key,
    ),
    [invariant.key],
  );
  assert.deepEqual(
    resolveKnowledge([ponytail, skill, mandatory], { ...ctx, explicit }).applied.map((k) => k.key),
    [mandatory.key],
  );
  const k = { ...invariant, reason: "GLOBAL scope" };
  assert.equal(isMandatory(k), true);
  assert.equal(
    planKnowledge([k], { requestText: "", stepType: "agent", inlineTokens: 0, indexSize: 0 })[0]
      .disclosure,
    "inline",
  );
  assert.equal(isMandatory({ ...k, category: "task_memory", metadata: {} }), false);
});
test("without Ponytail, existing conflict groups keep their enforced/scope/priority winners", () => {
  const rule = candidate("global-rule", { category: "business_rule" });
  const repoSkill = candidate("repo-skill", { scope_type: "REPOSITORY", scope_ref: "r" });
  assert.ok(compareCandidates(repoSkill, rule) < 0);
  const preferred = candidate("preferred", { priority: 50, metadata: { mandatory: true } });
  const plain = candidate("plain-rule", { category: "business_rule" });
  const explicit = [preferred.key, plain.key];
  assert.deepEqual(
    resolveKnowledge([plain, preferred], { ...ctx, explicit }).applied.map((k) => k.key),
    [preferred.key],
  );
  assert.deepEqual(
    resolveKnowledge(
      [
        candidate("b-rule", { category: "business_rule", conflict_key: null }),
        candidate("a-skill", { conflict_key: null }),
      ],
      { ...ctx, explicit: ["a-skill", "b-rule"] },
    ).applied.map((k) => k.key),
    ["a-skill", "b-rule"],
  );
});
test("non-enforced security policies and metadata.mandatory stay within the disclosure budget", () => {
  const big = "rule ".repeat(4000);
  const policy = candidate("soft-policy", {
    category: "security_policy",
    content: big,
    reason: "GLOBAL scope",
  } as Partial<KnowledgeCandidate>);
  const flagged = candidate("flagged", {
    category: "coding_standard",
    content: big,
    metadata: { mandatory: true },
    reason: "GLOBAL scope",
  } as Partial<KnowledgeCandidate>);
  for (const k of [policy, flagged]) {
    const item = { ...k, reason: "GLOBAL scope" };
    assert.equal(isMandatory(item), false);
    assert.notEqual(
      planKnowledge([item], {
        requestText: "",
        stepType: "agent",
        inlineTokens: 100,
        indexSize: 1,
      })[0].disclosure,
      "inline",
    );
  }
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
  await rollbackProposal(report.proposals[0].proposalId!, { by: "test" });
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
  for (const p of pending.proposals)
    assert.equal(p.status, p.key === "audit-protected" ? "skipped" : "pending", p.key);
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
  const reuse = candidate("reuse-first-development", { conflict_key: "engineering.reuse" });
  const map = candidate("map-legacy", {
    title: "Codebase map",
    conflict_key: null,
    category: "repository_convention",
  });
  const resolved = resolveKnowledge([reuse, ponytail, map], { ...ctx, explicit: [ponytail.key] });
  assert.deepEqual(
    resolved.applied.map((k) => k.key),
    [ponytail.key, map.key],
  );
  assert.ok(resolved.overridden.some((k) => k.key === reuse.key && k.reason === "conflict"));
  // Legacy maps are only replaced in the pack once a generated map exists (stale index keeps them).
  assert.ok(!resolved.overridden.some((k) => k.key === map.key));
  const legacyReuse = candidate("reuse-first-development", { conflict_key: null });
  resolveKnowledge([legacyReuse, ponytail], { ...ctx, explicit: [ponytail.key] });
  assert.equal(legacyReuse.conflict_key, null);
});
test("migration gives the existing shared reuse seed row its conflict key", async () => {
  const { loadMigrations } = await import("../src/db/migrate.ts");
  const m = loadMigrations().find((x) => x.name === "054_reuse_conflict_key")!;
  const { KNOWLEDGE_SEEDS } = await import("../src/knowledge/service.ts");
  if (!(await knowledge.get("reuse-first-development")))
    await knowledge.create(KNOWLEDGE_SEEDS.find((x) => x.key === "reuse-first-development")!);
  await pool.query(
    "UPDATE knowledge_items SET conflict_key=NULL WHERE key='reuse-first-development' AND owner_id IS NULL",
  );
  await pool.query(m.sql);
  const row = (
    await pool.query(
      "SELECT conflict_key FROM knowledge_items WHERE key='reuse-first-development' AND owner_id IS NULL",
    )
  ).rows[0];
  assert.equal(row.conflict_key, "engineering.reuse");
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
    approveProposal(result.proposals[0].proposalId!, { by: "system:knowledge-audit" }),
    /canonical item changed/,
  );
  assert.equal((await knowledge.get("stale-new")).enabled, true);
});

test("reverting identical historical text still appends a version", async () => {
  const old = await knowledge.get("audit-old");
  await knowledge.revert("audit-old", 1, null, "admin");
  assert.equal((await knowledge.get("audit-old")).current_version, old.current_version + 1);
});

test("TDD and verification keep their legacy step keys and target no command-only key", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../skills/external/manifest.json"), "utf8"),
  );
  for (const key of [
    "skill.ext.test-driven-development",
    "skill.ext.verification-before-completion",
  ]) {
    const keys: string[] = manifest.skills.find((s: { key: string }) => s.key === key).applicability
      .step_keys;
    for (const k of ["implement", "fix", "refactor", "test", "regression_test", "fix_test"])
      assert.ok(keys.includes(k), `${key} ${k}`);
    assert.equal(keys.includes("targeted_test"), false);
  }
});

test("re-import converges and keeps admin-tuned priority and conflict keys", async () => {
  const plan = planExternalSkills(resolve(import.meta.dirname, "../skills/external"));
  const pick = plan.candidates.filter((c) =>
    ["skill.ext.ponytail", "skill.ext.brainstorming"].includes(c.key),
  );
  await applyExternalSkills({ ...plan, candidates: pick, supersedes: [] });
  await knowledge.update("skill.ext.ponytail", { priority: 3 });
  await knowledge.update("skill.ext.brainstorming", { conflict_key: "admin.choice" });
  const again = await applyExternalSkills({ ...plan, candidates: pick, supersedes: [] });
  assert.deepEqual(
    again.rows.map((r) => r.action),
    pick.map(() => "unchanged"),
  );
  assert.equal((await knowledge.get("skill.ext.ponytail")).priority, 3);
  assert.equal((await knowledge.get("skill.ext.brainstorming")).conflict_key, "admin.choice");
});

test("audit remediation only deprecates unprotected duplicates and survives approval drift", async () => {
  for (const [key, category] of [
    ["r1-rule-a", "business_rule"],
    ["r1-rule-b", "business_rule"],
    ["r1-skill-a", "agent_skill"],
    ["r1-skill-b", "agent_skill"],
    ["r1-unused", "agent_skill"],
  ] as const)
    await knowledge.create({
      key,
      title: key,
      category,
      scope_type: "GLOBAL",
      content: key.startsWith("r1-rule")
        ? "rule twin body"
        : key === "r1-unused"
          ? "lonely"
          : "skill twin body",
      applicability: { step_keys: ["implement"] },
    });
  const items = (await knowledge.list()).filter((i) => i.key.startsWith("r1-")) as AuditItem[];
  const steps = [{ key: "implement", type: "coding_agent" }];
  const usage = {};
  const planned = await remediateKnowledgeAudit({ items, steps, usage }, { dryRun: true });
  assert.deepEqual(planned.proposals.map((p) => [p.key, p.status]).sort(), [
    ["r1-rule-b", "skipped"],
    ["r1-skill-b", "planned"],
  ]);
  await knowledge.update("r1-skill-a", { content: "canonical drifted" });
  const applied = await remediateKnowledgeAudit(
    { items, steps, usage },
    { autoApply: true, operator: "tester" },
  );
  const skill = applied.proposals.find((p) => p.key === "r1-skill-b")!;
  assert.equal(skill.status, "skipped");
  assert.match(skill.reason!, /canonical item changed/);
  assert.equal((await knowledge.get("r1-skill-b")).enabled, true);
  assert.equal((await knowledge.get("r1-rule-b")).enabled, true);
  const evidence = (
    await pool.query("SELECT evidence FROM knowledge_proposals WHERE id=$1", [skill.proposalId])
  ).rows[0].evidence;
  assert.equal(evidence[0].ref.operator, "tester");
});

test("audit actor cannot deprecate business rules or bypass the enforced guard", async () => {
  const { createProposal, approveProposal, AUDIT_ACTOR } =
    await import("../src/knowledge/proposals.ts");
  await knowledge.create({
    key: "r4-rule",
    title: "r4",
    category: "business_rule",
    scope_type: "GLOBAL",
    content: "r4 rule",
  });
  await knowledge.create({
    key: "r4-enforced",
    title: "r4e",
    category: "agent_skill",
    scope_type: "GLOBAL",
    content: "r4 enforced",
    enforced: true,
  });
  const evidence = [
    { source: "knowledge_audit", ref: {}, author: AUDIT_ACTOR, trust: "platform", quote: "x" },
  ];
  const base = {
    ownerId: null,
    changeType: "DEPRECATE" as const,
    proposed: {},
    createdBy: AUDIT_ACTOR,
    auditReviewOnly: true,
    sourceKind: "manual",
    evidence,
  };
  await assert.rejects(createProposal({ ...base, targetKey: "r4-enforced" } as any), /enforced/);
  const { proposal } = await createProposal({ ...base, targetKey: "r4-rule" } as any);
  await assert.rejects(approveProposal(proposal.id, { by: AUDIT_ACTOR }), /business rule/);
  assert.equal((await knowledge.get("r4-rule")).enabled, true);
});

test("DEPRECATE rollback leaves supersession it did not set untouched", async () => {
  const { createProposal, approveProposal } = await import("../src/knowledge/proposals.ts");
  for (const key of ["r3-old", "r3-new"])
    await knowledge.create({
      key,
      title: key,
      category: "agent_skill",
      scope_type: "GLOBAL",
      content: key,
      applicability: { step_keys: ["implement"] },
    });
  const successor = await knowledge.get("r3-new");
  await pool.query(
    "UPDATE knowledge_items SET superseded_by=$2 WHERE key=$1 AND owner_id IS NULL",
    ["r3-old", successor.id],
  );
  const { proposal } = await createProposal({
    ownerId: null,
    changeType: "DEPRECATE",
    targetKey: "r3-old",
    proposed: {},
    createdBy: "admin",
    sourceKind: "manual",
    evidence: [{ source: "requirement", ref: {}, author: "admin", trust: "human", quote: "old" }],
  } as any);
  await approveProposal(proposal.id, { by: "admin" });
  // Proposals applied before supersession was recorded carry no previous_superseded_by.
  await pool.query(
    "UPDATE knowledge_proposals SET applied = applied - 'previous_superseded_by' - 'previous_superseded_at' WHERE id=$1",
    [proposal.id],
  );
  await rollbackProposal(proposal.id, { by: "admin" });
  const old = await knowledge.get("r3-old");
  assert.equal(old.enabled, true);
  assert.equal(Number(old.superseded_by), Number(successor.id));
});

test("third-party skills cannot be reverted away from their pinned manifest", async () => {
  await assert.rejects(knowledge.revert("skill.ext.ponytail", 1, null, "admin"), /re-import/);
});

test("Ponytail pilot is not a public built-in template and reviews like the built-in review step", async () => {
  const { TEMPLATES, PONYTAIL_PILOT_TEMPLATE } = await import("../src/workflow/templates.ts");
  assert.ok(!TEMPLATES.some((t) => t.key === PONYTAIL_PILOT_TEMPLATE.key));
  const review = PONYTAIL_PILOT_TEMPLATE.spec.steps.find((s) => s.key === "review")!
    .config as Record<string, unknown>;
  assert.equal(review.independent, true);
  assert.equal(review.max_repairs, 2);
  assert.ok(review.output_contract);
  assert.deepEqual(review.skills, ["skill.ext.ponytail-review"]);
});
