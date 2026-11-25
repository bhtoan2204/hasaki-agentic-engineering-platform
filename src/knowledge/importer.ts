import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { config } from "../config.ts";
import pg from "pg";
import { pool, q } from "../db/pool.ts";
import { isSelfRepository } from "../platform/selfDevelopment.ts";
import { repositories, repoPath, type RepositoryRow } from "../repos/service.ts";
import { knowledge, type KnowledgeInput } from "./service.ts";
import type {
  Discovery,
  DiscoveryRepository,
  ImportCandidate,
  ImportReport,
} from "./importTypes.ts";
import { MAX_CHARS, SCAN_LIMITS } from "./importTypes.ts";
import { goKnowledgeScan } from "./goKnowledge.ts";

export { MAX_CHARS, SCAN_LIMITS } from "./importTypes.ts";
export type {
  Discovery,
  DiscoveredCandidate,
  DiscoveryRepository,
  ImportCandidate,
  ImportReport,
  ScopeTarget,
} from "./importTypes.ts";
import { hashOf } from "../workflow/definitions.ts";
import { createProposal } from "./proposals.ts";
import { ignoreError } from "../ignoreError.ts";

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

export const slug = (s: string) =>
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
  for (const m of text.matchAll(SECRET_ASSIGNMENT)) {
    if (IDENTIFIER_PATH.test(m[2])) continue;
    // PayPal approval links carry the order ID as `token`; it is a public identifier, not a credential.
    if (/paypal\.com\/checkoutnow\?$/i.test(text.slice(Math.max(0, m.index - 60), m.index)))
      continue;
    return true;
  }
  return false;
}

export function firstHeading(text: string) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim();
}
/**
 * s.slice(0, n), except that a cut inside a surrogate pair ends in U+FFFD instead of a lone surrogate (which is what
 * PostgreSQL stores for text, and what JSONB metadata would refuse). platform-go cuts the same way (jsstr.SliceUTF16).
 */
export function sliceUnits(s: string, n: number) {
  const t = s.slice(0, n);
  const last = t.charCodeAt(t.length - 1);
  return s.length > n && last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) + "\ufffd" : t;
}
export function firstParagraph(text: string) {
  const p = (
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
  ).replace(/\s+/g, " ");
  return sliceUnits(p, 300);
}

/** One scan's shared budget (all repositories). */
export interface ScanBudget {
  bytes: number;
  deadline: number;
}
export const newBudget = (): ScanBudget => ({
  bytes: 0,
  deadline: Date.now() + SCAN_LIMITS.deadlineMs,
});

/**
 * Files of one source root, read safely: symlinks are followed only when their target stays inside the root, each
 * file is opened without following a final symlink and its descriptor re-checked (a path swapped after the check
 * cannot escape), reads are bounded before allocation. Directory entries come in byte order (as readdir returns them).
 */
