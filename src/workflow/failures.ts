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
  [
    "auth",
    /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication (failed|error)|permission denied|invalid (api )?key|bad credentials|not authorized|access denied/i,
  ],
  ["rate_limit", /rate[ -]?limit|\b429\b|too many requests|overloaded|\b529\b|quota exceeded/i],
  [
    "workspace",
    /conflict|non-fast-forward|is checked out in your primary checkout|already checked out|cannot lock ref|uncommitted changes in|commits this worktree never had|index\.lock/i,
  ],
  [
    "missing_requirements",
    /missing requirement|insufficient (information|requirements)|requirements? (are )?unclear|no repositories are allowed/i,
  ],
  [
    "code",
    /tests? failed|verification (still failing|made no progress|could not complete)|independent verification failed|build failed|regression|command failed|exit \d+|compile/i,
  ],
  [
    "transient",
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|fetch failed|network|timed? ?out|lease expired|worker (died|lost|restarted)|\b50[0-4]\b|service unavailable|internal server error|temporar/i,
  ],
];

/** Exponential backoff, capped: base · 2^(attempt-1) ≤ cap. */
export const backoff = (base: number, attempt: number, cap = 900) =>
  Math.min(cap, Math.round(base * 2 ** Math.max(0, attempt - 1)));

export function classifyFailure(
  error: string,
  ctx: {
    executorRetryable?: boolean;
    attempt: number;
    maxAttempts: number;
    baseBackoff: number;
    /** Structured failure class from the harness failure table; wins over the error-text rules. */
    failureClass?: FailureClass;
  },
): FailureDecision {
  const text = String(error ?? "");
  const cls = (ctx.failureClass ??
    RULES.find(([, re]) => re.test(text))?.[0] ??
    "unknown") as FailureClass;
  const canRetry = ctx.attempt < ctx.maxAttempts;
  switch (cls) {
    case "auth":
      return {
        class: cls,
        action: "stop",
        delay_s: 0,
        reason:
          "authentication/permission errors do not fix themselves — fix credentials or access, then retry the step",
      };
    case "no_progress":
      return {
        class: cls,
        action: "stop",
        delay_s: 0,
        reason: "repeated identical failures — stopping instead of looping",
      };
    case "workspace":
      return {
        class: cls,
        action: "human",
        delay_s: 0,
        reason:
          "the workspace needs a human (git conflict / branch checked out elsewhere / unexpected changes)",
      };
    case "missing_requirements":
      return {
        class: cls,
        action: "human",
        delay_s: 0,
        reason: "the task needs information only a human can give",
      };
    case "rate_limit":
      // Rate limits get at least 3 attempts even on max_attempts=1 steps, with a longer base delay — unless the executor
      // marked the failure non-replayable (an external side effect may already have happened: reconcile, never replay).
      if (ctx.executorRetryable === false)
        return {
          class: cls,
          action: "stop",
          delay_s: 0,
          reason:
            "rate limited, but the executor marked the failure non-retryable (possible side effect) — reconcile before retrying",
        };
      return ctx.attempt < Math.max(ctx.maxAttempts, 3)
        ? {
            class: cls,
            action: "retry",
            delay_s: backoff(Math.max(30, ctx.baseBackoff), ctx.attempt),
            reason: "provider rate limit — retrying with exponential backoff",
          }
        : { class: cls, action: "stop", delay_s: 0, reason: "rate limit persisted across retries" };
    case "transient":
      return canRetry && ctx.executorRetryable !== false
        ? {
            class: cls,
            action: "retry",
            delay_s: backoff(ctx.baseBackoff, ctx.attempt),
            reason: "transient infrastructure error — retrying with exponential backoff",
          }
        : {
            class: cls,
            action: "stop",
            delay_s: 0,
            reason: canRetry
              ? "executor marked the failure non-retryable"
              : "retry budget exhausted",
          };
    case "code":
    case "unknown":
    default:
      // Code failures have their own repair loops (verification, test-failure flow); keep the executor's decision.
      return canRetry && ctx.executorRetryable !== false
        ? {
            class: cls,
            action: "retry",
            delay_s: backoff(ctx.baseBackoff, ctx.attempt),
            reason: "retrying (bounded by max_attempts)",
          }
        : {
            class: cls,
            action: "stop",
            delay_s: 0,
            reason: canRetry
              ? "executor marked the failure non-retryable"
              : "retry budget exhausted",
          };
  }
}

// ---------------------------------------------------------------- recovery diagnosis

/** Canonical recovery categories. Explicit machine codes win; error-text rules are only a fallback. */
export const RECOVERY_CATEGORIES = [
  "transient_network",
  "rate_limit",
  "quota",
  "session_expired",
  "worker_lost",
  "incomplete_result",
  "dependency_env",
  "code_test",
  "infra_test",
  "flaky_candidate",
  "workspace_conflict",
  "auth",
  "scope_security",
  "invalid_evidence",
  "contract_invalid",
  "no_progress",
  "budget_exhausted",
  "unknown_side_effect",
  "unknown",
] as const;
export type RecoveryCategory = (typeof RECOVERY_CATEGORIES)[number];

export const RECOVERY_STRATEGIES = [
  "RESUME",
  "RESTORE",
  "RETRY_BACKOFF",
  "HANDOFF",
  "REPAIR",
  "VERIFY_ONLY",
  "REPLAN",
  "RECONCILE",
  "WAIT",
  "STOP",
] as const;
export type RecoveryStrategy = (typeof RECOVERY_STRATEGIES)[number];

