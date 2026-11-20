package retrieval

import (
	"regexp"
	"strings"
)

// High-confidence patterns only: a match keeps the whole source out of the embedding store.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----`),
	regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{36,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{40,}`),
	regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{20,}`),
	regexp.MustCompile(`\bxox[bp]-[A-Za-z0-9-]{20,}`),
	regexp.MustCompile(`\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`),
}

var (
	urlCredentials = regexp.MustCompile(`\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/:@]+:([^\s/@]+)@[^\s/]+`)
	assignment     = regexp.MustCompile(`(?i)\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?([A-Za-z0-9_\-+/=]{16,})`)
	cardCandidate  = regexp.MustCompile(`\b[3-6]\d{3}(?:[ -]?\d){9,15}\b`)
)

func looksSecret(text string) bool {
	for _, p := range secretPatterns {
		if p.MatchString(text) {
			return true
		}
	}
	for _, m := range urlCredentials.FindAllStringSubmatch(text, -1) {
		if !placeholder(m[1]) {
			return true
		}
	}
	for _, m := range assignment.FindAllStringSubmatch(text, -1) {
		if hasLetterAndDigit(m[1]) {
			return true
		}
	}
	for _, m := range cardCandidate.FindAllString(text, -1) {
		if luhn(m) {
			return true
		}
	}
	return false
}

// placeholder recognises documentation credentials such as <password>, ${PASS}, *** or "password".
func placeholder(pw string) bool {
	return strings.ContainsAny(pw, "<>{}$*") || strings.EqualFold(pw, "password") || strings.EqualFold(pw, "pass")
}

func hasLetterAndDigit(s string) bool {
	return strings.ContainsAny(s, "0123456789") &&
		strings.ContainsFunc(s, func(r rune) bool { return r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' })
}

func luhn(s string) bool {
	sum, n := 0, 0
	for i := len(s) - 1; i >= 0; i-- {
		c := s[i]
		if c < '0' || c > '9' {
			continue
		}
		d := int(c - '0')
		if n%2 == 1 {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		n++
	}
	return n >= 13 && n <= 19 && sum%10 == 0
}
