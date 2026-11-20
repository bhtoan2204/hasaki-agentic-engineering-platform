import { pool, q } from "../../db/pool.ts";
import { config } from "../../config.ts";
import type { AnalyticsScope } from "./filters.ts";

/** Filter choices visible in `scope` (engineering cohorts) plus the shared production namespaces and services. */
export async function optionsAnalytics(scope: AnalyticsScope) {
  const [rows, prodServices] = await Promise.all([
    q(
      pool,
      `SELECT r.owner_id,u.username,r.definition_key,r.selected_repositories,
      COALESCE(NULLIF(w.project,''),NULLIF(r.inputs->>'project',''),'unknown') AS project FROM workflow_runs r
      JOIN users u ON u.id=r.owner_id LEFT JOIN work_items w ON w.id=r.work_item_id
      WHERE r.owner_id IS NOT NULL AND ($2::boolean OR r.owner_id=$1) GROUP BY 1,2,3,4,5 ORDER BY 3 LIMIT 1000`,
      [scope.ownerId, scope.all],
    ),
    q<{ namespace: string; service: string }>(
      pool,
      `SELECT DISTINCT COALESCE(NULLIF(namespace,''),'unknown') AS namespace,
        COALESCE(NULLIF(service,''),'unknown') AS service FROM prod_error_groups ORDER BY 1,2 LIMIT 500`,
    ),
  ]);
  const unique = (key: string) =>
    [...new Set(rows.flatMap((r) => (Array.isArray(r[key]) ? r[key] : [r[key]])))].sort();
  return {
    workflows: unique("definition_key"),
    repositories: unique("selected_repositories"),
    projects: [
      ...new Set([...unique("project"), ...config.prodErrors.namespaces.map((n) => n.project)]),
    ].sort(),
    namespaces: [
      ...new Set([
        ...config.prodErrors.namespaces.map((n) => n.namespace),
        ...prodServices.map((r) => r.namespace),
      ]),
    ].sort(),
    services: prodServices,
    environments: ["production"],
    users: [
      ...new Map(rows.map((r) => [r.owner_id, { id: r.owner_id, username: r.username }])).values(),
    ],
  };
}
