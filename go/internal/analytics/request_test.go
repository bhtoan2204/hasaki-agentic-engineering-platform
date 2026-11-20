package analytics

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

func validRequest() Request {
	return Request{
		Scope: Scope{OwnerID: 7},
		Filters: Filters{From: "2026-11-01", To: "2026-11-03", Timezone: "Asia/Bangkok", Bucket: "day",
			GroupBy: "provider", Page: 1, PageSize: 25},
	}
}

func ptr[T any](v T) *T { return &v }

func TestValidateMirrorsTheTypeScriptParser(t *testing.T) {
	ok := validRequest()
	if err := ok.Validate("usage"); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(r *Request){
		"no owner":           func(r *Request) { r.Scope.OwnerID = 0 },
		"bad date":           func(r *Request) { r.Filters.From = "2026-13-01x" },
		"no offset":          func(r *Request) { r.Filters.From = "2026-11-01T00:00:00" },
		"reversed":           func(r *Request) { r.Filters.From, r.Filters.To = r.Filters.To, r.Filters.From },
		"too long":           func(r *Request) { r.Filters.From = "2025-01-01" },
		"hourly too long":    func(r *Request) { r.Filters.Bucket, r.Filters.From = "hour", "2026-09-01" },
		"bad timezone":       func(r *Request) { r.Filters.Timezone = "Mars/Base" },
		"local timezone":     func(r *Request) { r.Filters.Timezone = "Local" },
		"bad bucket":         func(r *Request) { r.Filters.Bucket = "week" },
		"bad group":          func(r *Request) { r.Filters.GroupBy = "owner_id" },
		"page":               func(r *Request) { r.Filters.Page = 0 },
		"page size":          func(r *Request) { r.Filters.PageSize = 101 },
		"provider injection": func(r *Request) { r.Filters.Provider = ptr("x' OR 1=1") },
		"empty model":        func(r *Request) { r.Filters.Model = ptr("") },
		"long service":       func(r *Request) { r.Filters.Service = ptr(strings.Repeat("s", 161)) },
		"severity":           func(r *Request) { r.Filters.Severity = ptr("fatal") },
		"status":             func(r *Request) { r.Filters.IncidentStatus = ptr("closed") },
		"environment":        func(r *Request) { r.Filters.Environment = ptr("staging") },
		"user":               func(r *Request) { r.Filters.User = ptr(int64(0)) },
		"service without ns": func(r *Request) { r.Filters.Service = ptr("api") },
		"unknown dashboard":  nil,
	}
	for name, mutate := range cases {
		r := validRequest()
		dashboard := "usage"
		if mutate == nil {
			dashboard = "nope"
		} else {
			mutate(&r)
		}
		if name == "service without ns" {
			dashboard = "health-service"
		}
		if err := r.Validate(dashboard); !errors.Is(err, errInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// 366 days plus a DST hour is accepted, as in TypeScript.
	r := validRequest()
	r.Filters.From, r.Filters.To = "2025-11-01", "2026-11-02"
	if err := r.Validate("usage"); err != nil {
		t.Fatal(err)
	}
}

func TestBoundariesAndPreviousPeriodFollowTheTimezone(t *testing.T) {
	f := Filters{From: "2026-11-01", To: "2026-11-02", Timezone: "America/New_York"}
	lo, hi := rangeInstants(&f)
	// 2026-11-01 is the DST end: the local day has 25 hours.
	if lo.UTC().Format(time.RFC3339) != "2026-11-01T04:00:00Z" || hi.Sub(lo) != 25*time.Hour {
		t.Fatalf("%v %v", lo.UTC(), hi.Sub(lo))
	}
	p := previousPeriod(&f)
	if p.From != "2026-10-31T03:00:00.000Z" || p.To != "2026-11-01T04:00:00.000Z" {
		t.Fatalf("previous %s %s", p.From, p.To)
	}
	ts := Filters{From: "2026-11-01T10:00:00+07:00", To: "2026-11-01T12:00:00Z", Timezone: "UTC"}
	p = previousPeriod(&ts)
	if p.From != "2026-10-31T18:00:00.000Z" || p.To != "2026-11-01T03:00:00.000Z" {
		t.Fatalf("previous %s %s", p.From, p.To)
	}
}

func TestValuesConvertLikeNodePostgres(t *testing.T) {
	field := func(oid uint32) pgconn.FieldDescription { return pgconn.FieldDescription{DataTypeOID: oid} }
	ts := time.Date(2026, 11, 1, 3, 4, 5, 123987000, time.FixedZone("x", 7*3600))
	for _, c := range []struct {
		oid  uint32
		in   any
		raw  string
		want string
	}{
		{pgtype.NumericOID, pgtype.Numeric{}, "0.40000", `"0.40000"`},
		{pgtype.Int8OID, int64(9007199254740991), "", `9007199254740991`},
		{pgtype.TimestamptzOID, ts, "", `"2026-10-31T20:04:05.123Z"`},
		{pgtype.Float8OID, math.NaN(), "", `null`},
		{pgtype.JSONBOID, map[string]any{}, `{"b":1,"a":[0.10]}`, `{"b":1,"a":[0.10]}`},
		{pgtype.TextArrayOID, []any{"a", nil}, "", `["a",null]`},
	} {
		got, err := json.Marshal(jsValue(field(c.oid), c.in, []byte(c.raw)))
		if err != nil || string(got) != c.want {
			t.Errorf("oid %d: %s (%v), want %s", c.oid, got, err, c.want)
		}
	}
	row := Row{cols: []string{"z", "a"}, vals: []any{1, "x"}}
	if b, _ := json.Marshal(row); string(b) != `{"z":1,"a":"x"}` {
		t.Fatalf("column order lost: %s", b)
	}
}

func TestComparableAndCoverageMatchTypeScript(t *testing.T) {
	c := comparable(json.Number("12"), json.Number("8"))
	if c["delta"] != 4.0 || c["delta_pct"] != 50.0 {
		t.Fatal(c)
	}
	if c := comparable(json.Number("3"), json.Number("0")); c["delta_pct"] != nil || c["delta"] != 3.0 {
		t.Fatal(c)
	}
	if c := comparable(nil, json.Number("1")); c["current"] != nil || c["delta"] != nil {
		t.Fatal(c)
	}
	a := map[string]any{"successful_scans_in_range": json.Number("2"), "scans_in_range": json.Number("2"),
		"failed_scans_in_range": json.Number("0"), "window_coverage_ms": json.Number("7200000")}
	if !sameCoverage(a, a) || sameCoverage(a, map[string]any{}) {
		t.Fatal("sameCoverage")
	}
	p := healthParts{summary: map[string]any{"total_errors": json.Number("0"), "fingerprints": json.Number("0"),
		"new_incidents": json.Number("2")}, freshness: map[string]any{"window_coverage_ms": json.Number("1")}}
	markEmptyPartialUnknown(&p, &Filters{From: "2026-11-01", To: "2026-11-02", Timezone: "UTC"})
	if p.summary["total_errors"] != nil || p.summary["fingerprints"] != nil || p.summary["new_incidents"] == nil {
		t.Fatal(p.summary)
	}
}

func TestFreshnessStatus(t *testing.T) {
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	last := map[string]any{"finished_at": "2026-11-19T12:00:00+00:00"}
	fresh := map[string]any{"last_successful_scan": last, "window_coverage_ms": json.Number("3600000")}
	for want, latest := range map[string]map[string]any{
		"never":              nil,
		"scanning":           {"ok": nil, "finished_at": nil},
		"latest_scan_failed": {"ok": false, "finished_at": "x"},
		"current":            {"ok": true, "finished_at": "x"},
	} {
		if got := freshnessStatus(latest, fresh, time.Hour, now); got != want {
			t.Errorf("%v: %s, want %s", latest, got, want)
		}
	}
	if got := freshnessStatus(map[string]any{"ok": true}, fresh, 2*time.Hour, now); got != "partial" {
		t.Fatal(got)
	}
	if got := freshnessStatus(map[string]any{"ok": true}, fresh, time.Hour, now.Add(24*time.Hour)); got != "stale" {
		t.Fatal(got)
	}
}

func assertContract(t *testing.T, def string, body []byte) {
	t.Helper()
	path, err := filepath.Abs("../../contracts/analytics-v1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := jsonschema.NewCompiler().Compile("file://" + path + "#/$defs/" + def)
	if err != nil {
		t.Fatal(err)
	}
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("%s: invalid JSON %q", def, body)
	}
	if err := s.Validate(v); err != nil {
		t.Fatalf("%s does not match the contract: %v\n%s", def, err, body)
	}
}

func TestContractErrorsWithoutDatabase(t *testing.T) {
	mux := http.NewServeMux()
	Routes(mux, NewService(nil, 1), time.Second, slog.New(slog.DiscardHandler))
	body, _ := json.Marshal(validRequest())
	full := strings.Replace(string(body), `"prod_namespaces":null`, `"prod_namespaces":[]`, 1)
	assertContract(t, "Request", []byte(full))
	for payload, status := range map[string]int{
		`{`:                        http.StatusBadRequest,
		`{"scope":{"owner_id":1}}`: http.StatusBadRequest,
		strings.Replace(full, `"page":1`, `"page":0`, 1):         http.StatusBadRequest,
		strings.Replace(full, `"scope":{`, `"x":1,"scope":{`, 1): http.StatusBadRequest,
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/analytics/usage", strings.NewReader(payload)))
		if w.Code != status {
			t.Fatalf("%s: %d %s", payload, w.Code, w.Body)
		}
		assertContract(t, "Error", w.Body.Bytes())
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/internal/v1/analytics/stats", nil))
	assertContract(t, "Stats", w.Body.Bytes())
}

func TestSlotsBoundConcurrencyAndReportBusy(t *testing.T) {
	s := NewService(nil, 1)
	ctx, cancel := contextWithTimeout(20 * time.Millisecond)
	defer cancel()
	if err := s.acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.acquire(ctx); !errors.Is(err, ErrBusy) {
		t.Fatalf("second slot: %v", err)
	}
	if s.Stats().Busy != 1 {
		t.Fatal(s.Stats())
	}
}
