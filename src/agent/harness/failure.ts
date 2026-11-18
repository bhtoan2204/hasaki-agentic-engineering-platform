import {
  FAILURE_CATEGORIES,
  normalizeProviderFailure,
  type FailureCategory,
} from "../telemetry.ts";
import type { FailureClass } from "../../workflow/failures.ts";

export const HARNESS_FAILURE_CODES = [
  ...FAILURE_CATEGORIES,
  "IDLE_TIMEOUT",
  "NO_PROGRESS",
  "BUDGET_EXHAUSTED",
  "TOOL_BUDGET_EXHAUSTED",
  "INCOMPLETE_OUTPUT",
  "CONTRACT_INVALID",
  "INVALID_EVIDENCE",
  "POLICY_VIOLATION",
  "UNSAFE_SIDE_EFFECT",
  "GUARANTEE_UNMET",
  "WORKSPACE",
] as const;
export type HarnessFailureCode = (typeof HARNESS_FAILURE_CODES)[number];

export interface FailurePolicy {
  /** The engine may run another attempt (still bounded by max_attempts). */
  retryable: boolean;
  /** Inside one attempt, a failed session resume may be retried with a rebuilt prompt. */
  rebuildable: boolean;
  /** Engine recovery class; undefined keeps the text-based classification. */
  failureClass?: FailureClass;
  /** `details.provider_error.code` value read by provider handoff. */
  providerErrorCode: string;
}

const p = (
  retryable: boolean,
  rebuildable: boolean,
  providerErrorCode: string,
  failureClass?: FailureClass,
): FailurePolicy => ({ retryable, rebuildable, providerErrorCode, failureClass });

/** The single failure table: every provider and harness stage maps its failure onto one of these codes. */
export const FAILURE_POLICY: Record<HarnessFailureCode, FailurePolicy> = {
  RATE_LIMIT: p(true, true, "rate_limit", "rate_limit"),
  QUOTA_EXHAUSTED: p(false, false, "quota_exhausted"),
  AUTHENTICATION: p(false, false, "authentication", "auth"),
  PROVIDER_UNAVAILABLE: p(true, true, "provider_unavailable", "transient"),
  CONTEXT_LIMIT: p(false, false, "context_limit"),
  EXECUTION_TIMEOUT: p(true, false, "timeout", "transient"),
  TOOL_FAILURE: p(true, true, "tool_failure"),
  AGENT_ERROR: p(false, false, "agent_error"),
  CANCELED: p(false, false, "canceled"),
  UNKNOWN: p(true, true, "unknown"),
  IDLE_TIMEOUT: p(true, false, "idle_timeout", "transient"),
  NO_PROGRESS: p(false, false, "no_progress", "no_progress"),
  BUDGET_EXHAUSTED: p(false, false, "budget_exhausted"),
  TOOL_BUDGET_EXHAUSTED: p(false, false, "tool_budget_exhausted"),
  INCOMPLETE_OUTPUT: p(true, true, "incomplete_output", "transient"),
  CONTRACT_INVALID: p(true, false, "contract_invalid"),
  INVALID_EVIDENCE: p(false, false, "invalid_evidence"),
  POLICY_VIOLATION: p(false, false, "agent_error"),
  UNSAFE_SIDE_EFFECT: p(false, false, "unsafe_side_effect"),
  GUARANTEE_UNMET: p(false, false, "guarantee_unmet"),
  WORKSPACE: p(false, false, "workspace", "workspace"),
};

const LEGACY: Record<string, HarnessFailureCode> = {
  quota: "QUOTA_EXHAUSTED",
  auth: "AUTHENTICATION",
  model: "AGENT_ERROR",
  policy: "POLICY_VIOLATION",
  canceled: "CANCELED",
  timeout: "EXECUTION_TIMEOUT",
  incomplete: "INCOMPLETE_OUTPUT",
  rate_limit: "RATE_LIMIT",
  error: "UNKNOWN",
};

export const isFailureCode = (v: unknown): v is HarnessFailureCode =>
  typeof v === "string" && (HARNESS_FAILURE_CODES as readonly string[]).includes(v);

/** Maps a provider turn's failure label (structured code or legacy codex kind) onto the harness taxonomy. */
export function toFailureCode(raw: string | undefined | null): HarnessFailureCode | undefined {
  if (!raw) return undefined;
  if (isFailureCode(raw)) return raw;
  return LEGACY[raw] ?? undefined;
}

export const failurePolicy = (raw: string | undefined | null): FailurePolicy | undefined => {
  const code = toFailureCode(raw);
  return code ? FAILURE_POLICY[code] : undefined;
};

/** A turn failure the engine must not retry automatically (an unlabelled failure stays retryable). */
export const isTerminalFailure = (raw: string | undefined | null) =>
  failurePolicy(raw)?.retryable === false;

/** A failed resume that a rebuilt prompt cannot fix within the same attempt. */
export const blocksRebuild = (raw: string | undefined | null) =>
  failurePolicy(raw)?.rebuildable === false;

/** Shared error-text classifier for the hook-based CLIs (Copilot, Antigravity). */
export function classifyCliError(err: unknown): FailureCategory {
  const obj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  const errObj =
    typeof obj?.error === "object" && obj?.error !== null
      ? (obj.error as Record<string, unknown>)
      : null;
  const errMsg = typeof errObj?.message === "string" ? errObj.message : undefined;
  const text = String(obj?.message ?? errMsg ?? obj?.error ?? err ?? "").toLowerCase();
  if (/quota|resource has been exhausted|rate_limit|too many requests|429/.test(text)) {
    if (/quota|credit|billing|exhausted/.test(text)) return "QUOTA_EXHAUSTED";
    return "RATE_LIMIT";
  }
  if (/login|auth|unauthorized|credential|token/.test(text)) return "AUTHENTICATION";
  if (/timeout|timed out/.test(text)) return "EXECUTION_TIMEOUT";
  if (/cancel|abort/.test(text)) return "CANCELED";
  return normalizeProviderFailure(err);
}
