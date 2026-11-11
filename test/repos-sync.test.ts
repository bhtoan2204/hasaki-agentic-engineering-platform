import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { writeFileSync } from "node:fs";
import {
  repositories,
  syncRepositoriesFromConfig,
  repoPath,
  projectScope,
} from "../src/repos/service.ts";
import {
  frontmatter,
  importFromRepositories,
  importSkillDirectory,
  looksSecret,
} from "../src/knowledge/importer.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { knowledgeRestricted } from "../src/knowledge/visibility.ts";
import { createUser } from "../src/auth/users.ts";
import { allowedRepositoriesForRun } from "../src/repos/access.ts";

after(() => pool.end());

/**
 * Project mapping is now one input of user-scoped access (repos/access.ts): these tests look at the mapping alone, so
 * every repository is shared for reading with the test user and the result is what that user's run would get.
 */
let syncUser: number | null = null;
async function allowedFor(project: string) {
  syncUser ??= Number(
    (await createUser({ username: "sync-user", password: "sync-user-password", role: "member" }))
      .id,
  );
  await q(pool, "UPDATE repositories SET shared_access = 'read' WHERE shared_access = 'none'");
  return allowedRepositoriesForRun(syncUser, project);
}

test("group folders (e.g. oms-src/) are expanded into their git repos; local non-repos leave shared metadata unchanged", async () => {
  await migrate();
  for (const p of ["oms-src/oms-api", "oms-src/oms-background", "solo"])
    mkdirSync(join(config.reposRoot, p, ".git"), { recursive: true });
  mkdirSync(join(config.reposRoot, "oms-src", "docs"), { recursive: true }); // not a repo
  await repositories.upsert("oms-src", { projects: ["OMS"] }); // what the old sync registered
  await syncRepositoriesFromConfig();
  const byName = Object.fromEntries((await repositories.list()).map((r) => [r.name, r]));
  assert.equal(byName["oms-api"].path, "oms-src/oms-api");
  assert.equal(repoPath(byName["oms-api"]), join(config.reposRoot, "oms-src/oms-api"));
  assert.ok(byName["oms-api"].projects.includes("OMS"), "mapped via config.projects OMS → oms-api");
  assert.equal(byName["oms-background"].path, "oms-src/oms-background");
  assert.equal(
    byName["solo"],
    undefined,
    "a checkout under reposRoot that no project maps is not registered",
  );
  assert.equal(byName["oms-src"].enabled, true, "local filesystem cannot disable a shared entry");
  assert.equal(byName["docs"], undefined);
  assert.deepEqual((await allowedFor("OMS")).sort(), ["oms-api", "oms-background", "oms-src"]);
});

test("shared registry: a repo missing on this machine stays enabled; a known project never widens to every repo", async () => {
  await repositories.upsert("elsewhere-only", {
    path: "other-src/elsewhere-only",
    projects: ["Other"],
  }); // another machine's checkout
  await repositories.upsert("unrelated-tool", { path: "github/unrelated-tool" });
  await syncRepositoriesFromConfig();
  assert.equal(
    (await repositories.get("elsewhere-only"))!.enabled,
    true,
    "not on this disk is not a reason to disable a shared row",
  );
  for (const n of ["oms-api", "oms-background", "oms-src"])
    await repositories.upsert(n, { enabled: false });
  try {
    assert.deepEqual(
      await allowedFor("OMS"),
      [],
      "OMS has repositories (all disabled): never falls back to unrelated ones",
    );
    assert.ok(
      (await allowedFor("NoSuchProject")).includes("unrelated-tool"),
      "an unknown project sees every enabled repo the user may read",
    );
  } finally {
    for (const n of ["oms-api", "oms-background", "oms-src"])
      await repositories.upsert(n, { enabled: true });
    await q(pool, "DELETE FROM repositories WHERE name IN ('elsewhere-only', 'unrelated-tool')");
  }
});

test("projectScope: related projects link both ways, one hop, case-insensitive", () => {
  const related = { OMS: ["Payment", "Payment (New)"], Payment: ["Ledger"] };
  assert.deepEqual(projectScope("OMS", related).sort(), ["oms", "payment", "payment (new)"]);
  assert.deepEqual(
    projectScope("payment (new)", related).sort(),
    ["oms", "payment (new)"],
    "reverse direction",
  );
  assert.deepEqual(projectScope("Payment", related).sort(), ["ledger", "oms", "payment"]);
  assert.ok(
    !projectScope("OMS", related).includes("ledger"),
    "one hop only: Payment's links are not OMS's",
  );
  assert.deepEqual(projectScope("Other", related), ["other"]);
  assert.deepEqual(projectScope("  ", related), []);
});

