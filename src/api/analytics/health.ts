import { pool, q, one, withTx } from "../../db/pool.ts";
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { requireAdmin, type Actor } from "../../authz/access.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";
import { boundsSql, bucketSql, filterParams, type AnalyticsFilters, type AnalyticsScope } from "./filters.ts";
import { executionCte } from "./execution.ts";

const healthCte = `${executionCte},
visible_groups AS MATERIALIZED (
 SELECT g.*, CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.id END AS visible_work_item_id,
   CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.code END AS work_item_code
 FROM prod_error_groups g LEFT JOIN work_items w ON w.id=g.work_item_id
 WHERE ($13::text IS NULL OR COALESCE(NULLIF(g.service,''),'unknown')=$13)
 AND ($12::text IS NULL OR ($14::jsonb->>g.namespace)=$12 OR (w.project=$12 AND w.owner_id IS NOT NULL AND ($6 OR w.owner_id=$5)))
 AND ($15::text IS NULL OR COALESCE(NULLIF(lower(g.severity),''),'unknown')=$15)
 AND ($17::text IS NULL OR COALESCE(NULLIF(g.namespace,''),'unknown')=$17)
 AND ($18::text IS NULL OR $18='production')
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
 WHERE ($16::text IS NULL OR ($16='recurring' AND o.recurring) OR ($16<>'recurring' AND g.lifecycle_status=$16))
)`;

const projectMap = () => JSON.stringify(Object.fromEntries(config.prodErrors.namespaces.map((n) => [n.namespace, n.project])));
function paramsFor(f: AnalyticsFilters, scope: AnalyticsScope) {
  return [...filterParams(f, scope), projectMap(), f.severity, f.incidentStatus, f.namespace, f.environment];
}
function boundaryInstant(value: string, timezone: string) {
  if (value.length !== 10) return Date.parse(value);
  const target = Date.parse(`${value}T00:00:00Z`);
  let candidate = target;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(candidate)).map((x) => [x.type, x.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const delta = target - represented;
    candidate += delta;
    if (!delta) break;
  }
  return candidate;
}
function previousPeriod(f: AnalyticsFilters): AnalyticsFilters {
  const lo = boundaryInstant(f.from, f.timezone), hi = boundaryInstant(f.to, f.timezone), width = hi - lo;
  return { ...f, from: new Date(lo - width).toISOString(), to: new Date(lo).toISOString() };
}

