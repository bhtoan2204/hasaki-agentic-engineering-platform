import { pool, q, one, withTx } from "../../db/pool.ts";
import { config } from "../../config.ts";
import { HttpError } from "../../http/error.ts";
import { requireAdmin, type Actor } from "../../authz/access.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";
import { bucketSql, filterParams, type AnalyticsFilters, type AnalyticsScope } from "./filters.ts";
import { executionCte } from "./execution.ts";

/** Provider, model, user, workflow, and repository filters are the only reason health looks at workflow runs. */
function engineeringFilters(f: AnalyticsFilters) {
  return (
    f.provider != null ||
    f.model != null ||
    f.user != null ||
    f.workflow != null ||
    f.repository != null
  );
}

function healthFrom(f: AnalyticsFilters, pair = false) {
  const engineering = engineeringFilters(f);
  const runGate = engineering
    ? `AND (($7::text IS NULL AND $8::text IS NULL AND $9::bigint IS NULL AND $10::text IS NULL AND $11::text IS NULL)
   OR EXISTS(SELECT 1 FROM runs r WHERE r.work_item_id=g.work_item_id))`
    : "";
  const bounds = `bounds AS (SELECT $4::text AS bucket,
 CASE WHEN length($1::text)=10 THEN $1::timestamp AT TIME ZONE $3 ELSE $1::timestamptz END AS lo,
 CASE WHEN length($2::text)=10 THEN $2::timestamp AT TIME ZONE $3 ELSE $2::timestamptz END AS hi${
   pair
     ? `,
 CASE WHEN length($19::text)=10 THEN $19::timestamp AT TIME ZONE $3 ELSE $19::timestamptz END AS prev_lo,
 CASE WHEN length($20::text)=10 THEN $20::timestamp AT TIME ZONE $3 ELSE $20::timestamptz END AS prev_hi`
     : ""
 })`;
  const periods = pair
    ? `periods AS (
 SELECT 'current'::text AS period, lo, hi FROM bounds
 UNION ALL SELECT 'previous'::text, prev_lo, prev_hi FROM bounds)`
    : `periods AS (SELECT 'current'::text AS period, lo, hi FROM bounds)`;
  return `${engineering ? executionCte : `WITH ${bounds}`},
${periods},
visible_groups AS MATERIALIZED (
 SELECT g.*, CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.id END AS visible_work_item_id,
   CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.code END AS work_item_code
 FROM prod_error_groups g LEFT JOIN work_items w ON w.id=g.work_item_id
 WHERE ($13::text IS NULL OR COALESCE(NULLIF(g.service,''),'unknown')=$13)
 AND ($12::text IS NULL OR ($14::jsonb->>g.namespace)=$12 OR (w.project=$12 AND w.owner_id IS NOT NULL AND ($6 OR w.owner_id=$5)))
 AND ($15::text IS NULL OR COALESCE(NULLIF(lower(g.severity),''),'unknown')=$15)
 AND ($17::text IS NULL OR COALESCE(NULLIF(g.namespace,''),'unknown')=$17)
 AND ($18::text IS NULL OR $18='production')
 ${runGate}
 -- Bound parameters stay typed when this request does not filter on them.
 AND ($7::text IS NULL OR $7::text IS NOT NULL) AND ($8::text IS NULL OR $8::text IS NOT NULL)
 AND ($9::bigint IS NULL OR $9::bigint IS NOT NULL) AND ($10::text IS NULL OR $10::text IS NOT NULL)
 AND ($11::text IS NULL OR $11::text IS NOT NULL)
),
observations AS MATERIALIZED (
 SELECT o.scan_id,o.fingerprint,o.event_count,o.baseline_count,o.first_at,o.last_at,o.severity,o.hourly,
   s.window_start,s.window_end,p.period,p.lo AS period_lo,p.hi AS period_hi
 FROM prod_error_observations o
 JOIN prod_error_scans s ON s.id=o.scan_id
 JOIN visible_groups g ON g.fingerprint=o.fingerprint
 JOIN periods p ON s.window_start<p.hi AND s.window_end>p.lo
 WHERE s.ok
 UNION ALL
 SELECT COALESCE(g.last_scan_id,0),g.fingerprint,g.today_count,g.yesterday_count,g.first_at,g.last_at,g.severity,'[]'::jsonb,
   g.day::timestamp AT TIME ZONE $3,(g.day+1)::timestamp AT TIME ZONE $3,p.period,p.lo,p.hi
 FROM visible_groups g
 JOIN periods p ON g.day::timestamp AT TIME ZONE $3<p.hi AND (g.day+1)::timestamp AT TIME ZONE $3>p.lo
 WHERE NOT EXISTS(SELECT 1 FROM prod_error_observations o WHERE o.fingerprint=g.fingerprint)
),
hour_candidates AS (
 SELECT o.period,o.fingerprint,(h->>'hour')::timestamptz AS hour,(h->>'count')::bigint AS events,o.scan_id,
   least(o.window_end,(h->>'hour')::timestamptz+interval '1 hour')-greatest(o.window_start,(h->>'hour')::timestamptz) AS covered
 FROM observations o CROSS JOIN LATERAL jsonb_array_elements(o.hourly) h
 WHERE (h->>'hour')::timestamptz>=o.period_lo AND (h->>'hour')::timestamptz+interval '1 hour'<=o.period_hi
),
hours AS MATERIALIZED (
 SELECT DISTINCT ON(period,fingerprint,hour) * FROM hour_candidates ORDER BY period,fingerprint,hour,covered DESC,scan_id DESC
),
hour_totals AS (
 SELECT period,fingerprint,sum(events) AS events FROM hours GROUP BY period,fingerprint
),
obs_stats AS (
 SELECT o.period,o.fingerprint,
   (array_agg(o.event_count ORDER BY o.window_end DESC,o.scan_id DESC) FILTER(WHERE o.window_start>=o.period_lo AND o.window_end<=o.period_hi))[1] AS snapshot_events,
   (array_agg(o.severity ORDER BY o.window_end DESC,o.scan_id DESC))[1] AS severity,
   min(o.first_at) AS first_at,max(o.last_at) AS last_at,
   bool_or(o.baseline_count>0) OR count(DISTINCT (o.window_start AT TIME ZONE $3)::date)>1 AS recurring,
   count(*)::int AS snapshots,count(*) FILTER(WHERE jsonb_array_length(o.hourly)=0)::int AS missing_hourly
 FROM observations o GROUP BY o.period,o.fingerprint
),
incidents AS MATERIALIZED (
 SELECT g.*,s.period,COALESCE(h.events,s.snapshot_events) AS events,s.severity AS observed_severity,
   s.first_at AS observed_first_at,s.last_at AS observed_last_at,s.recurring,s.snapshots,s.missing_hourly,
   CASE WHEN g.acknowledged_at>=g.first_seen_at THEN extract(epoch FROM(g.acknowledged_at-g.first_seen_at))*1000 END AS acknowledge_ms,
   CASE WHEN g.resolved_at>=g.first_seen_at THEN extract(epoch FROM(g.resolved_at-g.first_seen_at))*1000 END AS resolve_ms
 FROM visible_groups g
 JOIN obs_stats s ON s.fingerprint=g.fingerprint
 LEFT JOIN hour_totals h ON h.fingerprint=g.fingerprint AND h.period=s.period
 WHERE ($16::text IS NULL OR ($16='recurring' AND s.recurring) OR ($16<>'recurring' AND g.lifecycle_status=$16))
)`;
}

