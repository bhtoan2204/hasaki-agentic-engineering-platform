package retrieval

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type store struct {
	db *pgxpool.Pool
}

type claim struct {
	sourceID   int64
	reason     string
	attempts   int
	enqueuedAt time.Time
}

type eligibleSource struct {
	version     int
	title       string
	description string
	content     string
}

type sourceState struct {
	version int
	hash    string
	status  string
}

func (s store) hasVector(ctx context.Context) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')").Scan(&ok)
	return ok, err
}

func (s store) claim(ctx context.Context, limit int, lease time.Duration) ([]claim, error) {
	rows, err := s.db.Query(ctx, `
		UPDATE retrieval.queue q SET claimed_until = now() + $2::interval
		 WHERE q.source_id IN (
		       SELECT source_id FROM retrieval.queue
		        WHERE next_attempt_at <= now() AND (claimed_until IS NULL OR claimed_until < now())
		        ORDER BY next_attempt_at
		        LIMIT $1
		        FOR UPDATE SKIP LOCKED)
		RETURNING q.source_id, q.reason, q.attempts, q.enqueued_at`, limit, lease)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (claim, error) {
		var c claim
		err := r.Scan(&c.sourceID, &c.reason, &c.attempts, &c.enqueuedAt)
		return c, err
	})
}

func (s store) eligible(ctx context.Context, id int64) (eligibleSource, bool, error) {
	var e eligibleSource
	err := s.db.QueryRow(ctx, `
		SELECT source_version, title, description, content FROM retrieval.eligible_sources WHERE source_id = $1`, id).
		Scan(&e.version, &e.title, &e.description, &e.content)
	if errors.Is(err, pgx.ErrNoRows) {
		return e, false, nil
	}
	return e, err == nil, err
}

func (s store) state(ctx context.Context, id int64, model string) (sourceState, bool, error) {
	var st sourceState
	err := s.db.QueryRow(ctx, `
		SELECT source_version, content_hash, status FROM retrieval.sources WHERE source_id = $1 AND model = $2`, id, model).
		Scan(&st.version, &st.hash, &st.status)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, false, nil
	}
	return st, err == nil, err
}

// dequeue removes the queue row only if it was not re-enqueued since the claim; otherwise it releases the claim
// so the newer change is picked up immediately.
func dequeue(ctx context.Context, tx pgx.Tx, c claim) error {
	tag, err := tx.Exec(ctx, "DELETE FROM retrieval.queue WHERE source_id = $1 AND enqueued_at = $2", c.sourceID, c.enqueuedAt)
	if err != nil || tag.RowsAffected() == 1 {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE retrieval.queue SET claimed_until = NULL WHERE source_id = $1", c.sourceID)
	return err
}

func (s store) dequeue(ctx context.Context, c claim) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error { return dequeue(ctx, tx, c) })
}

// retag points the source's existing state for the claim's model at a newer version with the same content hash.
func (s store) retag(ctx context.Context, c claim, model string, version int, hash string) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE retrieval.sources SET source_version = $3, updated_at = now()
			 WHERE source_id = $1 AND model = $2 AND content_hash = $4`, c.sourceID, model, version, hash); err != nil {
			return err
		}
		return dequeue(ctx, tx, c)
	})
}

// invalidate drops every model's rows for a source that is no longer eligible.
func (s store) invalidate(ctx context.Context, c claim) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "DELETE FROM retrieval.chunks WHERE source_id = $1", c.sourceID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "DELETE FROM retrieval.sources WHERE source_id = $1", c.sourceID); err != nil {
			return err
		}
		return dequeue(ctx, tx, c)
	})
}

type indexResult struct {
	model   string
	version int
	hash    string
	status  string
	vectors [][]float32
	errMsg  string
}

// write replaces the source's chunks and its row for r.model in one transaction. A terminal state for the current
// model also retires the rows of older models; a failure keeps them.
func (s store) write(ctx context.Context, c claim, r indexResult) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if r.status == "failed" {
			if _, err := tx.Exec(ctx, "DELETE FROM retrieval.chunks WHERE source_id = $1 AND model = $2", c.sourceID, r.model); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, "DELETE FROM retrieval.chunks WHERE source_id = $1", c.sourceID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM retrieval.sources WHERE source_id = $1 AND model <> $2", c.sourceID, r.model); err != nil {
				return err
			}
		}
		if len(r.vectors) > 0 {
			_, err := tx.CopyFrom(ctx, pgx.Identifier{"retrieval", "chunks"},
				[]string{"source_id", "model", "chunk", "dims", "embedding"},
				pgx.CopyFromSlice(len(r.vectors), func(i int) ([]any, error) {
					return []any{c.sourceID, r.model, i, len(r.vectors[i]), r.vectors[i]}, nil
				}))
			if err != nil {
				return err
			}
		}
		var errMsg *string
		if r.errMsg != "" {
			errMsg = &r.errMsg
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO retrieval.sources (source_id, model, source_version, content_hash, status, chunks, error, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, now())
			ON CONFLICT (source_id, model) DO UPDATE
			   SET source_version = excluded.source_version, content_hash = excluded.content_hash, status = excluded.status,
			       chunks = excluded.chunks, error = excluded.error, updated_at = now()`,
			c.sourceID, r.model, r.version, r.hash, r.status, len(r.vectors), errMsg)
		if err != nil {
			return err
		}
		return dequeue(ctx, tx, c)
	})
}

func (s store) retryLater(ctx context.Context, c claim) error {
	_, err := s.db.Exec(ctx, `
		UPDATE retrieval.queue
		   SET attempts = attempts + 1,
		       next_attempt_at = now() + make_interval(secs => least(power(2, attempts + 1) * 10, 1800)),
		       claimed_until = NULL
		 WHERE source_id = $1`, c.sourceID)
	return err
}

