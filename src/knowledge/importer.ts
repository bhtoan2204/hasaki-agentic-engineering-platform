import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { repositories, repoPath, type RepositoryRow } from "../repos/service.ts";
import { knowledge, type KnowledgeInput } from "./service.ts";
import { hashOf } from "../workflow/definitions.ts";

/**
 * Import the knowledge that already lives in the source repositories into the registry:
 *   CLAUDE.md / AGENTS.md, docs/*CONVENTION*.md      → repository_convention, REPOSITORY scope, inlined in prompts
 *   .claude/skills/<n>/SKILL.md, .agents/skills/...    → agent_skill, on-demand (index in prompt, read_knowledge tool)
 *   .cursor/rules/*.mdc                                → coding_standard for that repo, on-demand
 *   docs/** of *-wiki repositories                     → architecture_guideline / domain_knowledge, on-demand, per project
 * Identical skills found in several repositories become one item whose applicability lists those repositories.
 * Files that look like they contain credentials are skipped. Re-running creates new versions only for changed files.
 */

const MAX_CHARS = 60_000;
const SECRET_RE = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS key id
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, // Stripe-like
  /\b[\w-]*(password|passwd|secret|api[_-]?key|token|client[_-]?secret)[\w-]*\s*[:=]\s*["']?(?!<|\$\{|\{\{|xxx|\.\.\.|your|example|changeme)[A-Za-z0-9/+_\-.]{12,}/i,
];
const SKIP_PATH = [/env-production/i, /\.env/i, /secret/i, /superpowers\/(plans|specs)\//, /\/node_modules\//, /\/vendor\//];
const WIKI_SKIP = [/changelog/i, /build-docs/i, /reference\/links/i, /frontend-demo/i, /authoring\.md$/i];

export interface ImportCandidate extends KnowledgeInput {
  source: { repo: string; path: string; sha256: string }[];
}
export interface ImportReport {
  candidates: Array<{ key: string; title: string; category: string; scope: string; repos: string[]; chars: number; action: "create" | "update" | "unchanged" }>;
  skipped: Array<{ path: string; reason: string }>;
  created: number;
  updated: number;
  unchanged: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** YAML-ish frontmatter (`---\nkey: value\n---`) → fields + body. */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body: m[2] };
}

export function looksSecret(text: string) {
  return SECRET_RE.some((re) => re.test(text));
}

