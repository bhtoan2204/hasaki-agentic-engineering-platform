import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { config } from "../config.ts";
import { repositories, repoPath, type RepositoryRow } from "../repos/service.ts";
import { knowledge, type KnowledgeInput } from "./service.ts";
import { hashOf } from "../workflow/definitions.ts";
import { createProposal } from "./proposals.ts";

/**
 * Import the knowledge that already lives in the source repositories into the registry:
 *   CLAUDE.md / AGENTS.md, docs/*CONVENTION*.md      → repository_convention, REPOSITORY scope, inlined in prompts
 *   .claude/skills/<n>/SKILL.md, .agents/skills/...    → agent_skill, on-demand (index in prompt, read_knowledge tool)
 *   .cursor/rules/*.mdc                                → coding_standard for that repo, on-demand
 *   docs/** of *-wiki repositories                     → architecture_guideline / domain_knowledge, on-demand, per project
 *   docs/(sub/)*convention*.md of a *-wiki repository   → repository_convention inlined for the code repos next to the wiki
 *   .inventory/conflicts.md of a *-wiki repository     → domain_knowledge (where the docs disagree with the code)
 * Identical skills found in several repositories become one item whose applicability lists those repositories.
 * Files that look like they contain credentials are skipped. Re-running creates new versions only for changed files.
 * Items whose source file disappeared from a scanned repository are disabled ("retired"), and re-enabled if it returns.
 * Registry wins over a stale file: an item evolved through an approved proposal (metadata.evolution) is not overwritten.
 * If its source file is unchanged since that evolution the registry version stays ("registry_newer"); if the file
 * changed too, the file's text becomes a pending UPDATE proposal for a human to reconcile ("conflict"). Repository
 * files are never written by the platform.
 */

const MAX_CHARS = 60_000;
const SECRET_ASSIGNMENT =
  /\b[\w-]*(password|passwd|secret|api[_-]?key|token|client[_-]?secret)[\w-]*\s*[:=]\s*["']?(?!<|\$\{|\{\{|xxx|\.\.\.|your|example|changeme)([A-Za-z0-9/+_\-.]{12,})/gi;
/** `secret = payment_client.ecom_global.secret`: a reference to a field/config path, not a value. */
const IDENTIFIER_PATH = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/;
const SECRET_RE = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS key id
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, // Stripe-like
];
const SKIP_PATH = [
  /env-production/i,
  /\.env/i,
  /secret/i,
  /superpowers\/(plans|specs)\//,
  /\/node_modules\//,
  /\/vendor\//,
];
/** Interactive/meta skills from ~/.claude that would act autonomously in an unattended step. Imported disabled. */
export const USER_SKILLS_DISABLED = [
  "execute",
  "define",
  "pr",
  "address",
  "rebase-clean",
  "qa-review",
  "feedback",
  "codex-advisor",
  "skill-creator",
  "synced",
  "agent-browser",
  "upstream",
  "ask",
  "decision-analysis",
  "fact-check",
];
/** Extra wiki files outside docs/ worth importing (path relative to the wiki root). */
const WIKI_EXTRA = [/^\.inventory\/conflicts\.md$/];
const WIKI_SKIP = [
  /changelog/i,
  /build-docs/i,
  /reference\/links/i,
  /frontend-demo/i,
  /authoring\.md$/i,
];

