import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q, one, inTx, txWrote, type Db } from "../db/pool.ts";
import { CacheAside } from "../cache/index.ts";

export interface RepositoryRow {
  id: number;
  name: string;
  /** Relative to reposRoot; '' = same as name. */
  path: string;
  provider: string;
  remote_slug: string;
  description: string;
  projects: string[];
  services: string[];
  owners: string[];
  tags: string[];
  dependencies: string[];
  architecture: string;
  allowed_actions: string[];
  enabled: boolean;
}

/** The registry is small and read on every run start, discovery, PR and authorization check. */
const repoCache = new CacheAside<RepositoryRow[]>("repositories", ["repositories"], 60_000, 1);
function allRepositories(db: Db): Promise<RepositoryRow[]> {
  const load = () => q<RepositoryRow>(db, "SELECT * FROM repositories ORDER BY name");
  return inTx(db) && txWrote(db, "repositories") ? load() : repoCache.get("all", load);
}

const EDITABLE = ["path", "description", "projects", "services", "owners", "tags", "dependencies", "architecture", "allowed_actions", "enabled", "remote_slug", "provider"] as const;

export const repositories = {
  list(db: Db = pool) {
    return allRepositories(db);
  },
  async get(name: string, db: Db = pool) {
    return (await allRepositories(db)).find((r) => r.name === name);
  },
  async upsert(name: string, patch: Partial<RepositoryRow>, db: Db = pool) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid repository name "${name}"`);
    const cols = EDITABLE.filter((k) => patch[k] !== undefined);
    const existing = await repositories.get(name, db);
    if (!existing) {
      await q(
        db,
        `INSERT INTO repositories (name, ${cols.join(", ")}) VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join("")})`,
        [name, ...cols.map((k) => patch[k])],
      );
    } else if (cols.length) {
      await q(db, `UPDATE repositories SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE name = $1`, [
        name,
        ...cols.map((k) => patch[k]),
      ]);
    }
    return repositories.get(name, db);
  },

  /**
   * Enabled repositories allowed to perform `action` for a project: those mapped to the project or to a project
   * linked with it in config.relatedProjects, or every such repository when the project has no mapping.
   */
  async allowedFor(project: string, action: "read" | "write" | "pull_request" = "read", db: Db = pool): Promise<string[]> {
    const all = await allRepositories(db);
    const rows = all.filter((r) => r.enabled && r.allowed_actions.includes(action));
    const p = project.trim().toLowerCase();
    const scope = new Set(projectScope(project));
    const maps = (r: RepositoryRow) => r.projects.some((x) => scope.has(x.toLowerCase()));
    // A known project never widens to every repository, even when all of its repositories are disabled right now.
    if (p && all.some(maps)) return rows.filter(maps).map((r) => r.name);
    return rows.map((r) => r.name);
  },
};

/**
 * Lower-cased project names whose repositories a run for `project` may use: the project itself plus every project
 * linked with it in config.relatedProjects, in either direction, one hop only. Empty project → [].
 */
export function projectScope(project: string, related: Record<string, string[]> = config.relatedProjects ?? {}): string[] {
  const p = project.trim().toLowerCase();
  if (!p) return [];
  const scope = new Set([p]);
  for (const [from, tos] of Object.entries(related)) {
    const f = from.trim().toLowerCase();
    const t = (tos ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (f === p) t.forEach((x) => scope.add(x));
    else if (t.includes(p)) scope.add(f);
  }
  return [...scope];
}

export const repoPath = (r: Pick<RepositoryRow, "name" | "path">) => join(config.reposRoot, r.path || r.name);
const isGit = (rel: string) => existsSync(join(config.reposRoot, rel, ".git"));

/**
 * Expand a reposRoot-relative entry into git repositories: the entry itself if it is a repo, otherwise its direct
 * sub-folders that are repos (a "group" folder such as oms-src/ holding oms-api, oms-background, ...).
 */
export function expandRepoEntry(rel: string): string[] {
  if (isGit(rel)) return [rel];
  const dir = join(config.reposRoot, rel);
  if (!existsSync(dir)) {
    // A bare repo name ("oms-api") may live inside a group folder ("oms-src/oms-api").
    if (rel.includes("/") || !existsSync(config.reposRoot)) return [];
    return readdirSync(config.reposRoot).map((g) => join(g, rel)).filter(isGit);
  }
  try {
    return readdirSync(dir).filter((d) => isGit(join(rel, d))).map((d) => join(rel, d));
  } catch {
    return [];
  }
}

/**
 * Register git repositories from config.projects only (entries may be repos or group folders). Other checkouts under
 * reposRoot (tools, plugins, personal projects) are never registered. Never overwrites user edits.
 *
 * The registry lives in a database that several machines may share, each with its own reposRoot. A repository missing
 * from THIS machine is therefore left alone (it may exist on another one); only an entry that exists here but is not a
 * git repository (a group folder registered by an old sync) is disabled.
 */
export async function syncRepositoriesFromConfig() {
  const found = new Map<string, Set<string>>(); // relative path -> projects
  const add = (rel: string, project?: string) => {
    const s = found.get(rel) ?? found.set(rel, new Set()).get(rel)!;
    if (project) s.add(project);
  };
  for (const [project, entries] of Object.entries(config.projects)) for (const e of entries) for (const rel of expandRepoEntry(e)) add(rel, project);
  const taken = new Map<string, string>();
  for (const [rel, projects] of found) {
    let name = rel.split("/").pop()!;
    if (taken.has(name) && taken.get(name) !== rel) name = rel.replace(/\//g, ".");
    taken.set(name, rel);
    const existing = await repositories.get(name);
    const path = rel === name ? "" : rel;
    if (!existing) await repositories.upsert(name, { path, projects: [...projects], remote_slug: name });
    else {
      const merged = [...new Set([...existing.projects, ...projects])];
      const patch: Partial<RepositoryRow> = {};
      if (merged.length !== existing.projects.length) patch.projects = merged;
      if (!existing.path && path) patch.path = path;
      if (Object.keys(patch).length) await repositories.upsert(name, patch);
    }
  }
  for (const r of await repositories.list())
    if (r.enabled && existsSync(join(config.reposRoot, r.path || r.name)) && !isGit(r.path || r.name)) {
      await repositories.upsert(r.name, { enabled: false, description: r.description || `disabled: ${r.path || r.name} is not a git repository under reposRoot` });
      console.log(`repository ${r.name}: ${r.path || r.name} is not a git repository — disabled`);
    }
}

// ---------------------------------------------------------------- ranking

export interface RankedRepository {
  repo: string;
  score: number;
  reasons: string[];
}

const STOP = new Set("the and for with from that this into when then than have has are was were not but you your task api fix bug add new update của và cho khi các những được trong một không".split(" "));

export function tokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOP.has(t)),
    ),
  ];
}

/**
 * Deterministic, explainable relevance score. Every point comes with a human-readable reason so the
 * recommendation can be reviewed; AI re-ranking (optional) only reorders within this allowed set.
 */
export function rankRepositories(repos: RepositoryRow[], request: { text: string; keywords?: string[]; project?: string }): RankedRepository[] {
  const words = new Set([...tokens(request.text), ...(request.keywords ?? []).flatMap(tokens)]);
  return repos
    .map((r) => {
      let score = 0;
      const reasons: string[] = [];
      const own = !!request.project && r.projects.some((p) => p.toLowerCase() === request.project!.toLowerCase());
      if (own) {
        score += 2;
        reasons.push(`mapped to project ${request.project}`);
      }
      // A request that names another project a repo belongs to ("lỗi phía OMS" in a Payment ticket) points at that
      // repo. Repos of the run's own project already got the mapping bonus above.
      const named = own ? undefined : r.projects.find((p) => tokens(p).length > 0 && tokens(p).every((t) => words.has(t)));
      if (named) {
        score += 3;
        reasons.push(`request mentions project ${named}`);
      }
      const fields: Array<[string, string[], number]> = [
        ["name", tokens(r.name.replace(/[-_]/g, " ")), 3],
        ["services", r.services.flatMap(tokens), 3],
        ["tags", r.tags.flatMap(tokens), 2],
        ["description", tokens(r.description), 1],
        ["architecture", tokens(r.architecture), 1],
      ];
      for (const [field, fieldTokens, weight] of fields) {
        const hits = fieldTokens.filter((t) => words.has(t));
        if (hits.length) {
          score += weight * hits.length;
          reasons.push(`${field} matches: ${[...new Set(hits)].slice(0, 6).join(", ")}`);
        }
      }
      return { repo: r.name, score, reasons: reasons.length ? reasons : ["no keyword match"] };
    })
    .sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
}

/** Ambiguous = nothing matched, or the runner-up is within 25% of the leader. */
export function isAmbiguous(ranked: RankedRepository[]) {
  if (!ranked.length || ranked[0].score === 0) return true;
  return ranked.length > 1 && ranked[1].score >= ranked[0].score * 0.75;
}
