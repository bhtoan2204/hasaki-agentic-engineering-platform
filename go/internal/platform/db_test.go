package platform

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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

func TestReadOnlyPoolRejectsWrites(t *testing.T) {
	url := os.Getenv("PLATFORM_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PLATFORM_GO_TEST_DATABASE_URL not set")
	}
	db, err := OpenReadOnlyPool(context.Background(), url, 1, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var mode, jit, plans string
	if err := db.QueryRow(context.Background(), `SELECT current_setting('transaction_read_only'),
		current_setting('jit'), current_setting('plan_cache_mode')`).Scan(&mode, &jit, &plans); err != nil {
		t.Fatal(err)
	}
	if mode != "on" || jit != "off" || plans != "force_custom_plan" {
		t.Fatalf("read_only=%s jit=%s plan_cache_mode=%s", mode, jit, plans)
	}
	_, err = db.Exec(context.Background(), "CREATE TEMP TABLE analytics_write_probe(x int)")
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "25006" { // read_only_sql_transaction
		t.Fatalf("write on the analytics pool: %v", err)
	}
}