async function healthSet(f: AnalyticsFilters, scope: AnalyticsScope, includeDetails = true) {
  const params = paramsFor(f, scope);
  const jobs = [
    one(pool, `${healthCte} SELECT
      CASE WHEN EXISTS(SELECT 1 FROM prod_error_scans s CROSS JOIN bounds b WHERE s.ok AND s.window_start<b.hi AND s.window_end>b.lo) THEN CASE WHEN count(*)=0 THEN 0 ELSE sum(events) END ELSE NULL END AS total_errors,
      CASE WHEN EXISTS(SELECT 1 FROM prod_error_scans s CROSS JOIN bounds b WHERE s.ok AND s.window_start<b.hi AND s.window_end>b.lo) THEN count(*)::int ELSE NULL END AS fingerprints,
      count(*) FILTER(WHERE first_seen_at>=b.lo AND first_seen_at<b.hi)::int AS new_incidents,
      count(*) FILTER(WHERE lifecycle_status<>'resolved')::int AS active_incidents,
      count(*) FILTER(WHERE lifecycle_status='resolved')::int AS resolved_incidents,
      count(*) FILTER(WHERE observed_severity IN ('critical','high'))::int AS critical_high_incidents,
      count(*) FILTER(WHERE recurring)::int AS recurring_incidents,
      count(DISTINCT (COALESCE(NULLIF(namespace,''),'unknown'),COALESCE(NULLIF(service,''),'unknown')))::int AS affected_services,
      avg(acknowledge_ms) AS acknowledge_ms, avg(resolve_ms) AS resolve_ms,
      count(*) FILTER(WHERE acknowledge_ms IS NULL)::int AS missing_acknowledged,
      count(*) FILTER(WHERE resolve_ms IS NULL)::int AS missing_resolved,
      sum(missing_hourly)::int AS snapshots_missing_hourly,
      (SELECT count(*)::int FROM hours WHERE covered<interval '1 hour') AS partial_hours
      FROM incidents CROSS JOIN bounds b`, params),
    q(pool, `${healthCte} SELECT ${bucketSql("hour")} AS bucket,sum(events) AS events,count(DISTINCT fingerprint)::int AS fingerprints
      FROM hours GROUP BY 1 ORDER BY 1`, params),
    includeDetails ? q(pool, `${healthCte} SELECT COALESCE(NULLIF(lower(observed_severity),''),'unknown') AS severity,count(*)::int AS fingerprints,sum(events) AS events
      FROM incidents GROUP BY 1 ORDER BY CASE COALESCE(NULLIF(lower(observed_severity),''),'unknown') WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`, params) : Promise.resolve([]),
    includeDetails ? q(pool, `${healthCte} SELECT ${bucketSql("hour")} AS bucket,COALESCE(NULLIF(namespace,''),'unknown') AS namespace,
      COALESCE(NULLIF(service,''),'unknown') AS service,sum(h.events) AS events
      FROM hours h JOIN incidents i USING(fingerprint) GROUP BY 1,2,3 ORDER BY 1,2,3`, params) : Promise.resolve([]),
    q(pool, `${healthCte}, grouped AS (
      SELECT COALESCE(NULLIF(namespace,''),'unknown') AS namespace,COALESCE(NULLIF(service,''),'unknown') AS service,
        count(*)::int AS fingerprints,sum(events) AS events,
        count(*) FILTER(WHERE first_seen_at>=b.lo AND first_seen_at<b.hi)::int AS new_incidents,
        count(*) FILTER(WHERE lifecycle_status<>'resolved')::int AS unresolved_incidents,
      count(*) FILTER(WHERE observed_severity IN ('critical','high'))::int AS critical_high_incidents,
      sum(events) FILTER(WHERE observed_severity IN ('critical','high')) AS critical_high_errors,
        count(*) FILTER(WHERE recurring)::int AS recurring_incidents,max(observed_last_at) AS last_observed_error
      FROM incidents CROSS JOIN bounds b GROUP BY 1,2
    ) SELECT *,CASE WHEN sum(events) OVER()>0 THEN events*100.0/sum(events) OVER() END AS error_share_pct
      FROM grouped ORDER BY events DESC NULLS LAST,namespace,service`, params),
    includeDetails ? q(pool, `${healthCte}, status_counts AS (
      SELECT lifecycle_status AS status,count(*)::int AS incidents FROM incidents GROUP BY lifecycle_status
    ), reopen_counts AS (
      SELECT 'reopened' AS status,count(*)::int AS incidents FROM incidents i WHERE EXISTS(
        SELECT 1 FROM prod_error_lifecycle_events e WHERE e.fingerprint=i.fingerprint AND e.action='reopen'
        AND e.id=(SELECT max(e2.id) FROM prod_error_lifecycle_events e2 WHERE e2.fingerprint=i.fingerprint)
      )
      ) SELECT status,incidents FROM (SELECT * FROM status_counts UNION ALL SELECT * FROM reopen_counts) x
      ORDER BY CASE status WHEN 'open' THEN 1 WHEN 'acknowledged' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END`, params) : Promise.resolve([]),
    includeDetails ? q(pool, `${healthCte} SELECT g.fingerprint,g.namespace,COALESCE(NULLIF(g.service,''),'unknown') AS service,g.signature,g.observed_severity AS severity,g.lifecycle_status,g.status AS triage_status,
      g.events,g.recurring,g.first_seen_at,g.observed_first_at AS first_at,g.observed_last_at AS last_at,g.acknowledged_at,g.resolved_at,
      g.visible_work_item_id AS work_item_id,g.work_item_code,g.missing_hourly,
      (SELECT COALESCE(jsonb_agg(e),'[]') FROM (SELECT action,evidence,created_at FROM prod_error_lifecycle_events WHERE fingerprint=g.fingerprint ORDER BY id DESC LIMIT 3) e) AS lifecycle_events,
      COALESCE(links.runs,'[]'::jsonb) AS runs,count(*) OVER()::int AS total_rows
      FROM incidents g LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'verified',r.verified,'changes',r.summary->'changes',
          'pull_requests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('url',p.url,'repo',p.repo,'title',p.title)),'[]'::jsonb) FROM pull_requests p WHERE p.run_id=r.id))) AS runs
        FROM (SELECT * FROM runs WHERE work_item_id=g.visible_work_item_id ORDER BY id DESC LIMIT 5) r
      ) links ON true ORDER BY g.recurring DESC,g.events DESC NULLS LAST,g.fingerprint LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, params) : Promise.resolve([]),
    includeDetails ? q(pool, `${healthCte} SELECT fingerprint,namespace,COALESCE(NULLIF(service,''),'unknown') AS service,signature,observed_severity AS severity,
      events,recurring,observed_first_at AS first_at,observed_last_at AS last_at,visible_work_item_id AS work_item_id,work_item_code
      FROM incidents ORDER BY events DESC NULLS LAST LIMIT 10`, params) : Promise.resolve([]),
    includeDetails ? one(pool, `${healthCte} SELECT count(*) FILTER(WHERE visible_work_item_id IS NOT NULL)::int AS linked_incidents,
      count(DISTINCT visible_work_item_id) FILTER(WHERE visible_work_item_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs r WHERE r.work_item_id=incidents.visible_work_item_id))::int AS work_items_with_runs,
      count(DISTINCT r.id) FILTER(WHERE r.status='COMPLETED')::int AS completed_runs,
      count(DISTINCT r.id) FILTER(WHERE r.verified IS TRUE)::int AS verified_runs,
      count(DISTINCT p.id) FILTER(WHERE p.created IS TRUE)::int AS prs_created
      FROM incidents LEFT JOIN runs r ON r.work_item_id=incidents.visible_work_item_id
      LEFT JOIN pull_requests p ON (p.run_id=r.id OR p.work_item_id=incidents.visible_work_item_id)`, params) : Promise.resolve(null),
    one(pool, `WITH ${boundsSql}, scan_windows AS (
      SELECT greatest(s.window_start,b.lo) AS lo,least(s.window_end,b.hi) AS hi
      FROM prod_error_scans s CROSS JOIN bounds b WHERE s.window_start<b.hi AND s.window_end>b.lo AND s.ok
    ), ordered_windows AS (
      SELECT lo,hi,max(hi) OVER(ORDER BY lo,hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_hi FROM scan_windows
    ), coverage AS (
      SELECT COALESCE(sum(greatest(extract(epoch FROM(hi-greatest(lo,COALESCE(prior_hi,lo)))),0))*1000,0)::bigint AS window_coverage_ms FROM ordered_windows
    ) SELECT
      (SELECT row_to_json(s) FROM (SELECT id,trigger,started_at,finished_at,ok,error,groups,events,window_start,window_end,namespaces FROM prod_error_scans ORDER BY id DESC LIMIT 1) s) AS latest_scan,
      (SELECT row_to_json(s) FROM (SELECT id,trigger,started_at,finished_at,ok,window_start,window_end,namespaces FROM prod_error_scans WHERE ok ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 1) s) AS last_successful_scan,
      (SELECT max(o.last_at) FROM prod_error_observations o JOIN prod_error_scans s ON s.id=o.scan_id WHERE s.ok AND s.window_start<(SELECT hi FROM bounds) AND s.window_end>(SELECT lo FROM bounds)) AS latest_observation_at,
      (SELECT count(*)::int FROM prod_error_scans s WHERE s.window_start<(SELECT hi FROM bounds) AND s.window_end>(SELECT lo FROM bounds)) AS scans_in_range,
      (SELECT count(*)::int FROM prod_error_scans s WHERE s.ok AND s.window_start<(SELECT hi FROM bounds) AND s.window_end>(SELECT lo FROM bounds)) AS successful_scans_in_range,
      (SELECT count(*)::int FROM prod_error_scans s WHERE s.ok IS FALSE AND s.window_start<(SELECT hi FROM bounds) AND s.window_end>(SELECT lo FROM bounds)) AS failed_scans_in_range,
      (SELECT window_coverage_ms FROM coverage) AS window_coverage_ms`, [f.from, f.to, f.timezone, f.bucket]),
  ] as const;
  const [summary, trend, severity, serviceTrends, services, lifecycle, details, topFingerprints, remediation, freshness] = await Promise.all(jobs);
  return { summary, trend, severity, serviceTrends, services, lifecycle, details, topFingerprints, remediation, freshness };
}

const comparable = (now: any, before: any) => {
  const value = (x: any) => x == null || !Number.isFinite(Number(x)) ? null : Number(x);
  const current = value(now), previous = value(before);
  const delta = current == null || previous == null ? null : current - previous;
  return { current, previous, delta, delta_pct: delta == null || previous == null || previous === 0 ? null : delta / previous * 100 };
};
const sameCoverage = (a: any, b: any) => Number(a?.successful_scans_in_range) === Number(b?.successful_scans_in_range)
  && Number(a?.scans_in_range) === Number(b?.scans_in_range)
  && Number(a?.failed_scans_in_range) === Number(b?.failed_scans_in_range)
  && Number(a?.window_coverage_ms) === Number(b?.window_coverage_ms);

export async function healthAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  const prev = previousPeriod(f);
  const serviceScope = { ...f, service: null };
  const [current, previous, currentServices, previousServices] = await Promise.all([
    healthSet(f, scope, true), healthSet(prev, scope, false),
    f.service ? healthSet(serviceScope, scope, false) : Promise.resolve(null),
    f.service ? healthSet({ ...prev, service: null }, scope, false) : Promise.resolve(null),
  ]);
  const markEmptyPartialUnknown = (set: any, period: AnalyticsFilters) => {
    const width = boundaryInstant(period.to, period.timezone) - boundaryInstant(period.from, period.timezone);
    if (Number(set.summary.total_errors) === 0 && Number(set.freshness.window_coverage_ms ?? 0) < width) {
      for (const key of ["total_errors", "fingerprints", "new_incidents", "active_incidents", "resolved_incidents", "critical_high_incidents", "recurring_incidents", "affected_services"])
        if (Number(set.summary[key] ?? 0) === 0) set.summary[key] = null;
    }
  };
  markEmptyPartialUnknown(current, f);
  markEmptyPartialUnknown(previous, prev);
  const oldServices = new Map((previousServices ?? previous).services.map((s: any) => [`${s.namespace}\0${s.service}`, s]));
  const serviceCoverageComparable = sameCoverage((currentServices ?? current).freshness, (previousServices ?? previous).freshness);
  const services = (currentServices ?? current).services
    .filter((s: any) => !f.service || s.service === f.service)
    .filter((s: any) => !f.namespace || s.namespace === f.namespace)
    .map((s: any) => {
      const old: any = oldServices.get(`${s.namespace}\0${s.service}`);
      return {
        ...s, previous_events: old?.events ?? null, change_events: serviceCoverageComparable ? comparable(s.events, old?.events).delta : null,
        change_pct: serviceCoverageComparable ? comparable(s.events, old?.events).delta_pct : null, change_comparable: serviceCoverageComparable,
        environment: "production", service_key: `${s.namespace}\u001f${s.service}`
      };
    });
  const summary = {
    ...current.summary, comparisons: Object.fromEntries([
      ["total_errors", comparable(current.summary.total_errors, previous.summary.total_errors)],
      ["fingerprints", comparable(current.summary.fingerprints, previous.summary.fingerprints)],
      ["new_incidents", comparable(current.summary.new_incidents, previous.summary.new_incidents)],
      ["active_incidents", comparable(current.summary.active_incidents, previous.summary.active_incidents)],
      ["resolved_incidents", comparable(current.summary.resolved_incidents, previous.summary.resolved_incidents)],
      ["critical_high_incidents", comparable(current.summary.critical_high_incidents, previous.summary.critical_high_incidents)],
      ["recurring_incidents", comparable(current.summary.recurring_incidents, previous.summary.recurring_incidents)],
      ["affected_services", comparable(current.summary.affected_services, previous.summary.affected_services)],
      ["acknowledge_ms", comparable(current.summary.acknowledge_ms, previous.summary.acknowledge_ms)],
      ["resolve_ms", comparable(current.summary.resolve_ms, previous.summary.resolve_ms)],
    ]), previous_coverage: previous.freshness, current_coverage: current.freshness
  };
  const denom = (currentServices ?? current).summary.total_errors;
  const lifecycleMap = new Map(current.lifecycle.map((x: any) => [x.status, x.incidents]));
  const effectiveFrom = boundaryInstant(f.from, f.timezone), effectiveTo = boundaryInstant(f.to, f.timezone), rangeMs = effectiveTo - effectiveFrom;
  const latestScan = current.freshness.latest_scan ? {
    ...current.freshness.latest_scan,
    error: current.freshness.latest_scan.error ? safeDiagnostics(String(current.freshness.latest_scan.error)) : null
  } : null;
  const freshness = {
    ...current.freshness, latest_scan: latestScan,
    status: !latestScan ? "never" : latestScan.ok == null && !latestScan.finished_at ? "scanning" :
      !current.freshness.last_successful_scan ? "never" : !latestScan.ok ? "latest_scan_failed" :
        Date.now() - new Date(current.freshness.last_successful_scan.finished_at).getTime() > 24 * 3600_000 ? "stale" :
          Number(current.freshness.window_coverage_ms ?? 0) < effectiveTo - effectiveFrom ? "partial" : "current",
    data_source: "Splunk production index", environment: "production", latest_observation_at: current.freshness.latest_observation_at ?? null,
  };
  const remediation = {
    ...current.remediation, fixes_verified: current.remediation.verified_runs,
    merged_prs: null, merged_prs_available: false, resolution_inferred_from_agent: false
  };
  const trend = current.trend;
  const previousTrend = previous.trend.map((r: any) => ({ ...r, bucket: new Date(new Date(r.bucket).getTime() + rangeMs).toISOString(), period: "previous" }));
  return {
    summary: {
      ...summary, new_errors: summary.new_incidents, resolved: summary.resolved_incidents,
      unresolved: summary.active_incidents, recurring: summary.recurring_incidents
    },
    trend, previousTrend, serviceTrends: current.serviceTrends, severity: current.severity.map((s: any) => ({ ...s, incidents: s.fingerprints })),
    services: services.map((s: any) => ({ ...s, error_share_pct: denom > 0 ? Number(s.events) * 100 / Number(denom) : null })),
    lifecycle: { statuses: ["open", "acknowledged", "resolved"].map((status) => ({ status, incidents: lifecycleMap.get(status) ?? 0 })), recurring_incidents: current.summary.recurring_incidents, reopened_incidents: lifecycleMap.get("reopened") ?? 0 },
    details: current.details, topFingerprints: current.topFingerprints, remediation, freshness,
    filters: { namespace: f.namespace, severity: f.severity, incident_status: f.incidentStatus },
    range: { from: new Date(effectiveFrom).toISOString(), to: new Date(effectiveTo).toISOString() },
    data_window: { from: new Date(effectiveFrom).toISOString(), to: new Date(effectiveTo).toISOString(), timezone: f.timezone },
    semantics: { event_count: "sum of deduplicated observed hourly counts; partial or unavailable history remains null", service_identity: "namespace + service; unknown attribution is retained", error_share: "service observed events / all observed events in the same scope excluding the service selector; not a request failure rate", comparison: "immediately previous equal-duration half-open range with same remaining filters", lifecycle: "mutually exclusive explicit operator statuses; recurring is separate", remediation: "linked workflow evidence; PR creation is not production resolution", merged_prs: "unavailable in the current schema" },
    source: "shared_splunk_scans", trend_source: "widest_scan_per_fingerprint_hour", lifecycle_source: "explicit_operator_status",
  };
}

export async function healthServiceAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  if (!f.service || !f.namespace) throw new HttpError(400, "service and namespace are required");
  const result = await healthAnalytics(f, scope);
  const service = result.services.find((s: any) => s.service === f.service && (!f.namespace || s.namespace === f.namespace));
  return { ...result, service: service ?? null, services: service ? [service] : [], service_detail: true };
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
