package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestReadyz(t *testing.T) {
	url := os.Getenv("PLATFORM_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PLATFORM_GO_TEST_DATABASE_URL not set")
	}
	db, err := OpenPool(context.Background(), url, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	w := httptest.NewRecorder()
	Readyz(db)(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("readyz = %d %s", w.Code, w.Body)
	}
	db.Close()
	w = httptest.NewRecorder()
	Readyz(db)(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz on closed pool = %d", w.Code)
	}
}
