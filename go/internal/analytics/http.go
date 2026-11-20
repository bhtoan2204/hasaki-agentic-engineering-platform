package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"claude-task-platform/go/internal/platform"
)

// Response is the v1 envelope (go/contracts/analytics-v1.schema.json).
type Response struct {
	Data       any     `json:"data"`
	TookMs     float64 `json:"took_ms"`
	Statements int64   `json:"statements"`
}

// Routes registers the v1 analytics API. Each request runs under min(X-Request-Timeout-Ms, timeout), which also
// bounds the wait for an analytics slot; a client disconnect cancels the statements in PostgreSQL.
//
//	POST /internal/v1/analytics/{dashboard}   200 Response | 400 invalid_request | 503 busy/unavailable | 504 timeout
//	GET  /internal/v1/analytics/stats         200 Stats
func Routes(mux *http.ServeMux, s *Service, timeout time.Duration, log *slog.Logger) {
	mux.HandleFunc("GET /internal/v1/analytics/stats", func(w http.ResponseWriter, _ *http.Request) {
		platform.WriteJSON(w, http.StatusOK, s.Stats())
	})
	mux.HandleFunc("POST /internal/v1/analytics/{dashboard}", func(w http.ResponseWriter, r *http.Request) {
		d := timeout
		if ms, err := strconv.Atoi(r.Header.Get("X-Request-Timeout-Ms")); err == nil && ms > 0 {
			d = min(d, time.Duration(ms)*time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d + 5*time.Second))
		dashboard := r.PathValue("dashboard")
		var req Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body")
			return
		}
		if err := req.Validate(dashboard); err != nil {
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		start, before := time.Now(), s.statements.Load()
		s.requests.Add(1)
		s.inflight.Add(1)
		data, err := s.Load(ctx, dashboard, &req)
		s.inflight.Add(-1)
		switch {
		case err == nil:
			platform.WriteJSON(w, http.StatusOK, Response{Data: data,
				TookMs: float64(time.Since(start).Microseconds()) / 1000, Statements: s.statements.Load() - before})
		case errors.Is(err, ErrBusy):
			platform.WriteError(w, http.StatusServiceUnavailable, "busy", "analytics capacity exhausted")
		case errors.Is(err, context.DeadlineExceeded) || isCanceledQuery(err):
			if r.Context().Err() != nil {
				return // the caller is gone
			}
			platform.WriteError(w, http.StatusGatewayTimeout, "timeout", "analytics query exceeded its deadline")
		case errors.Is(err, context.Canceled):
			return
		default:
			// SQL text and parameters stay in the log; the caller only learns that the engine failed.
			log.Error("analytics query failed", "dashboard", dashboard, "error", err)
			platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", "analytics query failed")
		}
	})
}

// isCanceledQuery: PostgreSQL canceled the statement because its context ended (57014 query_canceled).
func isCanceledQuery(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "57014"
}

// Load runs one dashboard (exported for tests and benchmarks).
func (s *Service) Load(ctx context.Context, dashboard string, r *Request) (any, error) {
	switch dashboard {
	case "usage":
		return s.usage(ctx, r)
	case "performance":
		return s.performance(ctx, r)
	case "workflows":
		return s.workflows(ctx, r)
	case "health":
		return s.health(ctx, r)
	case "health-service":
		return s.healthService(ctx, r)
	case "options":
		return s.options(ctx, r)
	}
	return nil, invalid("unknown dashboard")
}
