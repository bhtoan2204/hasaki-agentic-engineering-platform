import { pool, q } from "../../db/pool.ts";
import { CacheAside } from "../../cache/index.ts";
import { audit, wantsSupport, type Actor } from "../../authz/access.ts";
import { config } from "../../config.ts";
import { parseAnalyticsFilters } from "./filters.ts";
import { usageAnalytics, performanceAnalytics, workflowAnalytics } from "./execution.ts";
import { healthAnalytics, healthServiceAnalytics } from "./health.ts";
import { HttpError } from "../../http/error.ts";

const cache = new CacheAside<any>(
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
export async function engineeringAnalytics(actor: Actor, url: URL, dashboard: string) {
  const scope = { ownerId: actor.id, all: wantsSupport(actor, url.searchParams.get("scope")) };
  const filters = parseAnalyticsFilters(url.searchParams);
  if (scope.all) await audit(actor.id, "support.list", "analytics", dashboard, { filters });
  if (dashboard === "options")
    return cache.get(JSON.stringify([scope, "options"]), async () => {
      const [rows, prodServices] = await Promise.all([q(
        pool,
        `SELECT r.owner_id,u.username,r.definition_key,r.selected_repositories,
      COALESCE(NULLIF(w.project,''),NULLIF(r.inputs->>'project',''),'unknown') AS project FROM workflow_runs r
      JOIN users u ON u.id=r.owner_id LEFT JOIN work_items w ON w.id=r.work_item_id
      WHERE r.owner_id IS NOT NULL AND ($2::boolean OR r.owner_id=$1) GROUP BY 1,2,3,4,5 ORDER BY 3 LIMIT 1000`,
        [scope.ownerId, scope.all],
      ), q(pool, `SELECT DISTINCT COALESCE(NULLIF(namespace,''),'unknown') AS namespace,
        COALESCE(NULLIF(service,''),'unknown') AS service FROM prod_error_groups ORDER BY 1,2 LIMIT 500`)]);
      const unique = (key: string) =>
        [...new Set(rows.flatMap((r) => (Array.isArray(r[key]) ? r[key] : [r[key]])))].sort();
      return {
        workflows: unique("definition_key"),
        repositories: unique("selected_repositories"),
        projects: [...new Set([...unique("project"), ...config.prodErrors.namespaces.map((n) => n.project)])].sort(),
        namespaces: [...new Set([...config.prodErrors.namespaces.map((n) => n.namespace), ...prodServices.map((r: any) => r.namespace)])].sort(),
        services: prodServices,
        environments: ["production"],
        users: [...new Map(rows.map((r) => [r.owner_id, { id: r.owner_id, username: r.username }])).values()],
        can_manage_incidents: actor.role === "admin",
      };
    });
  const loader = {
    health: healthAnalytics,
    "health-service": healthServiceAnalytics,
    usage: usageAnalytics,
    performance: performanceAnalytics,
    workflows: workflowAnalytics,
  }[dashboard];
  if (!loader) throw new HttpError(404, "Unknown analytics dashboard");
  const data = await cache.get(JSON.stringify([scope, dashboard, filters]), async () => ({
    ...(await loader(filters, scope)),
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
