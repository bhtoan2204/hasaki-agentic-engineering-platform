import { z } from "zod";
import { config } from "../config.ts";

export type SourceKind = "knowledge" | "skill" | "task_memory" | "lesson" | "chat_memory";

export interface SemanticHit {
  rank: number;
  similarity: number;
  version: number;
  contentHash: string;
  chunk: number;
}

const searchResponse = z.object({
  model: z.string(),
  results: z.array(
    z.object({
      source_id: z.number().int(),
      key: z.string(),
      source_kind: z.enum(["knowledge", "skill", "task_memory", "lesson", "chat_memory"]),
      version: z.number().int(),
      content_hash: z.string().regex(/^[0-9a-f]{64}$/),
      similarity: z.number(),
      chunk: z.number().int().min(0),
    }),
  ),
  took_ms: z.number(),
});

// Query embedding time grows with length (bge-m3 on CPU: ~0.3 s per 1000 chars); the head of the request text
// (title, description) carries the meaning and keeps the call inside timeoutMs.
const MAX_QUERY_CHARS = 1200;

/** Fallbacks to lexical-only ranking since process start, by reason. */
export const semanticFallbacks: Record<string, number> = {};
const lastLogged = new Map<string, number>();

function fallback(reason: string, detail?: string): null {
  semanticFallbacks[reason] = (semanticFallbacks[reason] ?? 0) + 1;
  const now = Date.now();
  if (reason !== "disabled" && now - (lastLogged.get(reason) ?? 0) >= 60_000) {
    lastLogged.set(reason, now);
    console.warn(
      `semantic retrieval unavailable (${reason}${detail ? `: ${detail}` : ""}); lexical ranking only`,
    );
  }
  return null;
}

/** Authenticated request to the Go retrieval service; throws on network errors and timeouts. */
export function retrievalService(path: string, body?: unknown, timeoutMs?: number) {
  const ms = timeoutMs ?? config.retrieval.semantic.timeoutMs;
  return fetch(new URL(path, config.retrieval.semantic.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${process.env.RETRIEVAL_INTERNAL_TOKEN ?? ""}`,
      "X-Request-Timeout-Ms": String(ms),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(ms),
  });
}

/**
 * Semantic rank (1-based, best chunk per source) of the given authorized sources, or null when the service cannot
 * be used — callers then keep lexical ranking. Never throws.
 */
export async function semanticRanks(req: {
  ownerId: number;
  query: string;
  sourceIds?: number[];
  sourceKinds?: SourceKind[];
  topK?: number;
}): Promise<Map<number, SemanticHit> | null> {
  const query = req.query.trim().slice(0, MAX_QUERY_CHARS);
  if (!query || req.sourceIds?.length === 0) return null;
  const cfg = config.retrieval.semantic;
  if (!cfg.enabled) return fallback("disabled");
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return fallback("missing_token");
  let res: Response;
  try {
    res = await retrievalService("/internal/v1/retrieval/search", {
      owner_id: req.ownerId,
      query,
      ...(req.sourceIds ? { source_ids: req.sourceIds.slice(0, 5000) } : {}),
      ...(req.sourceKinds ? { source_kinds: req.sourceKinds } : {}),
      top_k: Math.min(100, req.topK ?? cfg.topK),
      min_similarity: cfg.minSimilarity,
    });
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    return fallback(
      timeout ? "timeout" : "unreachable",
      timeout ? undefined : (e as Error).message,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    return fallback(`http_${res.status}`);
  }
  const parsed = searchResponse.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) return fallback("invalid_response");
  const allowed = req.sourceIds && new Set(req.sourceIds);
  const out = new Map<number, SemanticHit>();
  for (const h of [...parsed.data.results].sort((a, b) => b.similarity - a.similarity)) {
    if (h.similarity < cfg.minSimilarity || out.has(h.source_id)) continue;
    if (allowed && !allowed.has(h.source_id)) continue;
    out.set(h.source_id, {
      rank: out.size + 1,
      similarity: h.similarity,
      version: h.version,
      contentHash: h.content_hash,
      chunk: h.chunk,
    });
  }
  return out;
}

/**
 * semanticRanks over loaded items, keyed by knowledge key. Hits whose version differs from the loaded item are stale
 * embeddings and are dropped; the remaining ranks are renumbered. Undefined when semantic ranking is unavailable.
 */
export async function semanticRanksByKey(
  ownerId: number | null | undefined,
  query: string,
  items: Array<{ id?: number | string | null; key: string; version: number }>,
  sourceKinds?: SourceKind[],
): Promise<Map<string, SemanticHit> | undefined> {
  if (!ownerId) return undefined;
  const byId = new Map(items.filter((k) => k.id != null).map((k) => [Number(k.id), k]));
  const hits = await semanticRanks({ ownerId, query, sourceIds: [...byId.keys()], sourceKinds });
  if (!hits) return undefined;
  const out = new Map<string, SemanticHit>();
  for (const [id, h] of hits) {
    const k = byId.get(id);
    if (k && k.version === h.version && !out.has(k.key))
      out.set(k.key, { ...h, rank: out.size + 1 });
  }
  return out;
}
