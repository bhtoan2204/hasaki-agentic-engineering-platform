/**
 * CODE_SEARCH_ENGINE=go (ADR 0006): searches, dependency/reference lookups, exact search and code context answered
 * by platform-go (go/internal/codeintelligence/search.go, contract go/contracts/code-intelligence-v1.schema.json
 * SearchRequest). This module is the trust boundary: it authorizes the scope, resolves every repository through
 * localScope (registration, read permission, run ownership, worktree identity) ONCE per call — in parallel, keeping
 * the repository order — and sends only those checkouts. platform-go never chooses a path.
 *
 * Fallback: an unreachable, overloaded or outdated platform-go (network error, timeout, 5xx, 409 version) answers
 * through the TypeScript engine — same authorization, same freshness checks, so never stale. A 400 (a scope or input
 * this module should never have produced) and a refused credential (401/403) are raised, never answered by fallback.
 */
import { realpath } from "node:fs/promises";
import { config } from "../config.ts";
import { workspacesOf } from "../git/provider.ts";
import { platformGoCall } from "../retrieval/semantic.ts";
import { enqueue, goLimits, localScope } from "./indexer.ts";
import { parserVersion } from "./parser.ts";

/** The authorized scope of src/codeIntelligence/search.ts SearchScope (the parts this module reads). */
interface SearchScope {
  repositories: string[];
  runId?: number;
  workspaces?: Readonly<Record<string, string>>;
  provision?: boolean;
}

export const goSearchStats = { calls: 0, fallbacks: {} as Record<string, number> };

/** Repositories of the scope's run that have a workspace (one lookup per call). */
const runRepos = async (scope: SearchScope) =>
  scope.runId ? new Set((await workspacesOf(scope.runId)).map((w) => w.repo)) : new Set<string>();

/** Resolve the authorized scope once: localScope per repository (at most four at once), in scope order. */
async function resolveScope(scope: SearchScope, provision: boolean, inRun?: Set<string>) {
  inRun ??= await runRepos(scope);
  const out = new Array<
    { ok: true; repo: GoRepository } | { ok: false; name: string; error: string }
  >(scope.repositories.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, scope.repositories.length) }, async () => {
      for (let i = next++; i < scope.repositories.length; i = next++) {
        const name = scope.repositories[i];
        const run = inRun.has(name) ? scope.runId : undefined;
        try {
          const local = await localScope(name, run, provision, scope.workspaces?.[name]);
          out[i] = {
            ok: true,
            repo: {
              name,
              repository_id: Number(local.repo.id),
              root: await realpath(local.root),
              primary: await realpath(local.primary),
              default_branch: local.repo.default_branch || config.baseBranch,
              run_id: run ?? null,
            },
          };
        } catch (e) {
          out[i] = { ok: false, name, error: (e as Error).message };
        }
      }
    }),
  );
  return {
    repositories: out.filter((r) => r.ok).map((r) => r.repo),
    unavailable: out.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error })),
  };
}

export interface GoRepository {
  name: string;
  repository_id: number;
  root: string;
  primary: string;
  default_branch: string;
  run_id: number | null;
}

export interface GoSearchResponse<H, E> {
  hits?: H[];
  edges?: E[];
  fallback_count: number;
  unavailable: string[];
  enqueue: Array<{ repository: string; run_id: number | null }>;
  body?: string;
  metrics: Record<string, number>;
}

type Op = "symbols" | "dependencies" | "exact" | "context";
interface Query {
  text?: string;
  symbol?: string;
  pattern?: string;
  limit?: number;
  depth?: number;
  direction?: string;
  any_file?: boolean;
}

/** The code-intelligence-v1 SearchRequest (go/contracts/code-intelligence-v1.schema.json). */
export function goSearchRequest(
  op: Op,
  query: Query,
  resolved: { repositories: GoRepository[]; unavailable: Array<{ name: string; error: string }> },
  allowedRoots: string[],
) {
  return {
    op,
    ...query,
    repositories: resolved.repositories,
    unavailable: resolved.unavailable,
    allowed_roots: allowedRoots,
    instance_id: config.instanceId,
    parser_version: parserVersion(),
    context_chars: config.codeIntelligence.contextTokens * 4,
    limits: goLimits(),
  };
}

/**
 * One platform-go call. Returns null when the TypeScript engine must answer instead (availability failures only).
 * `provision` is the provisioning policy of the TypeScript path being replaced.
 */
export async function goSearch<H, E>(
  op: Op,
  scope: SearchScope,
  provision: boolean,
  query: Query,
): Promise<GoSearchResponse<H, E> | null> {
  if (config.codeIntelligence.searchEngine !== "go") return null;
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return fallback("missing_token");
  return call<H, E>(op, scope, await resolveScope(scope, provision), query);
}

const fallback = (reason: string) => {
  goSearchStats.fallbacks[reason] = (goSearchStats.fallbacks[reason] ?? 0) + 1;
  return null;
};

async function call<H, E>(
  op: Op,
  scope: SearchScope,
  resolved: Awaited<ReturnType<typeof resolveScope>>,
  query: Query,
): Promise<GoSearchResponse<H, E> | null> {
  const roots = await Promise.all(
    [config.reposRoot, config.dataDir].map((p) => realpath(p).catch(() => p)),
  );
  const res = await platformGoCall(
    "code search request",
    "/internal/v1/code-intelligence/search",
    goSearchRequest(op, query, resolved, roots),
    Math.min(config.codeIntelligence.timeoutMs, 60_000),
  );
  if (!res.ok) return fallback(res.reason);
  const body = res.body as unknown as GoSearchResponse<H, E>;
  goSearchStats.calls++;
  // Indexing stays a TypeScript queue: schedule what platform-go found unindexed.
  if (scope.provision !== false)
    for (const e of body.enqueue ?? [])
      await enqueue(e.repository, e.run_id ?? undefined).catch(() => {});
  return body;
}

/**
 * searchCodeExact through platform-go with the sequential loop's semantics: repositories are authorized four at a
 * time in scope order and searched only until the limit is filled; a repository the loop would have reached and
 * that fails authorization raises its error there, as localScope does in the TypeScript loop. Returns null when the
 * TypeScript engine must answer (the whole call: partial results are dropped, the search is read-only).
 */
export async function goExactSearch<H extends { repository: string }>(
  scope: SearchScope,
  provision: boolean,
  query: { pattern: string; limit: number; any_file: boolean },
): Promise<H[] | null> {
  if (config.codeIntelligence.searchEngine !== "go") return null;
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return fallback("missing_token");
  const inRun = await runRepos(scope);
  const hits: H[] = [];
  for (let i = 0; i < scope.repositories.length && hits.length < query.limit; i += 4) {
    const names = scope.repositories.slice(i, i + 4);
    const resolved = await resolveScope({ ...scope, repositories: names }, provision, inRun);
    const res = resolved.repositories.length
      ? await call<H, never>("exact", scope, resolved, {
          ...query,
          limit: query.limit - hits.length,
        })
      : { hits: [] as H[] };
    if (!res) return null;
    for (const name of names) {
      const refused = resolved.unavailable.find((u) => u.name === name);
      if (refused) throw new Error(refused.error);
      for (const h of res.hits ?? [])
        if (h.repository === name && hits.length < query.limit) hits.push(h);
      if (hits.length >= query.limit) break;
    }
  }
  return hits;
}
