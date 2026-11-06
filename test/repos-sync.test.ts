import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { writeFileSync } from "node:fs";
import { repositories, syncRepositoriesFromConfig, repoPath, projectScope } from "../src/repos/service.ts";
import { frontmatter, importFromRepositories, looksSecret } from "../src/knowledge/importer.ts";
import { knowledge } from "../src/knowledge/service.ts";

after(() => pool.end());

test("group folders (e.g. oms-src/) are expanded into their git repos; local non-repos leave shared metadata unchanged", async () => {
  await migrate();
  for (const p of ["oms-src/oms-api", "oms-src/oms-background", "solo"]) mkdirSync(join(config.reposRoot, p, ".git"), { recursive: true });
  mkdirSync(join(config.reposRoot, "oms-src", "docs"), { recursive: true }); // not a repo
  await repositories.upsert("oms-src", { projects: ["OMS"] }); // what the old sync registered
  await syncRepositoriesFromConfig();
  const byName = Object.fromEntries((await repositories.list()).map((r) => [r.name, r]));
  assert.equal(byName["oms-api"].path, "oms-src/oms-api");
  assert.equal(repoPath(byName["oms-api"]), join(config.reposRoot, "oms-src/oms-api"));
  assert.ok(byName["oms-api"].projects.includes("OMS"), "mapped via config.projects OMS → oms-api");
  assert.equal(byName["oms-background"].path, "oms-src/oms-background");
  assert.equal(byName["solo"], undefined, "a checkout under reposRoot that no project maps is not registered");
  assert.equal(byName["oms-src"].enabled, true, "local filesystem cannot disable a shared entry");
  assert.equal(byName["docs"], undefined);
  assert.deepEqual((await repositories.allowedFor("OMS")).sort(), ["oms-api", "oms-background", "oms-src"]);
});

test("shared registry: a repo missing on this machine stays enabled; a known project never widens to every repo", async () => {
  await repositories.upsert("elsewhere-only", { path: "other-src/elsewhere-only", projects: ["Other"] }); // another machine's checkout
  await repositories.upsert("unrelated-tool", { path: "github/unrelated-tool" });
  await syncRepositoriesFromConfig();
  assert.equal((await repositories.get("elsewhere-only"))!.enabled, true, "not on this disk is not a reason to disable a shared row");
  for (const n of ["oms-api", "oms-background", "oms-src"]) await repositories.upsert(n, { enabled: false });
  try {
    assert.deepEqual(await repositories.allowedFor("OMS"), [], "OMS has repositories (all disabled): never falls back to unrelated ones");
    assert.ok((await repositories.allowedFor("NoSuchProject")).includes("unrelated-tool"), "an unknown project still sees every enabled repo");
  } finally {
    for (const n of ["oms-api", "oms-background", "oms-src"]) await repositories.upsert(n, { enabled: true });
    await q(pool, "DELETE FROM repositories WHERE name IN ('elsewhere-only', 'unrelated-tool')");
  }
});

test("projectScope: related projects link both ways, one hop, case-insensitive", () => {
  const related = { OMS: ["Payment", "Payment (New)"], Payment: ["Ledger"] };
  assert.deepEqual(projectScope("OMS", related).sort(), ["oms", "payment", "payment (new)"]);
  assert.deepEqual(projectScope("payment (new)", related).sort(), ["oms", "payment (new)"], "reverse direction");
  assert.deepEqual(projectScope("Payment", related).sort(), ["ledger", "oms", "payment"]);
  assert.ok(!projectScope("OMS", related).includes("ledger"), "one hop only: Payment's links are not OMS's");
  assert.deepEqual(projectScope("Other", related), ["other"]);
  assert.deepEqual(projectScope("  ", related), []);
});

test("allowedFor: a run for a project also sees the repositories of its related projects", async () => {
  await repositories.upsert("payment-core", { path: "payment-src/payment-core", projects: ["Payment"] });
  const saved = config.relatedProjects;
  try {
    config.relatedProjects = {};
    assert.ok(!(await repositories.allowedFor("Payment")).includes("oms-api"), "unlinked: OMS repos stay out of a Payment run");
    config.relatedProjects = { OMS: ["Payment"] };
    const forPayment = await repositories.allowedFor("Payment");
    assert.ok(forPayment.includes("payment-core") && forPayment.includes("oms-api") && forPayment.includes("oms-background"));
    assert.ok((await repositories.allowedFor("oms")).includes("payment-core"), "link works from the other side too");
    assert.ok(!(await repositories.allowedFor("Payment")).includes("unrelated-tool"));
  } finally {
    config.relatedProjects = saved;
    await q(pool, "DELETE FROM repositories WHERE name = 'payment-core'");
  }
});

