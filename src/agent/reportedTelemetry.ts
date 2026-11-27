/** A leaf module: the shape of provider telemetry and the helpers a provider adapter uses to report part of it. */

export interface ProviderTelemetry {
  model_turns: number | null;
  assistant_messages: number | null;
  provider_tool_uses: number | null;
  provider_tool_errors: number | null;
  session_model: string | null;
  api_models: string[];
  provider_duration_ms: number | null;
  reasoning_tokens: number | null;
}

/** Telemetry of a provider that reports only part of it: whatever is not given stays null, never 0. */
export function reportedTelemetry(reported: Partial<ProviderTelemetry>): ProviderTelemetry {
  return {
    model_turns: null,
    assistant_messages: null,
    provider_tool_uses: null,
    provider_tool_errors: null,
    session_model: null,
    api_models: [],
    provider_duration_ms: null,
    reasoning_tokens: null,
    ...reported,
  };
}

/** Cumulative provider usage: a later event fills in or replaces numbers, but never turns a known number into null. */
export function mergeReportedTokens(
  previous: Record<string, number | null> | null,
  next: Record<string, number | null | undefined> | null | undefined,
): Record<string, number | null> | null {
  if (!next) return previous;
  const merged: Record<string, number | null> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value != null) merged[key] = value;
    else if (!(key in merged)) merged[key] = null;
  }
  return merged;
}