export class SourceTree {
  readonly root: string;
  readonly label: string;
  readonly skipped: ImportReport["skipped"];
  readonly budget: ScanBudget;
  readonly real: string;
  incomplete = false;
  /** Read failures so far (not absences): callers that would otherwise fall back to another file check it. */
  failures = 0;
  private entries = 0;
  constructor(root: string, label: string, skipped: ImportReport["skipped"], budget: ScanBudget) {
    this.root = root;
    this.label = label;
    this.skipped = skipped;
    this.budget = budget;
    this.real = realpathSync(root);
  }
  private inside(p: string) {
    return p === this.real || p.startsWith(this.real + "/");
  }
  private shown(file: string) {
    return `${this.label}/${relative(this.root, file)}`;
  }
  /** A budget is spent (entries, bytes, deadline): the scan stops here. A read failure only makes it incomplete. */
  private stopped = false;
  private exhausted() {
    if (this.budget.bytes > SCAN_LIMITS.maxTotalBytes || Date.now() > this.budget.deadline)
      this.stopped = true;
    if (this.stopped) this.incomplete = true;
    return this.stopped;
  }
  /**
   * A filesystem error: ENOENT, ENOTDIR and ELOOP mean the source is gone (a legitimate deletion); anything else —
   * permissions, I/O, descriptor exhaustion — means it could not be read, so the repository's scan is incomplete
   * (reported, and nothing of it is retired). Returns false either way.
   */
  private failed(p: string, e: unknown): false {
    const code = (e as NodeJS.ErrnoException)?.code ?? "EIO";
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    this.incomplete = true;
    this.failures++;
    this.skipped.push({ path: this.shown(p), reason: `unreadable (${code})` });
    return false;
  }
  /** existsSync with the distinction above: true when it exists, false when absent or unreadable (incomplete). */
  exists(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch (e) {
      return this.failed(p, e);
    }
  }
  /** A symlink whose target exists outside the root (resolve() returned null for that reason, not another). */
  private pointsOutside(p: string) {
    try {
      return !this.inside(realpathSync(p));
    } catch {
      return false;
    }
  }
  /** Real path of `p` when it exists and stays inside the root; null when absent, unreadable or outside. */
  private resolve(p: string): string | null {
    try {
      const real = realpathSync(p);
      return this.inside(real) ? real : null;
    } catch (e) {
      return this.failed(p, e) || null;
    }
  }
  /** Directory entries in byte order; [] when absent, [] and incomplete when unreadable. */
  list(dir: string) {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      this.failed(dir, e);
      return [];
    }
  }

  walk(dir: string, depth = 4): string[] {
    if (depth < 0 || this.exhausted()) return [];
    const list = this.list(dir);
    const out: string[] = [];
    for (const e of list) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "vendor") continue;
      if (++this.entries > SCAN_LIMITS.maxEntries) this.stopped = true;
      if (this.exhausted()) break;
      const p = join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        const target = this.resolve(p);
        if (!target) {
          if (this.pointsOutside(p))
            this.skipped.push({ path: this.shown(p), reason: "symlink outside the repository" });
          continue;
        }
        try {
          isDir = statSync(target).isDirectory();
        } catch (err) {
          this.failed(p, err);
          continue;
        }
      }
      if (isDir) out.push(...this.walk(p, depth - 1));
      else out.push(p);
    }
    return out;
  }

  /** The file's text (UTF-8) when it is a regular file inside the root within the size bound; else null (reported). */
  readRaw(file: string): string | null {
    if (this.exhausted()) {
      this.skipped.push({
        path: this.shown(file),
        reason: "scan stopped: time or size budget exhausted",
      });
      return null;
    }
    const real = this.resolve(file);
    if (!real) {
      if (this.pointsOutside(file))
        this.skipped.push({ path: this.shown(file), reason: "symlink outside the repository" });
      return null;
    }
    let fd: number;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      return this.failed(file, e) || null;
    }
    try {
      let st, opened;
      try {
        st = fstatSync(fd);
        opened = realpathSync(`/proc/self/fd/${fd}`);
      } catch (e) {
        return this.failed(file, e) || null;
      }
      // The descriptor, not the path: a component swapped for a symlink after resolve() is caught here.
      if (!st.isFile() || !this.inside(opened)) return null;
      const buf = Buffer.alloc(Math.min(st.size, SCAN_LIMITS.maxFileBytes) + 1);
      let n = 0;
      try {
        for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
      } catch (e) {
        return this.failed(file, e) || null;
      }
      if (n > SCAN_LIMITS.maxFileBytes) {
        this.skipped.push({
          path: this.shown(file),
          reason: `larger than ${SCAN_LIMITS.maxFileBytes} bytes`,
        });
        return null;
      }
      this.budget.bytes += n;
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  }

  /** Read a source file for import: excluded paths, credentials and empty files are skipped (and reported). */
  read(file: string): string | null {
    const rel = relative(this.root, file);
    if (SKIP_PATH.some((re) => re.test(rel)))
      return (
        this.skipped.push({
          path: this.shown(file),
          reason: "path excluded (env/secret/task plan)",
        }),
        null
      );
    const text = this.readRaw(file);
    if (text === null || !text.trim()) return null;
    if (looksSecret(text))
      return (
        this.skipped.push({ path: this.shown(file), reason: "looks like it contains credentials" }),
        null
      );
    if (text.length > MAX_CHARS)
      this.skipped.push({ path: this.shown(file), reason: `truncated to ${MAX_CHARS} chars` });
    return sliceUnits(text, MAX_CHARS);
  }
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
  tree: SourceTree,
  skillDir: string,
  mainFile: string,
): SkillCompanion[] {
  return tree
    .walk(skillDir, 3)
    .filter((f) => f !== mainFile && COMPANION_FILE.test(f))
    .sort()
    .flatMap((f) => {
      const text = tree.read(f);
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
        description: sliceUnits(fields.description || firstParagraph(body), 600),
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
        description: sliceUnits(
          /\.md$/i.test(c.rel)
            ? firstHeading(c.text) || firstParagraph(c.text)
            : `${c.rel} of skill ${fields.name || s.name}`,
          300,
        ),
      },
      source: src(c.rel, c.text),
    })),
  ];
}

