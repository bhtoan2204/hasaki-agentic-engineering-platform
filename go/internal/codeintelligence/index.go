// Package codeintelligence indexes repositories into the code_intelligence schema (symbols, relations and
// per-commit snapshots). TypeScript keeps the job queue, repository provisioning and authorization; this package
// does the CPU- and IO-heavy part of one job: file discovery, parsing, persistence and atomic publication.
package codeintelligence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Request is one indexing job, resolved and authorized by the TypeScript worker that holds its lease.
type Request struct {
	RepositoryID  int64  `json:"repository_id"`
	Primary       string `json:"primary"`
	Root          string `json:"root"`
	Base          string `json:"base"`
	RunID         *int64 `json:"run_id"`
	ParserVersion string `json:"parser_version"`
	InstanceID    string `json:"instance_id"`
	Fence         *Fence `json:"fence"`
	Limits        Limits `json:"limits"`
}

// Metrics keeps the keys of the TypeScript indexer's metrics (code_intelligence.runs.metrics).
type Metrics struct {
	IndexedFiles   int   `json:"indexed_files"`
	SkippedFiles   int   `json:"skipped_files"`
	ParseFailures  int   `json:"parse_failures"`
	IndexCacheHits int   `json:"index_cache_hits"`
	ParsedFiles    int   `json:"parsed_files"`
	DBStatements   int64 `json:"db_statements"`
	ParseWorkers   int   `json:"parse_workers"`
	IndexDuration  int64 `json:"index_duration,omitempty"`
	ProcessedFiles *int  `json:"processed_files,omitempty"`
	TotalFiles     *int  `json:"total_files,omitempty"`
}

type Response struct {
	Snapshot json.RawMessage `json:"snapshot"`
	Metrics  Metrics         `json:"metrics"`
}

// Indexer runs jobs with a bounded number of parse workers each, and at most `jobs` jobs at a time.
type Indexer struct {
	db      *pgxpool.Pool
	workers int
	jobs    chan struct{}
}

// NewIndexer leaves CPU for the API and the embedding worker: by default half the cores, at most four.
func NewIndexer(db *pgxpool.Pool, workers, jobs int) *Indexer {
	if workers <= 0 {
		workers = max(1, min(4, runtime.NumCPU()/2))
	}
	return &Indexer{db: db, workers: workers, jobs: make(chan struct{}, max(1, jobs))}
}

// ErrVersion means TypeScript asked for an index version this extractor does not produce.
var ErrVersion = errors.New("extractor version mismatch")

const batchSize = 400

// Index runs one job. Errors carry the TypeScript indexer's messages, which its diagnostic() categorizes.
func (ix *Indexer) Index(ctx context.Context, req Request) (Response, error) {
	if !strings.HasPrefix(req.ParserVersion, ExtractorVersion+"/") {
		return Response{}, ErrVersion
	}
	select {
	case ix.jobs <- struct{}{}:
		defer func() { <-ix.jobs }()
	case <-ctx.Done():
		return Response{}, ctx.Err()
	}
	start := time.Now()
	ctx, cancel := context.WithDeadline(ctx, start.Add(time.Duration(req.Limits.TimeoutMs)*time.Millisecond))
	defer cancel()
	j := &job{ix: ix, req: req, st: store{db: ix.db, version: req.ParserVersion, statements: &atomic.Int64{}}}
	j.m.ParseWorkers = ix.workers
	j.parsers = make([]Parsers, ix.workers)
	for i := range j.parsers {
		j.parsers[i] = Parsers{}
	}
	defer func() {
		for _, p := range j.parsers {
			p.Close()
		}
	}()
	snap, err := j.run(ctx)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			err = errors.New("Index timeout")
		}
		return Response{}, err
	}
	j.m.IndexDuration = time.Since(start).Milliseconds()
	j.m.DBStatements = j.st.statements.Load()
	return Response{Snapshot: snap, Metrics: j.m}, nil
}

type job struct {
	ix      *Indexer
	req     Request
	st      store
	m       Metrics
	parsers []Parsers
}

