package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrBusy means every analytics slot stayed taken until the request deadline: the caller may fall back.
var ErrBusy = errors.New("analytics capacity exhausted")

// Service runs analytics statements on its own read-only pool (platform.OpenReadOnlyPool). A slot is held per
// statement and there are as many slots as pool connections, so waiting is bounded by the request deadline and
// reported as ErrBusy instead of queueing silently inside the pool.
type Service struct {
	db    *pgxpool.Pool
	slots chan struct{}
	now   func() time.Time

	statements  atomic.Int64
	statementNs atomic.Int64
	requests    atomic.Int64
	busy        atomic.Int64
	slotWaitNs  atomic.Int64
	inflight    atomic.Int64
}

func NewService(db *pgxpool.Pool, maxConcurrent int) *Service {
	return &Service{db: db, slots: make(chan struct{}, max(1, maxConcurrent)), now: time.Now}
}

// Stats are cumulative counters since start, plus the pool's current state (GET /internal/v1/analytics/stats).
type Stats struct {
	Requests      int64   `json:"requests"`
	Statements    int64   `json:"statements"`
	StatementMs   float64 `json:"statement_ms"`
	Busy          int64   `json:"busy"`
	Inflight      int64   `json:"inflight"`
	SlotWaitMs    float64 `json:"slot_wait_ms"`
	MaxConcurrent int     `json:"max_concurrent"`
	Pool          struct {
		Max          int32   `json:"max"`
		Acquired     int32   `json:"acquired"`
		Idle         int32   `json:"idle"`
		Total        int32   `json:"total"`
		Acquires     int64   `json:"acquires"`
		EmptyAcquire int64   `json:"empty_acquires"`
		AcquireMs    float64 `json:"acquire_wait_ms"`
	} `json:"pool"`
}

func (s *Service) Stats() Stats {
	st := Stats{Requests: s.requests.Load(), Statements: s.statements.Load(),
		StatementMs: float64(s.statementNs.Load()) / 1e6, Busy: s.busy.Load(),
		Inflight: s.inflight.Load(), SlotWaitMs: float64(s.slotWaitNs.Load()) / 1e6, MaxConcurrent: cap(s.slots)}
	if s.db != nil {
		p := s.db.Stat()
		st.Pool.Max, st.Pool.Acquired, st.Pool.Idle, st.Pool.Total = p.MaxConns(), p.AcquiredConns(), p.IdleConns(), p.TotalConns()
		st.Pool.Acquires, st.Pool.EmptyAcquire = p.AcquireCount(), p.EmptyAcquireCount()
		st.Pool.AcquireMs = float64(p.AcquireDuration().Microseconds()) / 1000
	}
	return st
}

func (s *Service) acquire(ctx context.Context) error {
	start := time.Now()
	defer func() { s.slotWaitNs.Add(int64(time.Since(start))) }()
	select {
	case s.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			s.busy.Add(1)
			return ErrBusy
		}
		return ctx.Err()
	}
}

// numericText asks PostgreSQL for numeric in text form, which is exactly what node-postgres hands TypeScript.
var numericText = pgx.QueryResultFormatsByOID{pgtype.NumericOID: pgx.TextFormatCode}

// query runs one read-only statement under an analytics slot and converts rows the way node-postgres does.
func (s *Service) query(ctx context.Context, sql string, args ...any) ([]Row, error) {
	if err := s.acquire(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.slots }()
	s.statements.Add(1)
	start := time.Now()
	defer func() { s.statementNs.Add(int64(time.Since(start))) }()
	rows, err := s.db.Query(ctx, sql, append([]any{numericText}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	var out []Row
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		raw := rows.RawValues()
		r := Row{cols: make([]string, len(fields)), vals: make([]any, len(fields))}
		for i, f := range fields {
			r.cols[i] = f.Name
			r.vals[i] = jsValue(f, vals[i], raw[i])
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) one(ctx context.Context, sql string, args ...any) (Row, error) {
	rows, err := s.query(ctx, sql, args...)
	if err != nil {
		return Row{}, err
	}
	if len(rows) != 1 {
		return Row{}, fmt.Errorf("expected one row, got %d", len(rows))
	}
	return rows[0], nil
}

// jsValue converts a PostgreSQL value to the JSON value node-postgres produces with the platform's type parsers:
// int8 as a number (src/db/pool.ts), numeric as its exact text, timestamps as Date.toISOString(), json as parsed.
func jsValue(f pgconn.FieldDescription, v any, raw []byte) any {
	if v == nil {
		return nil
	}
	switch f.DataTypeOID {
	case pgtype.NumericOID:
		return string(raw)
	case pgtype.JSONOID, pgtype.JSONBOID:
		if raw == nil {
			return nil
		}
		return json.RawMessage(append([]byte(nil), raw...))
	}
	switch x := v.(type) {
	case time.Time:
		return isoTime(x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil // JSON.stringify(NaN) is null
		}
		return x
	case float32:
		return jsValue(f, float64(x), raw)
	case []any:
		for i := range x {
			if t, ok := x[i].(time.Time); ok {
				x[i] = isoTime(t)
			}
		}
		return x
	}
	return v
}

// isoTime is JavaScript's Date.prototype.toISOString (millisecond precision, truncated, UTC).
func isoTime(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

// Row keeps column order, as a node-postgres row object does, so responses keep their field order.
type Row struct {
	cols []string
	vals []any
}

func (r Row) Get(name string) any {
	for i, c := range r.cols {
		if c == name {
			return r.vals[i]
		}
	}
	return nil
}

func (r Row) MarshalJSON() ([]byte, error) {
	o := make(Object, 0, len(r.cols))
	for i, c := range r.cols {
		o = append(o, Field{c, r.vals[i]})
	}
	return o.MarshalJSON()
}

// Field and Object build JSON objects with a fixed key order.
type Field struct {
	Key   string
	Value any
}

type Object []Field

func (o Object) MarshalJSON() ([]byte, error) {
	buf := []byte{'{'}
	for i, f := range o {
		if i > 0 {
			buf = append(buf, ',')
		}
		k, _ := json.Marshal(f.Key)
		v, err := json.Marshal(f.Value)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f.Key, err)
		}
		buf = append(append(append(buf, k...), ':'), v...)
	}
	return append(buf, '}'), nil
}
