import { redactSecrets } from "../integrations/redact.ts";

export const FAILURE_CATEGORIES = [
  "RATE_LIMIT",
  "QUOTA_EXHAUSTED",
  "AUTHENTICATION",
  "PROVIDER_UNAVAILABLE",
  "CONTEXT_LIMIT",
  "EXECUTION_TIMEOUT",
  "TOOL_FAILURE",
  "AGENT_ERROR",
  "CANCELED",
  "UNKNOWN",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

interface ProviderFailureDetail {
  code?: unknown;
  type?: unknown;
  message?: unknown;
}

interface ProviderFailure extends ProviderFailureDetail {
  error?: string | ProviderFailureDetail;
  status?: unknown;
  errors?: { join?: (separator: string) => unknown };
  result?: unknown;
}

/** Structured codes take priority. A timeout is never evidence of depleted quota. */
export function normalizeProviderFailure(error: unknown): FailureCategory {
  const e = error as ProviderFailure | null | undefined;
  const detail = typeof e?.error === "string" ? undefined : e?.error;
  const code = String(
    e?.code ??
      (typeof e?.error === "string" ? e.error : detail?.code) ??
      detail?.type ??
      e?.status ??
      e?.type ??
      "",
  ).toLowerCase();
  const exact = code.toUpperCase();
  if (exact !== "UNKNOWN" && (FAILURE_CATEGORIES as readonly string[]).includes(exact))
    return exact as FailureCategory;
  const text = String(
    e?.message ?? detail?.message ?? e?.errors?.join?.(" ") ?? e?.result ?? error ?? "",
  ).toLowerCase();
  const classify = (s: string): FailureCategory | null => {
    if (
      /insufficient_quota|quota_exhausted|usage_limit_reached|billing_hard_limit|credit balance|exceeded your current quota|quota limit reached|quota exceeded|usage limit reached|you(?:'|’)ve hit your (?:usage )?limit|you have hit your (?:usage )?limit|purchase more credits/.test(
        s,
      )
    )
      return "QUOTA_EXHAUSTED";
    if (/rate_limit|rate limit|too many requests|\b429\b/.test(s)) return "RATE_LIMIT";
    if (
      /authentication|not authenticated|not logged in|login required|unauthorized|invalid_api_key|\b401\b/.test(
        s,
      )
    )
      return "AUTHENTICATION";
    if (/context_length|context limit|context window|prompt is too long/.test(s))
      return "CONTEXT_LIMIT";
    if (/overloaded|service_unavailable|provider unavailable|\b50[234]\b/.test(s))
      return "PROVIDER_UNAVAILABLE";
    if (/cancelled|canceled|aborterror/.test(s)) return "CANCELED";
    if (/timeout|timed out/.test(s)) return "EXECUTION_TIMEOUT";
    if (/tool_failure|tool failed/.test(s)) return "TOOL_FAILURE";
    if (/agent_error/.test(s)) return "AGENT_ERROR";
    return null;
  };
  return classify(code) ?? classify(text) ?? "UNKNOWN";
}
export function safeDiagnostics(value: unknown): string {
  const text =
    value instanceof Error
      ? JSON.stringify({ message: value.message, code: (value as NodeJS.ErrnoException).code })
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return redactSecrets(text ?? "")
    .replace(/\b(?:sk|rt|sess)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .slice(0, 4000);
}

type UsageSession = Record<string, unknown> & { tokens?: Record<string, unknown> | null };

type UsageRow = Record<string, unknown> & {
  provider_sessions?: Record<string, UsageSession> | null;
  normalized_failure_category?: string | null;
};

interface UsageCoverage {
  reported: number;
  missing: number;
  partial: number;
  sessions_missing: number;
}

type UsageSummary = Record<string, unknown> & {
  attempts: number;
  coverage: Record<string, UsageCoverage>;
  failures: Record<string, number>;
  latency_ms: Record<string, number | null>;
  provider_latency_ms: Record<string, number | null>;
};

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Null-preserving totals expose known subtotals together with explicit coverage. */
export function usageSummary(rows: UsageRow[]): UsageSummary {
  const fields = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "reasoning_tokens",
    "reported_cost_usd",
    "provider_execution_ms",
    "tool_execution_ms",
    "wall_duration_ms",
    "queue_duration_ms",
    "human_wait_ms",
    "tool_failures",
  ];
  const totals: Record<string, number | null> = {};
  const coverage: Record<string, UsageCoverage> = {};
  const failures: Record<string, number> = {};
  for (const field of fields) {
    const values = rows.map((r) => r[field]).filter(isFiniteNumber);
    totals[field] = values.length ? values.reduce((a, b) => a + b, 0) : null;
    const tokenKeys: Record<string, string> = {
      input_tokens: "input",
      output_tokens: "output",
      cache_read_tokens: "cache_read",
      cache_creation_tokens: "cache_creation",
      reasoning_tokens: "reasoning_output",
    };
    let partial = 0;
    let sessionsMissing = 0;
    for (const row of rows) {
      if (!tokenKeys[field] && !["reported_cost_usd", "provider_execution_ms"].includes(field))
        continue;
      const sessions = Object.values(row.provider_sessions ?? {});
      if (!sessions.length) continue;
      const missing = sessions.filter(
        (s) => (tokenKeys[field] ? s.tokens?.[tokenKeys[field]] : s[field]) == null,
      ).length;
      sessionsMissing += missing;
      if (missing && missing < sessions.length) partial++;
    }
    coverage[field] = {
      reported: values.length,
      missing: rows.length - values.length,
      partial,
      sessions_missing: sessionsMissing,
    };
  }
  for (const r of rows)
    if (r.normalized_failure_category)
      failures[r.normalized_failure_category] = (failures[r.normalized_failure_category] ?? 0) + 1;
  const percentiles = (field: string) => {
    const times = rows
      .map((r) => r[field])
      .filter(isFiniteNumber)
      .sort((a, b) => a - b);
    return Object.fromEntries(
      [50, 95, 99].map((p) => [
        `p${p}`,
        times.length ? times[Math.max(0, Math.ceil((times.length * p) / 100) - 1)] : null,
      ]),
    );
  };
  return {
    attempts: rows.length,
    coverage,
    failures,
    ...totals,
    latency_ms: percentiles("wall_duration_ms"),
    provider_latency_ms: percentiles("provider_execution_ms"),
  };
}
