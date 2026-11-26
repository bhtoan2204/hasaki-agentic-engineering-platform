/** The kinds of shared analyses (shared_analyses.kind). */
export const SHARED_KINDS = [
  "prod_error.runtime_rca",
  "prod_error.bug_hunt",
  "code_assessment",
] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

export type SharedOutcomeName =
  "hit" | "wait" | "miss" | "forced" | "bypass" | "lost_race" | "denied";

/** One lookup outcome or one settled row. Every field is a value the caller already holds (rule R1). */
export interface SharedEvent {
  kind: SharedKind;
  outcome: SharedOutcomeName | "published" | "failed" | "stale" | "expired";
  analysisId: number | null;
  version: number | null;
  runId: number | null;
  actorId: number | null;
  /** The dedup key (sha256 hex) and the tenant (installation scope), when known. */
  key?: string | null;
  scope?: string | null;
  /** bypass: access | backoff | exhausted | not_allowed; failed: the failure reason; stale: what changed. */
  reason?: string;
  /** A lookup's own time (hit, wait, miss, forced, bypass). */
  durationMs?: number;
  /** A hit: the tokens the source version spent. */
  tokensSaved?: number;
}