export interface ImportCandidate extends KnowledgeInput {
  source: { repo: string; path: string; sha256: string }[];
}
export interface ImportReport {
  candidates: Array<{
    key: string;
    title: string;
    category: string;
    scope: string;
    repos: string[];
    chars: number;
    action: "create" | "update" | "unchanged" | "retire" | "registry_newer" | "conflict";
    proposal_id?: number;
  }>;
  skipped: Array<{ path: string; reason: string }>;
  created: number;
  updated: number;
  unchanged: number;
  retired: number;
  /** Evolved in the registry, repository file changed too: a proposal was opened instead of overwriting. */
  conflicts: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * YAML-ish frontmatter (`---\nkey: value\n---`) → fields + body. Top-level scalars only, including block scalars
 * (`key: >-` folded, `key: |` literal) and plain values continued on indented lines.
 */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  let key: string | null = null;
  let style: "folded" | "literal" | "plain" = "plain";
  let parts: string[] = [];
  const flush = () => {
    if (key === null) return;
    const v = style === "literal" ? parts.join("\n") : parts.filter(Boolean).join(" ");
    fields[key] = v.replace(/^["']|["']$/g, "").trim();
  };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      flush();
      key = kv[1];
      const block = kv[2].trim().match(/^([>|])[-+]?$/);
      style = block ? (block[1] === ">" ? "folded" : "literal") : "plain";
      parts = block ? [] : [kv[2].trim()];
    } else if (key !== null && (/^\s+\S/.test(line) || !line.trim())) parts.push(line.trim());
  }
  flush();
  return { fields, body: m[2] };
}