function firstHeading(text: string) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim();
}
function firstParagraph(text: string) {
  return (
    text
      .replace(/^---[\s\S]*?---/, "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("```")) ?? ""
  )
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function walk(dir: string, depth = 4): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "vendor") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, depth - 1));
    else out.push(p);
  }
  return out;
}

/** Scan every enabled repository on disk and build import candidates (no DB writes). */
export async function scanRepositories(): Promise<{ candidates: ImportCandidate[]; skipped: ImportReport["skipped"] }> {
  const repos = (await repositories.list()).filter((r) => r.enabled && existsSync(join(repoPath(r), ".git")));
  const skipped: ImportReport["skipped"] = [];
  const out: ImportCandidate[] = [];
  const skills = new Map<string, { name: string; text: string; repos: RepositoryRow[]; paths: string[] }>(); // by name+hash

  const read = (r: RepositoryRow, file: string): string | null => {
    const rel = relative(repoPath(r), file);
    const shown = `${r.name}/${rel}`;
    if (SKIP_PATH.some((re) => re.test(rel))) return (skipped.push({ path: shown, reason: "path excluded (env/secret/task plan)" }), null);
    if (!statSync(file).isFile()) return null;
    const text = readFileSync(file, "utf8");
    if (!text.trim()) return null;
    if (looksSecret(text)) return (skipped.push({ path: shown, reason: "looks like it contains credentials" }), null);
    if (text.length > MAX_CHARS) skipped.push({ path: shown, reason: `truncated to ${MAX_CHARS} chars` });
    return text.slice(0, MAX_CHARS);
  };

  for (const r of repos) {
    const root = repoPath(r);
    const src = (file: string, text: string) => ({ repo: r.name, path: relative(root, file), sha256: sha(text) });

    // 1. Agent instructions / conventions: inlined for that repository (identical copies, e.g. AGENTS.md = CLAUDE.md, once).
    const seenText = new Set<string>();
    for (const f of ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules"]) {
      const file = join(root, f);
      if (!existsSync(file)) continue;
      const text = read(r, file);
      if (!text || seenText.has(sha(text))) continue;
      seenText.add(sha(text));
      out.push({
        key: slug(`${r.name}.${f.replace(/\.md$/i, "")}`),
        category: "repository_convention",
        scope_type: "REPOSITORY",
        scope_ref: r.name,
        title: `${r.name}: ${f}`,
        content: text,
        metadata: { load: "inline", description: firstParagraph(text) },
        source: [src(file, text)],
      });
    }
    for (const file of walk(join(root, "docs"), 1).filter((f) => /convention/i.test(basename(f)) && f.endsWith(".md"))) {
      const text = read(r, file);
      if (!text) continue;
      out.push({
        key: slug(`${r.name}.${basename(file, ".md")}`),
        category: "repository_convention",
        scope_type: "REPOSITORY",
        scope_ref: r.name,
        title: `${r.name}: ${firstHeading(text) ?? basename(file)}`,
        content: text,
        metadata: { load: "inline", description: firstParagraph(text) },
        source: [src(file, text)],
      });
    }

    // 2. Skills (.claude preferred over .agents for the same name).
    const seenInRepo = new Set<string>();
    for (const base of [".claude/skills", ".agents/skills"]) {
      const dir = join(root, base);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (seenInRepo.has(name)) continue;
        const file = ["SKILL.md", `${name}.md`].map((f) => join(dir, name, f)).find(existsSync);
        if (!file) continue;
        const text = read(r, file);
        if (!text) continue;
        seenInRepo.add(name);
        const id = `${name}:${sha(text)}`;
        const e = skills.get(id) ?? skills.set(id, { name, text, repos: [], paths: [] }).get(id)!;
        e.repos.push(r);
        e.paths.push(`${r.name}/${relative(root, file)}`);
      }
    }

    // 3. Cursor rules: coding standards for that repository, on demand.
    for (const file of walk(join(root, ".cursor", "rules"), 1).filter((f) => f.endsWith(".mdc") || f.endsWith(".md"))) {
      const text = read(r, file);
      if (!text) continue;
      const { fields, body } = frontmatter(text);
      out.push({
        key: slug(`${r.name}.rule.${basename(file).replace(/\.mdc?$/, "")}`),
        category: "coding_standard",
        scope_type: "REPOSITORY",
        scope_ref: r.name,
        title: `${r.name}: ${firstHeading(body) ?? basename(file)}`,
        content: body.trim(),
        metadata: { load: fields.alwaysApply === "true" ? "inline" : "on_demand", description: fields.description || firstParagraph(body), globs: fields.globs ?? null },
        source: [src(file, text)],
      });
    }

    // 4. Wiki repositories: architecture + partner/domain docs for the whole project, on demand.
    if (/wiki/i.test(r.name)) {
      const projects = [...new Set((await repositories.list()).filter((x) => x.path.split("/")[0] === r.path.split("/")[0] && x.path).flatMap((x) => x.projects).concat(r.projects))];
      for (const file of walk(root, 4).filter((f) => f.endsWith(".md") && /\/docs\//.test(f))) {
        const rel = relative(root, file);
        if (WIKI_SKIP.some((re) => re.test(rel))) continue;
        const text = read(r, file);
        if (!text) continue;
        out.push({
          key: slug(`${r.name}.${rel.replace(/\.md$/, "").replace(/\//g, ".")}`),
          category: /architecture/i.test(rel) ? "architecture_guideline" : "domain_knowledge",
          scope_type: "GLOBAL",
          title: `${r.name}: ${firstHeading(text) ?? rel}`,
          content: text,
          applicability: projects.length ? { projects } : {},
          metadata: { load: "on_demand", description: firstParagraph(text) },
          source: [src(file, text)],
        });
      }
    }
  }

  // Skills: identical copies across repositories → one item for all of them.
  const byName = new Map<string, number>();
  for (const s of skills.values()) byName.set(s.name, (byName.get(s.name) ?? 0) + 1);
  for (const s of skills.values()) {
    const { fields, body } = frontmatter(s.text);
    const variants = byName.get(s.name)!;
    const repoNames = s.repos.map((r) => r.name);
    out.push({
      key: slug(variants > 1 ? `skill.${s.name}.${repoNames[0]}` : `skill.${s.name}`),
      category: "agent_skill",
      scope_type: "GLOBAL",
      title: `Skill: ${fields.name || s.name}${variants > 1 ? ` (${repoNames.join(", ")})` : ""}`,
      content: body.trim(),
      applicability: { repos: repoNames },
      metadata: { load: "on_demand", description: (fields.description || firstParagraph(body)).slice(0, 600) },
      source: s.repos.map((r, i) => ({ repo: r.name, path: s.paths[i].slice(r.name.length + 1), sha256: sha(s.text) })),
    });
  }
  return { candidates: out, skipped };
}

/** Create/update registry items from the scan. Unchanged files create no new version. */
export async function importFromRepositories(opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const { candidates, skipped } = await scanRepositories();
  const report: ImportReport = { candidates: [], skipped, created: 0, updated: 0, unchanged: 0 };
  for (const c of candidates) {
    const { source, ...item } = c;
    const metadata = { ...(item.metadata ?? {}), source, imported_from_repository: true };
    const existing = await knowledge.get(c.key);
    let action: "create" | "update" | "unchanged" = "create";
    if (existing) {
      const v = existing.versions[0];
      // JSONB reorders keys, so compare canonical hashes rather than JSON strings.
      const same = v.content === c.content && hashOf(v.applicability ?? {}) === hashOf(c.applicability ?? {}) && hashOf(v.metadata?.source ?? null) === hashOf(source);
      action = same ? "unchanged" : "update";
    }
    report.candidates.push({ key: c.key, title: c.title, category: c.category, scope: `${c.scope_type}${c.scope_ref ? ":" + c.scope_ref : ""}`, repos: [...new Set(source.map((s) => s.repo))], chars: c.content.length, action });
    report[action === "create" ? "created" : action === "update" ? "updated" : "unchanged"]++;
    if (opts.dryRun || action === "unchanged") continue;
    if (action === "create") await knowledge.create({ ...item, metadata, created_by: "repository import", change_note: `imported from ${source.map((s) => `${s.repo}/${s.path}`).join(", ")}` });
    else await knowledge.update(c.key, { content: c.content, applicability: c.applicability ?? {}, metadata, change_note: "re-imported: source file changed", created_by: "repository import" });
  }
  return report;
}
