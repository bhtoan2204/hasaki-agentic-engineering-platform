package retrieval

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode"
)

const (
	chunkSize    = 1500
	chunkOverlap = 200
	maxChunks    = 32
)

// sourceText is the embedded text of a source; status/stale checks in SQL hash the same concatenation.
func sourceText(title, description, content string) string {
	return title + "\n" + description + "\n\n" + content
}

func contentHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// chunkText splits text into at most maxChunks windows of about chunkSize runes, cutting at the last paragraph,
// sentence or word boundary in the second half of each window, with chunkOverlap runes carried over.
// Text past the last chunk is not embedded.
func chunkText(text string) []string {
	r := runePrefix(text, maxChunks*chunkSize)
	var out []string
	for start := 0; start < len(r) && len(out) < maxChunks; {
		end := len(r)
		if start+chunkSize < len(r) {
			end = cutPoint(r, start+chunkSize/2, start+chunkSize)
		}
		if c := strings.TrimSpace(string(r[start:end])); c != "" {
			out = append(out, c)
		}
		if end == len(r) {
			break
		}
		next := end - chunkOverlap
		for i := next; i < end; i++ {
			if unicode.IsSpace(r[i]) {
				next = i + 1
				break
			}
		}
		start = max(next, start+1)
	}
	return out
}

func runePrefix(s string, n int) []rune {
	r := make([]rune, 0, min(len(s), n))
	for _, c := range s {
		if len(r) == n {
			break
		}
		r = append(r, c)
	}
	return r
}

// cutPoint returns the end of the window (lo, hi]: after the last paragraph break, else after the last sentence end,
// else after the last whitespace, else hi.
func cutPoint(r []rune, lo, hi int) int {
	for i := hi - 1; i > lo; i-- {
		if r[i] == '\n' && r[i-1] == '\n' {
			return i + 1
		}
	}
	for i := hi - 1; i > lo; i-- {
		if strings.ContainsRune(".!?。！？", r[i-1]) && unicode.IsSpace(r[i]) || r[i] == '\n' {
			return i + 1
		}
	}
	for i := hi - 1; i > lo; i-- {
		if unicode.IsSpace(r[i]) {
			return i + 1
		}
	}
	return hi
}