const projectMap = () =>
  JSON.stringify(
    Object.fromEntries(config.prodErrors.namespaces.map((n) => [n.namespace, n.project])),
  );
function paramsFor(f: AnalyticsFilters, scope: AnalyticsScope) {
  return [
    ...filterParams(f, scope),
    projectMap(),
    f.severity,
    f.incidentStatus,
    f.namespace,
    f.environment,
  ];
}
function boundaryInstant(value: string, timezone: string) {
  if (value.length !== 10) return Date.parse(value);
  const target = Date.parse(`${value}T00:00:00Z`);
  let candidate = target;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(candidate)).map((x) => [x.type, x.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const delta = target - represented;
    candidate += delta;
    if (!delta) break;
  }
  return candidate;
}
function previousPeriod(f: AnalyticsFilters): AnalyticsFilters {
  const lo = boundaryInstant(f.from, f.timezone),
    hi = boundaryInstant(f.to, f.timezone),
    width = hi - lo;
  return { ...f, from: new Date(lo - width).toISOString(), to: new Date(lo).toISOString() };
}

type HealthParts = {
  summary: any;
  trend: any[];
  severity: any[];
  serviceTrends: any[];
  services: any[];
  lifecycle: any[];
  details: any[];
  topFingerprints: any[];
  remediation: any;
  freshness: any;
};
type HealthPair = { current: HealthParts; previous: HealthParts };

