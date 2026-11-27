package proderrors

import (
	"math"
	"regexp"
	"slices"
	"strings"
)

// What a production error text says about itself. The rules mirror src/prodErrors/classify.ts and both are pinned by
// testdata/classify-vectors.json. RE2 has no lookaround, so each rule is "matches this and not that".
var (
	crashStrong = regexp.MustCompile(`(?i)\bfatal error:|runtime: out of memory|\boomkilled\b|outofmemoryerror|all goroutines are asleep`)
	crashWeak   = regexp.MustCompile(`(?i)\bpanic\b|nil pointer|invalid memory address|index out of range|\bdeadlock\b|out of memory`)
	recovered   = regexp.MustCompile(`(?i)recovered (from )?(a )?panic|panic (was |has been )?recovered|recovered panic|recovering from panic`)
	dbDeadlock  = regexp.MustCompile(`(?i)deadlock found|deadlock detected|try restarting transaction|er_lock_deadlock|sqlstate[ =:(]*(40001|40p01)`)

	moneyAlways  = regexp.MustCompile(`(?i)refund|hoàn tiền|reconcil|sign(ature)? not match|invalid sign|checksum|\bipn\b|\bcod\b|chargeback`)
	moneyPhrase  = regexp.MustCompile(`(?i)duplicate (payment|transaction|order|charge|refund|callback)|double (charge|refund|payment|spend|debit)|amount (mismatch|not match|invalid)`)
	moneyWord    = regexp.MustCompile(`(?i)\b(charge|capture|settle(d|ment)?|callback|webhook|amount)\b`)
	moneyContext = regexp.MustCompile(`(?i)payment|order|transaction|wallet|thanh toán|đơn hàng|zalopay|momo|vnpay|paypal|stripe`)
)

func isCrash(text string) bool {
	return crashStrong.MatchString(text) ||
		(crashWeak.MatchString(text) && !recovered.MatchString(text) && !dbDeadlock.MatchString(text))
}

func isMoney(text string) bool {
	return moneyAlways.MatchString(text) || moneyPhrase.MatchString(text) ||
		(moneyWord.MatchString(text) && moneyContext.MatchString(text))
}

// rowIsCrash is scan.ts rowIsCrash(): a row that must survive the per-source cap.
func rowIsCrash(r Row) bool {
	if n := jsNumber(get(r, "is_crash")); finite(n) && n > 0 {
		return true
	}
	lv := get(r, "lv")
	if lv == nil {
		lv = ""
	}
	if _, u := lv.(undefinedT); u {
		lv = ""
	}
	if fatal.MatchString(toUpperJS(jsString(lv))) {
		return true
	}
	return isCrash(joinElem(get(r, "sig")) + "\n" + joinElem(get(r, "sample")))
}

// capRows is scan.ts capSourceRows(): crash groups first, then by today, at most limit rows; the second result says
// whether anything was cut.
func capRows(rows []Row, limit int) ([]Row, bool) {
	ranked := slices.Clone(rows)
	crash := make(map[int]bool, len(ranked))
	idx := make([]int, len(ranked))
	for i := range ranked {
		idx[i] = i
		crash[i] = rowIsCrash(ranked[i])
	}
	slices.SortStableFunc(idx, func(a, b int) int {
		switch {
		case crash[a] && !crash[b]:
			return -1
		case !crash[a] && crash[b]:
			return 1
		}
		x, y := num(get(ranked[a], "today")), num(get(ranked[b], "today"))
		switch {
		case y > x:
			return 1
		case y < x:
			return -1
		}
		return 0
	})
	out := make([]Row, 0, min(limit, len(idx)))
	for _, i := range idx[:min(limit, len(idx))] {
		out = append(out, ranked[i])
	}
	return out, len(rows) > limit
}

