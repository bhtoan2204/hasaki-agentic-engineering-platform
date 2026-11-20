package platform

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

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
