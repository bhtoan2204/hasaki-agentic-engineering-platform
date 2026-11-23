package platform

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
)

func TestObserveAccessLog(t *testing.T) {
	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	for _, tc := range []struct {
		method string
		path   string
		status int
		logged bool
	}{
		{http.MethodGet, "/healthz", http.StatusOK, false},
		{http.MethodHead, "/readyz", http.StatusOK, false},
		{http.MethodGet, "/readyz", http.StatusServiceUnavailable, true},
		{http.MethodPost, "/healthz", http.StatusMethodNotAllowed, true},
		{http.MethodGet, "/internal/v1/retrieval/status", http.StatusOK, true},
	} {
		t.Run(tc.method+" "+tc.path+" "+http.StatusText(tc.status), func(t *testing.T) {
			var buf bytes.Buffer
			h := Observe(slog.New(slog.NewJSONHandler(&buf, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := trace.SpanContextFromContext(r.Context()).TraceID().String(); got != traceID {
					t.Errorf("request trace ID = %s, want %s", got, traceID)
				}
				w.WriteHeader(tc.status)
			}))
			r := httptest.NewRequest(tc.method, tc.path+"?token=private", nil)
			r.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if !tc.logged {
				if buf.Len() != 0 {
					t.Fatalf("unexpected probe log: %s", buf.String())
				}
				return
			}
			var entry map[string]any
			if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
				t.Fatalf("expected one JSON access log: %v", err)
			}
			if entry["event"] != "http.request_completed" || entry["method"] != tc.method || entry["path"] != tc.path ||
				entry["status"] != float64(tc.status) || entry["trace_id"] != traceID || entry["span_id"] == nil {
				t.Fatalf("unexpected access log fields: %v", entry)
			}
		})
	}
}

func TestRequireBearer(t *testing.T) {
	h := RequireBearer(testToken, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for _, tc := range []struct {
		header string
		want   int
	}{
		{"", http.StatusUnauthorized},
		{"Bearer wrong", http.StatusUnauthorized},
		{testToken, http.StatusUnauthorized},
		{"bearer " + testToken, http.StatusUnauthorized},
		{"Bearer " + testToken + "x", http.StatusUnauthorized},
		{"Bearer " + testToken, http.StatusNoContent},
	} {
		r := httptest.NewRequest(http.MethodGet, "/internal/x", nil)
		if tc.header != "" {
			r.Header.Set("Authorization", tc.header)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("Authorization %q: status %d, want %d", tc.header, w.Code, tc.want)
		}
	}
}

func TestWithDeadline(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   time.Duration
	}{
		{"", 2 * time.Second},
		{"500", 500 * time.Millisecond},
		{"60000", 2 * time.Second},
		{"-5", 2 * time.Second},
		{"soon", 2 * time.Second},
	} {
		var got time.Duration
		h := WithDeadline(2*time.Second, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			dl, ok := r.Context().Deadline()
			if !ok {
				t.Fatal("no deadline")
			}
			got = time.Until(dl)
		}))
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		if tc.header != "" {
			r.Header.Set("X-Request-Timeout-Ms", tc.header)
		}
		h.ServeHTTP(httptest.NewRecorder(), r)
		if got > tc.want || got < tc.want-100*time.Millisecond {
			t.Errorf("X-Request-Timeout-Ms %q: deadline in %v, want ~%v", tc.header, got, tc.want)
		}
	}
}