// ---------------------------------------------------------------- discovery (engine) and assembly (policy)
// Discovery reads the sources and builds every candidate except where it applies: each carries a scope target that
// assembleCandidates() resolves against the registry (scope, applicability, the enable policy of user skills). The
// platform-go (go/internal/knowledge) reads the files and returns the Discovery; scope, applicability and governance
// never leave TypeScript.

/** The user-level skills directory imported with the repositories. */
export const userSkillsDir = () =>
  process.env.CLAUDE_USER_SKILLS_DIR ?? join(homedir(), ".claude", "skills");

const UNATTENDED_UNSAFE_REASON =
  "interactive/workflow skill: acts on its own (push, PR, delegation) — enable deliberately";

/**
 * Policy over a discovery (TypeScript only): where each candidate applies, from the registry's repositories and
 * projects, and which user-level skills are imported disabled (USER_SKILLS_DISABLED).
 */
export function assembleCandidates(d: Discovery, all: RepositoryRow[]): ImportCandidate[] {
  const wikiSiblings = (name: string) => {
    const r = all.find((x) => x.name === name)!;
    // Code repositories a wiki documents: same group folder (e.g. payment-src/*) OR a project in common in the registry.
    // The project test also covers platform-managed checkouts, whose path is empty (e.g. a repository registered by URL).
    const group = r.path.includes("/") ? r.path.split("/")[0] : "";
    const wikiProjects = new Set(r.projects ?? []);
    return all
      .filter(
        (x) =>
          x.enabled &&
          x.name !== r.name &&
          !/wiki/i.test(x.name) &&
          ((group && x.path.split("/")[0] === group) ||
            (x.projects ?? []).some((p) => wikiProjects.has(p))),
      )
      .map((x) => x.name)
      .sort();
  };
  const wikiProjects = (name: string) => {
    const r = all.find((x) => x.name === name)!;
    return [
      ...new Set(
        all
          .filter((x) => x.path.split("/")[0] === r.path.split("/")[0] && x.path)
          .flatMap((x) => x.projects)
          .concat(r.projects),
      ),
    ];
  };
  return d.candidates.map(({ target, ...c }): ImportCandidate => {
    switch (target.kind) {
      case "repository":
        return { ...c, scope_type: "REPOSITORY", scope_ref: target.repo };
      case "repositories": {
        const t = scopeForRepositories(target.repos, all);
        return { ...c, ...t.scope, applicability: t.applicability };
      }
      case "wiki_siblings": {
        const siblings = wikiSiblings(target.repo);
        const t = scopeForRepositories(siblings.length ? siblings : [target.repo], all);
        return { ...c, ...t.scope, applicability: t.applicability };
      }
      case "wiki_projects": {
        const t = scopeForProjects(wikiProjects(target.repo));
        return { ...c, ...t.scope, applicability: t.applicability };
      }
      case "user_skill": {
        const t = scopeForUserSkill(target.name, all);
        // Interactive/meta skills of ~/.claude act on their own (push, open PRs, delegate): imported disabled.
        if (c.metadata?.origin !== "user")
          return { ...c, ...t.scope, applicability: t.applicability };
        const unsafe = USER_SKILLS_DISABLED.includes(target.name);
        return {
          ...c,
          ...t.scope,
          applicability: t.applicability,
          enabled: !unsafe,
          metadata: {
            ...c.metadata,
            ...(unsafe ? { disabled_reason: UNATTENDED_UNSAFE_REASON } : {}),
          },
        };
      }
    }
  });
}

