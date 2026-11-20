package codeintelligence

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Expected values come from Node (String.prototype.localeCompare, the queryTerms regex of search.ts).
func TestLocaleCompareMatchesNode(t *testing.T) {
	got := []string{"b", "A", "a", "_x", "Z", "ä", "src/a.ts", "src-b/a.ts", "src/A.ts", "x10", "x9", "a.b", "a-b", "a_b"}
	slices.SortStableFunc(got, localeCompare)
	want := []string{"_x", "a", "A", "ä", "a_b", "a-b", "a.b", "b", "src-b/a.ts", "src/a.ts", "src/A.ts", "x10", "x9", "Z"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestQueryTermsMatchesNode(t *testing.T) {
	got := queryTerms("find searchSymbols, pkg.Foo::bar a1 x and searchSymbols again _ab 9abc")
	want := []string{"find", "searchSymbols", "pkg.Foo::bar", "and", "again", "_ab", "abc"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if n := len(queryTerms("a b !! 12")); n != 0 {
		t.Fatalf("no term in short words and digits, got %d", n)
	}
	many := make([]string, 40)
	for i := range many {
		many[i] = "term" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	if n := len(queryTerms(strings.Join(many, " "))); n != 24 {
		t.Fatalf("terms are capped at 24, got %d", n)
	}
}

func TestSortHitsIsStableAndDeterministic(t *testing.T) {
	h := func(repo, file string, line int, conf float64, mt string) Hit {
		return Hit{Repository: repo, FilePath: file, LineRange: [2]int{line, line}, Confidence: conf, MatchType: mt}
	}
	hits := []Hit{
		h("b", "x.ts", 1, 0.9, "exact"),
		h("a", "y.ts", 9, 0.95, "exact"),
		h("a", "y.ts", 2, 0.95, "qualified"),
		h("B", "x.ts", 1, 0.9, "exact"),
		h("a", "x.ts", 5, 0.9, "exact"),
		h("a", "x.ts", 5, 0.9, "exact"), // tie: original order kept
	}
	hits[5].Snippet = ptr("second")
	sortHits(hits)
	var got []string
	for _, x := range hits {
		got = append(got, x.Repository+"/"+x.FilePath+":"+string(rune('0'+x.LineRange[0])))
	}
	want := []string{"a/y.ts:2", "a/y.ts:9", "a/x.ts:5", "a/x.ts:5", "b/x.ts:1", "B/x.ts:1"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if hits[3].Snippet == nil {
		t.Fatal("stable sort: tied hits keep their order")
	}
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", "-q", dir).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
}

func validSearch(t *testing.T) (*SearchRequest, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repos := filepath.Join(root, "repos")
	gitInit(t, filepath.Join(repos, "a"))
	return &SearchRequest{
		Op:            "symbols",
		Text:          "searchSymbols",
		Limit:         30,
		Repositories:  []SearchRepo{{Name: "a", RepositoryID: 1, Root: filepath.Join(repos, "a"), Primary: filepath.Join(repos, "a"), DefaultBranch: "main"}},
		AllowedRoots:  []string{repos},
		InstanceID:    "i",
		ParserVersion: ExtractorVersion + "/x",
		ContextChars:  8000,
		Limits:        Limits{MaxFileBytes: 1, MaxFiles: 1, MaxScanBytes: 1, MaxSymbols: 1, TimeoutMs: 1000, Excludes: []string{}},
		Unavailable:   []Unavailable{},
	}, repos
}

func TestValidateSearchRefusesWhatTypeScriptNeverSends(t *testing.T) {
	req, repos := validSearch(t)
	if err := ValidateSearch(req, []string{filepath.Dir(repos)}); err != nil {
		t.Fatalf("valid request refused: %v", err)
	}
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	gitInit(t, filepath.Join(outside, "o"))
	if err := os.Symlink(filepath.Join(repos, "a"), filepath.Join(repos, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repos, "plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(r *SearchRequest){
		"other parser":          func(r *SearchRequest) { r.ParserVersion = "extractor-0/x" },
		"unknown op":            func(r *SearchRequest) { r.Op = "grep" },
		"no instance":           func(r *SearchRequest) { r.InstanceID = "" },
		"no allowed roots":      func(r *SearchRequest) { r.AllowedRoots = nil },
		"relative allowed root": func(r *SearchRequest) { r.AllowedRoots = []string{"repos"} },
		"filesystem root":       func(r *SearchRequest) { r.AllowedRoots = []string{"/"} },
		"limit":                 func(r *SearchRequest) { r.Limit = 201 },
		"depth":                 func(r *SearchRequest) { r.Depth = 4 },
		"direction":             func(r *SearchRequest) { r.Direction = "sideways" },
		"empty pattern":         func(r *SearchRequest) { r.Op = "exact"; r.Pattern = "" },
		"multiline pattern":     func(r *SearchRequest) { r.Op = "exact"; r.Pattern = "a\nb" },
		"no limits":             func(r *SearchRequest) { r.Limits = Limits{} },
		"outside allowed root":  func(r *SearchRequest) { r.Repositories[0].Root = filepath.Join(outside, "o") },
		"traversal":             func(r *SearchRequest) { r.Repositories[0].Root = filepath.Join(repos, "a") + "/../a" },
		"symlinked checkout":    func(r *SearchRequest) { r.Repositories[0].Primary = filepath.Join(repos, "link") },
		"not a checkout":        func(r *SearchRequest) { r.Repositories[0].Root = filepath.Join(repos, "plain") },
		"missing checkout":      func(r *SearchRequest) { r.Repositories[0].Root = filepath.Join(repos, "gone") },
		"ref injection":         func(r *SearchRequest) { r.Repositories[0].DefaultBranch = "--upload-pack=x" + " y" },
		"ref traversal":         func(r *SearchRequest) { r.Repositories[0].DefaultBranch = "a/../b" },
		"duplicate repository":  func(r *SearchRequest) { r.Repositories = append(r.Repositories, r.Repositories[0]) },
		"bad repository id":     func(r *SearchRequest) { r.Repositories[0].RepositoryID = 0 },
		"bad run id":            func(r *SearchRequest) { r.Repositories[0].RunID = ptr(int64(-1)) },
		"too many repositories": func(r *SearchRequest) { r.Unavailable = make([]Unavailable, 30) },
	}
	for name, mutate := range cases {
		r, _ := validSearch(t)
		r.AllowedRoots = []string{repos}
		r.Repositories[0].Root, r.Repositories[0].Primary = filepath.Join(repos, "a"), filepath.Join(repos, "a")
		mutate(r)
		if err := ValidateSearch(r, []string{filepath.Dir(repos)}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSearchContract(t *testing.T) {
	req, repos := validSearch(t)
	body, _ := json.Marshal(req)
	assertContract(t, "SearchRequest", body)

	mux := http.NewServeMux()
	Routes(mux, NewIndexer(nil, 1, 1).WithTrustedRoots([]string{filepath.Dir(repos)}), slog.New(slog.DiscardHandler))
	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/code-intelligence/search", strings.NewReader(body)))
		return w
	}
	other := *req
	other.ParserVersion = "extractor-0/x"
	otherBody, _ := json.Marshal(other)
	bad := *req
	bad.Repositories = []SearchRepo{{Name: "a", RepositoryID: 1, Root: "/etc", Primary: "/etc", DefaultBranch: "main"}}
	badBody, _ := json.Marshal(bad)
	for body, status := range map[string]int{
		`{`:                       http.StatusBadRequest,
		`{"op":"symbols","x":1}`:  http.StatusBadRequest,
		string(badBody):           http.StatusBadRequest,
		string(otherBody):         http.StatusConflict,
		`{"op":"exact","pattern"`: http.StatusBadRequest,
	} {
		w := post(body)
		if w.Code != status {
			t.Fatalf("%.60s: status %d, want %d (%s)", body, w.Code, status, w.Body)
		}
		assertContract(t, "Error", w.Body.Bytes())
	}

	id := int64(3)
	resp, _ := json.Marshal(SearchResponse{
		Hits: []Hit{{Repository: "a", FilePath: "x.ts", LineRange: [2]int{1, 2}, MatchType: "exact", Confidence: 1,
			Snapshot: Provenance{ID: &id, Commit: "c"}, SymbolName: ptr("x"), ContentHash: ptr("h")}},
		Edges: []Edge{{ID: 1, Repository: "a", Snapshot: Provenance{Commit: "c"}, MatchType: "candidate",
			CandidateDefinitions: &[]Hit{}}},
		Unavailable: []string{"b: Repository unavailable or unauthorized"},
		Enqueue:     []EnqueueEntry{{Repository: "a"}},
		Body:        ptr("a/x.ts:1-2 commit=c base\n"),
	})
	assertContract(t, "SearchResponse", resp)
}

// §9 (ADR 0007): the request's allowed_roots only narrow the server's trusted roots; without trusted roots the
// endpoint is unavailable (the TypeScript engine answers), never open.
func TestAllowedRootsMustLieInsideTheTrustedRoots(t *testing.T) {
	req, repos := validSearch(t)
	if err := ValidateSearch(req, nil); !errors.Is(err, ErrUnconfigured) {
		t.Fatalf("no trusted roots: %v", err)
	}
	elsewhere, _ := filepath.EvalSymlinks(t.TempDir())
	if err := ValidateSearch(req, []string{elsewhere}); err == nil {
		t.Fatal("allowed root outside the trusted roots accepted")
	}
	// The request widening its own allowed roots to "/"-like parents of the trusted root is refused too.
	wide := *req
	wide.AllowedRoots = []string{filepath.Dir(filepath.Dir(repos))}
	if err := ValidateSearch(&wide, []string{filepath.Dir(repos)}); err == nil {
		t.Fatal("allowed root wider than the trusted root accepted")
	}
	if err := ValidateSearch(req, []string{repos}); err != nil {
		t.Fatalf("allowed root equal to a trusted root refused: %v", err)
	}

	mux := http.NewServeMux()
	Routes(mux, NewIndexer(nil, 1, 1), slog.New(slog.DiscardHandler))
	b, _ := json.Marshal(req)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/code-intelligence/search", strings.NewReader(string(b))))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured trusted roots: status %d", w.Code)
	}
}
