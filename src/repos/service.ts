import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveRepoPath } from "./paths.ts";
import { repositoryRemote, repositoryBranch } from "./remote.ts";
import { config } from "../config.ts";
import { pool, q, one, inTx, txWrote, withTx, type Db } from "../db/pool.ts";
import { CacheAside } from "../cache/index.ts";

export interface RepositoryRow {
  id: number;
  name: string;
  /** Relative to reposRoot; '' = same as name. */
  path: string;
  provider: string;
  remote_slug: string;
  repository_url?: string | null;
  default_branch?: string;
  description: string;
  projects: string[];
  services: string[];
  owners: string[];
  tags: string[];
  dependencies: string[];
  architecture: string;
  allowed_actions: string[];
  enabled: boolean;
  /** Explicit access for every active user ('none' = only per-user grants; see repos/access.ts). */
  shared_access?: "none" | "read" | "write" | "pull_request";
}

/** The registry is small and read on every run start, discovery, PR and authorization check. */
const repoCache = new CacheAside<RepositoryRow[]>("repositories", ["repositories"], 60_000, 1);
function allRepositories(db: Db): Promise<RepositoryRow[]> {
  const load = () => q<RepositoryRow>(db, "SELECT * FROM repositories ORDER BY name");
  return inTx(db) && txWrote(db, "repositories") ? load() : repoCache.get("all", load);
}

const EDITABLE = ["repository_url", "default_branch", "path", "description", "projects", "services", "owners", "tags", "dependencies", "architecture", "allowed_actions", "enabled", "remote_slug", "provider"] as const;

/** A repository cannot be removed right now (HTTP 409). */
export class RepositoryInUseError extends Error {
  status = 409;
}