export function looksSecret(text: string) {
  if (SECRET_RE.some((re) => re.test(text))) return true;
  for (const m of text.matchAll(SECRET_ASSIGNMENT)) if (!IDENTIFIER_PATH.test(m[2])) return true;
  return false;
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
      .find(
        (p) =>
          p &&
          !p.startsWith("#") &&
          !p.startsWith("```") &&
          !/^this file provides guidance to claude/i.test(p),
      ) ?? ""
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

/** Read a source file for import: excluded paths, credentials and empty files are skipped (and reported). */
function readChecked(
  root: string,
  label: string,
  file: string,
  skipped: ImportReport["skipped"],
): string | null {
  const rel = relative(root, file);
  const shown = `${label}/${rel}`;
  if (SKIP_PATH.some((re) => re.test(rel)))
    return (skipped.push({ path: shown, reason: "path excluded (env/secret/task plan)" }), null);
  if (!statSync(file).isFile()) return null;
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return null;
  if (looksSecret(text))
    return (skipped.push({ path: shown, reason: "looks like it contains credentials" }), null);
  if (text.length > MAX_CHARS)
    skipped.push({ path: shown, reason: `truncated to ${MAX_CHARS} chars` });
  return text.slice(0, MAX_CHARS);
}

// ---------------------------------------------------------------- scope derivation
// The scope label says where an item applies: one repository → REPOSITORY, one project → PROJECT, only content that is
// genuinely cross-project stays GLOBAL (with an applicability list) or ORGANIZATION. Re-imports derive the same scope,
// so a corrected scope is never flipped back.

export interface ScopeSpec {
  scope: Pick<KnowledgeInput, "scope_type" | "scope_ref">;
  applicability: Record<string, unknown>;
}
type RepoProjects = Pick<RepositoryRow, "name" | "projects" | "enabled">;

/** Projects shared by every given registered repository (names no longer in the registry are ignored), in the registry order of the first one. */
function sharedProjects(repoNames: string[], all: RepoProjects[]): string[] {
  const rows = repoNames
    .map((n) => all.find((r) => r.name === n))
    .filter((r): r is RepoProjects => !!r);
  if (!rows.length) return [];
  return (rows[0].projects ?? []).filter((p) => rows.every((r) => (r.projects ?? []).includes(p)));
}

/** Content for a set of repositories: one → REPOSITORY; several in one project → PROJECT (keeps the repository list); else GLOBAL. */
export function scopeForRepositories(repoNames: string[], all: RepoProjects[]): ScopeSpec {
  const names = [...new Set(repoNames)];
  if (names.length === 1)
    return { scope: { scope_type: "REPOSITORY", scope_ref: names[0] }, applicability: {} };
  const project = sharedProjects(names, all)[0];
  return project
    ? { scope: { scope_type: "PROJECT", scope_ref: project }, applicability: { repos: names } }
    : { scope: { scope_type: "GLOBAL" }, applicability: { repos: names } };
}

/** Whole-project docs (wiki): PROJECT scope on the first project; applicability lists every project it covers. */
export function scopeForProjects(projects: string[]): ScopeSpec {
  return projects.length
    ? {
        scope: { scope_type: "PROJECT", scope_ref: projects[0] },
        applicability: projects.length > 1 ? { projects } : {},
      }
    : { scope: { scope_type: "GLOBAL" }, applicability: {} };
}

/**
 * Project of an organization-wide (user-level) skill named after a project's repositories: its first name segment is
 * the first segment of that project's repository names (`oms-carrier-ghn` ↔ `oms-api`, `oms-background` → OMS).
 * Null when no repository shares the prefix or they span unrelated projects.
 */
export function projectForSkillName(name: string, all: RepoProjects[]): string | null {
  const first = (s: string) => s.toLowerCase().split(/[-_.]/)[0];
  const prefix = first(name);
  if (!prefix) return null;
  return (
    sharedProjects(
      all.filter((r) => r.enabled && first(r.name) === prefix).map((r) => r.name),
      all,
    )[0] ?? null
  );
}

/** A skill that was available everywhere (~/.claude): its project when it is named after one, else the organization. */
export function scopeForUserSkill(name: string, all: RepoProjects[]): ScopeSpec {
  const project = projectForSkillName(name, all);
  return project
    ? { scope: { scope_type: "PROJECT", scope_ref: project }, applicability: {} }
    : { scope: { scope_type: "ORGANIZATION", scope_ref: config.organization }, applicability: {} };
}

/** A supporting file of a skill (reference doc, script), path relative to the skill directory. */
export interface SkillCompanion {
  rel: string;
  text: string;
}
const COMPANION_FILE = /\.(md|txt|py|sh|ts|js|mjs|json|ya?ml|go|sql)$/i;

/** Supporting files next to a skill's main file (reference/, references/, scripts/, …), sorted by path. */
function readSkillCompanions(
  skillDir: string,
  mainFile: string,
  read: (file: string) => string | null,
): SkillCompanion[] {
  return walk(skillDir, 3)
    .filter((f) => f !== mainFile && COMPANION_FILE.test(f))
    .sort()
    .flatMap((f) => {
      const text = read(f);
      return text ? [{ rel: relative(skillDir, f).split(/[\\/]/).join("/"), text }] : [];
    });
}

/**
 * One skill → its registry items: the skill itself plus one item per supporting file. Agents only receive registry
 * text (no skill directory on disk), so the skill body gets a footer mapping each relative path it links to onto the
 * read_knowledge key of that file. Supporting files are never listed in the prompt index (metadata.parent_skill).
 */
export function skillCandidates(s: {
  key: string;
  name: string;
  text: string;
  companions: SkillCompanion[];
  titleSuffix?: string;
  scope: Pick<KnowledgeInput, "scope_type" | "scope_ref">;
  applicability: Record<string, unknown>;
  /** Per source repository: the skill directory relative to that repository root. */
  sources: { repo: string; dir: string; mainFile: string }[];
}): ImportCandidate[] {
  const { fields, body } = frontmatter(s.text);
  const companionKey = (rel: string) =>
    slug(`${s.key}.${rel.replace(/\.md$/i, "").replace(/\//g, ".")}`);
  const footer = s.companions.length
    ? "\n\n---\n## Supporting files (knowledge registry)\n\nThis skill's files are stored in the knowledge registry, not on disk. Where the text above links to one of these paths, load it with `read_knowledge`:\n\n" +
      s.companions
        .map(
          (c) =>
            `- \`${c.rel}\` → \`read_knowledge key=${companionKey(c.rel)}\`${!/\.(md|txt)$/i.test(c.rel) ? " (script: write it to a temporary file before running it)" : ""}`,
        )
        .join("\n") +
      "\n"
    : "";
  const src = (rel: string, text: string) =>
    s.sources.map((x) => ({
      repo: x.repo,
      path: [x.dir, rel].filter(Boolean).join("/"),
      sha256: sha(text),
    }));
  return [
    {
      key: s.key,
      category: "agent_skill",
      ...s.scope,
      title: `Skill: ${fields.name || s.name}${s.titleSuffix ?? ""}`,
      content: body.trim() + footer,
      applicability: s.applicability,
      metadata: {
        load: "on_demand",
        description: (fields.description || firstParagraph(body)).slice(0, 600),
        ...(s.companions.length
          ? { companions: s.companions.map((c) => companionKey(c.rel)) }
          : {}),
      },
      source: s.sources.map((x) => ({
        repo: x.repo,
        path: [x.dir, x.mainFile].filter(Boolean).join("/"),
        sha256: sha(s.text),
      })),
    },
    ...s.companions.map((c) => ({
      key: companionKey(c.rel),
      category: "agent_skill",
      ...s.scope,
      title: `Skill: ${fields.name || s.name} — ${c.rel}`,
      content: c.text,
      applicability: s.applicability,
      metadata: {
        load: "on_demand",
        parent_skill: s.key,
        skill_file: c.rel,
        description: (/\.md$/i.test(c.rel)
          ? firstHeading(c.text) || firstParagraph(c.text)
          : `${c.rel} of skill ${fields.name || s.name}`
        ).slice(0, 300),
      },
      source: src(c.rel, c.text),
    })),
  ];
}

/** Scan every enabled repository on disk and build import candidates (no DB writes). */
export async function scanRepositories(): Promise<{
  candidates: ImportCandidate[];
  skipped: ImportReport["skipped"];
  scanned: string[];
}> {
  const all = await repositories.list();
  const repos = all.filter((r) => r.enabled && existsSync(join(repoPath(r), ".git")));
  const skipped: ImportReport["skipped"] = [];
  const out: ImportCandidate[] = [];
  const skills = new Map<
    string,
    {
      name: string;
      text: string;
      companions: SkillCompanion[];
      repos: RepositoryRow[];
      paths: string[];
    }
  >(); // by name+hash

  const read = (r: RepositoryRow, file: string): string | null =>
    readChecked(repoPath(r), r.name, file, skipped);

  for (const r of repos) {
    const root = repoPath(r);
    const src = (file: string, text: string) => ({
      repo: r.name,
      path: relative(root, file),
      sha256: sha(text),
    });
    const isWiki = /wiki/i.test(r.name);
    // Code repositories living next to a wiki (same group folder, e.g. payment-src/*): the wiki's conventions apply to them.
    const group = r.path.includes("/") ? r.path.split("/")[0] : "";
    const siblings =
      isWiki && group
        ? all
            .filter(
              (x) =>
                x.enabled &&
                x.name !== r.name &&
                !/wiki/i.test(x.name) &&
                x.path.split("/")[0] === group,
            )
            .map((x) => x.name)
            .sort()
        : [];

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
    for (const file of walk(join(root, "docs"), 1).filter(
      (f) => /convention/i.test(basename(f)) && f.endsWith(".md"),
    )) {
      const text = read(r, file);
      if (!text) continue;
      if (isWiki) {
        // Nobody codes in the wiki itself: inline the conventions for the code repositories it documents.
        const target = scopeForRepositories(siblings.length ? siblings : [r.name], all);
        out.push({
          key: slug(`${r.name}.${basename(file, ".md")}`),
          category: "repository_convention",
          ...target.scope,
          title: `${r.name}: ${firstHeading(text) ?? basename(file)}`,
          content: text,
          applicability: target.applicability,
          metadata: { load: "inline", description: firstParagraph(text) },
          source: [src(file, text)],
        });
        continue;
      }
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
        const companions = readSkillCompanions(join(dir, name), file, (f) => read(r, f));
        const id = `${name}:${sha(text)}:${sha(JSON.stringify(companions))}`;
        const e =
          skills.get(id) ??
          skills.set(id, { name, text, companions, repos: [], paths: [] }).get(id)!;
        e.repos.push(r);
        e.paths.push(`${r.name}/${relative(root, file)}`);
      }
    }

    // 3. Cursor rules: coding standards for that repository, on demand.
    for (const file of walk(join(root, ".cursor", "rules"), 1).filter(
      (f) => f.endsWith(".mdc") || f.endsWith(".md"),
    )) {
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
        metadata: {
          load: fields.alwaysApply === "true" ? "inline" : "on_demand",
          description: fields.description || firstParagraph(body),
          globs: fields.globs ?? null,
        },
        source: [src(file, text)],
      });
    }

    // 4. Wiki repositories: architecture + partner/domain docs for the whole project, on demand.
    if (isWiki) {
      const projects = [
        ...new Set(
          all
            .filter((x) => x.path.split("/")[0] === r.path.split("/")[0] && x.path)
            .flatMap((x) => x.projects)
            .concat(r.projects),
        ),
      ];
      for (const file of walk(root, 4).filter(
        (f) =>
          f.endsWith(".md") &&
          (/\/docs\//.test(f) || WIKI_EXTRA.some((re) => re.test(relative(root, f)))),
      )) {
        const rel = relative(root, file);
        if (WIKI_SKIP.some((re) => re.test(rel))) continue;
        if (
          /\/docs\//.test(file) &&
          /convention/i.test(basename(file)) &&
          relative(join(root, "docs"), file).split("/").length <= 2
        )
          continue; // imported above as a convention
        const text = read(r, file);
        if (!text) continue;
        out.push({
          key: slug(`${r.name}.${rel.replace(/^\./, "").replace(/\.md$/, "").replace(/\//g, ".")}`),
          category: /architecture/i.test(rel) ? "architecture_guideline" : "domain_knowledge",
          ...scopeForProjects(projects).scope,
          title: `${r.name}: ${firstHeading(text) ?? rel}`,
          content: text,
          applicability: scopeForProjects(projects).applicability,
          metadata: { load: "on_demand", description: firstParagraph(text) },
          source: [src(file, text)],
        });
      }
    }
  }

  // User-level skills (~/.claude/skills): previously auto-loaded by Claude Code; now imported once into the registry
  // (agent steps no longer load Claude Code settings layers). Copies of repository skills are skipped; workflow/meta
  // skills that act on their own (push, open PRs, delegate to other tools) are imported disabled.
  const repoSkillHashes = new Set([...skills.values()].map((s) => sha(s.text)));
  const userSkillHashes = new Set<string>();
  const userDir = process.env.CLAUDE_USER_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  if (existsSync(userDir)) {
    for (const name of readdirSync(userDir)) {
      const file = join(userDir, name, "SKILL.md");
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      // Same content as a repository skill: keep the repository item, but it was available everywhere via ~/.claude,
      // so it must not shrink to the repositories that happen to contain a copy (widened below).
      if (repoSkillHashes.has(sha(text))) {
        userSkillHashes.add(sha(text));
        continue;
      }
      if (looksSecret(text)) {
        skipped.push({
          path: `~/.claude/skills/${name}/SKILL.md`,
          reason: "looks like it contains credentials",
        });
        continue;
      }
      const { fields, body } = frontmatter(text);
      const unattendedUnsafe = USER_SKILLS_DISABLED.includes(name);
      const target = scopeForUserSkill(name, all);
      out.push({
        key: slug(`user.skill.${name}`),
        category: "agent_skill",
        ...target.scope,
        applicability: target.applicability,
        title: `Skill: ${fields.name || name}`,
        content: body.trim().slice(0, MAX_CHARS),
        enabled: !unattendedUnsafe,
        metadata: {
          load: "on_demand",
          description: (fields.description || firstParagraph(body)).slice(0, 600),
          origin: "user",
          ...(unattendedUnsafe
            ? {
                disabled_reason:
                  "interactive/workflow skill: acts on its own (push, PR, delegation) — enable deliberately",
              }
            : {}),
        },
        source: [{ repo: "~/.claude", path: `skills/${name}/SKILL.md`, sha256: sha(text) }],
      });
    }
  }

  // Skills: identical copies across repositories → one item for all of them.
  const byName = new Map<string, number>();
  for (const s of skills.values()) byName.set(s.name, (byName.get(s.name) ?? 0) + 1);
  for (const s of skills.values()) {
    const variants = byName.get(s.name)!;
    const repoNames = s.repos.map((r) => r.name);
    const orgWide = userSkillHashes.has(sha(s.text));
    // Also in ~/.claude (available everywhere before): widened to its project, or the organization if generic.
    const target = orgWide ? scopeForUserSkill(s.name, all) : scopeForRepositories(repoNames, all);
    out.push(
      ...skillCandidates({
        key: slug(variants > 1 ? `skill.${s.name}.${repoNames[0]}` : `skill.${s.name}`),
        name: s.name,
        text: s.text,
        companions: s.companions,
        titleSuffix: variants > 1 ? ` (${repoNames.join(", ")})` : "",
        scope: target.scope,
        applicability: target.applicability,
        sources: s.repos.map((r, i) => {
          const path = s.paths[i].slice(r.name.length + 1);
          return { repo: r.name, dir: dirname(path), mainFile: basename(path) };
        }),
      }),
    );
  }
  return { candidates: out, skipped, scanned: repos.map((r) => r.name) };
}