async function healthSet(
  f: AnalyticsFilters,
  scope: AnalyticsScope,
  includeDetails: boolean,
  pair: true,
): Promise<HealthPair>;
async function healthSet(
  f: AnalyticsFilters,
  scope: AnalyticsScope,
  includeDetails?: boolean,
  pair?: false,
): Promise<HealthParts>;
async function healthSet(
  f: AnalyticsFilters,
  scope: AnalyticsScope,
  includeDetails = true,
  pair: boolean = false,
): Promise<HealthParts | HealthPair> {
  const params = paramsFor(f, scope);
  if (pair) {
    const prev = previousPeriod(f);
    params.push(prev.from, prev.to);
  }
  const page = `LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
  const linkedRuns =
    includeDetails && !engineeringFilters(f)
      ? `,
runs AS (
 SELECT r.id,r.work_item_id,r.status,r.summary,
   CASE WHEN v.coding_steps>0 AND v.checked_steps=v.coding_steps THEN v.passed_steps=v.coding_steps END AS verified
 FROM workflow_runs r CROSS JOIN bounds b
 LEFT JOIN LATERAL (
   SELECT count(*)::int AS coding_steps,
     count(*) FILTER (WHERE a.metrics->'verification'->>'passed' IN ('true','false') OR a.metrics->'independent_verification'->>'verdict' IN ('PASS','FAIL'))::int AS checked_steps,
     count(*) FILTER (WHERE a.metrics->'verification'->>'passed'='true' OR a.metrics->'independent_verification'->>'verdict'='PASS')::int AS passed_steps
   FROM workflow_steps s LEFT JOIN LATERAL (
     SELECT a.metrics FROM workflow_step_attempts a WHERE a.step_id=s.id AND a.invalidated_at IS NULL ORDER BY a.id DESC LIMIT 1
   ) a ON true WHERE s.run_id=r.id AND s.type='coding_agent'
 ) v ON true
 WHERE r.created_at>=b.lo AND r.created_at<b.hi AND r.owner_id IS NOT NULL AND ($6::boolean OR r.owner_id=$5::bigint)
   AND r.work_item_id IN (SELECT visible_work_item_id FROM incidents WHERE period='current' AND visible_work_item_id IS NOT NULL)
)`
      : "";
  const detailCtes = includeDetails
    ? `,
severity AS (
 SELECT COALESCE(NULLIF(lower(observed_severity),''),'unknown') AS severity,count(*)::int AS fingerprints,sum(events) AS events
 FROM incidents WHERE period='current' GROUP BY 1
),
service_trends AS (
 SELECT ${bucketSql("h.hour")} AS bucket,COALESCE(NULLIF(i.namespace,''),'unknown') AS namespace,
   COALESCE(NULLIF(i.service,''),'unknown') AS service,sum(h.events) AS events
 FROM hours h JOIN incidents i ON i.fingerprint=h.fingerprint AND i.period=h.period AND i.period='current'
 WHERE (COALESCE(NULLIF(i.namespace,''),'unknown'),COALESCE(NULLIF(i.service,''),'unknown')) IN (
   SELECT COALESCE(NULLIF(namespace,''),'unknown'),COALESCE(NULLIF(service,''),'unknown')
   FROM incidents WHERE period='current' GROUP BY 1,2 ORDER BY sum(events) DESC NULLS LAST,1,2 LIMIT 5
 )
 GROUP BY 1,2,3
),
lifecycle AS (
 SELECT lifecycle_status AS status,count(*)::int AS incidents FROM incidents WHERE period='current' GROUP BY lifecycle_status
 UNION ALL
 SELECT 'reopened',count(*)::int FROM incidents i WHERE i.period='current' AND EXISTS(
   SELECT 1 FROM prod_error_lifecycle_events e WHERE e.fingerprint=i.fingerprint AND e.action='reopen'
   AND e.id=(SELECT max(e2.id) FROM prod_error_lifecycle_events e2 WHERE e2.fingerprint=i.fingerprint)
 )
),
incident_rows AS (
 SELECT paged.*,COALESCE(links.runs,'[]'::jsonb) AS runs
 FROM (
   SELECT g.fingerprint,g.namespace,COALESCE(NULLIF(g.service,''),'unknown') AS service,g.signature,g.observed_severity AS severity,g.lifecycle_status,g.status AS triage_status,
     g.events,g.recurring,g.first_seen_at,g.observed_first_at AS first_at,g.observed_last_at AS last_at,g.acknowledged_at,g.resolved_at,
     g.visible_work_item_id AS work_item_id,g.work_item_code,g.missing_hourly,
     (SELECT COALESCE(jsonb_agg(e),'[]') FROM (SELECT action,evidence,created_at FROM prod_error_lifecycle_events WHERE fingerprint=g.fingerprint ORDER BY id DESC LIMIT 3) e) AS lifecycle_events,
     count(*) OVER()::int AS total_rows
   FROM incidents g WHERE g.period='current' ORDER BY g.recurring DESC,g.events DESC NULLS LAST,g.fingerprint ${page}
 ) paged LEFT JOIN LATERAL (
   SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'verified',r.verified,'changes',r.summary->'changes',
     'pull_requests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('url',p.url,'repo',p.repo,'title',p.title)),'[]'::jsonb) FROM pull_requests p WHERE p.run_id=r.id))) AS runs
   FROM (SELECT * FROM runs WHERE work_item_id=paged.work_item_id ORDER BY id DESC LIMIT 5) r
 ) links ON true
),
top_rows AS (
 SELECT fingerprint,namespace,COALESCE(NULLIF(service,''),'unknown') AS service,signature,observed_severity AS severity,
   events,recurring,observed_first_at AS first_at,observed_last_at AS last_at,visible_work_item_id AS work_item_id,work_item_code
 FROM incidents WHERE period='current' ORDER BY events DESC NULLS LAST LIMIT 10
),
remediation AS (
 SELECT count(*) FILTER(WHERE visible_work_item_id IS NOT NULL)::int AS linked_incidents,
   count(DISTINCT visible_work_item_id) FILTER(WHERE visible_work_item_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs r WHERE r.work_item_id=incidents.visible_work_item_id))::int AS work_items_with_runs,
   count(DISTINCT r.id) FILTER(WHERE r.status='COMPLETED')::int AS completed_runs,
   count(DISTINCT r.id) FILTER(WHERE r.verified IS TRUE)::int AS verified_runs,
   count(DISTINCT p.id) FILTER(WHERE p.created IS TRUE)::int AS prs_created
 FROM incidents LEFT JOIN runs r ON r.work_item_id=incidents.visible_work_item_id
 LEFT JOIN pull_requests p ON (p.run_id=r.id OR p.work_item_id=incidents.visible_work_item_id)
 WHERE incidents.period='current'
)`
    : "";
  const row = await one(
    pool,
    `${healthFrom(f, pair)},
