import { config } from "../config.ts";
import type { SharedRow } from "./repository.ts";
import type { SharedKind } from "./types.ts";

/**
 * Validity rules of shared results (docs/shared-results/PLAN.md, section 4.3) as pure functions: no I/O, the clock is an
 * argument. The lookup applies them through the hooks (servable, mayStart) so a test or a later step can still replace them.
 */

/** valid, and not past its end: the only rows a lookup may serve. */
export function isServable(row: Pick<SharedRow, "status" | "valid_until">, now: Date): boolean {
  return (
    row.status === "valid" && (row.valid_until == null || row.valid_until.getTime() > now.getTime())
  );
}

/** When a result published `now` stops being served (TTL per kind, configurable). */
export function validUntil(kind: SharedKind, now: Date, ttl = config.sharedResults.ttl): Date {
  const ms =
    kind === "prod_error.runtime_rca"
      ? ttl.runtimeRcaHours * 3_600_000
      : kind === "prod_error.bug_hunt"
        ? ttl.bugHuntDays * 86_400_000
        : ttl.codeAssessmentDays * 86_400_000;
  return new Date(now.getTime() + ms);
}

/** Minutes a key waits after its `failures`-th failure in a row: min(cap, 2^failures). */
export const backoffMinutes = (
  failures: number,
  capMinutes = config.sharedResults.retryCapMinutes,
) => Math.min(capMinutes, 2 ** Math.max(1, Math.min(failures, 30)));

export type RetryState =
  | { state: "none" }
  | { state: "backoff"; retryAt: Date }
  | { state: "exhausted"; failures: number };

/** What the latest version of a key says about starting it again. Only a failed latest version can hold a key back. */
export function retryState(
  latest: Pick<SharedRow, "status" | "attempts" | "next_retry_at"> | null,
  now: Date,
  maxAttempts = config.sharedResults.maxAttempts,
): RetryState {
  if (latest?.status !== "failed") return { state: "none" };
  if (latest.attempts >= maxAttempts) return { state: "exhausted", failures: latest.attempts };
  if (latest.next_retry_at && latest.next_retry_at.getTime() > now.getTime())
    return { state: "backoff", retryAt: latest.next_retry_at };
  return { state: "none" };
}

/** May the lookup claim the key now (not held back by backoff or by exhausted attempts)? A force re-run ignores it. */
export const canStart = (latest: Parameters<typeof retryState>[0], now: Date) =>
  retryState(latest, now).state === "none";

/**
 * Why `older` no longer matches what a request would ask for now: the parts of its key that differ from `newer`. Only
 * keys of the same subject (same error, repositories and focus) are compared. Empty when nothing differs.
 */
export function staleReason(
  older: Record<string, unknown>,
  newer: Record<string, unknown>,
): string {
  const reasons: string[] = [];
  if (JSON.stringify(older.repos) !== JSON.stringify(newer.repos)) {
    const was = new Map(
      ((older.repos as string[]) ?? []).map((r) => r.split("@") as [string, string]),
    );
    const moved = ((newer.repos as string[]) ?? [])
      .map((r) => r.split("@") as [string, string])
      .filter(([repo, commit]) => was.get(repo) !== commit)
      .map(([repo]) => repo);
    reasons.push(`commit_changed:${moved.join(",")}`);
  }
  if (older.workflow !== newer.workflow) reasons.push("definition_changed");
  if (older.contract !== newer.contract) reasons.push("contract_changed");
  if (older.rubric !== newer.rubric) reasons.push("rubric_changed");
  if (older.model !== newer.model) reasons.push("model_changed");
  return reasons.join(";");
}
