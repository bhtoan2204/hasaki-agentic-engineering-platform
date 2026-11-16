/**
 * `npm run knowledge:rescope [-- --dry-run]` — recompute the scope of existing shared knowledge with the importer's
 * rules (knowledge/importer.ts "scope derivation") without re-importing: one repository → REPOSITORY, one project →
 * PROJECT, generic user-level skills → ORGANIZATION, genuinely cross-project items unchanged. Content is never
 * touched and nothing is retired, so it is safe where the platform-managed checkouts lack files that were imported
 * earlier from a local path. Idempotent; a later import derives the same scopes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pool } from "../db/pool.ts";
import { migrate } from "../db/migrate.ts";
import { knowledge } from "../knowledge/service.ts";
import { repositories } from "../repos/service.ts";
import {
  scopeForProjects,
  scopeForRepositories,
  scopeForUserSkill,
  type ScopeSpec,
} from "../knowledge/importer.ts";
import { hashOf } from "../workflow/definitions.ts";

const dryRun = process.argv.includes("--dry-run");
await migrate();
const all = await repositories.list();
const items = ((await knowledge.list()) as any[]).filter(
  (it) => it.owner_id == null && it.scope_type !== "REPOSITORY" && it.category !== "task_memory",
);

const skillName = (path: string) => path.split("/").slice(-2, -1)[0] ?? "";
const userDir = process.env.CLAUDE_USER_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
/**
 * Same rule as the importer: a repository skill identical to a ~/.claude copy was available everywhere and is widened
 * (to its project, or the organization). Without that copy on this machine, fall back to the widened shapes already
 * in the registry (ORGANIZATION, or PROJECT without a repository list).
 */
function widened(name: string, source: { sha256?: string }, it: any): boolean {
  const copy = join(userDir, name, "SKILL.md");
  if (existsSync(copy) && source.sha256)
    return createHash("sha256").update(readFileSync(copy, "utf8")).digest("hex") === source.sha256;
  return (
    it.scope_type === "ORGANIZATION" ||
    (it.scope_type === "PROJECT" && !(it.applicability?.repos?.length > 0))
  );
}
const isSkillPath = (path: string) => /(^|\/)skills\/[^/]+\/[^/]+$/.test(path);

/** The scope the importer would derive today; null = leave as is (cross-project or not derivable). */
function target(it: any): ScopeSpec | null {
  const meta = it.metadata ?? {};
  const app = it.applicability ?? {};
  const sources: { repo: string; path: string }[] = Array.isArray(meta.source) ? meta.source : [];
  if (meta.parent_skill) return null; // follows its parent (below)
  if (sources.length && sources.every((s) => s.repo.startsWith("~")))
    return scopeForUserSkill(skillName(sources[0].path), all);
  if (
    it.category === "agent_skill" &&
    sources.length &&
    sources.every((s) => isSkillPath(s.path))
  ) {
    const name = skillName(sources[0].path);
    if (widened(name, sources[0] as any, it)) return scopeForUserSkill(name, all);
    return scopeForRepositories(
      sources.map((s) => s.repo),
      all,
    );
  }
  if (Array.isArray(app.projects) && app.projects.length && !app.repos?.length) {
    const { projects, ...rest } = app;
    const spec = scopeForProjects(projects);
    return { scope: spec.scope, applicability: { ...rest, ...spec.applicability } };
  }
  if (Array.isArray(app.repos) && app.repos.length) {
    const spec = scopeForRepositories(app.repos, all);
    if (spec.scope.scope_type === "GLOBAL") return null; // genuinely cross-project
    // Manual items keep their other restrictions (step_keys, step_types, ...); REPOSITORY drops the redundant list.
    const { repos, ...rest } = app;
    return { scope: spec.scope, applicability: { ...rest, ...spec.applicability } };
  }
  return null;
}

const decided = new Map<string, ScopeSpec>();
for (const it of items) {
  const t = target(it);
  if (t) decided.set(it.key, t);
}
for (const it of items) {
  const parent = it.metadata?.parent_skill;
  if (!parent) continue;
  const p =
    decided.get(parent) ??
    (() => {
      const row = items.find((x) => x.key === parent);
      return row
        ? {
            scope: { scope_type: row.scope_type, scope_ref: row.scope_ref },
            applicability: row.applicability ?? {},
          }
        : undefined;
    })();
  if (p) decided.set(it.key, p);
}

let changed = 0;
for (const it of items) {
  const t = decided.get(it.key);
  if (!t) continue;
  const ref = t.scope.scope_type === "GLOBAL" ? "" : (t.scope.scope_ref ?? "");
  const same =
    it.scope_type === t.scope.scope_type &&
    (it.scope_ref ?? "") === ref &&
    hashOf(it.applicability ?? {}) === hashOf(t.applicability);
  if (same) continue;
  changed++;
  const from = `${it.scope_type}${it.scope_ref ? ":" + it.scope_ref : ""} ${JSON.stringify(it.applicability ?? {})}`;
  const to = `${t.scope.scope_type}${ref ? ":" + ref : ""} ${JSON.stringify(t.applicability)}`;
  console.log(`${it.enabled ? "  " : "- "}${it.key.padEnd(62)} ${from}  →  ${to}`);
  if (dryRun) continue;
  await knowledge.update(it.key, {
    scope_type: t.scope.scope_type,
    scope_ref: ref,
    applicability: t.applicability,
    change_note: `rescoped: ${from} → ${to}`,
    created_by: "knowledge rescope",
  });
}
console.log(
  `\n${dryRun ? "DRY RUN: " : ""}${changed} rescoped of ${items.length} shared non-repository items ("- " = disabled item)`,
);
await pool.end();
