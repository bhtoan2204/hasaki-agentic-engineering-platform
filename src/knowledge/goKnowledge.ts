/**
 * KNOWLEDGE_IMPORT_ENGINE=go (ADR 0007): the repository knowledge scan (discovery) runs in platform-go
 * (go/internal/knowledge, contract go/contracts/knowledge-v1.schema.json). TypeScript chooses the repositories,
 * resolves where each candidate applies and publishes; platform-go only reads, inside the roots this server
 * configured it with (PLATFORM_TRUSTED_ROOTS).
 *
 * Fallback: the scan has no side effects, so an unreachable, slow, overloaded or outdated platform-go (network error,
 * timeout, 5xx, 409 version) is answered by the TypeScript discovery. A refused request (400) or a refused credential
 * (401/403) is raised: falling back would hide a misconfiguration or a scope this module should never send.
 */
import { config } from "../config.ts";
import { retrievalService } from "../retrieval/semantic.ts";
import { MAX_CHARS, SCAN_LIMITS, type Discovery, type DiscoveryRepository } from "./importTypes.ts";

/** Version of the discovery rules both engines implement; platform-go refuses (409) any other. */
export const KNOWLEDGE_SCAN_VERSION = "knowledge-scan-1";

export const goKnowledgeStats = { calls: 0, fallbacks: {} as Record<string, number> };

/** The knowledge-v1 ScanRequest. */
export function knowledgeScanRequest(repos: DiscoveryRepository[], userDir: string | null) {
  return {
    version: KNOWLEDGE_SCAN_VERSION,
    repositories: repos.map((r) => ({ name: r.name, root: r.root, self: r.self })),
    user_skills_dir: userDir,
    limits: {
      max_file_bytes: SCAN_LIMITS.maxFileBytes,
      max_entries: SCAN_LIMITS.maxEntries,
      max_total_bytes: SCAN_LIMITS.maxTotalBytes,
      deadline_ms: SCAN_LIMITS.deadlineMs,
      max_chars: MAX_CHARS,
    },
  };
}

/** The discovery from platform-go, or null when the TypeScript engine must scan instead. */
export async function goKnowledgeScan(
  repos: DiscoveryRepository[],
  userDir: string | null,
): Promise<Discovery | null> {
  if (config.knowledge.importEngine !== "go") return null;
  const fallback = (reason: string) => {
    goKnowledgeStats.fallbacks[reason] = (goKnowledgeStats.fallbacks[reason] ?? 0) + 1;
    return null;
  };
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return fallback("missing_token");
  let res: Response;
  try {
    res = await retrievalService(
      "/internal/v1/knowledge/scan",
      knowledgeScanRequest(repos, userDir),
      SCAN_LIMITS.deadlineMs + 10_000,
    );
  } catch (e) {
    return fallback((e as Error).name === "TimeoutError" ? "timeout" : "unreachable");
  }
  const body = await res.json().catch(() => undefined);
  if (res.status === 400 || res.status === 401 || res.status === 403)
    throw new Error(`knowledge scan refused (${res.status}): ${body?.error ?? "invalid"}`);
  if (!res.ok) return fallback(res.status === 409 ? "version_mismatch" : `http_${res.status}`);
  if (
    !body ||
    !Array.isArray(body.candidates) ||
    !Array.isArray(body.skipped) ||
    !Array.isArray(body.scanned) ||
    !Array.isArray(body.incomplete)
  )
    return fallback("invalid_response");
  // Only repositories this server asked for can be reported scanned (retirement is decided from that list).
  const asked = new Set(repos.map((r) => r.name));
  if (![...body.scanned, ...body.incomplete].every((n: string) => asked.has(n)))
    return fallback("invalid_response");
  goKnowledgeStats.calls++;
  return {
    candidates: body.candidates,
    skipped: body.skipped,
    scanned: body.scanned,
    incomplete: body.incomplete,
  };
}
