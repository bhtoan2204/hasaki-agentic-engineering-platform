package codeintelligence

import (
	"encoding/hex"
	"testing"
)

// Expected values are what Node produces (Buffer#toString, String#slice/trim, the TypeScript regular expressions).

func TestDecodeUTF8MatchesNode(t *testing.T) {
	for in, want := range map[string]string{
		"61e28262": "a�b",  // truncated 3-byte sequence: one replacement
		"f09f9841": "�A",   // truncated 4-byte sequence
		"eda080":   "���",  // UTF-16 surrogate encoded in UTF-8
		"fffe":     "��",   // bytes that never start a sequence
		"c0af":     "��",   // overlong encoding
		"f4908080": "����", // above U+10FFFF
		"e282ac":   "€",
	} {
		b, _ := hex.DecodeString(in)
		if got := decodeUTF8(b); got != want {
			t.Errorf("%s: got %q, want %q", in, got, want)
		}
	}
}

func TestSliceUTF16MatchesNode(t *testing.T) {
	for _, c := range []struct {
		in   string
		n    int
		want string
	}{
		{"a😀b", 2, "a�"}, // a lone high surrogate reaches PostgreSQL as U+FFFD
		{"a😀b", 3, "a😀"},
		{"😀😀", 1, "�"},
		{"xyz", 5, "xyz"},
	} {
		if got := sliceUTF16(c.in, c.n); got != c.want {
			t.Errorf("%q[:%d]: got %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

func TestJSTrim(t *testing.T) {
	if got := jsTrim("\u00a0\u2028 x \ufeff\u3000"); got != "x" {
		t.Errorf("got %q", got)
	}
	if got := jsTrim("\u0085x\u180e"); got != "\u0085x\u180e" {
		t.Errorf("U+0085 and U+180E are not JavaScript whitespace: got %q", got)
	}
}

func TestMaskQuotedMatchesNode(t *testing.T) {
	for in, want := range map[string]string{
		`f(a = "x\"y", b = 'q')`: `f(a = "…", b = "…")`,
		`say("abc\")`:            `say("…")`, // backtracks: the backslash is taken as a plain character
		`"unterminated`:          `"unterminated`,
		`a "b" c 'd`:             `a "…" c 'd`,
		"\"x\\\ny\"":             "\"x\\\ny\"", // `.` stops at line terminators
	} {
		if got := maskQuoted(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestRedactSecrets(t *testing.T) {
	for in, want := range map[string]string{
		`connect(url = "https://admin:s3cr3tpass@db")`: `connect(url = "https://admin:***@db")`,
		`auth("Bearer abcdefghijklmnop")`:              `auth("Bearer ***")`,
		`f(password = "hunter22")`:                     `f(password = "***")`,
	} {
		if got := redactSecrets(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}
