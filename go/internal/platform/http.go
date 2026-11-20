package platform

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func WriteError(w http.ResponseWriter, status int, code, msg string) {
	WriteJSON(w, status, map[string]string{"error": msg, "code": code})
}

// RequireBearer rejects requests whose Authorization header does not carry token.
func RequireBearer(token string, next http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			WriteError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// WithDeadline bounds each request by min(X-Request-Timeout-Ms, max).
func WithDeadline(max time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d := max
		if ms, err := strconv.Atoi(r.Header.Get("X-Request-Timeout-Ms")); err == nil && ms > 0 {
			d = min(d, time.Duration(ms)*time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Observe extracts W3C trace context, opens a server span and logs one line per request.
func Observe(log *slog.Logger, next http.Handler) http.Handler {
	tracer := otel.Tracer("platform-go/http")
	prop := propagation.TraceContext{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := tracer.Start(ctx, r.Method+" "+r.URL.Path, trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r.WithContext(ctx))
		span.SetAttributes(attribute.Int("http.response.status_code", rec.status))
		log.LogAttrs(ctx, slog.LevelInfo, "http",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", rec.status),
			slog.Float64("duration_ms", float64(time.Since(start).Microseconds())/1000))
	})
}

func Healthz(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func Readyz(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "reason": "database"})
			return
		}
		if err := CheckSchema(ctx, db); err != nil {
			WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "reason": "schema"})
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}
