package knowledge

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"hasaki-orbit/go/internal/jsstr"
)

// Text rules of src/knowledge/importer.ts, reproduced with their JavaScript semantics (UTF-16 lengths, JS `\s`,
// String.prototype.trim, the backtracking of the regular expressions they use). Candidate keys, titles,
// descriptions and contents must be identical to the TypeScript engine's: they are registry identities and the
// content the registry compares.

// isWord is JS `\w` (ASCII, no `u` flag).
func isWord(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}

// hasPrefixFold is a JS /…/i prefix test of an ASCII pattern: without the `u` flag, case folding never maps a
// non-ASCII character onto an ASCII one (ſ is not s), so an ASCII-only comparison is exact.
func hasPrefixFold(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	for i := 0; i < len(prefix); i++ {
		if lowerASCII(s[i]) != lowerASCII(prefix[i]) {
			return false
		}
	}
	return true
}

// asciiLower lowers A–Z only, keeping byte offsets (JS /i without `u` folds nothing else onto ASCII).
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		b[i] = lowerASCII(c)
	}
	return string(b)
}

func hasSuffixFold(s, suffix string) bool {
	return len(s) >= len(suffix) && hasPrefixFold(s[len(s)-len(suffix):], suffix)
}

// slug is s.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").
// Every character outside [a-z0-9_.-] becomes "-", so only lower-case mappings onto ASCII matter: A–Z, the Kelvin
// sign (→ k) and İ (→ "i" + U+0307, which becomes "i-").
func slug(s string) string {
	var b strings.Builder
	dash := false
	put := func(c byte) {
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '.' || c == '-' {
			b.WriteByte(c)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	for _, r := range s {
		switch {
		case r < utf8.RuneSelf:
			put(lowerASCII(byte(r)))
		case r == 0x212A:
			put('k')
		case r == 0x130:
			put('i')
			put(0x80) // U+0307
		default:
			put(0x80)
		}
	}
	out := b.String()
	i := 0
	for i < len(out) && !(out[i] >= 'a' && out[i] <= 'z' || out[i] >= '0' && out[i] <= '9') {
		i++
	}
	return strings.TrimRight(out[i:], "-")
}

// collapseWS is s.replace(/\s+/g, " ").
func collapseWS(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if jsstr.Space(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// lineStart reports whether i starts a line for a JS /m regular expression.
func lineStart(s string, i int) bool {
	if i == 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return jsstr.LineTerminator(r)
}

// firstHeading is text.match(/^#\s+(.+)$/m)?.[1]?.trim(); ok is false when there is no match.
func firstHeading(text string) (string, bool) {
	for p := 0; p < len(text); p++ {
		if text[p] != '#' || !lineStart(text, p) {
			continue
		}
		// \s+ greedy over JS whitespace (line terminators included), then .+ up to a line terminator.
		q := p + 1
		var spaces []int // start offsets of the whitespace characters
		for q < len(text) {
			r, w := utf8.DecodeRuneInString(text[q:])
			if !jsstr.Space(r) {
				break
			}
			spaces = append(spaces, q)
			q += w
		}
		if len(spaces) == 0 {
			continue
		}
		if q < len(text) {
			return jsstr.Trim(text[q:lineEnd(text, q)]), true
		}
		// Whitespace to the end: backtrack \s+ to the last non-terminator whitespace it can give back (.+ needs one).
		for k := len(spaces) - 1; k >= 1; k-- {
			r, _ := utf8.DecodeRuneInString(text[spaces[k]:])
			if !jsstr.LineTerminator(r) {
				return jsstr.Trim(text[spaces[k]:lineEnd(text, spaces[k])]), true
			}
		}
	}
	return "", false
}

func lineEnd(s string, i int) int {
	for i < len(s) {
		r, w := utf8.DecodeRuneInString(s[i:])
		if jsstr.LineTerminator(r) {
			return i
		}
		i += w
	}
	return i
}

// splitParagraphs is text.split(/\n\s*\n/): a separator runs from a "\n" to the last "\n" of the JS whitespace
// that follows it (greedy \s* gives characters back until a "\n" follows).
func splitParagraphs(text string) []string {
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] != '\n' {
			continue
		}
		last := -1
		for j := i + 1; j < len(text); {
			r, w := utf8.DecodeRuneInString(text[j:])
			if !jsstr.Space(r) {
				break
			}
			if r == '\n' {
				last = j
			}
			j += w
		}
		if last < 0 {
			continue
		}
		out = append(out, text[start:i])
		start = last + 1
		i = last
	}
	return append(out, text[start:])
}

// firstParagraph is firstParagraph() of importer.ts.
func firstParagraph(text string) string {
	if strings.HasPrefix(text, "---") {
		if end := strings.Index(text[3:], "---"); end >= 0 {
			text = text[3+end+3:]
		}
	}
	p := ""
	for _, part := range splitParagraphs(text) {
		t := jsstr.Trim(part)
		if t != "" && !strings.HasPrefix(t, "#") && !strings.HasPrefix(t, "```") &&
			!hasPrefixFold(t, "this file provides guidance to claude") {
			p = t
			break
		}
	}
	return jsstr.SliceUTF16(collapseWS(p), 300)
}

// frontmatter is frontmatter() of importer.ts: YAML-ish `---` header → top-level scalar fields + body.
func frontmatter(text string) (map[string]string, string) {
	fields := map[string]string{}
	// /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
	var start int
	switch {
	case strings.HasPrefix(text, "---\r\n"):
		start = 5
	case strings.HasPrefix(text, "---\n"):
		start = 4
	default:
		return fields, text
	}
	end, after := -1, 0
	for k := start; k < len(text); k++ {
		if strings.HasPrefix(text[k:], "\r\n---") {
			end, after = k, k+5
			break
		}
		if strings.HasPrefix(text[k:], "\n---") {
			end, after = k, k+4
			break
		}
	}
	if end < 0 {
		return fields, text
	}
	if after < len(text) && text[after] == '\r' {
		after++
	}
	if after < len(text) && text[after] == '\n' {
		after++
	}
	header, body := text[start:end], text[after:]

	key, style, parts := "", "plain", []string(nil)
	haveKey := false
	flush := func() {
		if !haveKey {
			return
		}
		var v string
		if style == "literal" {
			v = strings.Join(parts, "\n")
		} else {
			var kept []string
			for _, p := range parts {
				if p != "" {
					kept = append(kept, p)
				}
			}
			v = strings.Join(kept, " ")
		}
		fields[key] = jsstr.Trim(unquoteEnds(v))
	}
	for _, line := range splitCRLF(header) {
		if k, v, ok := keyValue(line); ok {
			flush()
			key, haveKey = k, true
			t := jsstr.Trim(v)
			if blockScalar(t) {
				style = map[byte]string{'>': "folded", '|': "literal"}[t[0]]
				parts = nil
			} else {
				style = "plain"
				parts = []string{t}
			}
		} else if haveKey && (indentedText(line) || jsstr.Trim(line) == "") {
			parts = append(parts, jsstr.Trim(line))
		}
	}
	flush()
	return fields, body
}

// splitCRLF is s.split(/\r?\n/).
func splitCRLF(s string) []string {
	parts := strings.Split(s, "\n")
	for i := 0; i < len(parts)-1; i++ {
		parts[i] = strings.TrimSuffix(parts[i], "\r")
	}
	return parts
}

// keyValue is line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/): the value is what follows the colon and the JS
// whitespace after it, and must hold no line terminator (`.` stops there and `$` is the end of the line).
func keyValue(line string) (string, string, bool) {
	if line == "" || !(isWord(line[0]) && !(line[0] >= '0' && line[0] <= '9')) {
		return "", "", false
	}
	i := 1
	for i < len(line) && (isWord(line[i]) || line[i] == '-') {
		i++
	}
	key := line[:i]
	i = skipWS(line, i)
	if i >= len(line) || line[i] != ':' {
		return "", "", false
	}
	i = skipWS(line, i+1)
	v := line[i:]
	if strings.IndexFunc(v, jsstr.LineTerminator) >= 0 {
		return "", "", false
	}
	return key, v, true
}

func skipWS(s string, i int) int {
	for i < len(s) {
		r, w := utf8.DecodeRuneInString(s[i:])
		if !jsstr.Space(r) {
			break
		}
		i += w
	}
	return i
}

// blockScalar is /^([>|])[-+]?$/ on the trimmed value.
func blockScalar(t string) bool {
	return (t == ">" || t == "|") || len(t) == 2 && (t[0] == '>' || t[0] == '|') && (t[1] == '-' || t[1] == '+')
}

// indentedText is /^\s+\S/.test(line).
func indentedText(line string) bool {
	i := skipWS(line, 0)
	return i > 0 && i < len(line)
}

// unquoteEnds is v.replace(/^["']|["']$/g, "").
func unquoteEnds(v string) string {
	if v != "" && (v[0] == '"' || v[0] == '\'') {
		v = v[1:]
		if v == "" {
			return v
		}
		if c := v[len(v)-1]; c == '"' || c == '\'' {
			return v[:len(v)-1]
		}
		return v
	}
	if v != "" && (v[len(v)-1] == '"' || v[len(v)-1] == '\'') {
		return v[:len(v)-1]
	}
	return v
}

// ---------------------------------------------------------------- credentials

var (
	secretRE = []*regexp.Regexp{
		regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`), // JWT
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
		regexp.MustCompile(`\b(AKIA|ASIA)[A-Z0-9]{16}\b`), // AWS key id
		regexp.MustCompile(`\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}`),
	}
	identifierPath = regexp.MustCompile(`^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$`)
	secretWords    = []string{"password", "passwd", "secret", "api_key", "api-key", "apikey", "token", "client_secret", "client-secret", "clientsecret"}
	placeholders   = []string{"<", "${", "{{", "xxx", "...", "your", "example", "changeme"}
)

func isValueChar(c byte) bool {
	return isWord(c) || c == '/' || c == '+' || c == '-' || c == '.'
}

// secretAnchors: a literal every match of secretRE[i] contains; the regular expression runs only when it occurs.
var secretAnchors = [][]string{{"eyJ"}, {"-----BEGIN "}, {"AKIA", "ASIA"}, {"_live_", "_test_"}}

// looksSecret is looksSecret() of importer.ts.
func looksSecret(text string) bool {
	for i, re := range secretRE {
		for _, a := range secretAnchors[i] {
			if strings.Contains(text, a) {
				if re.MatchString(text) {
					return true
				}
				break
			}
		}
	}
	// Every SECRET_ASSIGNMENT keyword contains one of these stems (case-insensitive): no stem, no match.
	lower := asciiLower(text)
	if !strings.Contains(lower, "passw") && !strings.Contains(lower, "secret") && !strings.Contains(lower, "api") &&
		!strings.Contains(lower, "token") {
		return false
	}
	// SECRET_ASSIGNMENT, matchAll semantics: leftmost match from `from`, the next search after its end.
	for from := 0; from < len(text); {
		start, value, end, ok := nextAssignment(text, lower, from)
		if !ok {
			return false
		}
		from = end
		if identifierPath.MatchString(value) || hasSuffixFold(text[:start], "paypal.com/checkoutnow?") {
			continue
		}
		return true
	}
	return false
}

// nextAssignment finds the leftmost match of
//
//	/\b[\w-]*(password|passwd|secret|api[_-]?key|token|client[_-]?secret)[\w-]*\s*[:=]\s*["']?(?!<|\$\{|\{\{|xxx|\.\.\.|your|example|changeme)([A-Za-z0-9/+_\-.]{12,})/i
//
// at or after from (lower is the ASCII-lowered text). The identifier is a whole [\w-] run: a shorter one cannot reach
// `\s*[:=]`. Within a run, \b first holds at its first word character; a later start sees a subset of the run and
// the same tail, so it cannot match where that one failed — one check per run.
func nextAssignment(text, lower string, from int) (start int, value string, end int, ok bool) {
	for s := from; s < len(text); {
		if !(isWord(text[s]) || text[s] == '-') {
			s++
			continue
		}
		e := s
		for e < len(text) && (isWord(text[e]) || text[e] == '-') {
			e++
		}
		w := s
		for w < e && !isWord(text[w]) {
			w++
		}
		if w == e { // dashes only: \b never holds inside
			s = e
			continue
		}
		start, value, end, ok = assignmentAt(text, lower, w, e)
		if ok {
			return
		}
		s = e
	}
	return 0, "", 0, false
}

// assignmentAt: the run text[s:e] holds a keyword and is followed by an accepted assignment.
func assignmentAt(text, lower string, s, e int) (int, string, int, bool) {
	run := lower[s:e]
	hit := false
	for _, w := range secretWords {
		if strings.Contains(run, w) {
			hit = true
			break
		}
	}
	if !hit {
		return 0, "", 0, false
	}
	i := skipWS(text, e)
	if i >= len(text) || (text[i] != ':' && text[i] != '=') {
		return 0, "", 0, false
	}
	i = skipWS(text, i+1)
	if i < len(text) && (text[i] == '"' || text[i] == '\'') {
		i++ // ["']? greedy; without it the value would have to start at the quote, which it cannot
	}
	for _, p := range placeholders {
		if hasPrefixFold(text[i:], p) {
			return 0, "", 0, false
		}
	}
	j := i
	for j < len(text) && isValueChar(text[j]) {
		j++
	}
	if j-i < 12 {
		return 0, "", 0, false
	}
	return s, text[i:j], j, true
}
