package codeintelligence

import (
	"context"
	"os"
	"testing"
)

// BenchmarkExtractRepository parses every eligible file of a checkout (no database):
//
//	CODE_INDEX_PARITY_REPO=~/src/oms-src/oms-background go test -run x -bench ExtractRepository ./internal/codeintelligence/
func BenchmarkExtractRepository(b *testing.B) {
	repo := os.Getenv("CODE_INDEX_PARITY_REPO")
	if repo == "" {
		b.Skip()
	}
	lim := Limits{MaxFileBytes: 512 << 10, MaxSymbols: 2000, MaxFiles: 20000, MaxScanBytes: 128 << 20, TimeoutMs: 120000}
	ctx := context.Background()
	var m Metrics
	files, _ := treeFiles(ctx, repo, "HEAD", lim, &m)
	r, _ := newBlobReader(ctx, repo, lim.MaxFileBytes)
	var srcs []string
	for _, f := range files {
		s, _ := r.Read(f.Blob)
		srcs = append(srcs, s)
	}
	r.Close()
	p := Parsers{}
	defer p.Close()
	for b.Loop() {
		for j, f := range files {
			if _, err := p.Extract(ctx, f.Path, srcs[j], lim); err != nil {
				b.Fatal(err)
			}
		}
	}
}
