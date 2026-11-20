package retrieval

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"testing"
	"time"
)

type httpClient struct {
	t testing.TB
	h http.Handler
}

func (c *httpClient) search(body string) SearchResponse {
	c.t.Helper()
	w := call(c.t, c.h, http.MethodPost, "/internal/v1/retrieval/search", body)
	if w.Code != http.StatusOK {
		c.t.Fatalf("search: %d %s", w.Code, w.Body)
	}
	assertContract(c.t, "SearchResponse", w.Body.Bytes())
	var resp SearchResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		c.t.Fatal(err)
	}
	return resp
}

func (c *httpClient) status() Status {
	c.t.Helper()
	w := call(c.t, c.h, http.MethodGet, "/internal/v1/retrieval/status", "")
	if w.Code != http.StatusOK {
		c.t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	assertContract(c.t, "Status", w.Body.Bytes())
	var st Status
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	return st
}

func searchBody(owner int64, query string, extra string) string {
	return fmt.Sprintf(`{"owner_id":%d,"query":%q,"top_k":10%s}`, owner, query, extra)
}

func keys(r SearchResponse) []string {
	out := make([]string, len(r.Results))
	for i, h := range r.Results {
		out[i] = h.Key
	}
	return out
}

func TestIndexAndSearch(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	u := f.addUser(t, "alice")
	f.addItem(t, item{key: "orders.confirmation", title: "Order confirmation", content: "Orders must be confirmed by the warehouse within 24 hours."})
	f.addItem(t, item{key: "skill.deploy", category: "agent_skill", title: "Deploy", content: "Deploy services with the release pipeline and roll back on alerts."})
	f.addItem(t, item{key: "pricing.discount", title: "Discounts", description: "promotion rules", content: "Discounts stack up to 30 percent for loyalty members."})

	if st := f.http.status(); st.QueueDepth != 3 || st.Stale != 3 || st.Indexed != 0 {
		t.Fatalf("before indexing: %+v", st)
	}
	f.drain(t)
	st := f.http.status()
	if st.QueueDepth != 0 || st.Indexed != 3 || st.Stale != 0 || st.Failed != 0 || !st.VectorExtension {
		t.Fatalf("after indexing: %+v", st)
	}

	resp := f.http.search(searchBody(u, "how fast must the warehouse confirm orders", ""))
	if len(resp.Results) == 0 || resp.Results[0].Key != "orders.confirmation" {
		t.Fatalf("results = %v", keys(resp))
	}
	hit := resp.Results[0]
	if hit.Version != 1 || hit.SourceKind != "knowledge" || hit.Chunk != 0 ||
		hit.ContentHash != contentHash(sourceText("Order confirmation", "", "Orders must be confirmed by the warehouse within 24 hours.")) {
		t.Fatalf("hit = %+v", hit)
	}
	for i := 1; i < len(resp.Results); i++ {
		if resp.Results[i].Similarity > resp.Results[i-1].Similarity {
			t.Fatal("results not ordered by similarity")
		}
	}
	if resp.Model != "ollama/m1@256" {
		t.Fatalf("model = %q", resp.Model)
	}

	kinds := f.http.search(searchBody(u, "deploy release pipeline", `,"source_kinds":["skill"]`))
	if !slices.Equal(keys(kinds), []string{"skill.deploy"}) {
		t.Fatalf("kind filter = %v", keys(kinds))
	}
	strict := f.http.search(searchBody(u, "deploy release pipeline", `,"min_similarity":0.99`))
	if len(strict.Results) != 0 {
		t.Fatalf("min_similarity ignored: %v", keys(strict))
	}

	before := f.fake.Requests.Load()
	f.http.search(searchBody(u, "how fast must the warehouse confirm orders", ""))
	if f.fake.Requests.Load() != before {
		t.Fatal("repeated query was embedded again")
	}
}

func TestUnchangedContentIsNotReembedded(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	f.addItem(t, item{key: "a", content: "alpha content"})
	f.drain(t)
	texts := f.fake.Texts.Load()
	f.exec(t, "UPDATE knowledge_items SET updated_at = now(), priority = priority + 1")
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue"); n != 1 {
		t.Fatalf("trigger did not enqueue: %d", n)
	}
	f.drain(t)
	if f.fake.Texts.Load() != texts {
		t.Fatal("unchanged content was embedded again")
	}
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue"); n != 0 {
		t.Fatalf("queue not drained: %d", n)
	}
}

