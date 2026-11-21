import { config, codeIntelligenceEnabled } from "../config.ts";
import { rankRepositories, type RepositoryRow, type RankedRepository } from "../repos/service.ts";
import { snapshot } from "./store.ts";
import { baseCommit, changes } from "./git.ts";
import { localScope } from "./indexer.ts";
import { goExactSearch, goSearch } from "./goSearch.ts";
/**
 * Code search (symbols, definitions, references, dependencies, exact text, code context) is answered by platform-go
 * (ADR 0006). This module authorizes the scope, shapes results and ranks repositories; it has no second engine.
 */
export interface SearchScope {
  repositories: string[];
  allowed: string[];
  runId?: number;
  /** When one run has several worktrees of the same repository, read this checkout rather than the first. */
  workspaces?: Readonly<Record<string, string>>;
  /** Metadata ranking may inspect existing sources but must never provision or schedule clones. */
  provision?: boolean;
}
export interface Hit {
  repository: string;
  file_path: string;
  line_range: [number, number];
  match_type: string;
  confidence: number;
  snapshot: {
    id: number | null;
    commit: string;
    generation: string;
    run_id: number | null;
  };
  symbol_name?: string;
  qualified_name?: string;
  signature?: string;
  snippet?: string;
  content_hash?: string;
}
interface RelationRow {
  id: number;
  extraction_id: number;
  file_path: string;
  source_name: string;
  target_name: string;
  relation_type: string;
  resolution: string;
  line: number;
  content_hash: string;
}
interface DependencyEdge extends RelationRow {
  repository: string;
  snapshot: Hit["snapshot"];
  line_range: [number, number];
  match_type: string;
  confidence: number;
  depth: number;
  candidate_definitions?: Hit[];
}
function authorize(s: SearchScope) {
  if (s.repositories.length > 30 || s.repositories.some((r) => !s.allowed.includes(r)))
    throw new Error("Unauthorized repository search");
}
export const queryTerms = (text: string) =>
  [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_./:-]{2,127}/g) ?? [])].slice(0, 24);
export async function fresh(
  repoName: string,
  runId?: number,
  provision = false,
  workspacePath?: string,
) {
  const local = await localScope(repoName, runId, provision, workspacePath);
  const base = await baseCommit(local.primary, local.repo.default_branch || config.baseBranch);
  const baseline = await snapshot(local.repo.id, `base:${base}`);
  if (!baseline) return { ...local, index: null, base };
  if (!runId) return { ...local, index: baseline, base };
  const state = await changes(local.root, base);
  const index =
    (await snapshot(
      local.repo.id,
      `overlay:${config.instanceId}:${runId}:${baseline.id}:${state.generation}`,
    )) ?? null;
  return { ...local, index, base };
}
/** Ranking of search hits (both engines): confidence, qualified first, then repository, path and line. */
const byRank = (a: Hit, b: Hit) =>
  b.confidence - a.confidence ||
  Number(b.match_type === "qualified") - Number(a.match_type === "qualified") ||
  a.repository.localeCompare(b.repository) ||
  a.file_path.localeCompare(b.file_path) ||
  a.line_range[0] - b.line_range[0];

/** Only published and freshly validated snapshot mappings are queried. Failure is a live-search fallback. */
export async function searchSymbols(
  text: string,
  scope: SearchScope,
  limit = 30,
): Promise<{ hits: Hit[]; fallback_count: number; search_latency: number }> {
  authorize(scope);
  const start = Date.now(),
    terms = queryTerms(text);
  if (!codeIntelligenceEnabled() || !terms.length)
    return { hits: [], fallback_count: 0, search_latency: Date.now() - start };
  const viaGo = await goSearch<Hit, never>("symbols", scope, scope.provision === true, {
    text,
    limit,
  });
  return {
    hits: (viaGo.hits ?? []).sort(byRank).slice(0, limit),
    fallback_count: viaGo.fallback_count,
    search_latency: Date.now() - start,
  };
}
export async function findDefinitions(symbol: string, scope: SearchScope) {
  const result = await searchSymbols(symbol, scope);
  const isDefinition = (h: Hit) => h.symbol_name === symbol || h.qualified_name === symbol;
  return {
    ...result,
    hits: result.hits.filter(isDefinition),
    // Text matches from a stale/unavailable index are never presented as definitions — but never hidden either.
    text_candidates: result.fallback_count
      ? result.hits.filter((h) => !isDefinition(h) && h.match_type === "text").slice(0, 10)
      : [],
  };
}
/** Syntax edges are preserved as candidates. Name equality never promotes them to resolved calls. */
export async function findDependencies(
  symbol: string,
  scope: SearchScope,
  depth = 1,
  direction: "out" | "in" = "out",
  report?: { unavailable: string[] },
) {
  authorize(scope);
  if (!codeIntelligenceEnabled()) return [];
  const viaGo = await goSearch<never, DependencyEdge>(
    "dependencies",
    scope,
    scope.provision === true,
    {
      symbol,
      depth,
      direction,
    },
  );
  for (const u of viaGo.unavailable)
    if (report && !report.unavailable.includes(u)) report.unavailable.push(u);
  return viaGo.edges ?? [];
}
export const findReferences = (symbol: string, scope: SearchScope) =>
  findDependencies(symbol, scope, 1, "in");