/** Repositories to scan: enabled ones checked out on this server (TypeScript decides; the engines only read). */
async function scanTargets() {
  const all = await repositories.list();
  const repos: DiscoveryRepository[] = [];
  for (const r of all.filter((x) => x.enabled && existsSync(join(repoPath(x), ".git"))))
    repos.push({ name: r.name, root: repoPath(r), self: await isSelfRepository(r) });
  return { all, repos };
}

/** Scan every enabled repository on disk and build import candidates (no DB writes). */
export async function scanRepositories(): Promise<{
  candidates: ImportCandidate[];
  skipped: ImportReport["skipped"];
  scanned: string[];
  incomplete: string[];
}> {
  const { all, repos } = await scanTargets();
  const d = await goKnowledgeScan(repos, userSkillsDir());
  return {
    candidates: assembleCandidates(d, all),
    skipped: d.skipped,
    scanned: d.scanned,
    incomplete: d.incomplete,
  };
}

const IMPORT_LOCK = 727_007; // pg_advisory_lock key: one knowledge import publishes at a time, across instances

/**
 * Publications are serialized (a second import waits, then finds the first one's items unchanged): candidates are
 * compared with the registry once, before writing. In this process by a queue; across instances by an advisory lock
 * held on a dedicated connection outside the pool — so it works with any pool size, including one — which
 * PostgreSQL releases when the holding process dies. Each write first checks the lock is still held
 * (importGuard): an import that lost its lock connection stops instead of writing next to another instance. Dry runs
 * only read and take no lock.
 */
let importQueue: Promise<unknown> = Promise.resolve();
let activeLock: { client: pg.Client; lost: Error | null; checkedAt: number } | null = null;

export function serializedImport<T>(dryRun: boolean | undefined, fn: () => Promise<T>) {
  if (dryRun) return fn();
  const run = importQueue.then(async () => {
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: config.database.connectionTimeoutMillis,
      keepAlive: true,
    });
    const lock = { client, lost: null as Error | null, checkedAt: Date.now() };
    client.on("error", (e) => (lock.lost ??= e));
    client.on("end", () => (lock.lost ??= new Error("connection closed")));
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [IMPORT_LOCK]);
      activeLock = lock;
      return await fn();
    } finally {
      activeLock = null;
      await client
        .query("SELECT pg_advisory_unlock($1)", [IMPORT_LOCK])
        .catch(ignoreError("knowledge_import.advisory_unlock"));
      await client.end().catch(ignoreError("knowledge_import.client_end"));
    }
  });
  importQueue = run.catch(ignoreError("knowledge_import.queue_chain"));
  return run;
}

/**
 * Before a registry write of a serialized import: throws if the lock connection is gone (the lock went with it).
 * The connection is probed at most once a second, so a long import pays one round trip per second, not per write.
 */
export async function importGuard() {
  const lock = activeLock;
  if (!lock) return;
  if (!lock.lost && Date.now() - lock.checkedAt >= 1000) {
    await lock.client.query("SELECT 1").catch((e) => (lock.lost ??= e));
    lock.checkedAt = Date.now();
  }
  if (lock.lost)
    throw new Error(
      `knowledge import stopped: its publication lock was lost (${lock.lost.message})`,
    );
}

/** Create/update registry items from the scan. Unchanged files create no new version. */
export function importFromRepositories(
  opts: { dryRun?: boolean; only?: string } = {},
): Promise<ImportReport> {
  return serializedImport(opts.dryRun, () => importFromRepositoriesNow(opts));
}