scan_windows AS (
 SELECT p.period,greatest(s.window_start,p.lo) AS lo,least(s.window_end,p.hi) AS hi
 FROM prod_error_scans s JOIN periods p ON s.window_start<p.hi AND s.window_end>p.lo WHERE s.ok
),
ordered_windows AS (
 SELECT period,lo,hi,max(hi) OVER(PARTITION BY period ORDER BY lo,hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_hi
 FROM scan_windows
),
coverage AS (
 SELECT p.period,COALESCE(sum(greatest(extract(epoch FROM(w.hi-greatest(w.lo,COALESCE(w.prior_hi,w.lo)))),0))*1000,0)::bigint AS window_coverage_ms
 FROM periods p LEFT JOIN ordered_windows w ON w.period=p.period GROUP BY p.period
),
summary AS (
 SELECT p.period,s.* FROM periods p CROSS JOIN LATERAL (
  SELECT
   CASE WHEN EXISTS(SELECT 1 FROM prod_error_scans sc WHERE sc.ok AND sc.window_start<p.hi AND sc.window_end>p.lo) THEN CASE WHEN count(*)=0 THEN 0 ELSE sum(i.events) END ELSE NULL END AS total_errors,
   CASE WHEN EXISTS(SELECT 1 FROM prod_error_scans sc WHERE sc.ok AND sc.window_start<p.hi AND sc.window_end>p.lo) THEN count(*)::int ELSE NULL END AS fingerprints,
   count(*) FILTER(WHERE i.first_seen_at>=p.lo AND i.first_seen_at<p.hi)::int AS new_incidents,
   count(*) FILTER(WHERE i.lifecycle_status<>'resolved')::int AS active_incidents,
   count(*) FILTER(WHERE i.lifecycle_status='resolved')::int AS resolved_incidents,
   count(*) FILTER(WHERE i.observed_severity IN ('critical','high'))::int AS critical_high_incidents,
   count(*) FILTER(WHERE i.recurring)::int AS recurring_incidents,
   count(DISTINCT (COALESCE(NULLIF(i.namespace,''),'unknown'),COALESCE(NULLIF(i.service,''),'unknown')))::int AS affected_services,
   avg(i.acknowledge_ms) AS acknowledge_ms, avg(i.resolve_ms) AS resolve_ms,
   count(*) FILTER(WHERE i.acknowledge_ms IS NULL)::int AS missing_acknowledged,
   count(*) FILTER(WHERE i.resolve_ms IS NULL)::int AS missing_resolved,
   sum(i.missing_hourly)::int AS snapshots_missing_hourly,
   (SELECT count(*)::int FROM hours h WHERE h.period=p.period AND h.covered<interval '1 hour') AS partial_hours
  FROM incidents i WHERE i.period=p.period
 ) s
),
trend AS (
 SELECT h.period,${bucketSql("h.hour")} AS bucket,sum(h.events) AS events,count(DISTINCT h.fingerprint)::int AS fingerprints
 FROM hours h GROUP BY 1,2
),
services AS (
 SELECT grouped.*,CASE WHEN sum(events) OVER(PARTITION BY period)>0 THEN events*100.0/sum(events) OVER(PARTITION BY period) END AS error_share_pct FROM (
  SELECT i.period,COALESCE(NULLIF(i.namespace,''),'unknown') AS namespace,COALESCE(NULLIF(i.service,''),'unknown') AS service,
    count(*)::int AS fingerprints,sum(i.events) AS events,
    count(*) FILTER(WHERE i.first_seen_at>=p.lo AND i.first_seen_at<p.hi)::int AS new_incidents,
    count(*) FILTER(WHERE i.lifecycle_status<>'resolved')::int AS unresolved_incidents,
    count(*) FILTER(WHERE i.observed_severity IN ('critical','high'))::int AS critical_high_incidents,
    sum(i.events) FILTER(WHERE i.observed_severity IN ('critical','high')) AS critical_high_errors,
    count(*) FILTER(WHERE i.recurring)::int AS recurring_incidents,max(i.observed_last_at) AS last_observed_error
  FROM incidents i JOIN periods p ON p.period=i.period GROUP BY 1,2,3
 ) grouped
),
global_scans AS (
 SELECT
  (SELECT row_to_json(s) FROM (SELECT id,trigger,started_at,finished_at,ok,error,groups,events,window_start,window_end,namespaces FROM prod_error_scans ORDER BY id DESC LIMIT 1) s) AS latest_scan,
  (SELECT row_to_json(s) FROM (SELECT id,trigger,started_at,finished_at,ok,window_start,window_end,namespaces FROM prod_error_scans WHERE ok ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 1) s) AS last_successful_scan
),
freshness AS (
 SELECT p.period,g.latest_scan,g.last_successful_scan,
  (SELECT max(o.last_at) FROM prod_error_observations o JOIN prod_error_scans s ON s.id=o.scan_id WHERE s.ok AND s.window_start<p.hi AND s.window_end>p.lo) AS latest_observation_at,
  (SELECT count(*)::int FROM prod_error_scans s WHERE s.window_start<p.hi AND s.window_end>p.lo) AS scans_in_range,
  (SELECT count(*)::int FROM prod_error_scans s WHERE s.ok AND s.window_start<p.hi AND s.window_end>p.lo) AS successful_scans_in_range,
  (SELECT count(*)::int FROM prod_error_scans s WHERE s.ok IS FALSE AND s.window_start<p.hi AND s.window_end>p.lo) AS failed_scans_in_range,
  c.window_coverage_ms
 FROM periods p JOIN coverage c ON c.period=p.period CROSS JOIN global_scans g
)
${linkedRuns}
${detailCtes}
SELECT
 (SELECT to_jsonb(s) - 'period' FROM summary s WHERE s.period='current') AS summary,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.bucket) FROM trend x WHERE x.period='current'),'[]'::jsonb) AS trend,
 ${
   includeDetails
     ? `COALESCE((SELECT jsonb_agg(jsonb_build_object('severity',severity,'fingerprints',fingerprints,'events',events) ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END) FROM severity),'[]'::jsonb)`
     : `'[]'::jsonb`
 } AS severity,
 ${
   includeDetails
     ? `COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.bucket,x.namespace,x.service) FROM service_trends x),'[]'::jsonb)`
     : `'[]'::jsonb`
 } AS service_trends,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.events DESC NULLS LAST,x.namespace,x.service) FROM services x WHERE x.period='current'),'[]'::jsonb) AS services,
 ${
   includeDetails
     ? `COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY CASE x.status WHEN 'open' THEN 1 WHEN 'acknowledged' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END) FROM lifecycle x),'[]'::jsonb)`
     : `'[]'::jsonb`
 } AS lifecycle,
 ${
   includeDetails
     ? `COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.recurring DESC,x.events DESC NULLS LAST,x.fingerprint) FROM incident_rows x),'[]'::jsonb)`
     : `'[]'::jsonb`
 } AS details,
 ${
   includeDetails
     ? `COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.events DESC NULLS LAST) FROM top_rows x),'[]'::jsonb)`
     : `'[]'::jsonb`
 } AS top_fingerprints,
 ${includeDetails ? "(SELECT to_jsonb(r) FROM remediation r)" : "NULL::jsonb"} AS remediation,
 (SELECT to_jsonb(f) - 'period' FROM freshness f WHERE f.period='current') AS freshness
 ${
   pair
     ? `,
 (SELECT to_jsonb(s) - 'period' FROM summary s WHERE s.period='previous') AS previous_summary,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.bucket) FROM trend x WHERE x.period='previous'),'[]'::jsonb) AS previous_trend,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.events DESC NULLS LAST,x.namespace,x.service) FROM services x WHERE x.period='previous'),'[]'::jsonb) AS previous_services,
 (SELECT to_jsonb(f) - 'period' FROM freshness f WHERE f.period='previous') AS previous_freshness`
     : ""
 }`,
    params,
  );
  const current = {
    summary: row?.summary,
    trend: row?.trend ?? [],
    severity: row?.severity ?? [],
    serviceTrends: row?.service_trends ?? [],
    services: row?.services ?? [],
    lifecycle: row?.lifecycle ?? [],
    details: row?.details ?? [],
    topFingerprints: row?.top_fingerprints ?? [],
    remediation: row?.remediation ?? null,
    freshness: row?.freshness,
  };
  if (!pair) return current;
  return {
    current,
    previous: {
      summary: row?.previous_summary,
      trend: row?.previous_trend ?? [],
      severity: [],
      serviceTrends: [],
      services: row?.previous_services ?? [],
      lifecycle: [],
      details: [],
      topFingerprints: [],
      remediation: null,
      freshness: row?.previous_freshness,
    },
  };
}

const comparable = (now: any, before: any) => {
  const value = (x: any) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  const current = value(now),
    previous = value(before);
  const delta = current == null || previous == null ? null : current - previous;
  return {
    current,
    previous,
    delta,
    delta_pct:
      delta == null || previous == null || previous === 0 ? null : (delta / previous) * 100,
  };
};
const sameCoverage = (a: any, b: any) =>
  Number(a?.successful_scans_in_range) === Number(b?.successful_scans_in_range) &&
  Number(a?.scans_in_range) === Number(b?.scans_in_range) &&
  Number(a?.failed_scans_in_range) === Number(b?.failed_scans_in_range) &&
  Number(a?.window_coverage_ms) === Number(b?.window_coverage_ms);

export async function healthAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  const prev = previousPeriod(f);
  const serviceScope = { ...f, service: null };
  let current: HealthParts;
  let previous: HealthParts;
  let currentServices: HealthParts | null;
  let previousServices: HealthParts | null;
  if (engineeringFilters(f)) {
    [current, previous, currentServices, previousServices] = await Promise.all([
      healthSet(f, scope, true),
      healthSet(prev, scope, false),
      f.service ? healthSet(serviceScope, scope, false) : Promise.resolve(null),
      f.service ? healthSet({ ...prev, service: null }, scope, false) : Promise.resolve(null),
    ]);
  } else {
    const [scoped, open] = await Promise.all([
      healthSet(f, scope, true, true),
      f.service ? healthSet(serviceScope, scope, false, true) : Promise.resolve(null),
    ]);
    current = scoped.current;
    previous = scoped.previous;
    currentServices = open?.current ?? null;
    previousServices = open?.previous ?? null;
  }
  const markEmptyPartialUnknown = (set: any, period: AnalyticsFilters) => {
    const width =
      boundaryInstant(period.to, period.timezone) - boundaryInstant(period.from, period.timezone);
    if (
      Number(set.summary.total_errors) === 0 &&
      Number(set.freshness.window_coverage_ms ?? 0) < width
    ) {
      for (const key of [
        "total_errors",
        "fingerprints",
        "new_incidents",
        "active_incidents",
        "resolved_incidents",
        "critical_high_incidents",
        "recurring_incidents",
        "affected_services",
      ])
        if (Number(set.summary[key] ?? 0) === 0) set.summary[key] = null;
    }
  };
  markEmptyPartialUnknown(current, f);
  markEmptyPartialUnknown(previous, prev);
  const oldServices = new Map(
    (previousServices ?? previous).services.map((s: any) => [`${s.namespace}\0${s.service}`, s]),
  );
  const serviceCoverageComparable = sameCoverage(
    (currentServices ?? current).freshness,
    (previousServices ?? previous).freshness,
  );
  const services = (currentServices ?? current).services
    .filter((s: any) => !f.service || s.service === f.service)
    .filter((s: any) => !f.namespace || s.namespace === f.namespace)
    .map((s: any) => {
      const old: any = oldServices.get(`${s.namespace}\0${s.service}`);
      return {
        ...s,
        previous_events: old?.events ?? null,
        change_events: serviceCoverageComparable ? comparable(s.events, old?.events).delta : null,
        change_pct: serviceCoverageComparable ? comparable(s.events, old?.events).delta_pct : null,
        change_comparable: serviceCoverageComparable,
        environment: "production",
        service_key: `${s.namespace}\u001f${s.service}`,
      };
    });
  const summary = {
    ...current.summary,
    comparisons: Object.fromEntries([
      ["total_errors", comparable(current.summary.total_errors, previous.summary.total_errors)],
      ["fingerprints", comparable(current.summary.fingerprints, previous.summary.fingerprints)],
      ["new_incidents", comparable(current.summary.new_incidents, previous.summary.new_incidents)],
      [
        "active_incidents",
        comparable(current.summary.active_incidents, previous.summary.active_incidents),
      ],
      [
        "resolved_incidents",
        comparable(current.summary.resolved_incidents, previous.summary.resolved_incidents),
      ],
      [
        "critical_high_incidents",
        comparable(
          current.summary.critical_high_incidents,
          previous.summary.critical_high_incidents,
        ),
      ],
      [
        "recurring_incidents",
        comparable(current.summary.recurring_incidents, previous.summary.recurring_incidents),
      ],
      [
        "affected_services",
        comparable(current.summary.affected_services, previous.summary.affected_services),
      ],
      [
        "acknowledge_ms",
        comparable(current.summary.acknowledge_ms, previous.summary.acknowledge_ms),
      ],
      ["resolve_ms", comparable(current.summary.resolve_ms, previous.summary.resolve_ms)],
    ]),
    previous_coverage: previous.freshness,
    current_coverage: current.freshness,
  };
  const denom = (currentServices ?? current).summary.total_errors;
  const lifecycleMap = new Map(current.lifecycle.map((x: any) => [x.status, x.incidents]));
  const effectiveFrom = boundaryInstant(f.from, f.timezone),
    effectiveTo = boundaryInstant(f.to, f.timezone),
    rangeMs = effectiveTo - effectiveFrom;
  const latestScan = current.freshness.latest_scan
    ? {
        ...current.freshness.latest_scan,
        error: current.freshness.latest_scan.error
          ? safeDiagnostics(String(current.freshness.latest_scan.error))
          : null,
      }
    : null;
  const freshness = {
    ...current.freshness,
    latest_scan: latestScan,
    status: !latestScan
      ? "never"
      : latestScan.ok == null && !latestScan.finished_at
        ? "scanning"
        : !current.freshness.last_successful_scan
          ? "never"
          : !latestScan.ok
            ? "latest_scan_failed"
            : Date.now() - new Date(current.freshness.last_successful_scan.finished_at).getTime() >
                24 * 3600_000
              ? "stale"
              : Number(current.freshness.window_coverage_ms ?? 0) < effectiveTo - effectiveFrom
                ? "partial"
                : "current",
    data_source: "Splunk production index",
    environment: "production",
    latest_observation_at: current.freshness.latest_observation_at ?? null,
  };
  const remediation = {
    ...current.remediation,
    fixes_verified: current.remediation.verified_runs,
    merged_prs: null,
    merged_prs_available: false,
    resolution_inferred_from_agent: false,
  };
  const trend = current.trend;
  const previousTrend = previous.trend.map((r: any) => ({
    ...r,
    bucket: new Date(new Date(r.bucket).getTime() + rangeMs).toISOString(),
    period: "previous",
  }));
  return {
    summary: {
      ...summary,
      new_errors: summary.new_incidents,
      resolved: summary.resolved_incidents,
      unresolved: summary.active_incidents,
      recurring: summary.recurring_incidents,
    },
    trend,
    previousTrend,
    serviceTrends: current.serviceTrends,
    severity: current.severity.map((s: any) => ({ ...s, incidents: s.fingerprints })),
    services: services.map((s: any) => ({
      ...s,
      error_share_pct: denom > 0 ? (Number(s.events) * 100) / Number(denom) : null,
    })),
    lifecycle: {
      statuses: ["open", "acknowledged", "resolved"].map((status) => ({
        status,
        incidents: lifecycleMap.get(status) ?? 0,
      })),
      recurring_incidents: current.summary.recurring_incidents,
      reopened_incidents: lifecycleMap.get("reopened") ?? 0,
    },
    details: current.details,
    topFingerprints: current.topFingerprints,
    remediation,
    freshness,
    filters: { namespace: f.namespace, severity: f.severity, incident_status: f.incidentStatus },
    range: { from: new Date(effectiveFrom).toISOString(), to: new Date(effectiveTo).toISOString() },
    data_window: {
      from: new Date(effectiveFrom).toISOString(),
      to: new Date(effectiveTo).toISOString(),
      timezone: f.timezone,
    },
    semantics: {
      event_count:
        "sum of deduplicated observed hourly counts; partial or unavailable history remains null",
      service_identity: "namespace + service; unknown attribution is retained",
      error_share:
        "service observed events / all observed events in the same scope excluding the service selector; not a request failure rate",
      comparison: "immediately previous equal-duration half-open range with same remaining filters",
      lifecycle: "mutually exclusive explicit operator statuses; recurring is separate",
      remediation: "linked workflow evidence; PR creation is not production resolution",
      merged_prs: "unavailable in the current schema",
    },
    source: "shared_splunk_scans",
    trend_source: "widest_scan_per_fingerprint_hour",
    lifecycle_source: "explicit_operator_status",
  };
}

export async function healthServiceAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  if (!f.service || !f.namespace) throw new HttpError(400, "service and namespace are required");
  const result = await healthAnalytics(f, scope);
  const service = result.services.find(
    (s: any) => s.service === f.service && (!f.namespace || s.namespace === f.namespace),
  );
  return {
    ...result,
    service: service ?? null,
    services: service ? [service] : [],
    service_detail: true,
  };
}

/** Operator evidence is an explicit supported resolution status, never an agent's completion claim. */
export async function updateIncidentLifecycle(actor: Actor, fingerprint: string, body: any) {
  requireAdmin(actor);
  const action = body.action;
  if (!["acknowledge", "resolve", "reopen"].includes(action))
    throw new HttpError(400, "Invalid lifecycle action");
  const evidence = safeDiagnostics(String(body.evidence ?? "").trim());
  if (action === "resolve" && evidence.length < 8)
    throw new HttpError(
      400,
      "Resolution requires an evidence reference or explanation (8–4000 characters)",
    );
  return withTx(async (c) => {
    const g = await one(c, "SELECT * FROM prod_error_groups WHERE fingerprint=$1 FOR UPDATE", [
      fingerprint,
    ]);
    if (!g) throw new HttpError(404, "Incident not found");
    const next =
      action === "resolve" ? "resolved" : action === "acknowledge" ? "acknowledged" : "open";
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
    await q(
      c,
      "INSERT INTO prod_error_lifecycle_events(fingerprint,action,actor_id,evidence) VALUES($1,$2,$3,$4)",
      [fingerprint, action, actor.id, evidence],
    );
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,$2,'prod_error',$3,$4)",
      [actor.id, `incident.${action}`, fingerprint, JSON.stringify({ evidence })],
    );
    return { ok: true, status: next };
  });
}