func (s store) release(ctx context.Context, ids []int64) error {
	_, err := s.db.Exec(ctx, "UPDATE retrieval.queue SET claimed_until = NULL WHERE source_id = ANY($1)", ids)
	return err
}

// enqueueMissing queues every eligible source the model has not handled at its current version (model change,
// first start) and every source that still has rows but is no longer eligible (expiry has no write to trigger on).
func (s store) enqueueMissing(ctx context.Context, model string) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		INSERT INTO retrieval.queue (source_id, reason)
		SELECT e.source_id, 'model' FROM retrieval.eligible_sources e
		 WHERE NOT EXISTS (SELECT 1 FROM retrieval.sources s
		                    WHERE s.source_id = e.source_id AND s.model = $1 AND s.source_version = e.source_version)
		UNION
		SELECT s.source_id, 'ineligible' FROM retrieval.sources s
		 WHERE NOT EXISTS (SELECT 1 FROM retrieval.eligible_sources e WHERE e.source_id = s.source_id)
		ON CONFLICT (source_id) DO NOTHING`, model)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (s store) enqueue(ctx context.Context, ids []int64, all bool) (int64, error) {
	var n int64
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO retrieval.queue (source_id, reason)
			SELECT id, 'reindex' FROM knowledge_items WHERE $1 OR id = ANY($2::bigint[])
			ON CONFLICT (source_id) DO UPDATE
			   SET reason = excluded.reason, attempts = 0, enqueued_at = now(), next_attempt_at = now(), claimed_until = NULL`,
			all, ids)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		_, err = tx.Exec(ctx, "SELECT pg_notify('retrieval_queue', '')")
		return err
	})
	return n, err
}

func (s store) queueDepth(ctx context.Context) (int64, error) {
	var n int64
	err := s.db.QueryRow(ctx, "SELECT count(*) FROM retrieval.queue").Scan(&n)
	return n, err
}

type Status struct {
	VectorExtension  bool   `json:"vector_extension"`
	Model            string `json:"model"`
	QueueDepth       int64  `json:"queue_depth"`
	Indexed          int64  `json:"indexed"`
	SkippedSensitive int64  `json:"skipped_sensitive"`
	Failed           int64  `json:"failed"`
	Stale            int64  `json:"stale"`
}

func (s store) status(ctx context.Context, model string) (Status, error) {
	st := Status{Model: model}
	err := s.db.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM retrieval.queue),
		       count(*) FILTER (WHERE status = 'indexed'),
		       count(*) FILTER (WHERE status = 'skipped_sensitive'),
		       count(*) FILTER (WHERE status = 'failed'),
		       (SELECT count(*) FROM retrieval.eligible_sources e
		         WHERE NOT EXISTS (
		               SELECT 1 FROM retrieval.sources s
		                WHERE s.source_id = e.source_id AND s.model = $1 AND s.source_version = e.source_version
		                  AND s.status IN ('indexed', 'skipped_sensitive', 'empty')
		                  AND s.content_hash = encode(sha256(convert_to(
		                        e.title || E'\n' || e.description || E'\n\n' || e.content, 'UTF8')), 'hex')))
		  FROM retrieval.sources WHERE model = $1`, model).
		Scan(&st.QueueDepth, &st.Indexed, &st.SkippedSensitive, &st.Failed, &st.Stale)
	return st, err
}

type SearchHit struct {
	SourceID    int64   `json:"source_id"`
	Key         string  `json:"key"`
	SourceKind  string  `json:"source_kind"`
	Version     int     `json:"version"`
	ContentHash string  `json:"content_hash"`
	Similarity  float64 `json:"similarity"`
	Chunk       int     `json:"chunk"`
}

type searchQuery struct {
	vector        []float32
	model         string
	ownerID       int64
	sourceIDs     []int64
	sourceKinds   []string
	minSimilarity float64
	topK          int
}

// search is one exact cosine scan: best chunk per source, restricted to sources the owner may see whose indexed
// version is still the eligible one.
func (s store) search(ctx context.Context, q searchQuery) ([]SearchHit, error) {
	rows, err := s.db.Query(ctx, `
		WITH best AS (
		  SELECT DISTINCT ON (c.source_id) c.source_id, c.chunk, c.embedding::vector <=> q.v AS distance
		    FROM retrieval.chunks c
		    JOIN knowledge_items i ON i.id = c.source_id
		   CROSS JOIN (SELECT $1::real[]::vector AS v) q
		   WHERE c.model = $2
		     AND (i.owner_id IS NULL OR i.owner_id = $3)
		     AND ($4::bigint[] IS NULL OR c.source_id = ANY($4))
		   ORDER BY c.source_id, distance
		)
		SELECT e.source_id, e.key, e.source_kind, e.source_version, s.content_hash, 1 - b.distance, b.chunk
		  FROM best b
		  JOIN retrieval.sources s ON s.source_id = b.source_id AND s.model = $2 AND s.status = 'indexed'
		  JOIN retrieval.eligible_sources e ON e.source_id = b.source_id AND e.source_version = s.source_version
		 WHERE ($5::text[] IS NULL OR e.source_kind = ANY($5))
		   AND b.distance <> 'NaN' AND 1 - b.distance >= $6
		 ORDER BY b.distance, e.source_id
		 LIMIT $7`,
		q.vector, q.model, q.ownerID, q.sourceIDs, q.sourceKinds, q.minSimilarity, q.topK)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (SearchHit, error) {
		var h SearchHit
		err := r.Scan(&h.SourceID, &h.Key, &h.SourceKind, &h.Version, &h.ContentHash, &h.Similarity, &h.Chunk)
		return h, err
	})
}