/** Create/update registry items from the scan. Unchanged files create no new version. */
export async function importFromRepositories(
  opts: { dryRun?: boolean; only?: string } = {},
): Promise<ImportReport> {
  const scan = await scanRepositories();
  const { skipped, scanned } = scan;
  // `only`: import just the items whose key starts with this prefix; nothing else is touched (no retirement pass).
  const candidates = opts.only
    ? scan.candidates.filter((c) => c.key.startsWith(opts.only!))
    : scan.candidates;
  const report: ImportReport = {
    candidates: [],
    skipped,
    created: 0,
    updated: 0,
    unchanged: 0,
    retired: 0,
    conflicts: 0,
  };
  // Repositories without a description get the opening paragraph of their CLAUDE.md (improves discovery ranking).
  if (!opts.dryRun && !opts.only)
    for (const c of candidates.filter(
      (x) =>
        x.category === "repository_convention" &&
        x.scope_type === "REPOSITORY" &&
        /\.claude$/.test(x.key),
    )) {
      const repo = await repositories.get(c.scope_ref!);
      const desc = String((c.metadata as any)?.description ?? "").slice(0, 400);
      if (repo && !repo.description && desc)
        await repositories.upsert(repo.name, { description: desc });
    }
  await applyCandidates(candidates, report, {
    dryRun: opts.dryRun,
    owned: true,
    createdBy: "repository import",
  });

  // Retire imported items whose source files are gone from repositories that were scanned (moved/deleted docs).
  // Only items owned by the import (metadata.imported_from_repository) and only when every source repo was on disk.
  if (opts.only) return report;
  const produced = new Set(candidates.map((c) => c.key));
  const scannedSet = new Set(scanned);
  for (const it of (await knowledge.list()) as any[]) {
    if (!it.enabled || produced.has(it.key) || !it.metadata?.imported_from_repository) continue;
    const sources: { repo: string; path: string }[] = it.metadata.source ?? [];
    if (!sources.length || !sources.every((s) => scannedSet.has(s.repo))) continue;
    report.candidates.push({
      key: it.key,
      title: it.title,
      category: it.category,
      scope: `${it.scope_type}${it.scope_ref ? ":" + it.scope_ref : ""}`,
      repos: [...new Set(sources.map((s) => s.repo))],
      chars: (it.content ?? "").length,
      action: "retire",
    });
    report.retired++;
    if (opts.dryRun) continue;
    await knowledge.update(it.key, {
      enabled: false,
      metadata: {
        ...it.metadata,
        retired_reason: `source no longer produced: ${sources.map((s) => `${s.repo}/${s.path}`).join(", ")}`,
      },
      change_note: "retired: source file removed or no longer imported",
      created_by: "repository import",
    });
  }
  return report;
}