const BY_CODE: Record<string, [RecoveryCategory, RecoveryStrategy]> = {
  RATE_LIMIT: ["rate_limit", "RETRY_BACKOFF"],
  PROVIDER_UNAVAILABLE: ["transient_network", "RETRY_BACKOFF"],
  EXECUTION_TIMEOUT: ["transient_network", "RETRY_BACKOFF"],
  IDLE_TIMEOUT: ["transient_network", "RETRY_BACKOFF"],
  QUOTA_EXHAUSTED: ["quota", "HANDOFF"],
  AUTHENTICATION: ["auth", "STOP"],
  CONTEXT_LIMIT: ["session_expired", "RESUME"],
  INCOMPLETE_OUTPUT: ["incomplete_result", "RESUME"],
  CONTRACT_INVALID: ["contract_invalid", "RESUME"],
  INVALID_EVIDENCE: ["invalid_evidence", "WAIT"],
  POLICY_VIOLATION: ["scope_security", "STOP"],
  GUARANTEE_UNMET: ["scope_security", "STOP"],
  UNSAFE_SIDE_EFFECT: ["unknown_side_effect", "WAIT"],
  NO_PROGRESS: ["no_progress", "WAIT"],
  BUDGET_EXHAUSTED: ["budget_exhausted", "STOP"],
  TOOL_BUDGET_EXHAUSTED: ["budget_exhausted", "STOP"],
  WORKSPACE: ["workspace_conflict", "WAIT"],
  CANCELED: ["unknown", "STOP"],
};

const TEXT_RULES: Array<[RecoveryCategory, RecoveryStrategy, RegExp]> = [
  ["no_progress", "WAIT", /no progress|same failures twice|made no progress/i],
  ["auth", "STOP", RULES.find(([c]) => c === "auth")![1]],
  ["quota", "HANDOFF", /quota (exceeded|exhausted)|insufficient[_ ]quota|billing/i],
  ["rate_limit", "RETRY_BACKOFF", RULES.find(([c]) => c === "rate_limit")![1]],
  ["workspace_conflict", "WAIT", RULES.find(([c]) => c === "workspace")![1]],
  [
    "dependency_env",
    "WAIT",
    /environment (is )?unavailable|command not found|ENOENT|no such file or directory.*(bin|node_modules)|cannot find module|missing (test )?prerequisite|test postgresql|docker (daemon|is not running)/i,
  ],
  [
    "infra_test",
    "WAIT",
    /could not complete|verification infrastructure|test (runner|infrastructure) (failed|crashed)/i,
  ],
  ["code_test", "REPAIR", RULES.find(([c]) => c === "code")![1]],
  ["transient_network", "RETRY_BACKOFF", RULES.find(([c]) => c === "transient")![1]],
];

export interface RecoveryDiagnosis {
  category: RecoveryCategory;
  strategy: RecoveryStrategy;
  /** "code" when a machine code decided, "text" for the regex fallback, "none" when nothing matched. */
  source: "code" | "text" | "none";
  /** Seconds the provider asked to wait (Retry-After), when it said so. */
  retry_after_s: number | null;
}

/** Retry-After from structured details first, then the message ("retry after 30s", "Retry-After: 30"). */
export function retryAfterSeconds(details: unknown, message: string): number | null {
  const d = details as {
    retry_after_s?: unknown;
    provider_error?: { retry_after_s?: unknown };
  } | null;
  const raw = d?.retry_after_s ?? d?.provider_error?.retry_after_s;
  const n = Number(raw ?? /retry[- ]after[:\s]+(\d+)/i.exec(message)?.[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.round(n)) : null;
}

export function diagnoseFailure(input: {
  error: string;
  failureCode?: string | null;
  details?: unknown;
}): RecoveryDiagnosis {
  const retry_after_s = retryAfterSeconds(input.details, input.error);
  const byCode = input.failureCode ? BY_CODE[input.failureCode] : undefined;
  if (byCode) return { category: byCode[0], strategy: byCode[1], source: "code", retry_after_s };
  const rule = TEXT_RULES.find(([, , re]) => re.test(input.error ?? ""));
  if (rule) return { category: rule[0], strategy: rule[1], source: "text", retry_after_s };
  // Unknown is never treated as transient: it keeps the bounded step retry and nothing more.
  return { category: "unknown", strategy: "WAIT", source: "none", retry_after_s };
}

/** Stable identity of a failure: volatile tokens (numbers, hashes, paths, timestamps) are masked. */
export function failureSignature(category: RecoveryCategory, error: string) {
  const norm = String(error ?? "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,64}\b/g, "#")
    .replace(/\d+/g, "0")
    .replace(/(\/[\w.-]+)+/g, "/p")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return `${category}:${norm}`;
}

/** Up to +20% jitter so recovering runs do not retry in lockstep. */
export const jittered = (seconds: number, random = Math.random) =>
  Math.round(seconds * (1 + 0.2 * Math.min(1, Math.max(0, random()))));

/** Categories where a repeat with unchanged evidence means the work itself is stuck (not the infrastructure). */
export const WORK_CATEGORIES: readonly RecoveryCategory[] = [
  "code_test",
  "incomplete_result",
  "contract_invalid",
  "unknown",
];

export const RECOVERY_LIMITS = {
  /** Identical failure (same signature, same workspace) tolerated before escalating as no-progress. */
  sameSignature: 2,
  /** Automatic recoveries per run, across steps, attempts and generations. */
  perRun: 12,
  /** Automatic resumes of one interrupted step. */
  interruptedResumes: 2,
};
