package codeintelligence

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The indexing endpoint reads only checkouts inside the trusted roots of platform-go's own configuration, and only
// commit ids reach git (ADR 0007 boundary review). Before, any path and any base were accepted with a valid token.
func TestIndexJobsStayInsideTheTrustedRoots(t *testing.T) {
	trusted, _ := filepath.EvalSymlinks(t.TempDir())
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	for _, d := range []string{filepath.Join(trusted, "repo"), filepath.Join(outside, "repo")} {
		if out, err := exec.Command("git", "init", "-q", d).CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
	}
	link := filepath.Join(trusted, "link")
	if err := os.Symlink(filepath.Join(outside, "repo"), link); err != nil {
		t.Fatal(err)
	}
	base := "0123456789abcdef0123456789abcdef01234567"
	job := func(primary, root, base string) Request {
		return Request{RepositoryID: 1, Primary: primary, Root: root, Base: base, ParserVersion: ExtractorVersion + "/x",
			InstanceID: "i", Limits: Limits{MaxFileBytes: 1, MaxSymbols: 1, MaxFiles: 1, MaxScanBytes: 1, TimeoutMs: 1000}}
	}
	ix := NewIndexer(nil, 1, 1).WithTrustedRoots([]string{trusted})
	repo := filepath.Join(trusted, "repo")
	if err := ix.trustedJob(job(repo, repo, base)); err != nil {
		t.Fatalf("a checkout inside the trusted roots was refused: %v", err)
	}
	for name, r := range map[string]Request{
		"outside":           job(filepath.Join(outside, "repo"), "", base),
		"symlinked out":     job(link, "", base),
		"traversal":         job(repo+"/../repo", "", base),
		"relative":          job("repo", "", base),
		"worktree outside":  job(repo, filepath.Join(outside, "repo"), base),
		"not a checkout":    job(trusted, "", base),
		"option as base":    job(repo, "", "--output=/tmp/x"),
		"ref name as base":  job(repo, "", "main"),
		"short hex as base": job(repo, "", "abc123"),
	} {
		if err := ix.trustedJob(r); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	// Over HTTP: refused with 400; without trusted roots 503 (never open); another extractor still 409.
	post := func(ix *Indexer, r Request) int {
		mux := http.NewServeMux()
		Routes(mux, ix, slog.New(slog.DiscardHandler))
		b, _ := json.Marshal(r)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/code-intelligence/index", bytes.NewReader(b)))
		assertContract(t, "Error", w.Body.Bytes())
		return w.Code
	}
	if c := post(ix, job(filepath.Join(outside, "repo"), "", base)); c != http.StatusBadRequest {
		t.Fatalf("outside: %d", c)
	}
	if c := post(NewIndexer(nil, 1, 1), job(repo, "", base)); c != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured: %d", c)
	}
	other := job(repo, "", base)
	other.ParserVersion = "extractor-0/x"
	if c := post(NewIndexer(nil, 1, 1), other); c != http.StatusConflict {
		t.Fatalf("version: %d", c)
	}
}