/**
 * Import one skill directory from any local path (e.g. a skill not yet merged into the repository's default branch,
 * which the platform-managed checkout does not contain). The items are attributed to `repo` (applicability + source)
 * but are NOT import-owned: a later repository import updates them once the skill lands in the checkout, and the
 * retirement pass never disables them in the meantime.
 */
export async function importSkillDirectory(opts: {
  dir: string;
  repo: string;
  dryRun?: boolean;
  createdBy?: string;
}): Promise<ImportReport> {
  const dir = opts.dir.replace(/[\\/]+$/, "");
  const name = basename(dir);
  const repo = await repositories.get(opts.repo);
  if (!repo) throw new Error(`unknown repository ${opts.repo}`);
  const mainFile = ["SKILL.md", `${name}.md`].map((f) => join(dir, f)).find(existsSync);
  if (!mainFile) throw new Error(`${dir} has no SKILL.md`);
  const skipped: ImportReport["skipped"] = [];
  const read = (f: string) => readChecked(dir, name, f, skipped);
  const text = read(mainFile);
  if (!text) throw new Error(`${mainFile} was skipped: ${skipped.map((s) => s.reason).join("; ")}`);
  const candidates = skillCandidates({
    key: slug(`skill.${name}`),
    name,
    text,
    companions: readSkillCompanions(dir, mainFile, read),
    ...scopeForRepositories([repo.name], await repositories.list()),
    sources: [{ repo: repo.name, dir: `.claude/skills/${name}`, mainFile: basename(mainFile) }],
  });
  // Still that repository's content: visibility follows its read access (knowledge/visibility.ts).
  for (const c of candidates) c.metadata = { ...c.metadata, imported_from_local_skill: true };
  const report: ImportReport = {
    candidates: [],
    skipped,
    created: 0,
    updated: 0,
    unchanged: 0,
    retired: 0,
    conflicts: 0,
  };
  await applyCandidates(candidates, report, {
    dryRun: opts.dryRun,
    owned: false,
    createdBy: opts.createdBy ?? "local skill import",
  });
  return report;
}

