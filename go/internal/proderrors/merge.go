package proderrors

import (
	"crypto/sha1"
	"encoding/hex"
	"math"
	"regexp"
	"slices"
	"strings"
)

// Row is one provider result row (an SPL `stats` row, or a SigNoz row built in the same shape by the gateway).
type Row = map[string]any

// Source tags rows with the provider they came from.
type Source struct {
	Name string // "splunk" | "signoz"
	Rows []Row
}

// Group is one prod_error_groups row (TypeScript toGroups output).
type Group struct {
	Fingerprint    string         `json:"fingerprint"`
	Namespace      string         `json:"namespace"`
	Service        string         `json:"service"`
	Level          string         `json:"level"`
	Caller         string         `json:"caller"`
	Signature      string         `json:"signature"`
	Sample         string         `json:"sample"`
	Detail         map[string]any `json:"detail"`
	Hourly         []HourPoint    `json:"hourly"`
	Day            string         `json:"day"`
	TodayCount     float64        `json:"today_count"`
	YesterdayCount float64        `json:"yesterday_count"`
	FirstAt        *string        `json:"first_at"`
	LastAt         *string        `json:"last_at"`
	Severity       string         `json:"severity"`
	Score          int            `json:"score"`
	Reasons        []string       `json:"reasons"`
}

type HourPoint struct {
	Hour  string  `json:"hour"`
	Count float64 `json:"count"`
}

func fingerprint(ns, svc, level, sig string) string {
	h := sha1.Sum([]byte(strings.Join([]string{ns, svc, level, sig}, "\x00")))
	return hex.EncodeToString(h[:])[:20]
}