test("allowed repositories: a run for a project also sees the repositories of its related projects", async () => {
  await repositories.upsert("payment-core", {
    path: "payment-src/payment-core",
    projects: ["Payment"],
  });
  const saved = config.relatedProjects;
  try {
    config.relatedProjects = {};
    assert.ok(
      !(await allowedFor("Payment")).includes("oms-api"),
      "unlinked: OMS repos stay out of a Payment run",
    );
    config.relatedProjects = { OMS: ["Payment"] };
    const forPayment = await allowedFor("Payment");
    assert.ok(
      forPayment.includes("payment-core") &&
        forPayment.includes("oms-api") &&
        forPayment.includes("oms-background"),
    );
    assert.ok(
      (await allowedFor("oms")).includes("payment-core"),
      "link works from the other side too",
    );
    assert.ok(!(await allowedFor("Payment")).includes("unrelated-tool"));
  } finally {
    config.relatedProjects = saved;
    await q(pool, "DELETE FROM repositories WHERE name = 'payment-core'");
  }
});

test("repository knowledge import: CLAUDE.md, shared skills, secrets skipped, re-import versions only changes", async () => {
  const api = join(config.reposRoot, "oms-src/oms-api"),
    bg = join(config.reposRoot, "oms-src/oms-background");
  writeFileSync(join(api, "CLAUDE.md"), "# oms-api\n\nMoney fields are int64 VND.\n");
  writeFileSync(join(api, "AGENTS.md"), "# oms-api\n\nMoney fields are int64 VND.\n"); // duplicate of CLAUDE.md
  for (const d of [api, bg]) {
    mkdirSync(join(d, ".claude/skills/solid"), { recursive: true });
    writeFileSync(
      join(d, ".claude/skills/solid/SKILL.md"),
      "---\nname: solid\ndescription: apply SOLID\n---\n# SOLID\nSRP first.\n",
    );
  }
  mkdirSync(join(bg, "docs"), { recursive: true });
  writeFileSync(join(bg, "CLAUDE.md"), "# bg\nDB_PASSWORD=Sup3rS3cretValue123\n");
  const r1 = await importFromRepositories();
  const keys = r1.candidates.map((c) => c.key);
  assert.ok(keys.includes("oms-api.claude"));
  assert.ok(!keys.includes("oms-api.agents"), "identical AGENTS.md is not imported twice");
  assert.ok(
    r1.skipped.some((s) => s.path === "oms-background/CLAUDE.md" && /credentials/.test(s.reason)),
  );
  const solid = (await knowledge.get("skill.solid"))!;
  assert.deepEqual(solid.versions[0].applicability.repos.sort(), ["oms-api", "oms-background"]);
  assert.equal(
    `${solid.scope_type}:${solid.scope_ref}`,
    "PROJECT:OMS",
    "several repositories of one project → PROJECT scope (repo list kept)",
  );
  assert.equal(solid.versions[0].metadata.load, "on_demand");
  assert.equal(solid.versions[0].metadata.description, "apply SOLID");
  const r2 = await importFromRepositories();
  assert.equal(r2.created + r2.updated, 0, "unchanged files create no versions");
  writeFileSync(join(api, "CLAUDE.md"), "# oms-api\n\nMoney fields are int64 VND. Refund once.\n");
  const r3 = await importFromRepositories();
  assert.equal(r3.updated, 1);
  assert.equal((await knowledge.get("oms-api.claude"))!.versions.length, 2);
  assert.ok(
    looksSecret("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjM0NjI4fQ.Ktmu1SKlCfLAw0aP0e1_37SNNOSk"),
  );
  assert.ok(!looksSecret("set API_KEY=<your key> in .env"));
  assert.equal(frontmatter("---\nname: x\n---\nbody").fields.name, "x");
});

test("visibility: ~/.claude user skills are never hidden; local skill imports follow their repository's access", () => {
  const readable = new Set(["oms-api"]);
  const user = {
    scope_type: "ORGANIZATION",
    metadata: {
      imported_from_repository: true,
      source: [{ repo: "~/.claude", path: "skills/x/SKILL.md" }],
    },
  };
  assert.equal(
    knowledgeRestricted(user, new Set()),
    false,
    "not repository content: visible to everyone",
  );
  const local = (repo: string) => ({
    scope_type: "GLOBAL",
    metadata: {
      imported_from_local_skill: true,
      source: [{ repo, path: ".claude/skills/x/SKILL.md" }],
    },
  });
  assert.equal(
    knowledgeRestricted(local("payment-fptpay"), readable),
    true,
    "no read access to the attributed repository",
  );
  assert.equal(knowledgeRestricted(local("oms-api"), readable), false);
  const repoImport = {
    scope_type: "GLOBAL",
    metadata: { imported_from_repository: true, source: [{ repo: "payment-fptpay", path: "a" }] },
  };
  assert.equal(
    knowledgeRestricted(repoImport, readable),
    true,
    "unchanged rule for repository imports",
  );
});