/** Create / update registry items from candidates. `owned`: mark them import-owned (eligible for retirement). */
async function applyCandidates(
  candidates: ImportCandidate[],
  report: ImportReport,
  opts: { dryRun?: boolean; owned: boolean; createdBy: string },
) {
  // Deleted by an admin (knowledge_deletions): never re-created while the source file still exists.
  const deleted = await knowledge.deletedKeys();
  for (const c of candidates) {
    const parent = (c.metadata as any)?.parent_skill as string | undefined;
    if (deleted.has(c.key) || (parent && deleted.has(parent))) {
      report.skipped.push({
        path: c.source.map((s) => `${s.repo}/${s.path}`).join(", "),
        reason: deleted.has(c.key)
          ? `${c.key} was deleted from the registry`
          : `${c.key}: its skill ${parent} was deleted from the registry`,
      });
      continue;
    }
    const { source, ...item } = c;
    const metadata = {
      ...(item.metadata ?? {}),
      source,
      ...(opts.owned ? { imported_from_repository: true } : {}),
    };
    const existing = await knowledge.get(c.key);
    const evolution = existing?.versions[0]?.metadata?.evolution;
    if (existing && evolution && existing.versions[0].content !== c.content) {
      const fileUnchanged = hashOf(evolution.base_source ?? null) === hashOf(source);
      const row: ImportReport["candidates"][number] = {
        key: c.key,
        title: c.title,
        category: c.category,
        scope: `${c.scope_type}${c.scope_ref ? ":" + c.scope_ref : ""}`,
        repos: [...new Set(source.map((s) => s.repo))],
        chars: c.content.length,
        action: fileUnchanged ? "registry_newer" : "conflict",
      };
      if (fileUnchanged) report.unchanged++;
      else {
        report.conflicts++;
        if (!opts.dryRun) {
          const r = await createProposal({
            ownerId: existing.owner_id ?? null,
            changeType: "UPDATE",
            targetKey: c.key,
            proposed: {
              content: c.content,
              scope_type: existing.scope_type,
              scope_ref: existing.scope_ref,
            },
            domain: c.category,
            confidence: 0.5,
            uncertainty: `the registry version came from proposal #${evolution.proposal_id}; the repository file changed afterwards — keep one, or merge both`,
            evidence: source.map((s) => ({
              source: "repository_file",
              ref: { repo: s.repo, path: s.path, sha256: s.sha256 },
              author: "repository import",
              trust: "platform" as const,
              quote: c.content.slice(0, 300),
            })),
            sourceKind: "repository_import",
            createdBy: "repository import",
          }).catch(() => null);
          if (r?.proposal) row.proposal_id = Number(r.proposal.id);
        }
      }
      report.candidates.push(row);
      continue;
    }
    let action: "create" | "update" | "unchanged" = "create";
    const wasRetired =
      !!existing && !existing.enabled && !!existing.versions[0]?.metadata?.retired_reason;
    if (existing) {
      const v = existing.versions[0];
      // JSONB reorders keys, so compare canonical hashes rather than JSON strings.
      const same =
        v.content === c.content &&
        hashOf(v.applicability ?? {}) === hashOf(c.applicability ?? {}) &&
        hashOf(v.metadata?.source ?? null) === hashOf(source) &&
        // Parser fixes (e.g. folded YAML descriptions) change these without touching the file.
        (v.metadata?.description ?? null) === ((item.metadata as any)?.description ?? null) &&
        hashOf(v.metadata?.companions ?? null) ===
          hashOf((item.metadata as any)?.companions ?? null) &&
        !!v.metadata?.imported_from_repository === opts.owned &&
        !!v.metadata?.imported_from_local_skill ===
          !!(item.metadata as any)?.imported_from_local_skill &&
        existing.scope_type === c.scope_type &&
        existing.scope_ref === (c.scope_ref ?? "");
      action = same && !wasRetired ? "unchanged" : "update";
    }
    report.candidates.push({
      key: c.key,
      title: c.title,
      category: c.category,
      scope: `${c.scope_type}${c.scope_ref ? ":" + c.scope_ref : ""}`,
      repos: [...new Set(source.map((s) => s.repo))],
      chars: c.content.length,
      action,
    });
    report[action === "create" ? "created" : action === "update" ? "updated" : "unchanged"]++;
    if (opts.dryRun || action === "unchanged") continue;
    if (action === "create")
      await knowledge.create({
        ...item,
        metadata,
        created_by: opts.createdBy,
        change_note: `imported from ${source.map((s) => `${s.repo}/${s.path}`).join(", ")}`,
      });
    else
      await knowledge.update(c.key, {
        content: c.content,
        applicability: c.applicability ?? {},
        metadata,
        scope_type: c.scope_type,
        scope_ref: c.scope_ref ?? "",
        change_note: wasRetired
          ? "re-imported: source file is back"
          : "re-imported: source file changed",
        created_by: opts.createdBy,
        ...(wasRetired ? { enabled: true } : {}),
      });
  }
}
