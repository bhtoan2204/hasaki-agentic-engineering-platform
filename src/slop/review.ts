import type { Finding } from "./findings.ts";

interface ScannedRepo {
  repo?: string;
  slop?: { status?: string; findings?: Finding[] } | null;
}

const MAX_LINES = 40;

/**
 * The slop findings the deterministic scan reported as new or worsened by this change, from the verification of every
 * upstream coding step, as review input. Empty when nothing was scanned or nothing new was found.
 */
export function slopReviewEvidence(
  upstream: Record<string, { output?: unknown } | undefined>,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  for (const step of Object.values(upstream)) {
    const last = (step?.output as { verification?: { last?: unknown } } | undefined)?.verification
      ?.last;
    const repos: ScannedRepo[] = Array.isArray(last) ? last : [];
    for (const r of repos)
      for (const f of r.slop?.findings ?? []) {
        if (f.status !== "new" && f.status !== "worsened") continue;
        const key = `${r.repo}:${f.fingerprint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total++;
        if (lines.length < MAX_LINES)
          lines.push(
            `- [${f.severity}/${f.rule}${f.status === "worsened" ? ", worsened" : ""}] ${r.repo}:${f.path}:${f.line}` +
              `${f.symbol ? ` (${f.symbol})` : ""} — ${f.message}${f.snippet ? `\n  \`${f.snippet.replace(/\s+/g, " ").slice(0, 160)}\`` : ""}`,
          );
      }
  }
  if (total > lines.length) lines.push(`- … ${total - lines.length} more not shown`);
  return lines.join("\n");
}