func TestNewVersionWithSameTextIsNotReembedded(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	u := f.addUser(t, "alice")
	id := f.addItem(t, item{key: "a", content: "refunds are approved by finance"})
	f.drain(t)
	texts := f.fake.Texts.Load()
	// A re-import that only changed metadata (e.g. the source path): same title, description and content.
	f.addVersion(t, id, 2, item{content: "refunds are approved by finance"})
	f.drain(t)
	if f.fake.Texts.Load() != texts {
		t.Fatal("identical text was embedded again")
	}
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE source_version = 2 AND status = 'indexed'"); n != 1 {
		t.Fatalf("state not moved to version 2: %d", n)
	}
	if !f.http.status().VectorExtension {
		return // search needs pgvector
	}
	resp := f.http.search(searchBody(u, "who approves refunds", ""))
	if len(resp.Results) != 1 || resp.Results[0].Version != 2 {
		t.Fatalf("results = %+v", resp.Results)
	}
}

func TestNewVersionReindexes(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	u := f.addUser(t, "alice")
	id := f.addItem(t, item{key: "a", content: "invoices are archived monthly"})
	f.drain(t)
	f.addVersion(t, id, 2, item{content: "refunds are approved by finance"})
	f.drain(t)
	resp := f.http.search(searchBody(u, "who approves refunds", ""))
	if len(resp.Results) != 1 || resp.Results[0].Version != 2 {
		t.Fatalf("results = %+v", resp.Results)
	}
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE source_version = 2 AND status = 'indexed'"); n != 1 {
		t.Fatalf("sources at v2 = %d", n)
	}
}

func TestStaleVersionIsNotReturnedBeforeReindex(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	u := f.addUser(t, "alice")
	id := f.addItem(t, item{key: "a", content: "invoices are archived monthly"})
	f.drain(t)
	f.addVersion(t, id, 2, item{content: "invoices are archived monthly, now weekly"})
	if r := f.http.search(searchBody(u, "invoices archived", "")); len(r.Results) != 0 {
		t.Fatalf("stale embedding returned: %+v", r.Results)
	}
	if st := f.http.status(); st.Stale != 1 {
		t.Fatalf("stale = %d", st.Stale)
	}
}

func TestReenqueueDuringProcessingIsKept(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	id := f.addItem(t, item{key: "a", content: "first"})
	claims, err := f.svc.store.claim(context.Background(), 10, claimLease)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim: %v %v", claims, err)
	}
	f.addVersion(t, id, 2, item{content: "second"})
	f.worker.processAll(context.Background(), claims)
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue WHERE claimed_until IS NULL"); n != 1 {
		t.Fatalf("newer change was dropped from the queue: %d", n)
	}
	f.drain(t)
	if n := f.count(t, "SELECT source_version FROM retrieval.sources"); n != 2 {
		t.Fatalf("indexed version %d, want 2", n)
	}
}

func TestIneligibleSourcesAreInvalidated(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	disabled := f.addItem(t, item{key: "a", content: "alpha"})
	expired := f.addItem(t, item{key: "b", content: "beta"})
	superseded := f.addItem(t, item{key: "c", content: "gamma"})
	kept := f.addItem(t, item{key: "d", content: "delta"})
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.chunks"); n != 4 {
		t.Fatalf("chunks = %d", n)
	}
	f.exec(t, "UPDATE knowledge_items SET enabled = false WHERE id = $1", disabled)
	f.exec(t, "UPDATE knowledge_items SET superseded_by = $2 WHERE id = $1", superseded, kept)
	f.drain(t)
	// Expiry happens without a write: only the periodic sweep notices it.
	f.exec(t, "UPDATE knowledge_items SET expires_at = now() + interval '50 milliseconds' WHERE id = $1", expired)
	f.drain(t)
	time.Sleep(60 * time.Millisecond)
	f.worker.sweep(context.Background())
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE source_id <> $1", kept); n != 0 {
		t.Fatalf("ineligible sources still indexed: %d", n)
	}
	if n := f.count(t, "SELECT count(*) FROM retrieval.chunks WHERE source_id <> $1", kept); n != 0 {
		t.Fatalf("ineligible chunks remain: %d", n)
	}
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue"); n != 0 {
		t.Fatalf("queue = %d", n)
	}
}

