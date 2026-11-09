/**
 * Failure classification + recovery policy, applied in one place (engine.applyResult) to every failed attempt.
 * Pure: the engine decides with the result (retry with backoff, stop, or pause for a human) and records it in the
 * attempt error so the history shows why. Retries stay bounded by the step's max_attempts (rate limits get a small
 * fixed minimum) — no infinite loops.
 */
export type FailureClass =
  | "transient" // network / infrastructure / worker crash / provider 5xx
  | "rate_limit" // LLM rate limit / overloaded
  | "code" // build / test / verification failures (repaired by their own loops)
  | "missing_requirements" // the task cannot be done without information
  | "auth" // authentication / permission
  | "workspace" // git conflicts, branch checked out elsewhere, dirty worktree
  | "no_progress" // repeated identical failures
  | "unknown";

export type RecoveryAction = "retry" | "stop" | "human";
export interface FailureDecision {
  class: FailureClass;
  action: RecoveryAction;
  /** Delay before the next attempt (retry only). */
  delay_s: number;
  reason: string;
}

const RULES: Array<[FailureClass, RegExp]> = [
  ["no_progress", /no progress|same failures twice|made no progress/i],
  ["auth", /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication (failed|error)|permission denied|invalid (api )?key|bad credentials|not authorized|access denied/i],
  ["rate_limit", /rate[ -]?limit|\b429\b|too many requests|overloaded|\b529\b|quota exceeded/i],
  ["workspace", /conflict|non-fast-forward|is checked out in your primary checkout|already checked out|cannot lock ref|uncommitted changes in|commits this worktree never had|index\.lock/i],
  ["missing_requirements", /missing requirement|insufficient (information|requirements)|requirements? (are )?unclear|no repositories are allowed/i],
  ["code", /tests? failed|verification (still failing|made no progress|could not complete)|independent verification failed|build failed|regression|command failed|exit \d+|compile/i],
  ["transient", /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|fetch failed|network|timed? ?out|lease expired|worker (died|lost|restarted)|\b50[0-4]\b|service unavailable|internal server error|temporar/i],
];

/** Exponential backoff, capped: base · 2^(attempt-1) ≤ cap. */
export const backoff = (base: number, attempt: number, cap = 900) => Math.min(cap, Math.round(base * 2 ** Math.max(0, attempt - 1)));

export function classifyFailure(error: string, ctx: { executorRetryable?: boolean; attempt: number; maxAttempts: number; baseBackoff: number }): FailureDecision {
  const text = String(error ?? "");
  const cls = (RULES.find(([, re]) => re.test(text))?.[0] ?? "unknown") as FailureClass;
  const canRetry = ctx.attempt < ctx.maxAttempts;
  switch (cls) {
    case "auth":
      return { class: cls, action: "stop", delay_s: 0, reason: "authentication/permission errors do not fix themselves — fix credentials or access, then retry the step" };
    case "no_progress":
      return { class: cls, action: "stop", delay_s: 0, reason: "repeated identical failures — stopping instead of looping" };
    case "workspace":
      return { class: cls, action: "human", delay_s: 0, reason: "the workspace needs a human (git conflict / branch checked out elsewhere / unexpected changes)" };
    case "missing_requirements":
      return { class: cls, action: "human", delay_s: 0, reason: "the task needs information only a human can give" };
    case "rate_limit":
      // Rate limits get at least 3 attempts even on max_attempts=1 steps, with a longer base delay — unless the executor
      // marked the failure non-replayable (an external side effect may already have happened: reconcile, never replay).
      if (ctx.executorRetryable === false) return { class: cls, action: "stop", delay_s: 0, reason: "rate limited, but the executor marked the failure non-retryable (possible side effect) — reconcile before retrying" };
      return ctx.attempt < Math.max(ctx.maxAttempts, 3)
        ? { class: cls, action: "retry", delay_s: backoff(Math.max(30, ctx.baseBackoff), ctx.attempt), reason: "provider rate limit — retrying with exponential backoff" }
        : { class: cls, action: "stop", delay_s: 0, reason: "rate limit persisted across retries" };
    case "transient":
      return canRetry && ctx.executorRetryable !== false
        ? { class: cls, action: "retry", delay_s: backoff(ctx.baseBackoff, ctx.attempt), reason: "transient infrastructure error — retrying with exponential backoff" }
        : { class: cls, action: "stop", delay_s: 0, reason: canRetry ? "executor marked the failure non-retryable" : "retry budget exhausted" };
    case "code":
    case "unknown":
    default:
      // Code failures have their own repair loops (verification, test-failure flow); keep the executor's decision.
      return canRetry && ctx.executorRetryable !== false
        ? { class: cls, action: "retry", delay_s: backoff(ctx.baseBackoff, ctx.attempt), reason: "retrying (bounded by max_attempts)" }
        : { class: cls, action: "stop", delay_s: 0, reason: canRetry ? "executor marked the failure non-retryable" : "retry budget exhausted" };
  }
}
