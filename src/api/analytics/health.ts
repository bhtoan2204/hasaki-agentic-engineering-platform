import { pool, q, one, withTx } from "../../db/pool.ts";
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { requireAdmin, type Actor } from "../../authz/access.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";
import { bucketSql, filterParams, type AnalyticsFilters, type AnalyticsScope } from "./filters.ts";
import { executionCte } from "./execution.ts";

const healthCte = `${executionCte},
visible_groups AS MATERIALIZED (
 SELECT g.*, CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.id END AS visible_work_item_id,
   CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.code END AS work_item_code
 FROM prod_error_groups g LEFT JOIN work_items w ON w.id=g.work_item_id
 WHERE ($13::text IS NULL OR g.service=$13)
 AND ($12::text IS NULL OR ($14::jsonb->>g.namespace)=$12 OR (w.project=$12 AND w.owner_id IS NOT NULL AND ($6 OR w.owner_id=$5)))
 AND (($7::text IS NULL AND $8::text IS NULL AND $9::bigint IS NULL AND $10::text IS NULL AND $11::text IS NULL)
   OR EXISTS(SELECT 1 FROM runs r WHERE r.work_item_id=g.work_item_id))
),
observations AS MATERIALIZED (
 SELECT o.*,s.window_start,s.window_end,g.namespace,g.service,g.signature,g.lifecycle_status,g.acknowledged_at,g.resolved_at,g.first_seen_at,g.visible_work_item_id,g.work_item_code,
   false AS legacy FROM prod_error_observations o JOIN prod_error_scans s ON s.id=o.scan_id JOIN visible_groups g ON g.fingerprint=o.fingerprint CROSS JOIN bounds b
 WHERE s.ok AND s.window_start<b.hi AND s.window_end>b.lo
 UNION ALL
 SELECT COALESCE(g.last_scan_id,0),g.fingerprint,g.today_count,g.yesterday_count,g.first_at,g.last_at,g.severity,'[]'::jsonb,
   g.day::timestamp AT TIME ZONE $3,(g.day+1)::timestamp AT TIME ZONE $3,g.namespace,g.service,g.signature,g.lifecycle_status,g.acknowledged_at,g.resolved_at,g.first_seen_at,g.visible_work_item_id,g.work_item_code,true
 FROM visible_groups g CROSS JOIN bounds b WHERE NOT EXISTS(SELECT 1 FROM prod_error_observations o WHERE o.fingerprint=g.fingerprint)
 AND g.day::timestamp AT TIME ZONE $3<b.hi AND (g.day+1)::timestamp AT TIME ZONE $3>b.lo
),
hour_candidates AS (
 SELECT o.fingerprint,(h->>'hour')::timestamptz AS hour,(h->>'count')::bigint AS events,o.scan_id,
   least(o.window_end,(h->>'hour')::timestamptz+interval '1 hour')-greatest(o.window_start,(h->>'hour')::timestamptz) AS covered
 FROM observations o CROSS JOIN LATERAL jsonb_array_elements(o.hourly) h CROSS JOIN bounds b
 WHERE (h->>'hour')::timestamptz>=b.lo AND (h->>'hour')::timestamptz+interval '1 hour'<=b.hi
),
hours AS MATERIALIZED (SELECT DISTINCT ON(fingerprint,hour) * FROM hour_candidates ORDER BY fingerprint,hour,covered DESC,scan_id DESC),
incidents AS MATERIALIZED (
 SELECT g.*,o.events,o.severity AS observed_severity,o.first_at AS observed_first_at,o.last_at AS observed_last_at,o.recurring,o.snapshots,o.missing_hourly,
   CASE WHEN g.acknowledged_at>=g.first_seen_at THEN extract(epoch FROM(g.acknowledged_at-g.first_seen_at))*1000 END AS acknowledge_ms,
   CASE WHEN g.resolved_at>=g.first_seen_at THEN extract(epoch FROM(g.resolved_at-g.first_seen_at))*1000 END AS resolve_ms
 FROM visible_groups g JOIN LATERAL (
  SELECT COALESCE((SELECT sum(events) FROM hours h WHERE h.fingerprint=g.fingerprint),
    (array_agg(event_count ORDER BY window_end DESC,scan_id DESC) FILTER(WHERE window_start>=b.lo AND window_end<=b.hi))[1]) AS events,
    (array_agg(severity ORDER BY window_end DESC,scan_id DESC))[1] AS severity,
    min(first_at) AS first_at,max(last_at) AS last_at,bool_or(baseline_count>0) OR count(DISTINCT (window_start AT TIME ZONE $3)::date)>1 AS recurring,
    count(*)::int AS snapshots,count(*) FILTER(WHERE jsonb_array_length(hourly)=0)::int AS missing_hourly
  FROM observations o CROSS JOIN bounds b WHERE o.fingerprint=g.fingerprint HAVING count(*)>0
 ) o ON true
)`;

