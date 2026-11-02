import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, q, one, type Db } from "../db/pool.ts";

export interface RepositoryRow {
  id: number;
  name: string;
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

const EDITABLE = ["description", "projects", "services", "owners", "tags", "dependencies", "architecture", "allowed_actions", "enabled", "remote_slug", "provider"] as const;

export const repositories = {
  list(db: Db = pool) {
    return q<RepositoryRow>(db, "SELECT * FROM repositories ORDER BY name");
  },
  get(name: string, db: Db = pool) {
    return one<RepositoryRow>(db, "SELECT * FROM repositories WHERE name = $1", [name]);
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
   * The deterministic allowed set for a project — same semantics as the legacy `allowedRepos(project)`:
   * repos mapped to the project, or every enabled repo when the project has no mapping.
   */
  async allowedFor(project: string, action: "read" | "write" | "pull_request" = "read", db: Db = pool): Promise<string[]> {
    const rows = await q<RepositoryRow>(db, "SELECT * FROM repositories WHERE enabled AND $1 = ANY(allowed_actions) ORDER BY name", [action]);
    const p = project.trim().toLowerCase();
    const mapped = rows.filter((r) => r.projects.some((x) => x.toLowerCase() === p));
    return (p && mapped.length ? mapped : rows).map((r) => r.name);
  },
};

/** Register repos from config.projects and the git checkouts in reposRoot. Never overwrites user edits. */
export async function syncRepositoriesFromConfig() {
  const mapped = new Map<string, Set<string>>();
  for (const [project, repos] of Object.entries(config.projects)) {
    for (const r of repos) (mapped.get(r) ?? mapped.set(r, new Set()).get(r)!).add(project);
  }
  const onDisk = existsSync(config.reposRoot)
    ? readdirSync(config.reposRoot).filter((r) => existsSync(join(config.reposRoot, r, ".git")))
    : [];
  for (const name of new Set([...mapped.keys(), ...onDisk])) {
    const existing = await repositories.get(name);
    const projects = [...(mapped.get(name) ?? [])];
    if (!existing) await repositories.upsert(name, { projects, remote_slug: name });
    else {
      const merged = [...new Set([...existing.projects, ...projects])];
      if (merged.length !== existing.projects.length) await repositories.upsert(name, { projects: merged });
    }
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
      if (request.project && r.projects.some((p) => p.toLowerCase() === request.project!.toLowerCase())) {
        score += 2;
        reasons.push(`mapped to project ${request.project}`);
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
