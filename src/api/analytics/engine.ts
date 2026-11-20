/**
 * Which implementation loads an analytics dashboard (ADR 0003). ANALYTICS_ENGINE=go reads it from platform-go
 * (go/internal/analytics, contract go/contracts/analytics-v1.schema.json); the in-process TypeScript loaders are the
 * default and the fallback. Authorization, support auditing, caching and the public response envelope stay in
 * src/api/analytics/index.ts for both engines.
 *
 * Fallback is for availability only (unreachable, timeout, overload, 5xx, malformed response). A 4xx from Go is a
 * validation or authentication failure and is raised, never retried in TypeScript. Fallbacks are bounded: at most
 * config.analytics.maxFallbackConcurrency run at once (the rest get 503), and after a failure Go is skipped for a
 * short cool-down so an outage does not add a timeout to every request.
 */
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { retrievalService } from "../../retrieval/semantic.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";
import type { AnalyticsFilters, AnalyticsScope } from "./filters.ts";
import { usageAnalytics, performanceAnalytics, workflowAnalytics } from "./execution.ts";
import { healthAnalytics, healthServiceAnalytics } from "./health.ts";
import { optionsAnalytics } from "./options.ts";

export type Dashboard =
  "usage" | "performance" | "workflows" | "health" | "health-service" | "options";

export const typescriptLoaders: Record<
  Dashboard,
  (f: AnalyticsFilters, scope: AnalyticsScope) => Promise<object>
> = {
  usage: usageAnalytics,
  performance: performanceAnalytics,
  workflows: workflowAnalytics,
  health: healthAnalytics,
  "health-service": healthServiceAnalytics,
  options: (_f, scope) => optionsAnalytics(scope),
};

/** Counters since process start (GET /api/metrics/cache-style diagnostics, benchmarks, tests). */
export const analyticsEngineStats = {
  go: 0,
  typescript: 0,
  fallbacks: {} as Record<string, number>,
  rejected: 0,
};
const COOL_DOWN_MS = 10_000;
let goDownUntil = 0;
let activeFallbacks = 0;
const lastLogged = new Map<string, number>();

/** Test hook: forget a previous outage. */
export function resetAnalyticsEngine() {
  goDownUntil = 0;
  activeFallbacks = 0;
}

class Unavailable extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

const prodNamespaces = () =>
  config.prodErrors.namespaces.map((n) => ({ namespace: n.namespace, project: n.project }));

function wire(f: AnalyticsFilters) {
  return {
    from: f.from,
    to: f.to,
    timezone: f.timezone,
    bucket: f.bucket,
    provider: f.provider,
    model: f.model,
    user: f.user,
    workflow: f.workflow,
    repository: f.repository,
    project: f.project,
    service: f.service,
    namespace: f.namespace,
    severity: f.severity,
    incident_status: f.incidentStatus,
    environment: f.environment,
    group_by: f.groupBy,
    page: f.page,
    page_size: f.pageSize,
  };
}

/** Top-level fields every dashboard response carries; a response without them is treated as malformed. */
const requiredKeys: Record<Dashboard, string[]> = {
  usage: ["summary", "trend", "breakdown", "details"],
  performance: ["summary", "comparison", "failures", "details"],
  workflows: ["workflows", "steps", "trend", "details", "hotspots", "evidence"],
  health: ["summary", "trend", "services", "details", "freshness"],
  "health-service": ["summary", "services", "service", "freshness"],
  options: ["workflows", "repositories", "projects", "namespaces", "services", "users"],
};

async function viaGo(
  dashboard: Dashboard,
  f: AnalyticsFilters,
  scope: AnalyticsScope,
  signal?: AbortSignal,
): Promise<object> {
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) throw new Unavailable("missing_token");
  let res: Response;
  try {
    res = await retrievalService(
      `/internal/v1/analytics/${dashboard}`,
      {
        scope: { owner_id: scope.ownerId, all: scope.all },
        filters: wire(f),
        prod_namespaces: prodNamespaces(),
      },
      config.analytics.timeoutMs,
      signal,
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    const timeout = (e as Error).name === "TimeoutError";
    throw new Unavailable(timeout ? "timeout" : "unreachable", (e as Error).message);
  }
  const body = (await res.json().catch(() => undefined)) as
    { data?: Record<string, unknown>; error?: string; code?: string } | undefined;
  if (res.status === 400) throw new HttpError(400, body?.error ?? "Invalid analytics request");
  if (res.status === 401 || res.status === 403)
    throw new HttpError(502, "platform-go rejected the internal analytics credentials");
  if (res.status === 503 || res.status === 504 || res.status >= 500)
    throw new Unavailable(body?.code ?? `http_${res.status}`);
  if (!res.ok) throw new HttpError(502, `platform-go analytics failed (HTTP ${res.status})`);
  const data = body?.data;
  if (!data || typeof data !== "object" || requiredKeys[dashboard].some((k) => !(k in data)))
    throw new Unavailable("invalid_response");
  // Redaction stays a TypeScript concern: the scan error is stored unredacted.
  const scan = (data.freshness as { latest_scan?: { error?: unknown } } | undefined)?.latest_scan;
  if (scan?.error) scan.error = safeDiagnostics(String(scan.error));
  return data;
}

function recordFallback(reason: string, detail: string) {
  analyticsEngineStats.fallbacks[reason] = (analyticsEngineStats.fallbacks[reason] ?? 0) + 1;
  const now = Date.now();
  if (now - (lastLogged.get(reason) ?? 0) >= 60_000) {
    lastLogged.set(reason, now);
    console.warn(`platform-go analytics unavailable (${detail}); using the TypeScript engine`);
  }
}

/** Loads one dashboard with the configured engine. Never widens `scope`: it comes from the authenticated actor. */
export async function loadDashboard(
  dashboard: Dashboard,
  f: AnalyticsFilters,
  scope: AnalyticsScope,
  signal?: AbortSignal,
): Promise<object> {
  if (config.analytics.engine === "go") {
    if (Date.now() >= goDownUntil) {
      try {
        const data = await viaGo(dashboard, f, scope, signal);
        analyticsEngineStats.go++;
        return data;
      } catch (e) {
        if (!(e instanceof Unavailable)) throw e;
        goDownUntil = Date.now() + COOL_DOWN_MS;
        recordFallback(e.reason, e.message);
      }
    } else recordFallback("cool_down", "recent failure");
    if (activeFallbacks >= config.analytics.maxFallbackConcurrency) {
      analyticsEngineStats.rejected++;
      throw new HttpError(503, "Analytics is temporarily unavailable; retry shortly");
    }
    activeFallbacks++;
    try {
      analyticsEngineStats.typescript++;
      return await typescriptLoaders[dashboard](f, scope);
    } finally {
      activeFallbacks--;
    }
  }
  analyticsEngineStats.typescript++;
  return typescriptLoaders[dashboard](f, scope);
}