test("repository knowledge import: CLAUDE.md, shared skills, secrets skipped, re-import versions only changes", async () => {
  const api = join(config.reposRoot, "oms-src/oms-api"), bg = join(config.reposRoot, "oms-src/oms-background");
  writeFileSync(join(api, "CLAUDE.md"), "# oms-api\n\nMoney fields are int64 VND.\n");
  writeFileSync(join(api, "AGENTS.md"), "# oms-api\n\nMoney fields are int64 VND.\n"); // duplicate of CLAUDE.md
  for (const d of [api, bg]) {
    mkdirSync(join(d, ".claude/skills/solid"), { recursive: true });
    writeFileSync(join(d, ".claude/skills/solid/SKILL.md"), "---\nname: solid\ndescription: apply SOLID\n---\n# SOLID\nSRP first.\n");
  }
  mkdirSync(join(bg, "docs"), { recursive: true });
  writeFileSync(join(bg, "CLAUDE.md"), "# bg\nDB_PASSWORD=Sup3rS3cretValue123\n");
  const r1 = await importFromRepositories();
  const keys = r1.candidates.map((c) => c.key);
  assert.ok(keys.includes("oms-api.claude"));
  assert.ok(!keys.includes("oms-api.agents"), "identical AGENTS.md is not imported twice");
  assert.ok(r1.skipped.some((s) => s.path === "oms-background/CLAUDE.md" && /credentials/.test(s.reason)));
  const solid = (await knowledge.get("skill.solid"))!;
  assert.deepEqual(solid.versions[0].applicability.repos.sort(), ["oms-api", "oms-background"]);
  assert.equal(solid.versions[0].metadata.load, "on_demand");
  assert.equal(solid.versions[0].metadata.description, "apply SOLID");
  const r2 = await importFromRepositories();
  assert.equal(r2.created + r2.updated, 0, "unchanged files create no versions");
  writeFileSync(join(api, "CLAUDE.md"), "# oms-api\n\nMoney fields are int64 VND. Refund once.\n");
  const r3 = await importFromRepositories();
  assert.equal(r3.updated, 1);
  assert.equal((await knowledge.get("oms-api.claude"))!.versions.length, 2);
  assert.ok(looksSecret("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjM0NjI4fQ.Ktmu1SKlCfLAw0aP0e1_37SNNOSk"));
  assert.ok(!looksSecret("set API_KEY=<your key> in .env"));
  assert.equal(frontmatter("---\nname: x\n---\nbody").fields.name, "x");
});

test("user-level ~/.claude skills: imported once (copies of repo skills skipped), autonomous workflow skills disabled", async () => {
  const dir = join(config.reposRoot, "..", "user-skills");
  for (const [n, body] of [["solid", "---\nname: solid\ndescription: apply SOLID\n---\n# SOLID\nSRP first.\n"], ["tdd", "---\nname: tdd\ndescription: red green refactor\n---\n# TDD\n"], ["pr", "---\nname: pr\ndescription: push and open a PR\n---\n# PR\n"]] as const) {
    mkdirSync(join(dir, n), { recursive: true });
    writeFileSync(join(dir, n, "SKILL.md"), body);
  }
  process.env.CLAUDE_USER_SKILLS_DIR = dir;
  const r = await importFromRepositories();
  const keys = r.candidates.map((c) => c.key);
  assert.ok(!keys.includes("user.skill.solid"), "identical to the repository copy of solid");
  const solidItem = (await knowledge.get("skill.solid"))!;
  assert.equal(solidItem.scope_type, "ORGANIZATION", "was available everywhere via ~/.claude: widened, not limited to the repos holding a copy");
  assert.deepEqual(solidItem.versions[0].applicability, {});
  assert.ok(keys.includes("user.skill.tdd"));
  const tdd = (await knowledge.get("user.skill.tdd"))!;
  assert.equal(tdd.scope_type, "ORGANIZATION");
  assert.equal(tdd.enabled, true);
  assert.equal((await knowledge.get("user.skill.pr"))!.enabled, false, "pushes/opens PRs on its own: imported disabled");
  process.env.CLAUDE_USER_SKILLS_DIR = join(config.reposRoot, "..", "empty-user-skills");
  assert.ok((await repositories.get("oms-api"))!.description.includes("Money fields"), "repo description filled from CLAUDE.md");
});

test("wiki import: conventions inlined for sibling code repos, conflicts.md imported, removed docs retired and revived", async () => {
  const wiki = join(config.reposRoot, "pay-src/pay-wiki"), core = join(config.reposRoot, "pay-src/pay-core");
  for (const d of [wiki, core]) mkdirSync(join(d, ".git"), { recursive: true });
  mkdirSync(join(wiki, "docs/development"), { recursive: true });
  mkdirSync(join(wiki, "docs/flows"), { recursive: true });
  mkdirSync(join(wiki, ".inventory"), { recursive: true });
  writeFileSync(join(wiki, "docs/development/conventions.md"), "# Conventions\n\nErrors wrap with %w.\n");
  writeFileSync(join(wiki, "docs/flows/refund.md"), "# Refund\n\nTwo steps.\n");
  writeFileSync(join(wiki, "docs/flows/old.md"), "# Old flow\n\nGone soon.\n");
  writeFileSync(join(wiki, ".inventory/conflicts.md"), "# conflicts\n\nOutbox is async.\n");
  writeFileSync(join(wiki, ".inventory/env-vars.md"), "# env\n");
  await repositories.upsert("pay-wiki", { path: "pay-src/pay-wiki", projects: ["Pay"] });
  await repositories.upsert("pay-core", { path: "pay-src/pay-core", projects: ["Pay"] });
  const r1 = await importFromRepositories();
  const keys = r1.candidates.map((c) => c.key);
  const conv = (await knowledge.get("pay-wiki.conventions"))!;
  assert.equal(conv.scope_type, "GLOBAL");
  assert.deepEqual(conv.versions[0].applicability, { repos: ["pay-core"] }, "applies to the code repos next to the wiki");
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
  assert.equal((await knowledge.get("pay-wiki.docs.flows.old"))!.enabled, true, "source is back: re-enabled");
});

test("looksSecret ignores config-path references but still catches literal values", () => {
  assert.ok(!looksSecret("secretB64 = payment_client.ecom_global.secret"));
  assert.ok(looksSecret("secretB64 = c2VjcmV0dmFsdWVfMTIzNDU2Nzg5"));
  assert.ok(looksSecret("api_key: 9f8e7d6c5b4a39281706"));
});
