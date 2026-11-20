package analytics

import "strings"

// healthShape selects which parts of the production health statement are built.
//
//	pair         current and the immediately previous equal-width period in one statement ($19,$20).
//	details      severity, service trends, lifecycle, incident page, top fingerprints and remediation.
//	engineering  provider/model/user/workflow/repository filters gate incidents on the run cohort.
//	split        a service is selected: incidents are built once for every service; the selected service's rows
//	             are flagged in_scope. The service table and its error-share denominator use all services, the
//	             rest uses in_scope rows. TypeScript runs this as two statements over the same scans.
type healthShape struct {
	pair, details, engineering, split bool
}

func engineeringFilters(f *Filters) bool {
	return f.Provider != nil || f.Model != nil || f.User != nil || f.Workflow != nil || f.Repository != nil
}

func healthFrom(s healthShape) string {
	runGate := ""
	if s.engineering {
		runGate = `AND (($7::text IS NULL AND $8::text IS NULL AND $9::bigint IS NULL AND $10::text IS NULL AND $11::text IS NULL)
   OR EXISTS(SELECT 1 FROM runs r WHERE r.work_item_id=g.work_item_id))`
	}
	bounds := `bounds AS (SELECT $4::text AS bucket,
 CASE WHEN length($1::text)=10 THEN $1::timestamp AT TIME ZONE $3 ELSE $1::timestamptz END AS lo,
 CASE WHEN length($2::text)=10 THEN $2::timestamp AT TIME ZONE $3 ELSE $2::timestamptz END AS hi`
	periods := `periods AS (SELECT 'current'::text AS period, lo, hi FROM bounds)`
	if s.pair {
		bounds += `,
 CASE WHEN length($19::text)=10 THEN $19::timestamp AT TIME ZONE $3 ELSE $19::timestamptz END AS prev_lo,
 CASE WHEN length($20::text)=10 THEN $20::timestamp AT TIME ZONE $3 ELSE $20::timestamptz END AS prev_hi`
		periods = `periods AS (
 SELECT 'current'::text AS period, lo, hi FROM bounds
 UNION ALL SELECT 'previous'::text, prev_lo, prev_hi FROM bounds)`
	}
	bounds += ")"
	head := "WITH " + bounds
	if s.engineering {
		head = executionCTE(s.details)
	}
	serviceFilter := `AND ($13::text IS NULL OR COALESCE(NULLIF(g.service,''),'unknown')=$13)`
	inScope := `true AS in_scope`
	if s.split {
		serviceFilter = ""
		inScope = `($13::text IS NULL OR COALESCE(NULLIF(g.service,''),'unknown')=$13) AS in_scope`
	}
	// Without a split the scoped sets are the sets themselves: names are substituted (scopedNames) instead of adding
	// pass-through CTEs, which PostgreSQL would materialize again with even worse row estimates.
	scoped := ""
	if s.split {
		scoped = `,
scoped_incidents AS MATERIALIZED (SELECT * FROM incidents WHERE in_scope),
scoped_hours AS MATERIALIZED (SELECT * FROM hours WHERE in_scope)`
	}
	return head + `,
` + periods + `,
visible_groups AS MATERIALIZED (
 SELECT g.fingerprint,g.namespace,g.service,g.signature,g.severity,g.status,g.lifecycle_status,g.first_seen_at,
   g.acknowledged_at,g.resolved_at,g.work_item_id,g.day,g.today_count,g.yesterday_count,g.first_at,g.last_at,g.last_scan_id,
   CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.id END AS visible_work_item_id,
   CASE WHEN w.owner_id IS NOT NULL AND ($6::boolean OR w.owner_id=$5) THEN w.code END AS work_item_code,
   COALESCE(NULLIF(g.namespace,''),'unknown') AS service_namespace,COALESCE(NULLIF(g.service,''),'unknown') AS service_name,
   ` + inScope + `
 FROM prod_error_groups g LEFT JOIN work_items w ON w.id=g.work_item_id
 WHERE true ` + serviceFilter + `
 AND ($12::text IS NULL OR ($14::jsonb->>g.namespace)=$12 OR (w.project=$12 AND w.owner_id IS NOT NULL AND ($6 OR w.owner_id=$5)))
 AND ($15::text IS NULL OR COALESCE(NULLIF(lower(g.severity),''),'unknown')=$15)
 AND ($17::text IS NULL OR COALESCE(NULLIF(g.namespace,''),'unknown')=$17)
 AND ($18::text IS NULL OR $18='production')
 ` + runGate + `
 AND ($7::text IS NULL OR $7::text IS NOT NULL) AND ($8::text IS NULL OR $8::text IS NOT NULL)
 AND ($9::bigint IS NULL OR $9::bigint IS NOT NULL) AND ($10::text IS NULL OR $10::text IS NOT NULL)
 AND ($11::text IS NULL OR $11::text IS NOT NULL) AND ($13::text IS NULL OR $13::text IS NOT NULL)
),
observations AS MATERIALIZED (
 SELECT o.scan_id,o.fingerprint,o.event_count,o.baseline_count,o.first_at,o.last_at,o.severity,o.hourly,
   s.window_start,s.window_end,p.period,p.lo AS period_lo,p.hi AS period_hi,g.service_namespace,g.service_name,g.in_scope
 FROM prod_error_observations o
 JOIN prod_error_scans s ON s.id=o.scan_id
 JOIN visible_groups g ON g.fingerprint=o.fingerprint
 JOIN periods p ON s.window_start<p.hi AND s.window_end>p.lo
 WHERE s.ok
 UNION ALL
 SELECT COALESCE(g.last_scan_id,0),g.fingerprint,g.today_count,g.yesterday_count,g.first_at,g.last_at,g.severity,'[]'::jsonb,
   g.day::timestamp AT TIME ZONE $3,(g.day+1)::timestamp AT TIME ZONE $3,p.period,p.lo,p.hi,g.service_namespace,g.service_name,g.in_scope
 FROM visible_groups g
 JOIN periods p ON g.day::timestamp AT TIME ZONE $3<p.hi AND (g.day+1)::timestamp AT TIME ZONE $3>p.lo
 WHERE NOT EXISTS(SELECT 1 FROM prod_error_observations o WHERE o.fingerprint=g.fingerprint)
),
hour_candidates AS (
 SELECT o.period,o.fingerprint,o.service_namespace,o.service_name,o.in_scope,(h->>'hour')::timestamptz AS hour,(h->>'count')::bigint AS events,o.scan_id,
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
)` + scoped
}