test("delete: a skill goes with its supporting files, leaves a tombstone, and neither import nor seed brings it back", async () => {
  const api = join(config.reposRoot, "oms-src/oms-api");
  const dir = join(api, ".claude/skills/del-me");
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: del-me\ndescription: to delete\n---\n# Del\n");
  writeFileSync(join(dir, "reference/a.md"), "# A\n");
  await importFromRepositories({ only: "skill.del-me" });
  assert.ok(await knowledge.get("skill.del-me.reference.a"));
  const r = await knowledge.remove("skill.del-me", { by: "admin", reason: "unused" });
  assert.deepEqual(r.deleted.sort(), ["skill.del-me", "skill.del-me.reference.a"]);
  assert.equal(await knowledge.get("skill.del-me"), undefined);
  assert.equal(
    await knowledge.get("skill.del-me.reference.a"),
    undefined,
    "supporting files are deleted with the skill",
  );
  const tomb = (
    await q<any>(pool, "SELECT * FROM knowledge_deletions WHERE key = 'skill.del-me'")
  )[0];
  assert.equal(tomb.reason, "unused");
  assert.equal(
    tomb.snapshot.versions[0].content.includes("# Del"),
    true,
    "snapshot keeps the content for a manual restore",
  );
  const again = await importFromRepositories({ only: "skill.del-me" });
  assert.equal(
    again.created,
    0,
    "the source file still exists, but a deleted key is not re-imported",
  );
  assert.ok(again.skipped.some((s) => /skill\.del-me was deleted/.test(s.reason)));
  writeFileSync(join(dir, "reference/b.md"), "# B\n"); // a supporting file added after the deletion
  assert.equal(
    (await importFromRepositories({ only: "skill.del-me" })).created,
    0,
    "supporting files of a deleted skill are not imported either",
  );
  // An explicit re-creation lifts the tombstone.
  await knowledge.create({
    key: "skill.del-me",
    category: "agent_skill",
    scope_type: "GLOBAL",
    title: "back",
    content: "x",
  });
  assert.equal(
    (await q(pool, "SELECT 1 FROM knowledge_deletions WHERE key = 'skill.del-me'")).length,
    0,
  );
  await knowledge.remove("skill.del-me", { by: "admin" });
  rmSync(dir, { recursive: true, force: true });
});

test("frontmatter: folded / literal block scalars and indented continuations", () => {
  const f = frontmatter(
    "---\nname: gw\ndescription: >-\n  Gateway contract —\n  use when signing.\nnotes: |\n  line one\n  line two\nplain: first\n  second\n---\n# Body\n",
  ).fields;
  assert.equal(f.name, "gw");
  assert.equal(f.description, "Gateway contract — use when signing.");
  assert.equal(f.notes, "line one\nline two");
  assert.equal(f.plain, "first second");
});

