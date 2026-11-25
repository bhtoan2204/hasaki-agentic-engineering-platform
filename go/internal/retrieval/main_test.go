package retrieval

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"hasaki-orbit/go/internal/platform"
	"hasaki-orbit/go/internal/retrieval/embed"
	"hasaki-orbit/go/internal/testutil"
)

const testDims = 256

// testDB is a database migrated by the TypeScript runner (go/scripts/test-integration.sh); nil skips integration tests.
var testDB *pgxpool.Pool

func TestMain(m *testing.M) {
	if url := os.Getenv("PLATFORM_GO_TEST_DATABASE_URL"); url != "" {
		var err error
		if testDB, err = openMigrated(url); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	code := m.Run()
	if testDB != nil {
		testDB.Close()
	}
	os.Exit(code)
}

func openMigrated(url string) (*pgxpool.Pool, error) {
	ctx := context.Background()
	db, err := platform.OpenPool(ctx, url, 8)
	if err != nil {
		return nil, err
	}
	if err := platform.CheckSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// needDB returns the integration database emptied of knowledge and users.
func needDB(t testing.TB) *pgxpool.Pool {
	t.Helper()
	if testDB == nil {
		t.Skip("PLATFORM_GO_TEST_DATABASE_URL not set")
	}
	resetDB(t, testDB)
	return testDB
}

func resetDB(t testing.TB, db *pgxpool.Pool) {
	t.Helper()
	if _, err := db.Exec(context.Background(), "TRUNCATE users, knowledge_items RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
}

type fixture struct {
	db     *pgxpool.Pool
	fake   *testutil.FakeEmbedder
	svc    *Service
	worker *Worker
	http   *httpClient
}

func newFixture(t testing.TB, db *pgxpool.Pool, model string) *fixture {
	t.Helper()
	fake := testutil.NewFakeEmbedder(testDims)
	t.Cleanup(fake.Close)
	return fixtureWith(t, db, fake, model)
}

func fixtureWith(t testing.TB, db *pgxpool.Pool, fake *testutil.FakeEmbedder, model string) *fixture {
	t.Helper()
	e := embed.Ollama{URL: fake.URL, Model: model, Dims: testDims}
	svc, err := NewService(context.Background(), db, e, fmt.Sprintf("ollama/%s@%d", model, testDims), discard)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{db: db, fake: fake, svc: svc, worker: NewWorker(svc, 4, 2), http: &httpClient{t: t, h: testServer(svc)}}
}

func (f *fixture) drain(t testing.TB) {
	t.Helper()
	f.worker.drain(context.Background())
}

type item struct {
	key, category, title, description, content, trust string
	owner                                             int64
}

func (f *fixture) addUser(t testing.TB, name string) int64 {
	t.Helper()
	var id int64
	err := f.db.QueryRow(context.Background(),
		"INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'member') RETURNING id", name).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *fixture) addItem(t testing.TB, it item) int64 {
	t.Helper()
	if it.category == "" {
		it.category = "domain_knowledge"
	}
	if it.title == "" {
		it.title = it.key
	}
	var owner *int64
	if it.owner != 0 {
		owner = &it.owner
	}
	ctx := context.Background()
	var id int64
	err := f.db.QueryRow(ctx, `
		INSERT INTO knowledge_items (key, category, scope_type, title, current_version, owner_id)
		VALUES ($1, $2, 'GLOBAL', $3, 1, $4) RETURNING id`, it.key, it.category, it.title, owner).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	f.addVersion(t, id, 1, it)
	return id
}

func (f *fixture) addVersion(t testing.TB, id int64, version int, it item) {
	t.Helper()
	meta := map[string]any{"description": it.description}
	if it.trust != "" {
		meta["memory"] = map[string]any{"trust": it.trust}
	}
	m, _ := json.Marshal(meta)
	ctx := context.Background()
	if _, err := f.db.Exec(ctx, "INSERT INTO knowledge_versions (item_id, version, content, metadata) VALUES ($1, $2, $3, $4)",
		id, version, it.content, m); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, "UPDATE knowledge_items SET current_version = $2 WHERE id = $1", id, version); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) exec(t testing.TB, sql string, args ...any) {
	t.Helper()
	if _, err := f.db.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) count(t testing.TB, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := f.db.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