// assess is scan.ts assess(): severity, score and reasons of one group.
func assess(level, signature, sample string, today, yesterday float64, baseline bool) (string, int, []string) {
	reasons := []string{}
	text := signature + "\n" + sample
	s := 1
	if today >= 1000 {
		s = 2
		reasons = append(reasons, "many|"+numberToString(today))
	}
	if fatal.MatchString(level) || isCrash(text) {
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
	if isMoney(text) {
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

// Thresholds of severity v2: configured in TypeScript (config.prodErrors.severity), handed over by the gateway.
type Thresholds struct {
	HeavyRate      float64 `json:"heavyRate"`
	ChronicHigh    float64 `json:"chronicHigh"`
	SpikeRatio     float64 `json:"spikeRatio"`
	SpikeMinRate   float64 `json:"spikeMinRate"`
	MinNewCount    float64 `json:"minNewCount"`
	MinWindowHours float64 `json:"minWindowHours"`
	MinSampleCount float64 `json:"minSampleCount"`
	NewWithinHours float64 `json:"newWithinHours"`
}

func DefaultThresholds() Thresholds {
	return Thresholds{HeavyRate: 40, ChronicHigh: 200, SpikeRatio: 3, SpikeMinRate: 6, MinNewCount: 5,
		MinWindowHours: 1, MinSampleCount: 20, NewWithinHours: 24}
}

// Context is what severity v2 needs beyond a row (scan.ts GroupContext): the window's length, when each fingerprint
// was first stored, the thresholds, and which verdict decides the severity (the other rides along in the detail).
type Context struct {
	WindowHours   float64            `json:"windowHours"`
	BaselineHours float64            `json:"baselineHours"`
	WindowEnd     float64            `json:"windowEnd"`
	Known         map[string]float64 `json:"known"`
	Thresholds    Thresholds         `json:"thresholds"`
	V2            bool               `json:"v2"`
}

// assessV2 is severity.ts assessV2(): rates per hour, new by first seen, a step for chronic errors, no high verdict from
// a tiny sample in a very short window.
func assessV2(level, signature, sample string, today, yesterday float64, baseline bool,
	windowHours, baselineHours float64, ageHours *float64, t Thresholds) (string, int, []string) {
	reasons := []string{}
	text := signature + "\n" + sample
	rate := today / math.Max(windowHours, t.MinWindowHours)
	baseRate := yesterday / math.Max(baselineHours, t.MinWindowHours)
	crash := fatal.MatchString(level) || isCrash(text)
	s := 1
	if rate >= t.HeavyRate {
		s = 2
		reasons = append(reasons, "many|"+numberToString(today))
	}
	if crash {
		s = 4
		reasons = append(reasons, "panic")
	}
	changed, isNew := false, false
	switch {
	case !baseline:
	case yesterday == 0:
		isNew = ageHours == nil || *ageHours <= t.NewWithinHours
		if isNew {
			reasons = append(reasons, "new")
			if today >= t.MinNewCount {
				s = max(s, 3)
			} else {
				s = max(s, 2)
			}
			changed = true
		} else {
			reasons = append(reasons, "returned")
			s = max(s, 2)
		}
	case rate >= t.SpikeMinRate && rate >= t.SpikeRatio*baseRate:
		reasons = append(reasons, "up|"+numberToString(jsRound(today/yesterday))+"|"+numberToString(yesterday))
		s = max(s, 3)
		changed = true
	case today*2 <= yesterday:
		reasons = append(reasons, "down|"+numberToString(yesterday))
	}
	if !isNew && rate >= t.ChronicHigh {
		reasons = append(reasons, "chronic|"+numberToString(jsRound(rate)))
		s = max(s, 3)
	}
	if isMoney(text) {
		reasons = append(reasons, "money")
		if changed && today >= t.MinNewCount {
			top := 3
			if rate >= t.HeavyRate {
				top = 4
			}
			s = max(s, min(top, s+1))
		}
	}
	if windowHours < t.MinWindowHours && today < t.MinSampleCount && !crash {
		s = min(s, 2)
	}
	if level == "SLOW" {
		switch {
		case slices.ContainsFunc(reasons, func(r string) bool { return strings.HasPrefix(r, "up|") }):
			s = 3
		case changed && today >= t.MinNewCount:
			s = 2
		default:
			s = 1
		}
	}
	return sev[s], s*1000 + int(min(999, jsRound(math.Log10(today+1)*100))), reasons
}
