// Package jsstr reproduces JavaScript string semantics the TypeScript platform relies on, for Go code whose output
// must match it byte for byte (code intelligence, knowledge import): UTF-16 lengths and slices, WHATWG UTF-8
// decoding (Node's Buffer#toString), String.prototype.trim and the `\s` class of JS regular expressions.
package jsstr

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode/utf8"
)

// DecodeUTF8 is Node's Buffer#toString("utf8"): every maximal invalid subpart becomes one U+FFFD (WHATWG).
func DecodeUTF8(b []byte) string {
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

func Sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// SliceUTF16 is s.slice(0, n) on a JS string. A cut inside a surrogate pair leaves a lone surrogate, which the
// PostgreSQL driver of the TypeScript side encodes as U+FFFD.
func SliceUTF16(s string, n int) string {
	if len(s) <= n { // never more UTF-16 units than UTF-8 bytes
		return s
	}
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

// Space is the WhiteSpace and LineTerminator set String.prototype.trim removes.
func Space(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func Trim(s string) string { return strings.TrimFunc(s, Space) }

// LineTerminator is what `.` in a JS regular expression does not match.
func LineTerminator(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }

// WS is JS `\s` as an RE2 character class (RE2's `\s` is ASCII only).
const WS = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// LenUTF16 is a JS string's length.
func LenUTF16(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