func (j *job) run(ctx context.Context) (json.RawMessage, error) {
	r := j.req
	baseIdentity := "base:" + r.Base
	baseline, baseID, err := j.st.snapshot(ctx, j.st.db, r.RepositoryID, baseIdentity)
	if err != nil {
		return nil, err
	}
	if baseline == nil {
		if baseline, baseID, err = j.indexBase(ctx); err != nil {
			return nil, err
		}
	}
	result, resultID := baseline, baseID
	if r.RunID != nil {
		if result, resultID, err = j.indexOverlay(ctx, baseID); err != nil {
			return nil, err
		}
	}
	if j.m.IndexedFiles, err = j.st.indexedFiles(ctx, resultID); err != nil {
		return nil, err
	}
	return result, nil
}

type blobBatch struct {
	offset int
	items  []source
	err    error
}

type source struct {
	index   int // position in the manifest
	path    string
	content string
	key     extractionKey
}

// indexBase indexes the base commit. Blobs are read by one goroutine one batch ahead of parsing, so Git IO,
// parsing and database writes overlap while at most two batches of source are in memory.
func (j *job) indexBase(ctx context.Context) (json.RawMessage, int64, error) {
	r := j.req
	manifest, err := treeFiles(ctx, r.Primary, r.Base, r.Limits, &j.m)
	if err != nil {
		return nil, 0, err
	}
	prior, err := j.st.priorExtractions(ctx, r.RepositoryID)
	if err != nil {
		return nil, 0, err
	}
	files := make([]fileRecord, len(manifest))
	for i, f := range manifest {
		files[i] = fileRecord{Path: f.Path, BlobHash: f.Blob}
	}
	reader, err := newBlobReader(ctx, r.Primary, r.Limits.MaxFileBytes)
	if err != nil {
		return nil, 0, err
	}
	defer reader.Close()
	batches := make(chan blobBatch, 1)
	readCtx, stopReading := context.WithCancel(ctx)
	// Runs before reader.Close: the producer has stopped using the git process when the channel is drained.
	defer func() {
		stopReading()
		for range batches {
		}
	}()
	go func() {
		defer close(batches)
		for offset := 0; offset < len(manifest); offset += batchSize {
			b := blobBatch{offset: offset}
			for i := offset; i < min(offset+batchSize, len(manifest)); i++ {
				f := manifest[i]
				if id, ok := prior[languageOf(f.Path)+":"+f.Blob]; ok {
					files[i].ExtractionID = id
					continue
				}
				content, err := reader.Read(f.Blob)
				if err != nil {
					b.err = err
					break
				}
				b.items = append(b.items, source{index: i, path: f.Path, content: content, key: extractionKey{languageOf(f.Path), sha256Hex(content)}})
			}
			select {
			case batches <- b:
			case <-readCtx.Done():
				return
			}
			if b.err != nil {
				return
			}
		}
	}()
	for b := range batches {
		if b.err != nil {
			return nil, 0, b.err
		}
		if err := j.st.progress(ctx, r.Fence, j.m, b.offset, len(manifest)); err != nil {
			return nil, 0, err
		}
		ids, err := j.resolve(ctx, b.items)
		if err != nil {
			return nil, 0, err
		}
		for _, s := range b.items {
			files[s.index].ExtractionID = ids[s.key]
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	for _, f := range files {
		if _, ok := prior[languageOf(f.Path)+":"+f.BlobHash]; ok {
			j.m.IndexCacheHits++
		}
	}
	return j.st.publish(ctx, snapshotInput{RepositoryID: r.RepositoryID, CommitSHA: r.Base, Identity: "base:" + r.Base}, files, r.Fence, nil)
}

// indexOverlay indexes a run worktree's changes on top of its base snapshot.
func (j *job) indexOverlay(ctx context.Context, baseID int64) (json.RawMessage, int64, error) {
	r := j.req
	head, generation, changes, err := worktreeChanges(ctx, r.Root, r.Base, r.Limits)
	if err != nil {
		return nil, 0, err
	}
	identity := fmt.Sprintf("overlay:%s:%d:%d:%s", r.InstanceID, *r.RunID, baseID, generation)
	if row, id, err := j.st.snapshot(ctx, j.st.db, r.RepositoryID, identity); err != nil || row != nil {
		return row, id, err
	}
	files := make([]fileRecord, len(changes))
	for offset := 0; offset < len(changes); offset += batchSize {
		if err := j.st.progress(ctx, r.Fence, j.m, offset, len(changes)); err != nil {
			return nil, 0, err
		}
		var items []source
		for i := offset; i < min(offset+batchSize, len(changes)); i++ {
			if c := changes[i]; c.Content != nil {
				items = append(items, source{index: i, path: c.Path, content: *c.Content, key: extractionKey{languageOf(c.Path), c.Hash}})
			}
		}
		ids, err := j.resolve(ctx, items)
		if err != nil {
			return nil, 0, err
		}
		for i := offset; i < min(offset+batchSize, len(changes)); i++ {
			c := changes[i]
			files[i] = fileRecord{Path: c.Path, BlobHash: c.Hash, Deleted: c.Content == nil}
			if c.Content != nil {
				files[i].ExtractionID = ids[extractionKey{languageOf(c.Path), c.Hash}]
			}
		}
	}
	base := baseID
	return j.st.publish(ctx, snapshotInput{
		RepositoryID: r.RepositoryID, CommitSHA: head, Identity: identity, BaseSnapshotID: &base,
		InstanceID: r.InstanceID, RunID: r.RunID, Generation: generation,
	}, files, r.Fence, func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		_, now, _, err := worktreeChanges(ctx, r.Root, r.Base, r.Limits)
		if err != nil {
			return err
		}
		if now != generation {
			return errors.New("Worktree changed while indexing")
		}
		return nil
	})
}

// resolve is extractionBatch() of src/codeIntelligence/store.ts: the extraction id of every distinct
// (language, content) — cached rows first, then parsed in parallel and stored in one transaction. Generated and
// unindexable files resolve to nil.
func (j *job) resolve(ctx context.Context, items []source) (map[extractionKey]*int64, error) {
	unique := map[extractionKey]source{}
	var order []extractionKey
	for _, s := range items {
		k := s.key
		if _, ok := unique[k]; !ok {
			order = append(order, k)
		}
		unique[k] = s // the last path wins, like the TypeScript Map
	}
	out := map[extractionKey]*int64{}
	if len(order) == 0 {
		return out, nil
	}
	cached, err := j.st.cached(ctx, j.st.db, order)
	if err != nil {
		return nil, err
	}
	j.m.IndexCacheHits += len(cached)
	var todo []extractionKey
	for _, k := range order {
		if id, ok := cached[k]; ok {
			out[k] = &id
			continue
		}
		s := unique[k]
		if !j.req.Limits.IncludeGenerated && generatedRe.MatchString(sliceUTF16(s.content, 1024)) {
			j.m.SkippedFiles++
			out[k] = nil
			continue
		}
		todo = append(todo, k)
	}
	parsed := make([]*Extraction, len(todo))
	errs := make([]error, len(todo))
	var next atomic.Int64
	var wg sync.WaitGroup
	for w := range min(len(todo), len(j.parsers)) {
		wg.Go(func() {
			for {
				i := int(next.Add(1) - 1)
				if i >= len(todo) || ctx.Err() != nil {
					return
				}
				s := unique[todo[i]]
				parsed[i], errs[i] = j.parsers[w].extract(ctx, s.path, s.content, s.key.hash, j.req.Limits)
			}
		})
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var store []*Extraction
	for i, e := range parsed {
		if errs[i] != nil {
			return nil, errs[i]
		}
		if e == nil {
			j.m.SkippedFiles++
			out[todo[i]] = nil
			continue
		}
		j.m.ParseFailures += e.ParseErrors
		store = append(store, e)
	}
	j.m.ParsedFiles += len(store)
	if len(store) == 0 {
		return out, nil
	}
	ids, err := j.st.persist(ctx, store)
	if err != nil {
		return nil, err
	}
	for _, e := range store {
		k := extractionKey{e.Language, e.ContentHash}
		if id, ok := ids[k]; ok {
			out[k] = &id
		}
	}
	return out, nil
}
