package retrieval

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestContentHash(t *testing.T) {
	// sha256("t\nd\n\nc"), the same value SQL computes in the status query.
	if got := contentHash(sourceText("t", "d", "c")); got != "63dedc45eb1c4ea3a5ef98ba156fe084dd084ca0ad11105e6c48ef3dc56fb6bc" {
		t.Fatalf("hash = %q", got)
	}
	if contentHash("a") == contentHash("b") {
		t.Fatal("hash not deterministic or not distinguishing")
	}
}

func TestChunkShortText(t *testing.T) {
	got := chunkText("  Title\nshort body  ")
	if len(got) != 1 || got[0] != "Title\nshort body" {
		t.Fatalf("chunks = %q", got)
	}
	if got := chunkText(" \n\n "); len(got) != 0 {
		t.Fatalf("blank text chunks = %q", got)
	}
}

func TestChunkBoundariesAndOverlap(t *testing.T) {
	var b strings.Builder
	for i := range 60 {
		b.WriteString("Sentence number ")
		b.WriteString(strings.Repeat("x", i%7+1))
		b.WriteString(" explains one rule of the platform in plain words. ")
		if i%10 == 9 {
			b.WriteString("\n\n")
		}
	}
	text := b.String()
	chunks := chunkText(text)
	if len(chunks) < 3 {
		t.Fatalf("got %d chunks", len(chunks))
	}
	for i, c := range chunks {
		if n := utf8.RuneCountInString(c); n > chunkSize {
			t.Fatalf("chunk %d has %d runes", i, n)
		}
		if i < len(chunks)-1 && !strings.HasSuffix(c, ".") {
			t.Errorf("chunk %d does not end at a sentence boundary: %q", i, c[len(c)-20:])
		}
		if i > 0 {
			prev := chunks[i-1]
			head := c[:20]
			if !strings.Contains(prev, head) {
				t.Errorf("chunk %d does not overlap its predecessor", i)
			}
		}
	}
	again := chunkText(text)
	if strings.Join(again, "|") != strings.Join(chunks, "|") {
		t.Fatal("chunking is not deterministic")
	}
}

func TestChunkMaxAndHardCut(t *testing.T) {
	chunks := chunkText(strings.Repeat("a", chunkSize*100))
	if len(chunks) != maxChunks {
		t.Fatalf("got %d chunks, want %d", len(chunks), maxChunks)
	}
	for _, c := range chunks {
		if len(c) != chunkSize {
			t.Fatalf("hard cut chunk has %d runes", len(c))
		}
	}
}

func TestChunkMultibyte(t *testing.T) {
	text := strings.Repeat("Quy tắc nghiệp vụ: đơn hàng phải được xác nhận trong vòng 24 giờ. ", 80)
	for _, c := range chunkText(text) {
		if !utf8.ValidString(c) || utf8.RuneCountInString(c) > chunkSize {
			t.Fatalf("invalid chunk of %d runes", utf8.RuneCountInString(c))
		}
	}
}

func BenchmarkChunkText(b *testing.B) {
	text := strings.Repeat("Platform knowledge explains how workflows resolve context. Each step loads rules.\n\n", 500)
	b.SetBytes(int64(len(text)))
	for b.Loop() {
		chunkText(text)
	}
}
