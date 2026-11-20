package analytics

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
)

// healthParts is one period's production health (TypeScript HealthParts), decoded where composition reads it and
// kept as raw JSON where it is only passed through.
type healthParts struct {
	summary        map[string]any
	trend          []map[string]any
	services       []map[string]any
	freshness      map[string]any
	severity       []map[string]any
	serviceTrends  json.RawMessage
	lifecycle      []map[string]any
	details        json.RawMessage
	topFingerprint json.RawMessage
	remediation    map[string]any
	// openTotalErrors is the all-services total when a split statement computed it.
	openTotalErrors any
}

func decode(raw any, into any) error {
	b, ok := raw.(json.RawMessage)
	if !ok || b == nil {
		return nil
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(into)
}

func (r *Request) healthParams(f *Filters, prev *[2]string) []any {
	m := make(Object, 0, len(r.ProdNamespaces))
	for _, n := range r.ProdNamespaces {
		m = append(m, Field{n.Namespace, n.Project})
	}
	projects, _ := json.Marshal(m)
	req := Request{Scope: r.Scope, Filters: *f}
	params := append(req.executionParams(), string(projects), f.Severity, f.IncidentStatus, f.Namespace, f.Environment)
	if prev != nil {
		params = append(params, prev[0], prev[1])
	}
	return params
}

// healthSet runs one health statement. With pair it returns current and previous; previous has no details.
func (s *Service) healthSet(ctx context.Context, r *Request, f *Filters, shape healthShape) (cur, prev healthParts, err error) {
	var prevBounds *[2]string
	if shape.pair {
		p := previousPeriod(f)
		prevBounds = &[2]string{p.From, p.To}
	}
	row, err := s.one(ctx, healthSQL(f, shape), r.healthParams(f, prevBounds)...)
	if err != nil {
		return cur, prev, err
	}
	for _, d := range []struct {
		col  string
		into any
	}{
		{"summary", &cur.summary}, {"trend", &cur.trend}, {"services", &cur.services}, {"freshness", &cur.freshness},
		{"severity", &cur.severity}, {"lifecycle", &cur.lifecycle}, {"remediation", &cur.remediation},
		{"previous_summary", &prev.summary}, {"previous_trend", &prev.trend},
		{"previous_services", &prev.services}, {"previous_freshness", &prev.freshness},
	} {
		if err := decode(row.Get(d.col), d.into); err != nil {
			return cur, prev, fmt.Errorf("decode %s: %w", d.col, err)
		}
	}
	raw := func(col string) json.RawMessage {
		if b, ok := row.Get(col).(json.RawMessage); ok {
			return b
		}
		return json.RawMessage("[]")
	}
	cur.serviceTrends, cur.details, cur.topFingerprint = raw("service_trends"), raw("details"), raw("top_fingerprints")
	cur.openTotalErrors = row.Get("open_total_errors")
	if v, ok := cur.openTotalErrors.(string); ok { // numeric arrives as text
		cur.openTotalErrors = json.Number(v)
	}
	return cur, prev, nil
}

// previousPeriod is the immediately preceding half-open range of the same width (TypeScript previousPeriod).
func previousPeriod(f *Filters) *Filters {
	lo, hi := rangeInstants(f)
	p := *f
	p.From, p.To = isoTime(lo.Add(-hi.Sub(lo))), isoTime(lo)
	return &p
}

func rangeInstants(f *Filters) (time.Time, time.Time) {
	loc, err := time.LoadLocation(f.Timezone)
	if err != nil {
		loc = time.UTC
	}
	from, _ := parseBoundary(f.From)
	to, _ := parseBoundary(f.To)
	return boundaryInstant(f.From, loc, from), boundaryInstant(f.To, loc, to)
}

// number is JavaScript Number(x) for the values health composition reads: null and absent are 0 unless strict.
func number(v any) (float64, bool) {
	switch x := v.(type) {
	case nil:
		return 0, false
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(x, 64)
		return f, err == nil
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	}
	return math.NaN(), false
}

func jsNumber(v any) float64 { // Number(v ?? 0)
	f, ok := number(v)
	if !ok && v != nil {
		return math.NaN()
	}
	return f
}

// comparable is TypeScript comparable(): current, previous, delta and delta_pct, null when either side is unknown.
func comparable(now, before any) map[string]any {
	value := func(x any) any {
		f, ok := number(x)
		if !ok || math.IsInf(f, 0) || math.IsNaN(f) {
			return nil
		}
		return f
	}
	c, p := value(now), value(before)
	var delta, pct any
	if c != nil && p != nil {
		d := c.(float64) - p.(float64)
		delta = d
		if p.(float64) != 0 {
			pct = d / p.(float64) * 100
		}
	}
	return map[string]any{"current": c, "previous": p, "delta": delta, "delta_pct": pct}
}

func sameCoverage(a, b map[string]any) bool {
	for _, k := range []string{"successful_scans_in_range", "scans_in_range", "failed_scans_in_range", "window_coverage_ms"} {
		x, ok1 := number(a[k])
		y, ok2 := number(b[k])
		if !ok1 || !ok2 || x != y {
			return false
		}
	}
	return true
}

var nullableSummary = []string{"total_errors", "fingerprints", "new_incidents", "active_incidents",
	"resolved_incidents", "critical_high_incidents", "recurring_incidents", "affected_services"}

var comparedSummary = []string{"total_errors", "fingerprints", "new_incidents", "active_incidents",
	"resolved_incidents", "critical_high_incidents", "recurring_incidents", "affected_services", "acknowledge_ms",
	"resolve_ms"}

// markEmptyPartialUnknown: zero errors over partial scan coverage is unknown, not zero.
func markEmptyPartialUnknown(p *healthParts, f *Filters) {
	if p.summary == nil {
		return
	}
	lo, hi := rangeInstants(f)
	width := float64(hi.Sub(lo).Milliseconds())
	if jsNumber(p.summary["total_errors"]) == 0 && jsNumber(p.freshness["window_coverage_ms"]) < width {
		for _, k := range nullableSummary {
			if jsNumber(p.summary[k]) == 0 {
				p.summary[k] = nil
			}
		}
	}
}

// health composes the dashboard exactly as TypeScript healthAnalytics does. Without engineering filters it is one
// statement (both periods; and every service when one is selected, where TypeScript needs a second statement).
// Engineering filters bind the incident gate to each period's run cohort, so those periods stay separate statements.
func (s *Service) health(ctx context.Context, r *Request) (Object, error) {
	f := &r.Filters
	prevF := previousPeriod(f)
	var current, previous healthParts
	var currentServices, previousServices *healthParts
	if engineeringFilters(f) {
		type result struct {
			p   healthParts
			err error
		}
		run := func(ff *Filters, details bool) chan result {
			ch := make(chan result, 1)
			go func() {
				c, _, err := s.healthSet(ctx, r, ff, healthShape{details: details, engineering: true})
				ch <- result{c, err}
			}()
			return ch
		}
		chans := []chan result{run(f, true), run(prevF, false)}
		if f.Service != nil {
			open, openPrev := *f, *prevF
			open.Service, openPrev.Service = nil, nil
			chans = append(chans, run(&open, false), run(&openPrev, false))
		}
		results := make([]healthParts, len(chans))
		for i, ch := range chans {
			res := <-ch
			if res.err != nil {
				return nil, res.err
			}
			results[i] = res.p
		}
		current, previous = results[0], results[1]
		if f.Service != nil {
			currentServices, previousServices = &results[2], &results[3]
		}
	} else {
		var err error
		split := f.Service != nil
		current, previous, err = s.healthSet(ctx, r, f, healthShape{pair: true, details: true, split: split})
		if err != nil {
			return nil, err
		}
		if split {
			// The split statement's service table already covers every service; the coverage is service-independent.
			currentServices = &healthParts{services: current.services, freshness: current.freshness,
				summary: map[string]any{"total_errors": current.openTotalErrors}}
			previousServices = &healthParts{services: previous.services, freshness: previous.freshness}
		}
	}
	markEmptyPartialUnknown(&current, f)
	markEmptyPartialUnknown(&previous, prevF)

	pick := func(open *healthParts, scoped *healthParts) *healthParts {
		if open != nil {
			return open
		}
		return scoped
	}
	oldServices := map[string]map[string]any{}
	for _, sv := range pick(previousServices, &previous).services {
		oldServices[fmt.Sprint(sv["namespace"])+"\x00"+fmt.Sprint(sv["service"])] = sv
	}
	coverageComparable := sameCoverage(pick(currentServices, &current).freshness, pick(previousServices, &previous).freshness)
	denom := pick(currentServices, &current).summary["total_errors"]
	services := []any{}
	for _, sv := range pick(currentServices, &current).services {
		if (f.Service != nil && sv["service"] != *f.Service) || (f.Namespace != nil && sv["namespace"] != *f.Namespace) {
			continue
		}
		out := map[string]any{}
		for k, v := range sv {
			out[k] = v
		}
		old := oldServices[fmt.Sprint(sv["namespace"])+"\x00"+fmt.Sprint(sv["service"])]
		var oldEvents any
		if old != nil {
			oldEvents = old["events"]
		}
		out["previous_events"] = oldEvents
		out["change_events"], out["change_pct"] = nil, nil
		if coverageComparable {
			c := comparable(sv["events"], oldEvents)
			out["change_events"], out["change_pct"] = c["delta"], c["delta_pct"]
		}
		out["change_comparable"] = coverageComparable
		out["environment"] = "production"
		out["service_key"] = fmt.Sprint(sv["namespace"]) + "\u001f" + fmt.Sprint(sv["service"])
		out["error_share_pct"] = nil
		if d, ok := number(denom); ok && d > 0 {
			out["error_share_pct"] = jsNumber(sv["events"]) * 100 / d
		}
		services = append(services, out)
	}

	summary := map[string]any{}
	for k, v := range current.summary {
		summary[k] = v
	}
	comparisons := map[string]any{}
	for _, k := range comparedSummary {
		comparisons[k] = comparable(current.summary[k], previous.summary[k])
	}
	summary["comparisons"] = comparisons
	summary["previous_coverage"] = previous.freshness
	summary["current_coverage"] = current.freshness
	summary["new_errors"] = summary["new_incidents"]
	summary["resolved"] = summary["resolved_incidents"]
	summary["unresolved"] = summary["active_incidents"]
	summary["recurring"] = summary["recurring_incidents"]

	lo, hi := rangeInstants(f)
	rangeMs := hi.Sub(lo)
	freshness := map[string]any{}
	for k, v := range current.freshness {
		freshness[k] = v
	}
	var latest map[string]any
	if raw, ok := current.freshness["latest_scan"].(map[string]any); ok {
		latest = map[string]any{}
		for k, v := range raw {
			latest[k] = v
		}
		if e, ok := latest["error"].(string); !ok || e == "" {
			latest["error"] = nil
		}
	}
	freshness["latest_scan"] = latest
	freshness["status"] = freshnessStatus(latest, current.freshness, rangeMs, s.now())
	freshness["data_source"] = "Splunk production index"
	freshness["environment"] = "production"
	freshness["latest_observation_at"] = current.freshness["latest_observation_at"]

	remediation := map[string]any{}
	for k, v := range current.remediation {
		remediation[k] = v
	}
	remediation["fixes_verified"] = current.remediation["verified_runs"]
	remediation["merged_prs"] = nil
	remediation["merged_prs_available"] = false
	remediation["resolution_inferred_from_agent"] = false

	previousTrend := []any{}
	for _, t := range previous.trend {
		out := map[string]any{}
		for k, v := range t {
			out[k] = v
		}
		if b, err := time.Parse(time.RFC3339Nano, fmt.Sprint(t["bucket"])); err == nil {
			out["bucket"] = isoTime(b.Add(rangeMs))
		}
		out["period"] = "previous"
		previousTrend = append(previousTrend, out)
	}
	severity := []any{}
	for _, sv := range current.severity {
		sv["incidents"] = sv["fingerprints"]
		severity = append(severity, sv)
	}
	lifecycle := map[string]any{}
	for _, l := range current.lifecycle {
		lifecycle[fmt.Sprint(l["status"])] = l["incidents"]
	}
	statuses := []any{}
	for _, st := range []string{"open", "acknowledged", "resolved"} {
		n := lifecycle[st]
		if n == nil {
			n = 0
		}
		statuses = append(statuses, map[string]any{"status": st, "incidents": n})
	}
	reopened := lifecycle["reopened"]
	if reopened == nil {
		reopened = 0
	}
	trend := any(current.trend)
	if current.trend == nil {
		trend = []any{}
	}
	from, to := isoTime(lo), isoTime(hi)
	return Object{
		{"summary", summary},
		{"trend", trend},
		{"previousTrend", previousTrend},
		{"serviceTrends", current.serviceTrends},
		{"severity", severity},
		{"services", services},
		{"lifecycle", map[string]any{"statuses": statuses, "recurring_incidents": current.summary["recurring_incidents"],
			"reopened_incidents": reopened}},
		{"details", current.details},
		{"topFingerprints", current.topFingerprint},
		{"remediation", remediation},
		{"freshness", freshness},
		{"filters", map[string]any{"namespace": f.Namespace, "severity": f.Severity, "incident_status": f.IncidentStatus}},
		{"range", map[string]any{"from": from, "to": to}},
		{"data_window", map[string]any{"from": from, "to": to, "timezone": f.Timezone}},
		{"semantics", map[string]any{
			"event_count":      "sum of deduplicated observed hourly counts; partial or unavailable history remains null",
			"service_identity": "namespace + service; unknown attribution is retained",
			"error_share":      "service observed events / all observed events in the same scope excluding the service selector; not a request failure rate",
			"comparison":       "immediately previous equal-duration half-open range with same remaining filters",
			"lifecycle":        "mutually exclusive explicit operator statuses; recurring is separate",
			"remediation":      "linked workflow evidence; PR creation is not production resolution",
			"merged_prs":       "unavailable in the current schema",
		}},
		{"source", "shared_splunk_scans"},
		{"trend_source", "widest_scan_per_fingerprint_hour"},
		{"lifecycle_source", "explicit_operator_status"},
	}, nil
}

func freshnessStatus(latest, fresh map[string]any, rangeMs time.Duration, now time.Time) string {
	if latest == nil {
		return "never"
	}
	if latest["ok"] == nil && (latest["finished_at"] == nil || latest["finished_at"] == "") {
		return "scanning"
	}
	last, _ := fresh["last_successful_scan"].(map[string]any)
	if last == nil {
		return "never"
	}
	if ok, _ := latest["ok"].(bool); !ok {
		return "latest_scan_failed"
	}
	finished := time.Unix(0, 0)
	if v, ok := last["finished_at"].(string); ok {
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			finished = t
		}
	}
	if now.Sub(finished) > 24*time.Hour {
		return "stale"
	}
	if jsNumber(fresh["window_coverage_ms"]) < float64(rangeMs.Milliseconds()) {
		return "partial"
	}
	return "current"
}

func (s *Service) healthService(ctx context.Context, r *Request) (Object, error) {
	out, err := s.health(ctx, r)
	if err != nil {
		return nil, err
	}
	f := &r.Filters
	var found any
	for _, field := range out {
		if field.Key != "services" {
			continue
		}
		for _, sv := range field.Value.([]any) {
			m := sv.(map[string]any)
			if m["service"] == *f.Service && (f.Namespace == nil || m["namespace"] == *f.Namespace) {
				found = m
				break
			}
		}
	}
	services := []any{}
	if found != nil {
		services = append(services, found)
	}
	for i := range out {
		if out[i].Key == "services" {
			out[i].Value = services
		}
	}
	// {...result, service, services, service_detail}: services keeps its position, the others are appended.
	return append(out, Field{"service", found}, Field{"service_detail", true}), nil
}
