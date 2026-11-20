package retrieval

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"claude-task-platform/go/internal/retrieval/embed"
	"claude-task-platform/go/internal/testutil"
)

const benchDims = 1024

func randomUnit(r *rand.Rand, dims int) []float32 {
	v := make([]float32, dims)
	var n float64
	for i := range v {
		x := r.NormFloat64()
		v[i] = float32(x)
		n += x * x
	}
	for i := range v {
		v[i] /= float32(math.Sqrt(n))
	}
	return v
}

// seedChunks writes n shared, indexed sources with one random chunk each, bypassing the embedder.
func seedChunks(b *testing.B, db *pgxpool.Pool, model string, n int) {
	b.Helper()
	ctx := context.Background()
	resetDB(b, db)
	exec := func(sql string, args ...any) {
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			b.Fatal(err)
		}
	}
	exec(`INSERT INTO knowledge_items (key, category, scope_type, title, current_version)
	      SELECT 'bench.' || g, 'domain_knowledge', 'GLOBAL', 'bench ' || g, 1 FROM generate_series(1, $1) g`, n)
	exec(`INSERT INTO knowledge_versions (item_id, version, content) SELECT id, 1, 'synthetic' FROM knowledge_items`)
	exec(`DELETE FROM retrieval.queue`)
	exec(`INSERT INTO retrieval.sources (source_id, model, source_version, content_hash, status, chunks)
	      SELECT id, $1, 1, repeat('0', 64), 'indexed', 1 FROM knowledge_items`, model)
	r := rand.New(rand.NewPCG(1, 2))
	_, err := db.CopyFrom(ctx, pgx.Identifier{"retrieval", "chunks"},
		[]string{"source_id", "model", "chunk", "dims", "embedding"},
		pgx.CopyFromSlice(n, func(i int) ([]any, error) {
			return []any{int64(i + 1), model, 0, benchDims, randomUnit(r, benchDims)}, nil
		}))
	if err != nil {
		b.Fatal(err)
	}
	exec("VACUUM ANALYZE retrieval.chunks")
}

func reportLatency(b *testing.B, samples []time.Duration) {
	slices.Sort(samples)
	pct := func(p float64) float64 {
		return float64(samples[int(p*float64(len(samples)-1))].Microseconds()) / 1000
	}
	b.ReportMetric(pct(0.50), "p50-ms")
	b.ReportMetric(pct(0.95), "p95-ms")
	b.ReportMetric(0, "ns/op")
}

func rssMB(b *testing.B) float64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		b.Fatal(err)
	}
	for line := range strings.Lines(string(data)) {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "VmRSS:" {
			kb, _ := strconv.Atoi(f[1])
			return float64(kb) / 1024
		}
	}
	return 0
}

// BenchmarkSearch measures the exact pgvector scan (SQL only) and the full service path (fake embedder over HTTP,
// cache miss on every query) at several corpus sizes of 1024-dim chunks.
func BenchmarkSearch(b *testing.B) {
	if testDB == nil {
		b.Skip("PLATFORM_GO_TEST_DATABASE_URL not set")
	}
	const model = "ollama/bench@1024"
	fake := testutil.NewFakeEmbedder(benchDims)
	defer fake.Close()
	for _, n := range []int{1000, 5000, 20000} {
		seedChunks(b, testDB, model, n)
		var size int64
		if err := testDB.QueryRow(context.Background(), "SELECT pg_total_relation_size('retrieval.chunks')").Scan(&size); err != nil {
			b.Fatal(err)
		}
		svc, err := newService(store{db: testDB}, embed.Ollama{URL: fake.URL, Model: "bench", Dims: benchDims}, model, true, discard)
		if err != nil {
			b.Fatal(err)
		}
		r := rand.New(rand.NewPCG(3, 4))
		b.Run(fmt.Sprintf("sql/chunks=%d", n), func(b *testing.B) {
			var samples []time.Duration
			for b.Loop() {
				q := searchQuery{vector: randomUnit(r, benchDims), model: model, ownerID: 1, minSimilarity: -2, topK: 30}
				start := time.Now()
				hits, err := svc.store.search(context.Background(), q)
				samples = append(samples, time.Since(start))
				if err != nil || len(hits) != 30 {
					b.Fatalf("hits=%d err=%v", len(hits), err)
				}
			}
			reportLatency(b, samples)
			b.ReportMetric(float64(size)/float64(n/1000)/(1<<20), "MiB/1k-chunks")
		})
		b.Run(fmt.Sprintf("service/chunks=%d", n), func(b *testing.B) {
			var samples []time.Duration
			i := 0
			for b.Loop() {
				i++
				start := time.Now()
				_, err := svc.Search(context.Background(), SearchRequest{OwnerID: 1, Query: fmt.Sprintf("query %d about orders", i), TopK: 30})
				samples = append(samples, time.Since(start))
				if err != nil {
					b.Fatal(err)
				}
			}
			reportLatency(b, samples)
			b.ReportMetric(rssMB(b), "rss-MiB")
		})
	}
}

// BenchmarkIndexing measures worker throughput (claim, chunk, embed with the fake provider, write) for sources of
// about three chunks each.
func BenchmarkIndexing(b *testing.B) {
	if testDB == nil {
		b.Skip("PLATFORM_GO_TEST_DATABASE_URL not set")
	}
	const sources = 500
	fake := testutil.NewFakeEmbedder(benchDims)
	defer fake.Close()
	svc, err := NewService(context.Background(), testDB, embed.Ollama{URL: fake.URL, Model: "bench", Dims: benchDims}, "ollama/bench@1024", discard)
	if err != nil {
		b.Fatal(err)
	}
	w := NewWorker(svc, 16, 2)
	paragraph := strings.Repeat("Orders are confirmed by the warehouse team within one business day. ", 20) + "\n\n"
	content := strings.Repeat(paragraph, 3)
	var elapsed time.Duration
	var chunks int
	for b.Loop() {
		b.StopTimer()
		resetDB(b, testDB)
		_, err := testDB.Exec(context.Background(), `
			WITH i AS (INSERT INTO knowledge_items (key, category, scope_type, title, current_version)
			           SELECT 'bench.' || g, 'domain_knowledge', 'GLOBAL', 'bench ' || g, 1 FROM generate_series(1, $1) g
			           RETURNING id)
			INSERT INTO knowledge_versions (item_id, version, content) SELECT id, 1, $2 || id FROM i`, sources, content)
		if err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
		start := time.Now()
		w.drain(context.Background())
		elapsed += time.Since(start)
		b.StopTimer()
		if err := testDB.QueryRow(context.Background(), "SELECT count(*) FROM retrieval.chunks").Scan(&chunks); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
	}
	b.ReportMetric(float64(sources*b.N)/elapsed.Seconds(), "sources/s")
	b.ReportMetric(float64(chunks*b.N)/elapsed.Seconds(), "chunks/s")
	b.ReportMetric(rssMB(b), "rss-MiB")
}