func TestDeleteCascades(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	id := f.addItem(t, item{key: "a", content: "alpha"})
	f.addItem(t, item{key: "b", content: "beta"})
	f.drain(t)
	f.addVersion(t, id, 2, item{content: "alpha two"})
	f.exec(t, "DELETE FROM knowledge_items WHERE id = $1", id)
	for _, table := range []string{"retrieval.sources", "retrieval.chunks", "retrieval.queue"} {
		if n := f.count(t, "SELECT count(*) FROM "+table+" WHERE source_id = $1", id); n != 0 {
			t.Fatalf("%s keeps %d rows of a deleted item", table, n)
		}
	}
}

func TestOwnerIsolation(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	alice, bob := f.addUser(t, "alice"), f.addUser(t, "bob")
	f.addItem(t, item{key: "memory.chat.bob1", category: "task_memory", owner: bob, content: "bob prefers vietnamese replies about invoices"})
	f.addItem(t, item{key: "memory.chat.alice1", category: "task_memory", owner: alice, content: "alice prefers short replies about invoices"})
	f.addItem(t, item{key: "shared", content: "invoices are archived monthly"})
	f.drain(t)

	got := keys(f.http.search(searchBody(alice, "bob prefers vietnamese replies about invoices", "")))
	if slices.Contains(got, "memory.chat.bob1") || !slices.Contains(got, "memory.chat.alice1") || !slices.Contains(got, "shared") {
		t.Fatalf("alice sees %v", got)
	}
	explicit := keys(f.http.search(searchBody(alice, "bob prefers vietnamese", `,"source_ids":[1,2,3]`)))
	if slices.Contains(explicit, "memory.chat.bob1") {
		t.Fatal("source_ids bypassed the owner filter")
	}
	bobs := f.http.search(searchBody(bob, "bob prefers vietnamese replies", `,"source_kinds":["chat_memory"]`))
	if !slices.Equal(keys(bobs), []string{"memory.chat.bob1"}) {
		t.Fatalf("bob sees %v", keys(bobs))
	}
}

func TestUnverifiedTaskMemoryIsNeverIndexed(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	u := f.addUser(t, "alice")
	unverified := f.addItem(t, item{key: "memory.run.x", category: "task_memory", trust: "unverified", content: "the build is flaky"})
	f.addItem(t, item{key: "memory.lesson.y", category: "task_memory", trust: "unverified", content: "a disputed lesson"})
	f.addItem(t, item{key: "memory.lesson.z", category: "task_memory", trust: "verified", content: "a verified lesson"})
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources"); n != 1 {
		t.Fatalf("indexed %d sources, want only the verified lesson", n)
	}
	if f.fake.Texts.Load() != 1 {
		t.Fatalf("embedded %d texts", f.fake.Texts.Load())
	}
	r := f.http.search(searchBody(u, "lesson", ""))
	if !slices.Equal(keys(r), []string{"memory.lesson.z"}) || r.Results[0].SourceKind != "lesson" {
		t.Fatalf("results = %+v", r.Results)
	}
	f.addVersion(t, unverified, 2, item{content: "the build is flaky", trust: "verified"})
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE source_id = $1", unverified); n != 1 {
		t.Fatal("verified task memory not indexed")
	}
}