export async function healthAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  const params = [
    ...filterParams(f, scope),
    JSON.stringify(Object.fromEntries(config.prodErrors.namespaces.map((n) => [n.namespace, n.project]))),
  ];
  const [summary, trend, severity, services, details] = await Promise.all([
    one(
      pool,
      `${healthCte} SELECT count(*)::int AS fingerprints,sum(events) AS total_errors,
      count(*) FILTER(WHERE first_seen_at>=b.lo AND first_seen_at<b.hi)::int AS new_errors,
      count(*) FILTER(WHERE lifecycle_status='resolved')::int AS resolved,
      count(*) FILTER(WHERE lifecycle_status<>'resolved')::int AS unresolved,
      count(*) FILTER(WHERE recurring)::int AS recurring,
      avg(acknowledge_ms) AS acknowledge_ms,avg(resolve_ms) AS resolve_ms,
      count(*) FILTER(WHERE acknowledge_ms IS NULL)::int AS missing_acknowledged,
      count(*) FILTER(WHERE resolve_ms IS NULL)::int AS missing_resolved,
      sum(missing_hourly)::int AS snapshots_missing_hourly,
      (SELECT count(*)::int FROM hours WHERE covered<interval '1 hour') AS partial_hours
      FROM incidents CROSS JOIN bounds b`,
      params,
    ),
    q(
      pool,
      `${healthCte} SELECT ${bucketSql("hour")} AS bucket,sum(events) AS events,count(DISTINCT fingerprint)::int AS fingerprints FROM hours GROUP BY 1 ORDER BY 1`,
      params,
    ),
    q(
      pool,
      `${healthCte} SELECT observed_severity AS severity,count(*)::int AS fingerprints,sum(events) AS events FROM incidents GROUP BY 1 ORDER BY sum(events) DESC`,
      params,
    ),
    q(
      pool,
      `${healthCte} SELECT service,'splunk' AS source_provider,count(*)::int AS fingerprints,sum(events) AS events FROM incidents GROUP BY 1 ORDER BY sum(events) DESC,1 LIMIT 50`,
      params,
    ),
    q(
      pool,
      `${healthCte} SELECT g.fingerprint,g.namespace,g.service,g.signature,g.observed_severity AS severity,g.lifecycle_status,g.status AS triage_status,
      g.events,g.recurring,g.first_seen_at,g.observed_first_at AS first_at,g.observed_last_at AS last_at,g.acknowledged_at,g.resolved_at,
      g.visible_work_item_id AS work_item_id,g.work_item_code,g.missing_hourly,
      (SELECT COALESCE(jsonb_agg(e),'[]') FROM (SELECT action,evidence,created_at FROM prod_error_lifecycle_events WHERE fingerprint=g.fingerprint ORDER BY id DESC LIMIT 3) e) AS lifecycle_events,
      COALESCE(links.runs,'[]'::jsonb) AS runs,count(*) OVER()::int AS total_rows
      FROM incidents g LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'verified',r.verified,
          'changes',r.summary->'changes','pull_requests',
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('url',p.url,'repo',p.repo,'title',p.title)),'[]'::jsonb) FROM pull_requests p WHERE p.run_id=r.id))) AS runs
        FROM (SELECT * FROM runs WHERE work_item_id=g.visible_work_item_id ORDER BY id DESC LIMIT 5) r
      ) links ON true
      ORDER BY g.recurring DESC,g.events DESC,g.fingerprint LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
      params,
    ),
  ]);
  return {
    summary,
    trend,
    severity,
    services,
    details,
    source: "shared_splunk_scans",
    trend_source: "widest_scan_per_fingerprint_hour",
    lifecycle_source: "explicit_operator_status",
  };
}

/** Operator evidence is an explicit supported resolution status, never an agent's completion claim. */
export async function updateIncidentLifecycle(actor: Actor, fingerprint: string, body: any) {
  requireAdmin(actor);
  const action = body.action;
  if (!["acknowledge", "resolve", "reopen"].includes(action)) throw new HttpError(400, "Invalid lifecycle action");
  const evidence = safeDiagnostics(String(body.evidence ?? "").trim());
  if (action === "resolve" && evidence.length < 8)
    throw new HttpError(400, "Resolution requires an evidence reference or explanation (8–4000 characters)");
  return withTx(async (c) => {
    const g = await one(c, "SELECT * FROM prod_error_groups WHERE fingerprint=$1 FOR UPDATE", [fingerprint]);
    if (!g) throw new HttpError(404, "Incident not found");
    const next = action === "resolve" ? "resolved" : action === "acknowledge" ? "acknowledged" : "open";
    if (g.lifecycle_status === next) return { ok: true, status: next };
    if (action === "acknowledge" && g.lifecycle_status === "resolved")
      throw new HttpError(409, "Reopen a resolved incident first");
    await q(
      c,
      `UPDATE prod_error_groups SET lifecycle_status=$2,
      acknowledged_at=CASE WHEN $3='acknowledge' THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
      resolved_at=CASE WHEN $3='resolve' THEN now() WHEN $3='reopen' THEN NULL ELSE resolved_at END,updated_at=now() WHERE fingerprint=$1`,
      [fingerprint, next, action],
    );
    await q(c, "INSERT INTO prod_error_lifecycle_events(fingerprint,action,actor_id,evidence) VALUES($1,$2,$3,$4)", [
      fingerprint,
      action,
      actor.id,
      evidence,
    ]);
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,$2,'prod_error',$3,$4)",
      [actor.id, `incident.${action}`, fingerprint, JSON.stringify({ evidence })],
    );
    return { ok: true, status: next };
  });
}
