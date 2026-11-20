// Package retrieval indexes eligible knowledge into embeddings and serves semantic search over them.
package retrieval

import (
	"container/list"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Embedder turns texts into vectors of the configured dimension, one per text, in order.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

var (
	errVectorUnavailable = errors.New("pgvector extension is not installed")
	errEmbedder          = errors.New("embedder unavailable")
)

type Service struct {
	store    store
	embedder Embedder
	model    string
	vector   bool
	log      *slog.Logger
	cache    *queryCache
	tracer   trace.Tracer
	metrics  metrics
}

type metrics struct {
	searchMs metric.Float64Histogram
	embeds   metric.Int64Counter
	indexed  metric.Int64Counter
	failed   metric.Int64Counter
}

func NewService(ctx context.Context, db *pgxpool.Pool, embedder Embedder, model string, log *slog.Logger) (*Service, error) {
	st := store{db: db}
	vector, err := st.hasVector(ctx)
	if err != nil {
		return nil, fmt.Errorf("detect pgvector: %w", err)
	}
	if !vector {
		log.Warn("pgvector is not installed: search is unavailable, indexing continues")
	}
	return newService(st, embedder, model, vector, log)
}

func newService(st store, embedder Embedder, model string, vector bool, log *slog.Logger) (*Service, error) {
	s := &Service{
		store:    st,
		embedder: embedder,
		model:    model,
		vector:   vector,
		log:      log,
		cache:    newQueryCache(256),
		tracer:   otel.Tracer("platform-go/retrieval"),
	}
	m := otel.Meter("platform-go/retrieval")
	s.metrics.searchMs, _ = m.Float64Histogram("retrieval.search.duration", metric.WithUnit("ms"))
	s.metrics.embeds, _ = m.Int64Counter("retrieval.embed.requests")
	s.metrics.indexed, _ = m.Int64Counter("retrieval.sources.indexed")
	s.metrics.failed, _ = m.Int64Counter("retrieval.sources.failed")
	_, err := m.Int64ObservableGauge("retrieval.queue.depth", metric.WithInt64Callback(
		func(ctx context.Context, o metric.Int64Observer) error {
			ctx, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			n, err := s.store.queueDepth(ctx)
			if err == nil {
				o.Observe(n)
			}
			return err
		}))
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) embed(ctx context.Context, texts []string) ([][]float32, error) {
	ctx, span := s.tracer.Start(ctx, "retrieval.embed", trace.WithAttributes(attribute.Int("texts", len(texts))))
	defer span.End()
	vecs, err := s.embedder.Embed(ctx, texts)
	outcome := "ok"
	if err != nil {
		outcome = "error"
		span.RecordError(err)
	}
	s.metrics.embeds.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
	return vecs, err
}

type SearchRequest struct {
	OwnerID       int64    `json:"owner_id"`
	Query         string   `json:"query"`
	SourceIDs     []int64  `json:"source_ids,omitempty"`
	SourceKinds   []string `json:"source_kinds,omitempty"`
	TopK          int      `json:"top_k"`
	MinSimilarity *float64 `json:"min_similarity,omitempty"`
}

type SearchResponse struct {
	Model   string      `json:"model"`
	Results []SearchHit `json:"results"`
	TookMs  float64     `json:"took_ms"`
}

func (s *Service) Search(ctx context.Context, req SearchRequest) (SearchResponse, error) {
	start := time.Now()
	ctx, span := s.tracer.Start(ctx, "retrieval.search")
	defer span.End()
	if !s.vector {
		return SearchResponse{}, errVectorUnavailable
	}
	key := sha256.Sum256([]byte(s.model + "\x00" + req.Query))
	vec, ok := s.cache.get(key)
	if !ok {
		vecs, err := s.embed(ctx, []string{req.Query})
		if err != nil {
			if ctx.Err() != nil {
				return SearchResponse{}, ctx.Err()
			}
			return SearchResponse{}, fmt.Errorf("%w: %w", errEmbedder, err)
		}
		vec = vecs[0]
		s.cache.put(key, vec)
	}
	minSim := -2.0
	if req.MinSimilarity != nil {
		minSim = *req.MinSimilarity
	}
	hits, err := s.store.search(ctx, searchQuery{
		vector: vec, model: s.model, ownerID: req.OwnerID, sourceIDs: req.SourceIDs, sourceKinds: req.SourceKinds,
		minSimilarity: minSim, topK: req.TopK,
	})
	if err != nil {
		if ctx.Err() != nil {
			return SearchResponse{}, ctx.Err()
		}
		return SearchResponse{}, err
	}
	took := float64(time.Since(start).Microseconds()) / 1000
	s.metrics.searchMs.Record(ctx, took)
	return SearchResponse{Model: s.model, Results: hits, TookMs: took}, nil
}

func (s *Service) Status(ctx context.Context) (Status, error) {
	st, err := s.store.status(ctx, s.model)
	st.VectorExtension = s.vector
	return st, err
}

func (s *Service) Reindex(ctx context.Context, ids []int64, all bool) (int64, error) {
	return s.store.enqueue(ctx, ids, all)
}

type queryCache struct {
	mu    sync.Mutex
	size  int
	order *list.List
	items map[[32]byte]*list.Element
}

type cacheEntry struct {
	key [32]byte
	vec []float32
}

func newQueryCache(size int) *queryCache {
	return &queryCache{size: size, order: list.New(), items: make(map[[32]byte]*list.Element, size)}
}

func (c *queryCache) get(k [32]byte) ([]float32, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[k]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(e)
	return e.Value.(cacheEntry).vec, true
}

func (c *queryCache) put(k [32]byte, v []float32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[k]; ok {
		c.order.MoveToFront(e)
		return
	}
	c.items[k] = c.order.PushFront(cacheEntry{key: k, vec: v})
	if c.order.Len() > c.size {
		last := c.order.Back()
		c.order.Remove(last)
		delete(c.items, last.Value.(cacheEntry).key)
	}
}