async function importFromRepositoriesNow(opts: { dryRun?: boolean; only?: string }) {
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
    ...(scan.incomplete.length ? { incomplete: scan.incomplete } : {}),
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
      const desc = String(c.metadata?.description ?? "").slice(0, 400);
      if (repo && !repo.description && desc)
        await repositories.upsert(repo.name, { description: desc });
    }
  await applyCandidates(candidates, report, {
    dryRun: opts.dryRun,
    owned: true,
    createdBy: "repository import",
    incomplete: new Set(scan.incomplete),
  });

  // Retire imported items whose source files are gone from repositories that were scanned (moved/deleted docs).
  // Only items owned by the import (metadata.imported_from_repository) and only when every source repo was on disk.
  if (opts.only) return report;
  const produced = new Set(candidates.map((c) => c.key));
  const scannedSet = new Set(scanned);
  // Summary listing (no contents); the contents of the few items retired are read once, for the report's `chars`.
  const retiring = (await knowledge.list({ summary: true })).filter((it) => {
    if (!it.enabled || produced.has(it.key) || !it.metadata?.imported_from_repository) return false;
    const sources: { repo: string }[] = it.metadata.source ?? [];
    return sources.length > 0 && sources.every((s) => scannedSet.has(s.repo));
  });
  const contents = retiring.length
    ? new Map(
        (
          await q<{ key: string; content: string }>(
            pool,
            `SELECT i.key, v.content FROM knowledge_items i
               JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
              WHERE i.owner_id IS NULL AND i.key = ANY($1::text[])`,
            [retiring.map((it) => it.key)],
          )
        ).map((r) => [r.key, r.content]),
      )
    : new Map<string, string>();
  for (const it of retiring) {
    const sources: { repo: string; path: string }[] = it.metadata.source;
    report.candidates.push({
      key: it.key,
      title: it.title,
      category: it.category,
      scope: `${it.scope_type}${it.scope_ref ? ":" + it.scope_ref : ""}`,
      repos: [...new Set(sources.map((s) => s.repo))],
      chars: (contents.get(it.key) ?? "").length,
      action: "retire",
    });
    report.retired++;
    if (opts.dryRun) continue;
    await importGuard();
    await knowledge.updateWithoutReload(it.key, {
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
  const tree = new SourceTree(dir, name, skipped, newBudget());
  const text = tree.read(mainFile);
  if (!text) throw new Error(`${mainFile} was skipped: ${skipped.map((s) => s.reason).join("; ")}`);
  const candidates = skillCandidates({
    key: slug(`skill.${name}`),
    name,
    text,
    companions: readSkillCompanions(tree, dir, mainFile),
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
  await serializedImport(opts.dryRun, () =>
    applyCandidates(candidates, report, {
      dryRun: opts.dryRun,
      owned: false,
      createdBy: opts.createdBy ?? "local skill import",
    }),
  );
  return report;
}

/**
 * Import a registered repository's knowledge from a LOCAL checkout: its agent instructions (CLAUDE.md / AGENTS.md,
 * inlined, same keys as the repository import) and every Markdown file under docs/ (on demand). For docs the
 * platform-managed checkout cannot see (git-ignored, unpushed or on another branch). Re-running updates in place.
 */
export async function importLocalCheckout(opts: {
  dir: string;
  repo: string;
  dryRun?: boolean;
  createdBy?: string;
}): Promise<ImportReport> {
  const root = opts.dir.replace(/[\\/]+$/, "");
  const repo = await repositories.get(opts.repo);
  if (!repo) throw new Error(`unknown repository ${opts.repo}`);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`${root} is not a directory`);
  const skipped: ImportReport["skipped"] = [];
  const tree = new SourceTree(root, repo.name, skipped, newBudget());
  const read = (f: string) => tree.read(f);
  const src = (file: string, text: string) => ({
    repo: repo.name,
    path: relative(root, file).replaceAll("\\", "/"),
    sha256: sha(text),
  });
  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const file = join(root, f);
    if (!tree.exists(file)) continue;
    const text = read(file);
    if (!text || seen.has(sha(text))) continue;
    seen.add(sha(text));
    candidates.push({
      key: slug(`${repo.name}.${f.replace(/\.md$/i, "")}`),
      category: "repository_convention",
      scope_type: "REPOSITORY",
      scope_ref: repo.name,
      title: `${repo.name}: ${f}`,
      content: text,
      metadata: {
        load: "inline",
        description: firstParagraph(text),
        imported_from_local_checkout: true,
      },
      source: [src(file, text)],
    });
  }
  for (const file of tree
    .walk(join(root, "docs"), 4)
    .filter((f) => /\.md$|\/llms\.txt$/i.test(f))
    .sort()) {
    const text = read(file);
    if (!text) continue;
    const rel = relative(root, file).replaceAll("\\", "/");
    candidates.push({
      key: slug(`${repo.name}.${rel.replace(/\.(md|txt)$/i, "").replace(/\//g, ".")}`),
      category: /architecture/i.test(rel) ? "architecture_guideline" : "domain_knowledge",
      scope_type: "REPOSITORY",
      scope_ref: repo.name,
      title: `${repo.name}: ${firstHeading(text.replace(/^---[\s\S]*?---/, "")) ?? rel}`,
      content: text,
      metadata: {
        load: "on_demand",
        description: firstParagraph(text),
        imported_from_local_checkout: true,
      },
      source: [src(file, text)],
    });
  }
  const report: ImportReport = {
    candidates: [],
    skipped,
    created: 0,
    updated: 0,
    unchanged: 0,
    retired: 0,
    conflicts: 0,
  };
  await serializedImport(opts.dryRun, () =>
    applyCandidates(candidates, report, {
      dryRun: opts.dryRun,
      owned: false,
      createdBy: opts.createdBy ?? "local checkout import",
    }),
  );
  return report;
}

/**
 * Create / update registry items from candidates. `owned`: mark them import-owned (eligible for retirement). The
 * registry state of every candidate is read in one statement (contents compared by hash); only changed items are
 * written, each in its own transaction as before (row lock, new version, audit).
 */
async function applyCandidates(
  candidates: ImportCandidate[],
  report: ImportReport,
  opts: { dryRun?: boolean; owned: boolean; createdBy: string; incomplete?: Set<string> },
) {
  // Deleted by an admin (knowledge_deletions): never re-created while the source file still exists.
  const deleted = await knowledge.deletedKeys();
  const current = await knowledge.latestShared(candidates.map((c) => c.key));
  for (const c of candidates) {
    const parent = c.metadata?.parent_skill as string | undefined;
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
    const existing = current.get(c.key);
    // An incomplete scan must not narrow an item either: if it came from a repository whose scan did not finish and
    // that repository is missing from the candidate's sources, the candidate may be missing it only because a file
    // could not be read. Defer the update to a complete scan (retirement is likewise never decided from one).
    const lost = ((existing?.metadata?.source ?? []) as { repo: string }[])
      .map((x) => x.repo)
      .filter((repo) => opts.incomplete?.has(repo) && !source.some((x) => x.repo === repo));
    if (lost.length) {
      report.skipped.push({
        path: source.map((x) => `${x.repo}/${x.path}`).join(", "),
        reason: `${c.key} not updated: the scan of ${[...new Set(lost)].join(", ")} is incomplete`,
      });
      continue;
    }
    const sameContent = existing?.content_sha256 === sha(c.content);
    const evolution = existing?.metadata?.evolution;
    if (existing && evolution && !sameContent) {
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
          await importGuard();
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
    const wasRetired = !!existing && !existing.enabled && !!existing.metadata?.retired_reason;
    if (existing) {
      const v = existing;
      // JSONB reorders keys, so compare canonical hashes rather than JSON strings.
      const same =
        sameContent &&
        hashOf(v.applicability ?? {}) === hashOf(c.applicability ?? {}) &&
        hashOf(v.metadata?.source ?? null) === hashOf(source) &&
        // Parser fixes (e.g. folded YAML descriptions) change these without touching the file.
        (v.metadata?.description ?? null) === (item.metadata?.description ?? null) &&
        hashOf(v.metadata?.companions ?? null) === hashOf(item.metadata?.companions ?? null) &&
        !!v.metadata?.imported_from_repository === opts.owned &&
        !!v.metadata?.imported_from_local_skill === !!item.metadata?.imported_from_local_skill &&
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
    await importGuard();
    if (action === "create")
      await knowledge.createWithoutReload({
        ...item,
        metadata,
        created_by: opts.createdBy,
        change_note: `imported from ${source.map((s) => `${s.repo}/${s.path}`).join(", ")}`,
      });
    else
      await knowledge.updateWithoutReload(c.key, {
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