// healthSQL is the production health statement for one shape (TypeScript healthSet).
func healthSQL(f *Filters, s healthShape) string {
	page := f.pagination()
	linkedRuns := ""
	if s.details && !s.engineering {
		linkedRuns = `,
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
   AND r.work_item_id IN (SELECT visible_work_item_id FROM scoped_incidents WHERE period='current' AND visible_work_item_id IS NOT NULL)
)`
	}
	detailCTEs := ""
	if s.details {
		detailCTEs = `,
severity AS (
 SELECT COALESCE(NULLIF(lower(observed_severity),''),'unknown') AS severity,count(*)::int AS fingerprints,sum(events) AS events
 FROM scoped_incidents WHERE period='current' GROUP BY 1
),
service_trends AS (
 -- TypeScript joins hours to incidents here. Both are CTEs with row estimates far below reality, so PostgreSQL
 -- nests a full scan of hours inside every incident (quadratic: 2.7 s of a 3 s dashboard on 1,500 groups). Hours
 -- carry their group's service (and split scope) from observations, and an hour belongs to a current incident unless the incident
 -- status filter removed it: that check is an uncorrelated IN under OR, a hashed subplan, so the trend is linear.
 SELECT ` + bucketSQL("h.hour") + ` AS bucket,h.service_namespace AS namespace,h.service_name AS service,
   sum(h.events) AS events
 FROM scoped_hours h
 WHERE h.period='current' AND (h.service_namespace,h.service_name) IN (
   SELECT COALESCE(NULLIF(namespace,''),'unknown'),COALESCE(NULLIF(service,''),'unknown')
   FROM scoped_incidents WHERE period='current' GROUP BY 1,2 ORDER BY sum(events) DESC NULLS LAST,1,2 LIMIT 5
 )
 AND ($16::text IS NULL OR h.fingerprint IN (SELECT fingerprint FROM scoped_incidents WHERE period='current'))
 GROUP BY 1,2,3
),
lifecycle AS (
 SELECT lifecycle_status AS status,count(*)::int AS incidents FROM scoped_incidents WHERE period='current' GROUP BY lifecycle_status
 UNION ALL
 SELECT 'reopened',count(*)::int FROM scoped_incidents i WHERE i.period='current' AND EXISTS(
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
   FROM scoped_incidents g WHERE g.period='current' ORDER BY g.recurring DESC,g.events DESC NULLS LAST,g.fingerprint ` + page + `
 ) paged LEFT JOIN LATERAL (
   SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'verified',r.verified,'changes',r.summary->'changes',
     'pull_requests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('url',p.url,'repo',p.repo,'title',p.title) ORDER BY p.id),'[]'::jsonb) FROM pull_requests p WHERE p.run_id=r.id))) AS runs
   FROM (SELECT * FROM runs WHERE work_item_id=paged.work_item_id ORDER BY id DESC LIMIT 5) r
 ) links ON true
),
top_rows AS (
 SELECT fingerprint,namespace,COALESCE(NULLIF(service,''),'unknown') AS service,signature,observed_severity AS severity,
   events,recurring,observed_first_at AS first_at,observed_last_at AS last_at,visible_work_item_id AS work_item_id,work_item_code
 FROM scoped_incidents WHERE period='current' ORDER BY events DESC NULLS LAST,fingerprint LIMIT 10
),
remediation AS (
 SELECT count(*) FILTER(WHERE visible_work_item_id IS NOT NULL)::int AS linked_incidents,
   count(DISTINCT visible_work_item_id) FILTER(WHERE visible_work_item_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs r WHERE r.work_item_id=i.visible_work_item_id))::int AS work_items_with_runs,
   count(DISTINCT r.id) FILTER(WHERE r.status='COMPLETED')::int AS completed_runs,
   count(DISTINCT r.id) FILTER(WHERE r.verified IS TRUE)::int AS verified_runs,
   count(DISTINCT p.id) FILTER(WHERE p.created IS TRUE)::int AS prs_created
 FROM scoped_incidents i LEFT JOIN runs r ON r.work_item_id=i.visible_work_item_id
 LEFT JOIN pull_requests p ON (p.run_id=r.id OR p.work_item_id=i.visible_work_item_id)
 WHERE i.period='current'
)`
	}
	openTotals := ""
	if s.split {
		openTotals = `,
open_totals AS (
 SELECT p.period,s.total_errors FROM periods p CROSS JOIN LATERAL (
  SELECT CASE WHEN EXISTS(SELECT 1 FROM prod_error_scans sc WHERE sc.ok AND sc.window_start<p.hi AND sc.window_end>p.lo)
    THEN CASE WHEN count(*)=0 THEN 0 ELSE sum(i.events) END ELSE NULL END AS total_errors
  FROM incidents i WHERE i.period=p.period) s
)`
	}
	var sel strings.Builder
	sel.WriteString(`
SELECT
 (SELECT to_jsonb(s) - 'period' FROM summary s WHERE s.period='current') AS summary,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.bucket) FROM trend x WHERE x.period='current'),'[]'::jsonb) AS trend,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.events DESC NULLS LAST,x.namespace,x.service) FROM services x WHERE x.period='current'),'[]'::jsonb) AS services,
 (SELECT to_jsonb(f) - 'period' FROM freshness f WHERE f.period='current') AS freshness`)
	if s.details {
		sel.WriteString(`,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('severity',severity,'fingerprints',fingerprints,'events',events) ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END) FROM severity),'[]'::jsonb) AS severity,
 COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.bucket,x.namespace,x.service) FROM service_trends x),'[]'::jsonb) AS service_trends,
 COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY CASE x.status WHEN 'open' THEN 1 WHEN 'acknowledged' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END) FROM lifecycle x),'[]'::jsonb) AS lifecycle,
 COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.recurring DESC,x.events DESC NULLS LAST,x.fingerprint) FROM incident_rows x),'[]'::jsonb) AS details,
 COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.events DESC NULLS LAST,x.fingerprint) FROM top_rows x),'[]'::jsonb) AS top_fingerprints,
 (SELECT to_jsonb(r) FROM remediation r) AS remediation`)
	}
	if s.pair {
		sel.WriteString(`,
 (SELECT to_jsonb(s) - 'period' FROM summary s WHERE s.period='previous') AS previous_summary,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.bucket) FROM trend x WHERE x.period='previous'),'[]'::jsonb) AS previous_trend,
 COALESCE((SELECT jsonb_agg((to_jsonb(x) - 'period') ORDER BY x.events DESC NULLS LAST,x.namespace,x.service) FROM services x WHERE x.period='previous'),'[]'::jsonb) AS previous_services,
 (SELECT to_jsonb(f) - 'period' FROM freshness f WHERE f.period='previous') AS previous_freshness`)
	}
	if s.split {
		sel.WriteString(`,
 (SELECT total_errors FROM open_totals WHERE period='current') AS open_total_errors`)
	}
	// The service table covers every service when split; otherwise the scope is already the selected one.
	serviceSource := "scoped_incidents"
	if s.split {
		serviceSource = "incidents"
	}
	return scopedNames(s, healthFrom(s)+`,
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
   (SELECT count(*)::int FROM scoped_hours h WHERE h.period=p.period AND h.covered<interval '1 hour') AS partial_hours
  FROM scoped_incidents i WHERE i.period=p.period
 ) s
),
trend AS (
 SELECT h.period,`+bucketSQL("h.hour")+` AS bucket,sum(h.events) AS events,count(DISTINCT h.fingerprint)::int AS fingerprints
 FROM scoped_hours h GROUP BY 1,2
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
  FROM `+serviceSource+` i JOIN periods p ON p.period=i.period GROUP BY 1,2,3
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
)`+linkedRuns+detailCTEs+openTotals+sel.String())
}

func scopedNames(s healthShape, sql string) string {
	if s.split {
		return sql
	}
	return strings.NewReplacer("scoped_incidents", "incidents", "scoped_hours", "hours").Replace(sql)
}
