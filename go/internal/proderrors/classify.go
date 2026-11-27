package proderrors

import (
	"regexp"
	"slices"
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
