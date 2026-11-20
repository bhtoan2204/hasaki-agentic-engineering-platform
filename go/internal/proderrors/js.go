package proderrors

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The grouping code (merge.go) is a port of src/prodErrors/scan.ts toGroups/mergeSourceRows, which read loosely
// typed provider rows with JavaScript conversions. These helpers reproduce exactly the conversions it relies on, so
// both engines produce byte-identical groups (pinned by testdata/golden.json, generated from TypeScript).

// undefined marks a missing property where JavaScript distinguishes it from null.
type undefinedT struct{}

var undefined = undefinedT{}

func get(row map[string]any, key string) any {
	if v, ok := row[key]; ok {
		return v
	}
	return undefined
}

var decimalLiteral = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)

// jsNumber is Number(v).
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case undefinedT:
		return math.NaN()
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		return stringToNumber(x)
	case []any:
		return stringToNumber(jsString(x))
	}
	return math.NaN()
}

func stringToNumber(s string) float64 {
	s = strings.TrimFunc(s, isJSWhitespace)
	switch s {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		if base != 0 {
			n, err := strconv.ParseUint(s[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	if !decimalLiteral.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !strings.Contains(err.Error(), "range") {
		return math.NaN()
	}
	return f
}

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// num is scan.ts num(): Number(v) when finite, else 0.
func num(v any) float64 {
	if f := jsNumber(v); finite(f) {
		return f
	}
	return 0
}

// jsString is String(v).
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return numberToString(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				if _, u := e.(undefinedT); !u {
					parts[i] = jsString(e)
				}
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// numberToString is Number.prototype.toString() (ECMAScript Number::toString, radix 10).
func numberToString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	case f < 0:
		return "-" + numberToString(-f)
	}
	// Shortest round-trip digits and the decimal exponent n (value = 0.digits × 10^n).
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	x, _ := strconv.Atoi(exp)
	n := x + 1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	m := digits[:1]
	if k > 1 {
		m += "." + digits[1:]
	}
	return fmt.Sprintf("%se%s%d", m, sign, abs(n-1))
}

func abs(i int) int {
	if i < 0 {
		return -i
	}
	return i
}

// slice16 is String.prototype.slice(0, max): a prefix of max UTF-16 code units. A surrogate pair cut in half leaves a
// lone surrogate, which reaches PostgreSQL as U+FFFD from both engines.
func slice16(s string, max int) string {
	if len(s) <= max { // bytes ≥ code units
		return s
	}
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > max {
			if w == 2 && units < max {
				return s[:i] + string(utf8.RuneError)
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// toUpperJS is String.prototype.toUpperCase for log level names. Go's simple case mapping differs from JavaScript's
// full mapping only for a few characters (ß → SS) that never occur in a level.
func toUpperJS(s string) string { return strings.ToUpper(s) }

// isoJS is new Date(ms).toISOString(): ms truncated toward zero; an invalid date is an error (RangeError).
func isoJS(ms float64) (string, error) {
	if !finite(ms) || math.Abs(ms) > 8.64e15 {
		return "", fmt.Errorf("RangeError: Invalid time value")
	}
	t := time.UnixMilli(int64(math.Trunc(ms))).UTC()
	y := t.Year()
	rest := t.Format("-01-02T15:04:05.000Z")
	switch {
	case y >= 0 && y <= 9999:
		return fmt.Sprintf("%04d%s", y, rest), nil
	case y < 0:
		return fmt.Sprintf("-%06d%s", -y, rest), nil
	}
	return fmt.Sprintf("+%06d%s", y, rest), nil
}
