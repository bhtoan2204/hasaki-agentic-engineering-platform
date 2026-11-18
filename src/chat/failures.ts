/** Structured chat turn failures. Codes are stable for UI actions; messages are sanitized for the owner. */

export const CHAT_FAILURE_CODES = [
  "PROVIDER_DISABLED",
  "PROVIDER_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "MODEL_UNAVAILABLE",
  "NO_ELIGIBLE_PROVIDER",
  "PROVIDER_STARTUP_TIMEOUT",
  "FIRST_RESPONSE_TIMEOUT",
  "IDLE_TIMEOUT",
  "TURN_TIMEOUT",
  "INCOMPLETE_OUTPUT",
  "TOOL_BUDGET_EXHAUSTED",
  "PERMISSION_DENIED",
  "CANCELED",
  "INTERRUPTED",
  "INTERNAL_ERROR",
] as const;

export type ChatFailureCode = (typeof CHAT_FAILURE_CODES)[number];

export interface ChatFailure {
  code: ChatFailureCode;
  message: string;
  provider?: string | null;
  model?: string | null;
  retryable: boolean;
  fallback_attempted?: boolean;
  actions?: Array<"retry" | "retry_other_provider" | "refresh_health" | "open_settings">;
  details?: Record<string, unknown>;
}

export class ChatTurnError extends Error {
  readonly failure: ChatFailure;
  constructor(failure: ChatFailure) {
    super(failure.message);
    this.name = "ChatTurnError";
    this.failure = failure;
  }
}

export function chatFailure(
  code: ChatFailureCode,
  message: string,
  extra: Partial<Omit<ChatFailure, "code" | "message">> = {},
): ChatFailure {
  const retryable = !["PERMISSION_DENIED", "CANCELED", "PROVIDER_DISABLED"].includes(code);
  const actions: ChatFailure["actions"] = [];
  if (retryable) actions.push("retry");
  if (
    code === "PROVIDER_UNAVAILABLE" ||
    code === "QUOTA_EXHAUSTED" ||
    code === "AUTHENTICATION_REQUIRED" ||
    code === "NO_ELIGIBLE_PROVIDER" ||
    code === "RATE_LIMITED"
  ) {
    actions.push("retry_other_provider", "refresh_health", "open_settings");
  }
  return {
    code,
    message: message.slice(0, 500),
    retryable,
    actions: extra.actions ?? actions,
    ...extra,
  };
}

/** Map provider/runtime errors into stable codes without leaking secrets. */
export function classifyProviderError(err: unknown, provider?: string | null): ChatFailure {
  const raw = String((err as Error)?.message ?? err);
  const msg = raw.slice(0, 500);
  const lower = msg.toLowerCase();
  if (/abor|cancel/i.test(lower)) return chatFailure("CANCELED", "Turn canceled", { provider });
  if (/quota|billing|credit|usage.?limit/i.test(lower))
    return chatFailure("QUOTA_EXHAUSTED", msg, { provider });
  if (/rate.?limit|429|too many requests/i.test(lower))
    return chatFailure("RATE_LIMITED", msg, { provider });
  if (/auth|login|not logged|credential|unauthorized|401/i.test(lower))
    return chatFailure("AUTHENTICATION_REQUIRED", msg, { provider });
  if (/disabled/i.test(lower)) return chatFailure("PROVIDER_DISABLED", msg, { provider });
  if (/model.*(unknown|unsupported|not found|invalid)/i.test(lower))
    return chatFailure("MODEL_UNAVAILABLE", msg, { provider });
  if (/timeout|timed out|deadline/i.test(lower))
    return chatFailure("TURN_TIMEOUT", msg, { provider });
  if (/not connected|unavailable|ENOENT|not found|spawn|executable/i.test(lower))
    return chatFailure("PROVIDER_UNAVAILABLE", msg, { provider });
  if (/permission|forbidden|not accessible|denied/i.test(lower))
    return chatFailure("PERMISSION_DENIED", msg, { provider, retryable: false });
  return chatFailure("INTERNAL_ERROR", msg, { provider });
}

export const EXECUTION_PHASES = [
  "queued",
  "validating_provider",
  "routing",
  "preparing_context",
  "calling_provider",
  "executing_tools",
  "switching_provider",
  "receiving_response",
  "completed",
  "failed",
  "canceled",
] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