test("skill import carries supporting files: one item per reference/script, footer maps paths to keys", async () => {
  const api = join(config.reposRoot, "oms-src/oms-api");
  const dir = join(api, ".claude/skills/gw-card");
  mkdirSync(join(dir, "reference"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: gw-card\ndescription: >-\n  Gateway card API contract.\n  Use when signing requests.\n---\n# GW\nSee [codes](reference/codes.md).\n",
  );
  writeFileSync(join(dir, "reference/codes.md"), "# Result codes\n\n-12 CARD_REJECTED\n");
  writeFileSync(
    join(dir, "scripts/sign.py"),
    "import hashlib\nprint(hashlib.sha256(b'x').hexdigest())\n",
  );
  writeFileSync(join(dir, "reference/leak.md"), "# Leak\nclient_secret: Sup3rS3cretValue123456\n");
  const r = await importFromRepositories({ only: "skill.gw-card" });
  assert.deepEqual(r.candidates.map((c) => c.key).sort(), [
    "skill.gw-card",
    "skill.gw-card.reference.codes",
    "skill.gw-card.scripts.sign.py",
  ]);
  assert.ok(
    r.skipped.some((s) => /reference\/leak\.md$/.test(s.path) && /credentials/.test(s.reason)),
    "companions go through the secret check",
  );
  const skill = (await knowledge.get("skill.gw-card"))!;
  const v = skill.versions[0];
  assert.equal(v.metadata.description, "Gateway card API contract. Use when signing requests.");
  assert.deepEqual(v.metadata.companions, [
    "skill.gw-card.reference.codes",
    "skill.gw-card.scripts.sign.py",
  ]);
  assert.match(
    v.content,
    /`reference\/codes\.md` → `read_knowledge key=skill\.gw-card\.reference\.codes`/,
  );
  assert.match(v.content, /`scripts\/sign\.py` → .*script: write it to a temporary file/);
  const ref = (await knowledge.get("skill.gw-card.reference.codes"))!;
  assert.equal(ref.category, "agent_skill");
  assert.equal(ref.versions[0].metadata.parent_skill, "skill.gw-card");
  assert.equal(ref.versions[0].metadata.description, "Result codes");
  assert.deepEqual(ref.versions[0].applicability, {});
  assert.equal(
    `${ref.scope_type}:${ref.scope_ref}`,
    "REPOSITORY:oms-api",
    "one repository → REPOSITORY scope, like its parent skill",
  );
  assert.equal(`${skill.scope_type}:${skill.scope_ref}`, "REPOSITORY:oms-api");
  assert.equal(
    ref.versions[0].metadata.source[0].path,
    ".claude/skills/gw-card/reference/codes.md",
  );
  assert.equal(
    (await importFromRepositories({ only: "skill.gw-card" })).created +
      (await importFromRepositories({ only: "skill.gw-card" })).updated,
    0,
    "re-import is idempotent",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("importSkillDirectory: a local, not-yet-committed skill is attributed to a repo but never import-owned", async () => {
  const dir = join(config.reposRoot, "..", "local-skills", "draft-skill");
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: draft-skill\ndescription: Draft contract.\n---\n# Draft\n",
  );
  writeFileSync(join(dir, "reference/api.md"), "# API\n");
  const r = await importSkillDirectory({ dir, repo: "oms-api" });
  assert.equal(r.created, 2);
  const item = (await knowledge.get("skill.draft-skill"))!;
  assert.equal(
    item.versions[0].metadata.imported_from_repository,
    undefined,
    "retirement never disables it before the skill lands in the checkout",
  );
  assert.equal(
    item.versions[0].metadata.imported_from_local_skill,
    true,
    "but visibility still follows oms-api access",
  );
  assert.equal(`${item.scope_type}:${item.scope_ref}`, "REPOSITORY:oms-api");
  assert.deepEqual(item.versions[0].applicability, {});
  assert.equal(item.versions[0].metadata.source[0].path, ".claude/skills/draft-skill/SKILL.md");
  await importFromRepositories();
  assert.equal(
    (await knowledge.get("skill.draft-skill"))!.enabled,
    true,
    "a full repository import leaves it alone",
  );
  assert.equal((await importSkillDirectory({ dir, repo: "oms-api" })).unchanged, 2);
  await assert.rejects(importSkillDirectory({ dir, repo: "no-such-repo" }), /unknown repository/);
});

test("user-level ~/.claude skills: imported once (copies of repo skills skipped), autonomous workflow skills disabled", async () => {
  const dir = join(config.reposRoot, "..", "user-skills");
  for (const [n, body] of [
    ["solid", "---\nname: solid\ndescription: apply SOLID\n---\n# SOLID\nSRP first.\n"],
    ["tdd", "---\nname: tdd\ndescription: red green refactor\n---\n# TDD\n"],
    ["pr", "---\nname: pr\ndescription: push and open a PR\n---\n# PR\n"],
    ["oms-carrier-x", "---\nname: oms-carrier-x\ndescription: carrier X API contract\n---\n# X\n"],
  ] as const) {
    mkdirSync(join(dir, n), { recursive: true });
    writeFileSync(join(dir, n, "SKILL.md"), body);
  }
  process.env.CLAUDE_USER_SKILLS_DIR = dir;
  const r = await importFromRepositories();
  const keys = r.candidates.map((c) => c.key);
  assert.ok(!keys.includes("user.skill.solid"), "identical to the repository copy of solid");
  const solidItem = (await knowledge.get("skill.solid"))!;
  assert.equal(
    solidItem.scope_type,
    "ORGANIZATION",
    "was available everywhere via ~/.claude: widened, not limited to the repos holding a copy",
  );
  assert.deepEqual(solidItem.versions[0].applicability, {});
  assert.ok(keys.includes("user.skill.tdd"));
  const tdd = (await knowledge.get("user.skill.tdd"))!;
  assert.equal(tdd.scope_type, "ORGANIZATION");
  assert.equal(tdd.enabled, true);
  assert.equal(
    (await knowledge.get("user.skill.pr"))!.enabled,
    false,
    "pushes/opens PRs on its own: imported disabled",
  );
  const carrier = (await knowledge.get("user.skill.oms-carrier-x"))!;
  assert.equal(
    `${carrier.scope_type}:${carrier.scope_ref}`,
    "PROJECT:OMS",
    "named after the OMS repositories (oms-*): OMS only, never Payment",
  );
  process.env.CLAUDE_USER_SKILLS_DIR = join(config.reposRoot, "..", "empty-user-skills");
  assert.ok(
    (await repositories.get("oms-api"))!.description.includes("Money fields"),
    "repo description filled from CLAUDE.md",
  );
});

test("wiki import: conventions inlined for sibling code repos, conflicts.md imported, removed docs retired and revived", async () => {
  const wiki = join(config.reposRoot, "pay-src/pay-wiki"),
    core = join(config.reposRoot, "pay-src/pay-core");
  for (const d of [wiki, core]) mkdirSync(join(d, ".git"), { recursive: true });
  mkdirSync(join(wiki, "docs/development"), { recursive: true });
  mkdirSync(join(wiki, "docs/flows"), { recursive: true });
  mkdirSync(join(wiki, ".inventory"), { recursive: true });
  writeFileSync(
    join(wiki, "docs/development/conventions.md"),
    "# Conventions\n\nErrors wrap with %w.\n",
  );
  writeFileSync(join(wiki, "docs/flows/refund.md"), "# Refund\n\nTwo steps.\n");
  writeFileSync(join(wiki, "docs/flows/old.md"), "# Old flow\n\nGone soon.\n");
  writeFileSync(join(wiki, ".inventory/conflicts.md"), "# conflicts\n\nOutbox is async.\n");
  writeFileSync(join(wiki, ".inventory/env-vars.md"), "# env\n");
  await repositories.upsert("pay-wiki", { path: "pay-src/pay-wiki", projects: ["Pay"] });
  await repositories.upsert("pay-core", { path: "pay-src/pay-core", projects: ["Pay"] });
  const r1 = await importFromRepositories();
  const keys = r1.candidates.map((c) => c.key);
  const conv = (await knowledge.get("pay-wiki.conventions"))!;
  assert.equal(
    `${conv.scope_type}:${conv.scope_ref}`,
    "REPOSITORY:pay-core",
    "applies to the code repo next to the wiki",
  );
  assert.deepEqual(conv.versions[0].applicability, {});
  const refund = (await knowledge.get("pay-wiki.docs.flows.refund"))!;
  assert.equal(
    `${refund.scope_type}:${refund.scope_ref}`,
    "PROJECT:Pay",
    "wiki docs are scoped to the project they document",
  );
  assert.equal(conv.versions[0].metadata.load, "inline");
  assert.ok(!keys.includes("pay-wiki.docs.development.conventions"), "not imported twice");
  assert.ok(keys.includes("pay-wiki.inventory.conflicts"), "conflicts.md imported");
  assert.ok(!keys.some((k) => /env-vars/.test(k)), "other .inventory files are not");
  assert.ok(keys.includes("pay-wiki.docs.flows.old"));

  rmSync(join(wiki, "docs/flows/old.md"));
  const r2 = await importFromRepositories();
  assert.equal(r2.retired, 1);
  const old = (await knowledge.get("pay-wiki.docs.flows.old"))!;
  assert.equal(old.enabled, false);
  assert.match(old.versions[0].metadata.retired_reason, /docs\/flows\/old\.md/);
  assert.equal((await knowledge.get("pay-wiki.docs.flows.refund"))!.enabled, true);
  assert.equal((await importFromRepositories()).retired, 0, "already retired: nothing more to do");

  writeFileSync(join(wiki, "docs/flows/old.md"), "# Old flow\n\nGone soon.\n");
  await importFromRepositories();
  assert.equal(
    (await knowledge.get("pay-wiki.docs.flows.old"))!.enabled,
    true,
    "source is back: re-enabled",
  );
});

test("looksSecret ignores config-path references but still catches literal values", () => {
  assert.ok(!looksSecret("secretB64 = payment_client.ecom_global.secret"));
  assert.ok(looksSecret("secretB64 = c2VjcmV0dmFsdWVfMTIzNDU2Nzg5"));
  assert.ok(looksSecret("api_key: 9f8e7d6c5b4a39281706"));
});
