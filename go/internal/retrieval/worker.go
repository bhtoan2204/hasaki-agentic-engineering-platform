package retrieval

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const (
	maxAttempts  = 5
	claimLease   = 2 * time.Minute
	pollInterval = 30 * time.Second
	embedTimeout = time.Minute
)

// Worker drains retrieval.queue: it embeds eligible sources and removes the rows of ineligible ones.
type Worker struct {
	svc   *Service
	batch int
	sem   chan struct{}
	log   *slog.Logger
}

func NewWorker(svc *Service, batch, concurrency int) *Worker {
	return &Worker{svc: svc, batch: batch, sem: make(chan struct{}, concurrency), log: svc.log.With("component", "worker")}
}

// Run blocks until ctx is cancelled. Claims still held at that point are released for another worker.
func (w *Worker) Run(ctx context.Context) {
	var listener *pgx.Conn
	defer func() {
		if listener != nil {
			_ = listener.Close(context.Background())
		}
	}()
	w.sweep(ctx)
	for ctx.Err() == nil {
		w.drain(ctx)
		if listener == nil {
			listener = w.listen(ctx)
		}
		wctx, cancel := context.WithTimeout(ctx, pollInterval)
		var err error
		if listener != nil {
			_, err = listener.WaitForNotification(wctx)
		} else {
			<-wctx.Done()
			err = wctx.Err()
		}
		cancel()
		switch {
		case ctx.Err() != nil:
		case errors.Is(err, context.DeadlineExceeded):
			w.sweep(ctx)
		case err != nil:
			w.log.Warn("listen connection lost", "error", err)
			_ = listener.Close(ctx)
			listener = nil
		}
	}
}

func (w *Worker) listen(ctx context.Context) *pgx.Conn {
	conn, err := pgx.ConnectConfig(ctx, w.svc.store.db.Config().ConnConfig.Copy())
	if err == nil {
		_, err = conn.Exec(ctx, "LISTEN retrieval_queue")
		if err != nil {
			_ = conn.Close(ctx)
		}
	}
	if err != nil {
		if ctx.Err() == nil {
			w.log.Warn("listen failed, polling", "error", err)
		}
		return nil
	}
	return conn
}

func (w *Worker) sweep(ctx context.Context) {
	n, err := w.svc.store.enqueueMissing(ctx, w.svc.model)
	if err != nil {
		if ctx.Err() == nil {
			w.log.Error("enqueue missing sources", "error", err)
		}
		return
	}
	if n > 0 {
		w.log.Info("enqueued sources", "count", n)
	}
}

// drain processes due queue rows until none are left.
func (w *Worker) drain(ctx context.Context) {
	for ctx.Err() == nil {
		claims, err := w.svc.store.claim(ctx, w.batch*2, claimLease)
		if err != nil {
			if ctx.Err() == nil {
				w.log.Error("claim queue rows", "error", err)
			}
			return
		}
		if len(claims) == 0 {
			return
		}
		w.processAll(ctx, claims)
	}
}

func (w *Worker) processAll(ctx context.Context, claims []claim) {
	var (
		mu        sync.Mutex
		abandoned []int64
		wg        sync.WaitGroup
		next      = make(chan claim)
	)
	for range cap(w.sem) {
		wg.Go(func() {
			for c := range next {
				if ctx.Err() == nil {
					w.handle(ctx, c)
				}
				if ctx.Err() != nil {
					mu.Lock()
					abandoned = append(abandoned, c.sourceID)
					mu.Unlock()
				}
			}
		})
	}
	for _, c := range claims {
		next <- c
	}
	close(next)
	wg.Wait()
	if len(abandoned) > 0 {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := w.svc.store.release(rctx, abandoned); err != nil {
			w.log.Error("release claims", "error", err)
		}
	}
}

func (w *Worker) handle(ctx context.Context, c claim) {
	res, err := w.process(ctx, c)
	if err == nil || ctx.Err() != nil {
		return
	}
	log := w.log.With("source_id", c.sourceID, "attempt", c.attempts+1)
	if c.attempts+1 < maxAttempts {
		log.Warn("index failed, will retry", "error", err)
		if err := w.svc.store.retryLater(ctx, c); err != nil {
			log.Error("schedule retry", "error", err)
		}
		return
	}
	log.Error("index failed, giving up", "error", err)
	res.status, res.vectors = "failed", nil
	res.errMsg = truncate(err.Error(), 500)
	if err := w.svc.store.write(ctx, c, res); err != nil {
		log.Error("record failure", "error", err)
		return
	}
	w.svc.metrics.failed.Add(ctx, 1)
}

// process returns the source's version and hash alongside any error so that a final failure is recorded against
// the version that failed.
func (w *Worker) process(ctx context.Context, c claim) (indexResult, error) {
	st := w.svc.store
	res := indexResult{model: w.svc.model}
	src, ok, err := st.eligible(ctx, c.sourceID)
	if err != nil {
		return res, err
	}
	if !ok {
		return res, st.invalidate(ctx, c)
	}
	text := sourceText(src.title, src.description, src.content)
	res.version, res.hash = src.version, contentHash(text)
	if c.reason != "reindex" {
		cur, found, err := st.state(ctx, c.sourceID, w.svc.model)
		if err != nil {
			return res, err
		}
		if found && cur.version == res.version && cur.hash == res.hash && cur.status != "failed" {
			return res, st.dequeue(ctx, c)
		}
	}
	switch {
	case strings.TrimSpace(text) == "":
		res.status = "empty"
	case looksSecret(text):
		res.status = "skipped_sensitive"
	default:
		res.vectors, err = w.embedChunks(ctx, chunkText(text))
		if err != nil {
			return res, err
		}
		res.status = "indexed"
	}
	if err := st.write(ctx, c, res); err != nil {
		return res, err
	}
	if res.status == "indexed" {
		w.svc.metrics.indexed.Add(ctx, 1, metric.WithAttributes(attribute.String("model", w.svc.model)))
	}
	return res, nil
}

func (w *Worker) embedChunks(ctx context.Context, chunks []string) ([][]float32, error) {
	out := make([][]float32, len(chunks))
	errs := make([]error, 0, 1)
	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	for lo := 0; lo < len(chunks); lo += w.batch {
		hi := min(lo+w.batch, len(chunks))
		wg.Go(func() {
			w.sem <- struct{}{}
			defer func() { <-w.sem }()
			ectx, cancel := context.WithTimeout(ctx, embedTimeout)
			defer cancel()
			vecs, err := w.svc.embed(ectx, chunks[lo:hi])
			if err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
				return
			}
			copy(out[lo:hi], vecs)
		})
	}
	wg.Wait()
	return out, errors.Join(errs...)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