export const repositories = {
  list(db: Db = pool) {
    return allRepositories(db);
  },
  async get(name: string, db: Db = pool) {
    return (await allRepositories(db)).find((r) => r.name === name);
  },
  async upsert(name: string, patch: Partial<RepositoryRow>, db: Db = pool) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || [".", ".."].includes(name)) throw new Error(`invalid repository name "${name}"`);
    if (patch.path && (isAbsolute(patch.path) || patch.path.split(/[\\/]/).includes(".."))) throw new Error("Shared repository path must be a relative layout hint; use local repositories overrides for absolute paths");
    patch = { ...patch };
    if (patch.repository_url != null) {
      const remote = repositoryRemote(patch.repository_url);
      patch.repository_url = remote.url;
      patch.remote_slug = `${remote.workspace}/${remote.slug}`;
      patch.provider = "bitbucket";
    }
    if (patch.default_branch) repositoryBranch(patch.default_branch);
    const existing = await repositories.get(name, db);
    if (existing?.repository_url && patch.repository_url !== undefined && patch.repository_url !== existing.repository_url) {
      const active = await one(db, "SELECT id FROM workflow_runs WHERE $1=ANY(allowed_repositories) AND status NOT IN ('COMPLETED','FAILED','CANCELED') LIMIT 1", [name]);
      if (active) throw new Error("Repository remote cannot change while runs are active");
    }
    if (existing?.repository_url && patch.repository_url === undefined) {
      const remote = repositoryRemote(existing.repository_url);
      patch.remote_slug = `${remote.workspace}/${remote.slug}`;
      patch.provider = "bitbucket";
    }
    const cols = EDITABLE.filter((k) => patch[k] !== undefined);
    if (!existing) {
      // Registering a deleted name again is explicit: discovery may pick it up again from now on.
      await q(db, "DELETE FROM repository_exclusions WHERE name = $1", [name]);
      await q(
        db,
        `INSERT INTO repositories (name${cols.length ? ", " + cols.join(", ") : ""}) VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join("")}) ON CONFLICT (name) DO NOTHING`,
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
   * Unregister a repository. Only the registry row (and its code-intelligence index, by cascade) is removed: local
   * checkouts on disk, past runs and their workspaces keep the name as history. The name is recorded as an exclusion
   * so discovery from config.projects (group folders) does not register it again on the next start. Refused while
   * an unfinished run may use it.
   */
  async remove(name: string, deletedBy: number | null = null) {
    return withTx(async (c) => {
      const existing = await one(c, "SELECT id FROM repositories WHERE name = $1 FOR UPDATE", [name]);
      if (!existing) return false;
      const active = await one(c, "SELECT id FROM workflow_runs WHERE $1=ANY(allowed_repositories) AND status NOT IN ('COMPLETED','FAILED','CANCELED') LIMIT 1", [name]);
      if (active) throw new RepositoryInUseError(`Repository is used by unfinished run #${active.id}; finish or cancel it first, or disable the repository`);
      await q(c, "DELETE FROM repositories WHERE name = $1", [name]);
      await q(c, "INSERT INTO repository_exclusions (name, deleted_by) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET deleted_by = EXCLUDED.deleted_by, deleted_at = now()", [name, deletedBy]);
      return true;
    });
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

export const repoPath = resolveRepoPath;
const isGit = (rel: string) => {
  const marker = join(config.reposRoot, rel, ".git");
  if (!existsSync(marker)) return false;
  // Linked worktrees are another checkout of an existing logical repository, not new registry entries.
  // Submodules also have a .git file but do not have a commondir marker, so keep discovering them.
  try {
    if (statSync(marker).isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"))?.[1];
      if (gitdir && existsSync(join(resolve(dirname(marker), gitdir.trim()), "commondir"))) return false;
    }
  } catch { return false; }
  return true;
};

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
 * from THIS machine is left alone. Local discovery only bootstraps absent entries; metadata edits are explicit.
 */
/** Repositories this installation's config.projects would (re-)register on boot: name → relative path and projects. */
export function configuredRepositories(): Map<string, { rel: string; projects: string[] }> {
  const found = new Map<string, Set<string>>(); // relative path -> projects
  const add = (rel: string, project?: string) => {
    const s = found.get(rel) ?? found.set(rel, new Set()).get(rel)!;
    if (project) s.add(project);
  };
  for (const [project, entries] of Object.entries(config.projects)) for (const e of entries) for (const rel of expandRepoEntry(e)) add(rel, project);
  const taken = new Map<string, string>();
  const out = new Map<string, { rel: string; projects: string[] }>();
  for (const [rel, projects] of found) {
    let name = rel.split("/").pop()!;
    if (taken.has(name) && taken.get(name) !== rel) name = rel.replace(/\//g, ".");
    taken.set(name, rel);
    out.set(name, { rel, projects: [...projects] });
  }
  return out;
}

export async function syncRepositoriesFromConfig() {
  const excluded = new Set((await q<{ name: string }>(pool, "SELECT name FROM repository_exclusions")).map((r) => r.name));
  for (const [name, { rel, projects }] of configuredRepositories()) {
    if (excluded.has(name)) continue; // deleted by an admin; only an explicit registration brings it back
    const existing = await repositories.get(name);
    const path = rel === name ? "" : rel;
    if (!existing) await repositories.upsert(name, { path, projects, remote_slug: name });
  }
  // Existing shared entries are never changed based on this installation's config or filesystem.

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

/** Registry branch with the installation default retained for legacy/local fixtures. */
export async function repositoryBaseBranch(name: string): Promise<string> {
  return (await repositories.get(name))?.default_branch || config.baseBranch;
}
export async function workspaceBaseBranch(path: string): Promise<string> {
  const row = await one(pool, "SELECT r.default_branch FROM repositories r JOIN execution_workspaces w ON r.name=w.repo WHERE w.path=$1 LIMIT 1", [path]);
  return row?.default_branch || config.baseBranch;
}

export function repositoryReference(repo: Pick<RepositoryRow, "repository_url" | "remote_slug" | "name">): string {
  if (!repo.repository_url) return repo.remote_slug || repo.name;
  const remote = repositoryRemote(repo.repository_url);
  return `${remote.workspace}/${remote.slug}`;
}