func TestSourceIDsRestriction(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	u := f.addUser(t, "alice")
	a := f.addItem(t, item{key: "a", content: "refund policy for damaged goods"})
	f.addItem(t, item{key: "b", content: "refund policy for late delivery"})
	f.drain(t)
	r := f.http.search(searchBody(u, "refund policy", fmt.Sprintf(`,"source_ids":[%d]`, a)))
	if !slices.Equal(keys(r), []string{"a"}) {
		t.Fatalf("results = %v", keys(r))
	}
}

func TestSensitiveAndEmptySources(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	f.addItem(t, item{key: "a", content: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"})
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE status = 'skipped_sensitive' AND chunks = 0"); n != 1 {
		t.Fatal("secret not skipped")
	}
	if f.fake.Texts.Load() != 0 || f.count(t, "SELECT count(*) FROM retrieval.chunks") != 0 {
		t.Fatal("secret content was embedded")
	}
	if st := f.http.status(); st.SkippedSensitive != 1 || st.Stale != 0 {
		t.Fatalf("status = %+v", st)
	}
	f.addItem(t, item{key: "b", title: " ", content: "\n"})
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE status = 'empty' AND chunks = 0"); n != 1 || f.fake.Texts.Load() != 0 {
		t.Fatal("empty source not recorded as empty")
	}
}

func TestModelChangeReindexes(t *testing.T) {
	db := needDB(t)
	old := newFixture(t, db, "m1")
	u := old.addUser(t, "alice")
	old.addItem(t, item{key: "a", content: "refund policy for damaged goods"})
	old.addItem(t, item{key: "b", content: "shipping times for remote islands"})
	old.drain(t)

	f := fixtureWith(t, db, old.fake, "m2")
	if st := f.http.status(); st.Stale != 2 || st.Indexed != 0 {
		t.Fatalf("new model status = %+v", st)
	}
	f.worker.sweep(context.Background())
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue WHERE reason = 'model'"); n != 2 {
		t.Fatalf("model change enqueued %d", n)
	}
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.sources WHERE model = 'ollama/m1@256'"); n != 0 {
		t.Fatalf("old model rows kept: %d", n)
	}
	if n := f.count(t, "SELECT count(DISTINCT model) FROM retrieval.chunks"); n != 1 {
		t.Fatal("old model chunks kept")
	}
	r := f.http.search(searchBody(u, "refund policy", ""))
	if len(r.Results) == 0 || r.Results[0].Key != "a" || r.Model != "ollama/m2@256" {
		t.Fatalf("results = %+v", r)
	}
	f.worker.sweep(context.Background())
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue"); n != 0 {
		t.Fatalf("sweep re-enqueued indexed sources: %d", n)
	}
}

func TestRetryBackoffThenFailed(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	id := f.addItem(t, item{key: "a", content: "alpha"})
	f.fake.Fail.Store(true)
	for attempt := 1; attempt < maxAttempts; attempt++ {
		f.drain(t)
		var attempts int
		var wait time.Duration
		err := f.db.QueryRow(context.Background(),
			"SELECT attempts, next_attempt_at - now() FROM retrieval.queue WHERE claimed_until IS NULL").Scan(&attempts, &wait)
		if err != nil {
			t.Fatal(err)
		}
		want := min(time.Duration(1<<attempt)*10*time.Second, 30*time.Minute)
		if attempts != attempt || wait < want-time.Second || wait > want {
			t.Fatalf("attempt %d: attempts=%d backoff=%v want %v", attempt, attempts, wait, want)
		}
		f.drain(t)
		if n := f.count(t, "SELECT attempts FROM retrieval.queue"); n != attempt {
			t.Fatal("row retried before its backoff elapsed")
		}
		f.exec(t, "UPDATE retrieval.queue SET next_attempt_at = now()")
	}
	f.drain(t)
	var status, errMsg string
	if err := f.db.QueryRow(context.Background(), "SELECT status, error FROM retrieval.sources WHERE source_id = $1", id).
		Scan(&status, &errMsg); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || errMsg == "" || len(errMsg) > 500 {
		t.Fatalf("status=%s error=%q", status, errMsg)
	}
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue"); n != 0 {
		t.Fatal("failed source still queued")
	}
	if st := f.http.status(); st.Failed != 1 || st.Stale != 1 {
		t.Fatalf("status = %+v", st)
	}
	f.worker.sweep(context.Background())
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue"); n != 0 {
		t.Fatal("sweep retries a failed source forever")
	}

	f.fake.Fail.Store(false)
	w := call(t, f.http.h, http.MethodPost, "/internal/v1/retrieval/reindex", fmt.Sprintf(`{"source_ids":[%d, 999]}`, id))
	if w.Code != 200 {
		t.Fatalf("reindex: %d %s", w.Code, w.Body)
	}
	assertContract(t, "ReindexResponse", w.Body.Bytes())
	var re struct{ Enqueued int }
	_ = json.Unmarshal(w.Body.Bytes(), &re)
	if re.Enqueued != 1 {
		t.Fatalf("enqueued = %d", re.Enqueued)
	}
	f.drain(t)
	if st := f.http.status(); st.Indexed != 1 || st.Failed != 0 {
		t.Fatalf("after reindex: %+v", st)
	}
}

