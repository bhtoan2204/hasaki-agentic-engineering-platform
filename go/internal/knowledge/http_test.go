package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func assertContract(t *testing.T, def string, body []byte) {
	t.Helper()
	path, err := filepath.Abs("../../contracts/knowledge-v1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := jsonschema.NewCompiler().Compile("file://" + path + "#/$defs/" + def)
	if err != nil {
		t.Fatal(err)
	}
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("%s: invalid JSON %q", def, body)
	}
	if err := s.Validate(v); err != nil {
		t.Fatalf("%s does not match the contract: %v\n%s", def, err, body)
	}
}

var testLimits = Limits{MaxFileBytes: 1 << 20, MaxEntries: 1000, MaxTotalBytes: 1 << 24, DeadlineMs: 10000, MaxChars: 60000}

// fixture: a trusted root with one checkout holding a convention, a skill with a companion, and a symlink out.
func fixture(t *testing.T) (trusted, repo, outside string) {
	t.Helper()
	trusted, _ = filepath.EvalSymlinks(t.TempDir())
	outside, _ = filepath.EvalSymlinks(t.TempDir())
	repo = filepath.Join(trusted, "repos", "svc")
	write := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(repo, "CLAUDE.md"), "# svc\n\nRules.\n")
	write(filepath.Join(repo, ".claude/skills/s/SKILL.md"), "---\nname: s\ndescription: d\n---\n# S\n")
	write(filepath.Join(repo, ".claude/skills/s/references/r.md"), "# R\n")
	write(filepath.Join(outside, "x.md"), "outside")
	if err := os.Symlink(filepath.Join(outside, "x.md"), filepath.Join(repo, "docs-convention.md")); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	return trusted, repo, outside
}

func TestScanContractAndValidation(t *testing.T) {
	trusted, repo, outside := fixture(t)
	s := NewScanner([]string{trusted}, 1)
	mux := http.NewServeMux()
	Routes(mux, s, slog.New(slog.DiscardHandler))
	post := func(body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/knowledge/scan", bytes.NewReader(b)))
		return w
	}
	valid := ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "svc", Root: repo}}, Limits: testLimits}
	b, _ := json.Marshal(valid)
	assertContract(t, "ScanRequest", b)
	w := post(valid)
	if w.Code != http.StatusOK {
		t.Fatalf("valid scan: %d %s", w.Code, w.Body)
	}
	assertContract(t, "ScanResponse", w.Body.Bytes())
	var res ScanResponse
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if len(res.Candidates) != 3 || res.Metrics.FilesRead == 0 || len(res.Scanned) != 1 {
		t.Fatalf("scan = %+v", res)
	}
	if strings.Contains(w.Body.String(), "outside") && !strings.Contains(w.Body.String(), "symlink outside the repository") {
		t.Fatal("content outside the root was read")
	}

	gone := filepath.Join(trusted, "later")
	for name, c := range map[string]struct {
		body   any
		status int
	}{
		"version":         {ScanRequest{Version: "knowledge-scan-0", Repositories: valid.Repositories, Limits: testLimits}, 409},
		"outside root":    {ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "o", Root: outside}}, Limits: testLimits}, 400},
		"traversal":       {ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "o", Root: repo + "/../svc"}}, Limits: testLimits}, 400},
		"relative":        {ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "o", Root: "repos/svc"}}, Limits: testLimits}, 400},
		"not a checkout":  {ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "o", Root: trusted}}, Limits: testLimits}, 400},
		"name":            {ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "a/b", Root: repo}}, Limits: testLimits}, 400},
		"duplicate":       {ScanRequest{Version: ScanVersion, Repositories: []Repository{{Name: "a", Root: repo}, {Name: "a", Root: repo}}, Limits: testLimits}, 400},
		"limits":          {ScanRequest{Version: ScanVersion, Repositories: valid.Repositories, Limits: Limits{MaxFileBytes: 1 << 30, MaxEntries: 1, MaxTotalBytes: 1, DeadlineMs: 1, MaxChars: 1}}, 400},
		"user dir out":    {ScanRequest{Version: ScanVersion, Repositories: valid.Repositories, UserSkillsDir: &outside, Limits: testLimits}, 400},
		"user dir absent": {ScanRequest{Version: ScanVersion, Repositories: valid.Repositories, UserSkillsDir: &gone, Limits: testLimits}, 200},
		"unknown field":   {map[string]any{"version": ScanVersion, "repositories": []any{}, "user_skills_dir": nil, "limits": testLimits, "x": 1}, 400},
	} {
		w := post(c.body)
		if w.Code != c.status {
			t.Errorf("%s: status %d, want %d (%s)", name, w.Code, c.status, w.Body)
		}
		if w.Code != 200 {
			assertContract(t, "Error", w.Body.Bytes())
		}
	}

	// No trusted roots configured: unavailable (TypeScript scans instead), never open.
	empty := http.NewServeMux()
	Routes(empty, NewScanner(nil, 1), slog.New(slog.DiscardHandler))
	w = httptest.NewRecorder()
	empty.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/knowledge/scan", bytes.NewReader(b)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured: %d", w.Code)
	}
}

// A trusted root that does not exist at startup (a user skills directory created later) is trusted once it exists.
func TestTrustedRootCreatedAfterStartup(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	later := filepath.Join(base, "skills")
	s := NewScanner([]string{later}, 1)
	if err := s.trusted(later); err == nil {
		t.Fatal("a missing directory was trusted")
	}
	if err := os.Mkdir(later, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := s.trusted(later); err != nil {
		t.Fatalf("created later: %v", err)
	}
}

// The scan deadline ends a scan with what it has, marking the rest incomplete; a canceled request is an error.
func TestDeadlineAndCancellation(t *testing.T) {
	_, repo, _ := fixture(t)
	lim := testLimits
	lim.DeadlineMs = 1
	ctx := context.Background()
	time.Sleep(2 * time.Millisecond)
	d, _, err := Discover(ctx, []Repository{{Name: "svc", Root: repo}}, "", lim)
	if err != nil {
		t.Fatal(err)
	}
	_ = d // may or may not finish within 1 ms; it must never report a repository both scanned and incomplete
	for _, n := range d.Incomplete {
		for _, m := range d.Scanned {
			if n == m {
				t.Fatalf("%s both scanned and incomplete", n)
			}
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := Discover(canceled, []Repository{{Name: "svc", Root: repo}}, "", testLimits); err == nil {
		t.Fatal("a canceled scan returned a result")
	}
}
