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

export type KeyChange =
  | { code: "commit_changed"; moved: Array<{ repo: string; was: string | undefined; now: string }> }
  | { code: "definition_changed" | "contract_changed" | "rubric_changed" | "model_changed" };

/**
 * What differs between the parts of `older` and of `newer` (two keys of one subject: same error, repositories and focus).
 * Empty when nothing differs.
 */
export function changesBetween(
  older: Record<string, unknown>,
  newer: Record<string, unknown>,
): KeyChange[] {
  const changes: KeyChange[] = [];
  if (JSON.stringify(older.repos) !== JSON.stringify(newer.repos)) {
    const was = new Map(
      ((older.repos as string[]) ?? []).map((r) => r.split("@") as [string, string]),
    );
    const moved = ((newer.repos as string[]) ?? [])
      .map((r) => r.split("@") as [string, string])
      .filter(([repo, commit]) => was.get(repo) !== commit)
      .map(([repo, now]) => ({ repo, was: was.get(repo), now }));
    changes.push({ code: "commit_changed", moved });
  }
  if (older.workflow !== newer.workflow) changes.push({ code: "definition_changed" });
  if (older.contract !== newer.contract) changes.push({ code: "contract_changed" });
  if (older.rubric !== newer.rubric) changes.push({ code: "rubric_changed" });
  if (older.model !== newer.model) changes.push({ code: "model_changed" });
  return changes;
}

/** The stale reason as stored: "commit_changed:a,b;model_changed". */
export const formatReasons = (changes: KeyChange[]) =>
  changes
    .map((c) =>
      c.code === "commit_changed" ? `${c.code}:${c.moved.map((m) => m.repo).join(",")}` : c.code,
    )
    .join(";");

/** Why `older` no longer matches what a request would ask for now (see changesBetween), as stored. */
export const staleReason = (older: Record<string, unknown>, newer: Record<string, unknown>) =>
  formatReasons(changesBetween(older, newer));

/** The model's identity without the configuration fingerprint ("claude/opus#cfg:ab12" → "claude/opus"). */
export const modelIdentity = (parts: Record<string, unknown>) =>
  String(parts.model ?? "").split("#")[0];