/**
 * Bounded ripgrep. Default: the indexed languages only (code fallback). `anyFile`: exact text / config / log search in
 * any non-secret file — Tree-sitter is never forced on strings or unsupported languages.
 */
export async function searchCodeExact(
  pattern: string,
  scope: SearchScope,
  limit = 20,
  opts: { anyFile?: boolean } = {},
): Promise<Hit[]> {
  authorize(scope);
  if (!pattern || pattern.length > 256 || pattern.includes("\n"))
    throw new Error("Invalid exact search pattern");
  const viaGo = await goExactSearch<Hit>(scope, scope.provision !== false, {
    pattern,
    limit,
    any_file: !!opts.anyFile,
  });
  return viaGo;
}
export function applyEvidence(
  ranked: RankedRepository[],
  hits: Hit[],
  dependencyRepos: Set<string> = new Set(),
) {
  const w = config.codeIntelligence.weights;
  return ranked
    .map((r) => {
      const evidence = hits.filter((h) => h.repository === r.repo);
      // At most one contribution per signal, capped below a strong name/service metadata match.
      const kinds = new Set(evidence.map((h) => h.match_type));
      const bonus = Math.min(
        w.cap,
        (kinds.has("exact_symbol") ? w.exact : 0) +
          (kinds.has("qualified") ? w.qualified : 0) +
          (kinds.has("path") ? w.path : 0) +
          (kinds.has("text") ? w.text : 0) +
          (dependencyRepos.has(r.repo) || kinds.has("dependency") ? w.dependency : 0),
      );
      return {
        ...r,
        score: r.score + bonus,
        reasons: bonus
          ? [
              ...r.reasons,
              `code evidence +${bonus}: ${[...kinds].sort().join(", ")}${dependencyRepos.has(r.repo) ? ", import/dependency candidate" : ""}`,
            ]
          : r.reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
}
export async function hybridRank(
  repos: RepositoryRow[],
  request: { text: string; keywords?: string[]; project?: string },
) {
  const old = rankRepositories(repos, request);
  if (!codeIntelligenceEnabled()) return old;
  try {
    const scope = {
      repositories: repos.map((r) => r.name).slice(0, 30),
      allowed: repos.map((r) => r.name),
      provision: false,
    };
    const found = await searchSymbols(
      [request.text, ...(request.keywords ?? [])].join(" "),
      scope,
      60,
    );
    const dependencies = new Set<string>();
    // Registry dependencies remain explicit evidence; syntax imports support candidate discovery only.
    for (const r of repos)
      if (r.dependencies.some((d) => found.hits.some((h) => h.repository === d)))
        dependencies.add(r.name);
    return applyEvidence(old, found.hits, dependencies);
  } catch {
    return old;
  }
}
export async function buildCodeContext(text: string, scope: SearchScope) {
  const start = Date.now();
  const empty = (latency: number) => ({
    body: "",
    hits: [] as Hit[],
    metrics: {
      search_latency: latency,
      context_latency: Date.now() - start,
      retrieved_context_size: 0,
      retrieved_context_tokens: 0,
      fallback_count: 0,
    },
  });
  if (!codeIntelligenceEnabled() || !queryTerms(text).length) return empty(0);
  authorize(scope);
  const viaGo = await goSearch<Hit, never>("context", scope, scope.provision === true, { text });
  const body = viaGo.body ?? "";
  return {
    body,
    hits: viaGo.hits ?? [],
    metrics: {
      search_latency: viaGo.metrics.took_ms ?? 0,
      context_latency: Date.now() - start,
      retrieved_context_size: body.length,
      retrieved_context_tokens: Math.ceil(body.length / 4),
      fallback_count: viaGo.fallback_count,
    },
  };
}