// str is scan.ts str(): String(first element of an array, or the value), first max UTF-16 units; null → "".
func str(v any, max int) string {
	if v == nil {
		return ""
	}
	if _, u := v.(undefinedT); u {
		return ""
	}
	if a, ok := v.([]any); ok {
		if len(a) == 0 {
			return slice16("undefined", max)
		}
		v = a[0]
	}
	return slice16(jsString(v), max)
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedT:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// hourlyPoints is the analytics_hourly field as a list (array, a single value, or nothing).
func hourlyPoints(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	if truthy(v) {
		return []any{v}
	}
	return nil
}

var (
	money = regexp.MustCompile(`(?i)refund|hoàn tiền|charge|capture|settle|reconcil|duplicate|double|callback|webhook|\bipn\b|amount|\bcod\b|checksum|sign(ature)? not match|invalid sign`)
	crash = regexp.MustCompile(`(?i)\bpanic\b|fatal error|nil pointer|index out of range|deadlock|out of memory|oomkilled`)
	fatal = regexp.MustCompile(`^(FATAL|PANIC|DPANIC|CRITICAL)$`)
	point = regexp.MustCompile(`^(\d+):(\d+)$`)
	sev   = []string{"low", "low", "medium", "high", "critical"}
)

// assess is scan.ts assess(): severity, score and reasons of one group.
func assess(level, signature, sample string, today, yesterday float64, baseline bool) (string, int, []string) {
	reasons := []string{}
	text := signature + "\n" + sample
	s := 1
	if today >= 1000 {
		s = 2
		reasons = append(reasons, "many|"+numberToString(today))
	}
	if fatal.MatchString(level) || crash.MatchString(text) {
		s = 4
		reasons = append(reasons, "panic")
	}
	changed := false
	switch {
	case !baseline:
	case yesterday == 0:
		reasons = append(reasons, "new")
		if today >= 5 {
			s = max(s, 3)
		} else {
			s = max(s, 2)
		}
		changed = true
	case today >= 50 && today >= 3*yesterday:
		reasons = append(reasons, "up|"+numberToString(jsRound(today/yesterday))+"|"+numberToString(yesterday))
		s = max(s, 3)
		changed = true
	case today*2 <= yesterday:
		reasons = append(reasons, "down|"+numberToString(yesterday))
	}
	if money.MatchString(text) {
		reasons = append(reasons, "money")
		if changed && today >= 5 {
			top := 3
			if today >= 50 {
				top = 4
			}
			s = max(s, min(top, s+1))
		}
	}
	if level == "SLOW" {
		switch {
		case slices.ContainsFunc(reasons, func(r string) bool { return strings.HasPrefix(r, "up|") }):
			s = 3
		case changed && today >= 5:
			s = 2
		default:
			s = 1
		}
	}
	return sev[s], s*1000 + int(min(999, jsRound(math.Log10(today+1)*100))), reasons
}

// jsRound is Math.round: halves round toward +∞.
func jsRound(f float64) float64 { return math.Floor(f + 0.5) }

// iso is scan.ts iso(): epoch seconds → ISO timestamp; null or "" → null.
func iso(v any) (*string, error) {
	if v == nil || v == "" {
		return nil, nil
	}
	if _, u := v.(undefinedT); u {
		return nil, nil
	}
	s, err := isoJS(jsNumber(v) * 1000)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ToGroups is scan.ts toGroups(): merged rows → group rows.
func ToGroups(rows []Row, day string) ([]Group, error) {
	out := make([]Group, 0, len(rows))
	for _, r := range rows {
		level := str(get(r, "lv"), 20)
		if level == "" {
			level = "ERROR"
		}
		signature := str(get(r, "sig"), 200)
		sample := str(get(r, "sample"), 2000)
		today, yesterday := num(get(r, "today")), num(get(r, "yesterday"))
		ns, svc := str(get(r, "ns"), 100), str(get(r, "svc"), 100)
		detail := map[string]any{}
		for key, max := range map[string]int{"err": 1000, "image": 300, "request_id": 100, "trace_id": 100, "stack": 2500, "pod": 100} {
			if v := str(get(r, key), max); v != "" {
				detail[key] = v
			}
		}
		if src, ok := r["sources"].([]any); ok && len(src) > 0 {
			detail["sources"] = src
		}
		if nb := get(r, "no_baseline"); truthy(nb) {
			detail["no_baseline"] = nb
		}
		if slow, ok := r["slow"]; ok && slow != nil {
			detail["slow"] = slow
		}
		hourly := []HourPoint{}
		for _, p := range hourlyPoints(get(r, "analytics_hourly")) {
			m := point.FindStringSubmatch(jsString(p))
			if m == nil {
				continue
			}
			epoch, count := stringToNumber(m[1])*1000, stringToNumber(m[2])
			if !finite(epoch) || epoch > 8.64e15 || count > 9007199254740991 {
				continue
			}
			hour, err := isoJS(epoch)
			if err != nil {
				return nil, err
			}
			hourly = append(hourly, HourPoint{hour, count})
		}
		first, err := iso(get(r, "first"))
		if err != nil {
			return nil, err
		}
		last, err := iso(get(r, "last"))
		if err != nil {
			return nil, err
		}
		severity, score, reasons := assess(level, signature, sample, today, yesterday, !truthy(get(r, "no_baseline")))
		out = append(out, Group{
			Fingerprint: fingerprint(ns, svc, level, signature), Namespace: ns, Service: svc, Level: level,
			Caller: str(get(r, "caller"), 200), Signature: signature, Sample: sample, Detail: detail, Hourly: hourly,
			Day: day, TodayCount: today, YesterdayCount: yesterday, FirstAt: first, LastAt: last,
			Severity: severity, Score: score, Reasons: reasons,
		})
	}
	return out, nil
}

// joinElem is how Array.prototype.join renders one element: null and undefined are empty.
func joinElem(v any) string {
	if v == nil {
		return ""
	}
	if _, u := v.(undefinedT); u {
		return ""
	}
	return jsString(v)
}

func byTodayDesc(rows []Row) {
	slices.SortStableFunc(rows, func(a, b Row) int {
		x, y := num(get(a, "today")), num(get(b, "today"))
		switch {
		case y > x:
			return 1
		case y < x:
			return -1
		}
		return 0
	})
}

// MergeSourceRows is scan.ts mergeSourceRows(): one row per group; a group seen by several sources keeps the larger
// counts (they usually hold the same cluster logs), merged hourly maxima and the union of sources.
func MergeSourceRows(sources ...Source) []Row {
	order := []string{}
	merged := map[string]Row{}
	for _, src := range sources {
		rows := slices.Clone(src.Rows)
		byTodayDesc(rows)
		if len(rows) > 300 {
			rows = rows[:300]
		}
		for _, r := range rows {
			lv := get(r, "lv")
			if lv == nil {
				lv = ""
			}
			if _, u := lv.(undefinedT); u {
				lv = ""
			}
			level := toUpperJS(jsString(lv))
			if level == "" {
				level = "ERROR"
			}
			key := strings.Join([]string{joinElem(get(r, "ns")), joinElem(get(r, "svc")), level, joinElem(get(r, "sig"))}, "\x00")
			hourly := func(h any) []any {
				out := []any{}
				for _, p := range hourlyPoints(h) {
					out = append(out, jsString(p))
				}
				return out
			}
			prev, seen := merged[key]
			if !seen {
				row := Row{}
				for k, v := range r {
					row[k] = v
				}
				row["sources"] = []any{src.Name}
				row["analytics_hourly"] = hourly(get(r, "analytics_hourly"))
				merged[key] = row
				order = append(order, key)
				continue
			}
			hourKeys := []string{}
			hours := map[string]float64{}
			for _, p := range append(slices.Clone(prev["analytics_hourly"].([]any)), hourly(get(r, "analytics_hourly"))...) {
				h, n, _ := strings.Cut(p.(string), ":")
				n, _, _ = strings.Cut(n, ":")
				v := stringToNumber(n)
				if math.IsNaN(v) {
					v = 0
				}
				if _, ok := hours[h]; !ok {
					hourKeys = append(hourKeys, h)
				}
				hours[h] = math.Max(hours[h], v)
			}
			points := make([]any, len(hourKeys))
			for i, h := range hourKeys {
				points[i] = h + ":" + numberToString(hours[h])
			}
			positive := func(vs ...any) []float64 {
				out := []float64{}
				for _, v := range vs {
					if f := jsNumber(v); finite(f) && f > 0 {
						out = append(out, f)
					}
				}
				return out
			}
			pick := func(field string, agg func(...float64) float64) any {
				if p := positive(get(prev, field), get(r, field)); len(p) > 0 {
					return agg(p...)
				}
				if v := get(prev, field); v != nil {
					if _, u := v.(undefinedT); !u {
						return v
					}
				}
				return get(r, field)
			}
			row := Row{}
			for k, v := range r { // {...r, ...prev, …}
				row[k] = v
			}
			for k, v := range prev {
				row[k] = v
			}
			row["today"] = math.Max(num(get(prev, "today")), num(get(r, "today")))
			row["yesterday"] = math.Max(num(get(prev, "yesterday")), num(get(r, "yesterday")))
			for field, agg := range map[string]func(...float64) float64{"first": minOf, "last": maxOf} {
				if v := pick(field, agg); v != undefined {
					row[field] = v
				} else {
					delete(row, field)
				}
			}
			srcs := slices.Clone(prev["sources"].([]any))
			if !slices.Contains(srcs, any(src.Name)) {
				srcs = append(srcs, src.Name)
			}
			row["sources"] = srcs
			if truthy(get(prev, "no_baseline")) && truthy(get(r, "no_baseline")) {
				row["no_baseline"] = get(r, "no_baseline")
			} else {
				delete(row, "no_baseline")
			}
			row["analytics_hourly"] = points
			merged[key] = row
		}
	}
	out := make([]Row, len(order))
	for i, k := range order {
		out[i] = merged[k]
	}
	byTodayDesc(out)
	return out
}

func minOf(v ...float64) float64 { return slices.Min(v) }
func maxOf(v ...float64) float64 { return slices.Max(v) }
