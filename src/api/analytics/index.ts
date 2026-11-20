import { CacheAside } from "../../cache/index.ts";
import { audit, wantsSupport, type Actor } from "../../authz/access.ts";
import { parseAnalyticsFilters } from "./filters.ts";
import { loadDashboard, type Dashboard } from "./engine.ts";
import { HttpError } from "../../http/error.ts";
import { SharedAbort } from "../../http/sharedAbort.ts";

const cache = new CacheAside<object>(
  "engineering.analytics",
  [
    "workflow_runs",
    "workflow_step_attempts",
    "work_items",
    "prod_error_groups",
    "prod_error_scans",
    "prod_error_lifecycle_events",
    "prod_error_observations",
    "pull_requests",
    "eval_results",
  ],
  30000,
  200,
);
const loads = new SharedAbort();
const DASHBOARDS = new Set<string>([
  "health",
  "health-service",
  "usage",
  "performance",
  "workflows",
]);

/**
 * `signal` aborts when every client waiting for this response has disconnected: the Go engine then cancels its
 * statements. A cached load shared with another request is not canceled by one of them leaving.
 */
export async function engineeringAnalytics(
  actor: Actor,
  url: URL,
  dashboard: string,
  signal?: AbortSignal,
) {
  const scope = { ownerId: actor.id, all: wantsSupport(actor, url.searchParams.get("scope")) };
  const filters = parseAnalyticsFilters(url.searchParams);
  if (scope.all) await audit(actor.id, "support.list", "analytics", dashboard, { filters });
  // Cache-aside loads are shared by key: cancel one only when all of its waiters are gone.
  const cached = async <T extends object>(key: string, load: (s: AbortSignal) => Promise<T>) => {
    const shared = loads.join(key, signal);
    try {
      return await cache.get(key, () => load(shared.signal));
    } finally {
      shared.leave();
    }
  };
  if (dashboard === "options")
    return {
      ...(await cached(JSON.stringify([scope, "options"]), (s) =>
        loadDashboard("options", filters, scope, s),
      )),
      can_manage_incidents: actor.role === "admin",
    };
  if (!DASHBOARDS.has(dashboard)) throw new HttpError(404, "Unknown analytics dashboard");
  const data = await cached(JSON.stringify([scope, dashboard, filters]), async (s) => ({
    ...(await loadDashboard(dashboard as Dashboard, filters, scope, s)),
    generated_at: new Date().toISOString(),
  }));
  return {
    ...data,
    filters,
    cache_ttl_seconds: 30,
    can_manage_incidents: actor.role === "admin",
    pagination: { page: filters.page, page_size: filters.pageSize },
    semantics: {
      interval: "[from,to)",
      cohort: "run_created_at",
      cost: "provider_reported_estimate",
      verification: "latest_active_coding_attempts",
      health: "shared_errors_with_owner_scoped_links",
    },
  };
}
