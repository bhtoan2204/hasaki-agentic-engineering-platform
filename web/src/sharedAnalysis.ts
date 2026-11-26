/**
 * Shared results in the UI (docs/shared-results/PLAN.md, step 7): the shape the API returns (src/sharing/view.ts) and the
 * pure decisions the card renders from, kept apart from React so they are unit-tested.
 */
export type SharedStatus = "running" | "valid" | "stale" | "failed" | "superseded";
export interface SharedView {
  outcome: string;
  analysis_id: number;
  kind: "code_assessment" | "prod_error.runtime_rca" | "prod_error.bug_hunt";
  version: number;
  status: SharedStatus;
  freshness: {
    analysed_at: string | null;
    age_seconds: number | null;
    valid_until: string | null;
    expired: boolean;
    stale_reason: string | null;
  };
  run_by: { id: number | null; name: string | null; is_you?: boolean };
  repositories?: string[];
  focus?: string | null;
  provenance: {
    trigger: string;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    provider: string | null;
    model: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
  };
  reuse: { count: number; last_at: string | null };
  /** A newer version of this analysis is running (a re-run) or failed; this one is the last valid result. */
  newer_version?: { version: number; status: "running" | "failed" };
  failure?: {
    attempts: number;
    reason: string | null;
    retry_at: string | null;
    exhausted: boolean;
  };
  occurrences?: {
    at_analysis: { today_count: number; last_at: string | null; day: string } | null;
    now: {
      today_count: number;
      yesterday_count: number;
      last_at: string | null;
      day: string;
    } | null;
    new_since_analysis: number | null;
  };
  run_id?: number;
  result?: unknown;
}

/** What the card says first. */
export type SharedState =
  "running_other" | "running_you" | "valid" | "stale" | "failed" | "superseded";

export function sharedState(v: SharedView): SharedState {
  if (v.status === "running") return v.run_by.is_you ? "running_you" : "running_other";
  // Past its end but not yet swept: already treated as stale by the lookup, so shown as stale.
  if (v.status === "valid" && v.freshness.expired) return "stale";
  return v.status;
}

export const sharedTone = (s: SharedState) =>
  ({
    running_other: "run",
    running_you: "run",
    valid: "ok",
    stale: "wait",
    failed: "err",
    superseded: "wait",
  })[s] as "run" | "ok" | "wait" | "err";

/** "commit_changed:a,b;model_changed" (or "ttl") → message keys with their parameters. */
export function staleReasons(v: SharedView): Array<{ key: string; repos?: string }> {
  const raw = v.freshness.stale_reason ?? (v.freshness.expired ? "ttl" : "");
  return raw
    .split(";")
    .filter(Boolean)
    .map((r) => {
      const [code, repos] = r.split(":");
      return { key: `sr.reason.${code}`, ...(repos ? { repos: repos.split(",").join(", ") } : {}) };
    });
}

/** The note under a result that a newer version is running or has failed, as a message key. */
export const newerNote = (v: SharedView) =>
  v.newer_version ? `sr.newer.${v.newer_version.status}` : null;

/** A force re-run makes sense for a settled result (also failed or out of attempts), never beside a running one. */
export const canForce = (v: SharedView) => v.status !== "running";

/** The runner as the reader may see it: their own name, "you", or nothing (the API leaves the name out otherwise). */
export function runner(v: SharedView): { key: string; name?: string } {
  if (v.run_by.is_you) return { key: "sr.runByYou" };
  return v.run_by.name ? { key: "sr.runBy", name: v.run_by.name } : { key: "sr.runByMember" };
}

/** Age as the largest whole unit. */
export function age(seconds: number | null): { n: number; unit: "s" | "m" | "h" | "d" } | null {
  if (seconds == null) return null;
  if (seconds < 60) return { n: seconds, unit: "s" };
  if (seconds < 3600) return { n: Math.floor(seconds / 60), unit: "m" };
  if (seconds < 86_400) return { n: Math.floor(seconds / 3600), unit: "h" };
  return { n: Math.floor(seconds / 86_400), unit: "d" };
}

/** A short line about the result itself: how many findings or causes, when the snapshot lists them. */
export function resultCount(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  for (const k of ["findings", "causes", "candidates", "defects"]) {
    const list = (result as Record<string, unknown>)[k];
    if (Array.isArray(list)) return list.length;
  }
  return null;
}
