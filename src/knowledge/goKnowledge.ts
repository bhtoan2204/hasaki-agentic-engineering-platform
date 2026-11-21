/**
 * The repository knowledge scan (discovery) runs in platform-go (ADR 0007; go/internal/knowledge, contract
 * go/contracts/knowledge-v1.schema.json). TypeScript chooses the repositories, resolves where each candidate applies
 * and publishes; platform-go only reads, inside the roots this server configured it with (PLATFORM_TRUSTED_ROOTS).
 * An unavailable platform-go fails the import (it is retryable and has no side effects); a refused request or
 * credential is raised as such.
 */
import { platformGoCall } from "../retrieval/semantic.ts";
import { MAX_CHARS, SCAN_LIMITS, type Discovery, type DiscoveryRepository } from "./importTypes.ts";

/** Version of the discovery rules both engines implement; platform-go refuses (409) any other. */
export const KNOWLEDGE_SCAN_VERSION = "knowledge-scan-1";

export const goKnowledgeStats = { calls: 0, failures: {} as Record<string, number> };

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

/** The discovery from platform-go (the only engine: an unavailable or invalid answer fails the import, retryable). */
export async function goKnowledgeScan(
  repos: DiscoveryRepository[],
  userDir: string | null,
): Promise<Discovery> {
  const fail = (reason: string): never => {
    goKnowledgeStats.failures[reason] = (goKnowledgeStats.failures[reason] ?? 0) + 1;
    throw new Error(`Knowledge scan is unavailable (platform-go: ${reason}); retry shortly`);
  };
  const res = await platformGoCall(
    "knowledge scan",
    "/internal/v1/knowledge/scan",
    knowledgeScanRequest(repos, userDir),
    SCAN_LIMITS.deadlineMs + 10_000,
  );
  if (!res.ok) return fail(res.reason);
  const body = res.body as unknown as Discovery;
  if (
    !Array.isArray(body.candidates) ||
    !Array.isArray(body.skipped) ||
    !Array.isArray(body.scanned) ||
    !Array.isArray(body.incomplete)
  )
    return fail("invalid_response");
  // Only repositories this server asked for can be reported scanned (retirement is decided from that list).
  const asked = new Set(repos.map((r) => r.name));
  if (![...body.scanned, ...body.incomplete].every((n: string) => asked.has(n)))
    return fail("invalid_response");
  goKnowledgeStats.calls++;
  return {
    candidates: body.candidates,
    skipped: body.skipped,
    scanned: body.scanned,
    incomplete: body.incomplete,
  };
}
