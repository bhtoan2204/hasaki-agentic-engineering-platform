/**
 * CODE_SEARCH_ENGINE=go (ADR 0006): searches, dependency/reference lookups, exact search and code context answered
 * by platform-go (go/internal/codeintelligence/search.go, contract go/contracts/code-intelligence-v1.schema.json
 * SearchRequest). This module is the trust boundary: it authorizes the scope, resolves every repository through
 * localScope (registration, read permission, run ownership, worktree identity) ONCE per call — in parallel, keeping
 * the repository order — and sends only those checkouts. platform-go never chooses a path.
 *
 * Fallback: an unreachable, overloaded or outdated platform-go (network error, timeout, 5xx, 409 version) answers
 * through the TypeScript engine — same authorization, same freshness checks, so never stale. A 400 (a scope or input
 * this module should never have produced) is raised.
 */
import { realpath } from "node:fs/promises";
import { config } from "../config.ts";
import { workspacesOf } from "../git/provider.ts";
import { retrievalService } from "../retrieval/semantic.ts";
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

/** Resolve the authorized scope once: one workspace lookup, localScope per repository (at most four at once). */
async function resolveScope(scope: SearchScope, provision: boolean) {
  const inRun = scope.runId
    ? new Set((await workspacesOf(scope.runId)).map((w) => w.repo))
    : new Set<string>();
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
  const fallback = (reason: string) => {
    goSearchStats.fallbacks[reason] = (goSearchStats.fallbacks[reason] ?? 0) + 1;
    return null;
  };
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return fallback("missing_token");
  const resolved = await resolveScope(scope, provision);
  const roots = await Promise.all(
    [config.reposRoot, config.dataDir].map((p) => realpath(p).catch(() => p)),
  );
  let res: Response;
  try {
    res = await retrievalService(
      "/internal/v1/code-intelligence/search",
      goSearchRequest(op, query, resolved, roots),
      Math.min(config.codeIntelligence.timeoutMs, 60_000),
    );
  } catch (e) {
    return fallback((e as Error).name === "TimeoutError" ? "timeout" : "unreachable");
  }
  const body = await res.json().catch(() => undefined);
  if (res.status === 400)
    throw new Error(`code search request refused: ${body?.error ?? "invalid"}`);
  if (!res.ok) return fallback(res.status === 409 ? "version_mismatch" : `http_${res.status}`);
  if (!body || typeof body !== "object") return fallback("invalid_response");
  goSearchStats.calls++;
  // Indexing stays a TypeScript queue: schedule what platform-go found unindexed.
  if (scope.provision !== false)
    for (const e of body.enqueue ?? [])
      await enqueue(e.repository, e.run_id ?? undefined).catch(() => {});
  return body as GoSearchResponse<H, E>;
}
