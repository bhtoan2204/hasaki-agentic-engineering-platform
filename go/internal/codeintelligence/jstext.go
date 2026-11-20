package codeintelligence

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The TypeScript indexer shares the extraction cache and snapshot identities with this one, so every string rule
// below reproduces its JavaScript behaviour exactly (UTF-16 lengths, WHATWG decoding, String.prototype.trim, JS
// regular expressions). Differences would change content hashes or signatures and split the shared index.

// decodeUTF8 is Node's Buffer#toString("utf8"): every maximal invalid subpart becomes one U+FFFD (WHATWG).
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + 16)
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			sb.WriteByte(c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
			need = 2
		case c == 0xED:
			need, hi = 2, 0x9F
		case c == 0xF0:
			need, lo = 3, 0x90
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		case c == 0xF4:
			need, hi = 3, 0x8F
		default:
			sb.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		for k := 0; k < need; k++ {
			if j >= len(b) || b[j] < lo || b[j] > hi {
				break
			}
			lo, hi = 0x80, 0xBF
			j++
		}
		if j-i == need+1 {
			sb.Write(b[i:j])
		} else {
			sb.WriteRune(utf8.RuneError)
		}
		i = j
	}
	return sb.String()
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// sliceUTF16 is s.slice(0, n) on a JS string. A cut inside a surrogate pair leaves a lone surrogate, which the
// PostgreSQL driver of the TypeScript side encodes as U+FFFD.
func sliceUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			if units < n {
				return s[:i] + string(utf8.RuneError)
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// jsSpace is the WhiteSpace and LineTerminator set String.prototype.trim removes.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, jsSpace) }

// jsLineTerminator is what `.` in a JS regular expression does not match.
func jsLineTerminator(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }

// JS `\s` is wider than RE2's: spell it out where it matters.
const jsWS = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var secretRules = []struct {
	re  *regexp.Regexp
	rep string
}{
	{regexp.MustCompile(`(?i)\b(Bearer|Basic)` + jsWS + `+[A-Za-z0-9._~+/=-]{12,}`), "$1 ***"},
	{regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}`), "<jwt>"},
	{regexp.MustCompile(`\bgl(?:pat|dt|ptt|rt|rtr|cbt|imt|ft|soat|oas|agent|wt|ffct)-[A-Za-z0-9_-]{16,}`), "<gitlab-token>"},
	{regexp.MustCompile(`(?i)(PRIVATE-TOKEN` + jsWS + `*:` + jsWS + `*)[^\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`), "${1}***"},
	{regexp.MustCompile(`(//[^/@\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}:]+:)[^@\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}/]{4,}@`), "${1}***@"},
	{regexp.MustCompile(`(?i)((?:password|passwd|secret|api[_-]?key|[a-z_-]*token|client[_-]?secret)["']?` + jsWS + `*[:=]` + jsWS + `*["']?)[^\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}"',;&}]{4,}`), "${1}***"},
}

// redactSecrets is src/integrations/redact.ts redactSecrets.
func redactSecrets(s string) string {
	for _, r := range secretRules {
		s = r.re.ReplaceAllString(s, r.rep)
	}
	return s
}

// maskQuoted is s.replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '"…"'), including the backtracking order of the lazy
// alternation (an escape is tried before taking the backslash as a plain character).
func maskQuoted(s string) string {
	rs := []rune(s)
	var out strings.Builder
	for i := 0; i < len(rs); {
		if rs[i] == '\'' || rs[i] == '"' {
			if end := quotedEnd(rs, i+1, rs[i]); end >= 0 {
				out.WriteString(`"…"`)
				i = end
				continue
			}
		}
		out.WriteRune(rs[i])
		i++
	}
	return out.String()
}

func quotedEnd(rs []rune, start int, q rune) int {
	failed := map[int]bool{}
	var at func(p int) int
	at = func(p int) int {
		if p >= len(rs) || failed[p] {
			return -1
		}
		if rs[p] == q {
			return p + 1
		}
		if rs[p] == '\\' && p+1 < len(rs) && !jsLineTerminator(rs[p+1]) {
			if r := at(p + 2); r >= 0 {
				return r
			}
		}
		if !jsLineTerminator(rs[p]) {
			if r := at(p + 1); r >= 0 {
				return r
			}
		}
		failed[p] = true
		return -1
	}
	return at(start)
}

var (
	signatureCut = regexp.MustCompile(`(?i)\bAS` + jsWS + `+\$\$|\{`)
	generatedRe  = regexp.MustCompile(`Code generated [^\n\r\x{2028}\x{2029}]*DO NOT EDIT|@generated`)
)

// unquote is s.replace(/^["'`]|["'`]$/g, "").
func unquote(s string) string {
	if s != "" && strings.ContainsRune("\"'`", rune(s[0])) {
		s = s[1:]
	}
	if s != "" && strings.ContainsRune("\"'`", rune(s[len(s)-1])) {
		s = s[:len(s)-1]
	}
	return s
}
