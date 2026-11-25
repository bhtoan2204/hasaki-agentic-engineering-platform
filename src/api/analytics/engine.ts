/**
 * Analytics dashboards are read by platform-go (go/internal/analytics, contract go/contracts/analytics-v1.schema.json;
 * ADR 0003). Authorization, support auditing, caching and the public response envelope stay in
 * src/api/analytics/index.ts. A 4xx from Go is a validation or authentication failure; an unreachable, slow or
 * malformed platform-go is reported as 503 (there is no second implementation to fall back to).
 */
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { retrievalService } from "../../retrieval/semantic.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";
import type { AnalyticsFilters, AnalyticsScope } from "./filters.ts";

export type Dashboard =
  "usage" | "performance" | "workflows" | "health" | "health-service" | "options";

/** Counters since process start (diagnostics, tests). */
export const analyticsEngineStats = {
  go: 0,
  failures: {} as Record<string, number>,
};

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
  if (!config.retrieval.internalToken) throw new Unavailable("missing_token");
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

/** Loads one dashboard from platform-go. Never widens `scope`: it comes from the authenticated actor. */
export async function loadDashboard(
  dashboard: Dashboard,
  f: AnalyticsFilters,
  scope: AnalyticsScope,
  signal?: AbortSignal,
): Promise<object> {
  try {
    const data = await viaGo(dashboard, f, scope, signal);
    analyticsEngineStats.go++;
    return data;
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    analyticsEngineStats.failures[e.reason] = (analyticsEngineStats.failures[e.reason] ?? 0) + 1;
    throw new HttpError(
      503,
      `Analytics is temporarily unavailable (platform-go: ${e.reason}); retry shortly`,
    );
  }
}
