package codeintelligence

import (
	"claude-task-platform/go/internal/jsstr"
	"regexp"
	"strings"
)

// The TypeScript indexer shares the extraction cache and snapshot identities with this one, so every string rule
// below reproduces its JavaScript behaviour exactly (UTF-16 lengths, WHATWG decoding, String.prototype.trim, JS
// regular expressions). Differences would change content hashes or signatures and split the shared index.

var (
	decodeUTF8       = jsstr.DecodeUTF8
	sha256Hex        = jsstr.Sha256Hex
	sliceUTF16       = jsstr.SliceUTF16
	jsSpace          = jsstr.Space
	jsTrim           = jsstr.Trim
	jsLineTerminator = jsstr.LineTerminator
)

// JS `\s` is wider than RE2's: spell it out where it matters.
const jsWS = jsstr.WS

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