func TestReindexAll(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	f.addItem(t, item{key: "a", content: "alpha"})
	f.addItem(t, item{key: "b", content: "beta"})
	f.drain(t)
	texts := f.fake.Texts.Load()
	w := call(t, f.http.h, http.MethodPost, "/internal/v1/retrieval/reindex", `{"all":true}`)
	assertContract(t, "ReindexResponse", w.Body.Bytes())
	f.drain(t)
	if f.fake.Texts.Load() != texts+2 {
		t.Fatal("explicit reindex did not re-embed")
	}
}

func TestShutdownReleasesClaims(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	f.addItem(t, item{key: "a", content: "alpha"})
	f.addItem(t, item{key: "b", content: "beta"})
	ctx, cancel := context.WithCancel(context.Background())
	claims, err := f.svc.store.claim(ctx, 10, claimLease)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	f.worker.processAll(ctx, claims)
	if n := f.count(t, "SELECT count(*) FROM retrieval.queue WHERE claimed_until IS NULL AND attempts = 0"); n != 2 {
		t.Fatalf("released %d of 2 claims", n)
	}
}

func TestWorkerRunWakesOnNotify(t *testing.T) {
	f := newFixture(t, needDB(t), "m1")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.worker.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	time.Sleep(200 * time.Millisecond)
	f.addItem(t, item{key: "a", content: "alpha"})
	deadline := time.Now().Add(5 * time.Second)
	for f.count(t, "SELECT count(*) FROM retrieval.sources WHERE status = 'indexed'") != 1 {
		if time.Now().After(deadline) {
			t.Fatal("worker did not wake on NOTIFY")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWithoutPgvector(t *testing.T) {
	url := os.Getenv("PLATFORM_GO_TEST_NOVECTOR_DATABASE_URL")
	if url == "" {
		t.Skip("PLATFORM_GO_TEST_NOVECTOR_DATABASE_URL not set")
	}
	db, err := openMigrated(url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	resetDB(t, db)
	f := newFixture(t, db, "m1")
	u := f.addUser(t, "alice")
	f.addItem(t, item{key: "a", content: "alpha"})
	f.drain(t)
	if n := f.count(t, "SELECT count(*) FROM retrieval.chunks WHERE cardinality(embedding) = $1", testDims); n != 1 {
		t.Fatalf("worker did not store real[] embeddings: %d", n)
	}
	if st := f.http.status(); st.VectorExtension || st.Indexed != 1 {
		t.Fatalf("status = %+v", st)
	}
	w := call(t, f.http.h, http.MethodPost, "/internal/v1/retrieval/search", searchBody(u, "alpha", ""))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("search without pgvector: %d", w.Code)
	}
	assertContract(t, "Error", w.Body.Bytes())
	var e struct{ Code string }
	_ = json.Unmarshal(w.Body.Bytes(), &e)
	if e.Code != "vector_unavailable" {
		t.Fatalf("code = %q", e.Code)
	}
}
