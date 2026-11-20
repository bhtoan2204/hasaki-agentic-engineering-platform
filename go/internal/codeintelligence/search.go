package codeintelligence

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// Code search (ADR 0006): searchSymbols, findDependencies/findReferences, searchCodeExact and buildCodeContext of
// src/codeIntelligence/search.ts, answered in one request. TypeScript authorizes and resolves the scope (which
// repositories, which checkout or worktree, which run) and sends only that; this side never chooses a path.
//
// What changes is the execution model, not the semantics: freshness (base commit, worktree generation, snapshot) is
// computed once per repository per request instead of twice per repository per query; SQL runs once per query for
// all repositories instead of once per repository; Git and ripgrep run with bounded parallelism; sources are read
// once per request (Git objects in one cat-file batch per repository). Every result is still validated after its
// queries: repositories whose snapshot changed meanwhile are dropped and reported, exactly like the TypeScript
// recheck. Ordering, limits, fallbacks, confidences and provenance are the TypeScript ones.

type SearchRepo struct {
	Name          string `json:"name"`
	RepositoryID  int64  `json:"repository_id"`
	Root          string `json:"root"`
	Primary       string `json:"primary"`
	DefaultBranch string `json:"default_branch"`
	RunID         *int64 `json:"run_id"`
}

// Unavailable is a repository TypeScript could not resolve (unauthorized checkout, missing worktree): it counts as
// a fallback and is reported, like the TypeScript catch path.
type Unavailable struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

type SearchRequest struct {
	Op            string        `json:"op"` // symbols | dependencies | exact | context
	Text          string        `json:"text"`
	Symbol        string        `json:"symbol"`
	Pattern       string        `json:"pattern"`
	Limit         int           `json:"limit"`
	Depth         int           `json:"depth"`
	Direction     string        `json:"direction"`
	AnyFile       bool          `json:"any_file"`
	Repositories  []SearchRepo  `json:"repositories"`
	Unavailable   []Unavailable `json:"unavailable"`
	AllowedRoots  []string      `json:"allowed_roots"`
	InstanceID    string        `json:"instance_id"`
	ParserVersion string        `json:"parser_version"`
	ContextChars  int           `json:"context_chars"`
	Limits        Limits        `json:"limits"`
}

type SearchResponse struct {
	Hits          []Hit          `json:"hits,omitempty"`
	FallbackCount int            `json:"fallback_count"`
	Edges         []Edge         `json:"edges,omitempty"`
	Unavailable   []string       `json:"unavailable"`
	Enqueue       []EnqueueEntry `json:"enqueue"`
	Body          *string        `json:"body,omitempty"`
	Metrics       SearchMetrics  `json:"metrics"`
}

type EnqueueEntry struct {
	Repository string `json:"repository"`
	RunID      *int64 `json:"run_id"`
}

type SearchMetrics struct {
	Statements    int64 `json:"statements"`
	GitProcesses  int64 `json:"git_processes"`
	RgProcesses   int64 `json:"rg_processes"`
	SourceReads   int64 `json:"source_reads"`
	SourceBytes   int64 `json:"source_bytes"`
	FreshnessRuns int64 `json:"freshness_checks"`
	TookMs        int64 `json:"took_ms"`
}

// Provenance is a hit's snapshot (Hit["snapshot"]).
type Provenance struct {
	ID         *int64 `json:"id"`
	Commit     string `json:"commit"`
	Generation string `json:"generation"`
	RunID      *int64 `json:"run_id"`
}

// Hit mirrors the TypeScript Hit; optional fields appear only for the kinds that carry them.
type Hit struct {
	Repository    string     `json:"repository"`
	FilePath      string     `json:"file_path"`
	LineRange     [2]int     `json:"line_range"`
	MatchType     string     `json:"match_type"`
	Confidence    float64    `json:"confidence"`
	Snapshot      Provenance `json:"snapshot"`
	SymbolName    *string    `json:"symbol_name,omitempty"`
	QualifiedName *string    `json:"qualified_name,omitempty"`
	Signature     *string    `json:"signature,omitempty"`
	Snippet       *string    `json:"snippet,omitempty"`
	ContentHash   *string    `json:"content_hash,omitempty"`
}

// Edge mirrors DependencyEdge: the relation row (r.*), file and content hash, then the search fields.
type Edge struct {
	ID                   int64      `json:"id"`
	ExtractionID         int64      `json:"extraction_id"`
	FilePath             string     `json:"file_path"`
	SourceName           string     `json:"source_name"`
	TargetName           string     `json:"target_name"`
	RelationType         string     `json:"relation_type"`
	Resolution           string     `json:"resolution"`
	Line                 int        `json:"line"`
	ContentHash          string     `json:"content_hash"`
	Repository           string     `json:"repository"`
	Snapshot             Provenance `json:"snapshot"`
	LineRange            [2]int     `json:"line_range"`
	MatchType            string     `json:"match_type"`
	Confidence           float64    `json:"confidence"`
	Depth                int        `json:"depth"`
	CandidateDefinitions *[]Hit     `json:"candidate_definitions,omitempty"`
}

var (
	queryTerm  = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_./:-]{2,127}`)
	refName    = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)
	collator   = collate.New(language.Und)
	collatorMu sync.Mutex
)

// localeCompare is String.prototype.localeCompare (ICU root collation, as Node uses it).
func localeCompare(a, b string) int {
	collatorMu.Lock()
	defer collatorMu.Unlock()
	return collator.CompareString(a, b)
}

// queryTerms is queryTerms() of search.ts.
func queryTerms(text string) []string {
	var out []string
	for _, t := range queryTerm.FindAllString(text, -1) {
		if !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	if len(out) > 24 {
		out = out[:24]
	}
	return out
}

// Searcher answers code search requests; Slots bounds concurrent requests (each runs at most four Git or ripgrep
// subprocesses at once), shared with indexing's own bounds.
type Searcher struct {
	DB    *pgxpool.Pool
	Slots chan struct{}
}

func NewSearcher(db *pgxpool.Pool, concurrent int) *Searcher {
	return &Searcher{DB: db, Slots: make(chan struct{}, max(1, concurrent))}
}

// ValidateSearch rejects anything TypeScript would never send: arbitrary paths, refs or oversized inputs.
func ValidateSearch(r *SearchRequest) error {
	if !strings.HasPrefix(r.ParserVersion, ExtractorVersion+"/") {
		return ErrVersion
	}
	if !slices.Contains([]string{"symbols", "dependencies", "exact", "context"}, r.Op) {
		return errors.New("unknown operation")
	}
	if len(r.Repositories)+len(r.Unavailable) > 30 || r.InstanceID == "" || len(r.AllowedRoots) == 0 {
		return errors.New("scope must name at most 30 authorized repositories, the instance and allowed roots")
	}
	if len(r.Text) > 8000 || len(r.Symbol) > 512 || r.Limit < 0 || r.Limit > 200 || r.Depth > 3 ||
		(r.Direction != "" && r.Direction != "in" && r.Direction != "out") || r.ContextChars < 0 || r.ContextChars > 200000 {
		return errors.New("invalid query bounds")
	}
	if r.Op == "exact" && (r.Pattern == "" || len(r.Pattern) > 256 || strings.ContainsAny(r.Pattern, "\n\x00")) {
		return errors.New("Invalid exact search pattern")
	}
	if r.Limits.MaxFileBytes <= 0 || r.Limits.MaxFiles <= 0 || r.Limits.MaxScanBytes <= 0 {
		return errors.New("limits are required")
	}
	seen := map[string]bool{}
	for _, root := range r.AllowedRoots {
		if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == "/" {
			return errors.New("invalid allowed root")
		}
	}
	for _, repo := range r.Repositories {
		if repo.Name == "" || seen[repo.Name] || repo.RepositoryID <= 0 || !refName.MatchString(repo.DefaultBranch) ||
			strings.Contains(repo.DefaultBranch, "..") || (repo.RunID != nil && *repo.RunID <= 0) {
			return fmt.Errorf("invalid repository scope %q", repo.Name)
		}
		seen[repo.Name] = true
		for _, p := range []string{repo.Root, repo.Primary} {
			if err := checkoutPath(p, r.AllowedRoots); err != nil {
				return fmt.Errorf("repository %q: %w", repo.Name, err)
			}
		}
	}
	return nil
}

// checkoutPath: an absolute, canonical (no symlink component) directory inside an allowed root, holding a .git.
func checkoutPath(p string, allowed []string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return errors.New("checkout path is not absolute and clean")
	}
	if !slices.ContainsFunc(allowed, func(a string) bool { return strings.HasPrefix(p, a+"/") }) {
		return errors.New("checkout path outside the platform's repositories")
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || real != p {
		return errors.New("checkout path is not canonical")
	}
	if st, err := os.Stat(p); err != nil || !st.IsDir() {
		return errors.New("checkout path is not a directory")
	}
	if _, err := os.Lstat(filepath.Join(p, ".git")); err != nil {
		return errors.New("checkout path is not a Git checkout")
	}
	return nil
}

// ---------------------------------------------------------------- request state

type freshness struct {
	base       string
	identity   string // snapshot identity looked up
	generation string
	snapshot   *snapshotRow // nil: no index (fallback)
	err        error
}

type snapshotRow struct {
	ID         int64
	Commit     string
	Generation string
	RunID      *int64
}

type search struct {
	s       *Searcher
	req     *SearchRequest
	repos   map[string]*SearchRepo
	order   []string
	m       SearchMetrics
	mu      sync.Mutex
	fresh   map[string]*freshness
	sources map[string]*string // root\x00path or commit:path → content (nil = unreadable)
	enqueue []EnqueueEntry
	// Composite operations (dependencies, context) validate once, after their last query: rechecks are collected in
	// pending and settled by settle(), which drops every result of a repository whose snapshot changed meanwhile.
	deferred bool
	pending  map[string]bool
}

func (st *search) gitCount(n int) {
	st.mu.Lock()
	st.m.GitProcesses += int64(n)
	st.mu.Unlock()
}

// parallel runs fn for every repository with at most four at once, keeping results by name.
func parallel[T any](names []string, fn func(name string) T) map[string]T {
	out := make(map[string]T, len(names))
	var mu sync.Mutex
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, n := range names {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			v := fn(n)
			mu.Lock()
			out[n] = v
			mu.Unlock()
		})
	}
	wg.Wait()
	return out
}

// identities computes, for each repository, the snapshot identity it must be answered from right now (fresh() of
// search.ts without the SQL): the base commit, and for a run its worktree generation.
func (st *search) identities(ctx context.Context, names []string) map[string]*freshness {
	return parallel(names, func(name string) *freshness {
		repo := st.repos[name]
		f := &freshness{}
		base, n, err := baseCommit(ctx, repo.Primary, repo.DefaultBranch)
		st.gitCount(n)
		if err != nil {
			f.err = err
			return f
		}
		f.base = base
		f.identity = "base:" + base
		if repo.RunID != nil {
			_, generation, _, err := worktreeChanges(ctx, repo.Root, base, st.req.Limits)
			st.gitCount(3)
			if err != nil {
				f.err = err
				return f
			}
			f.generation = generation
		}
		return f
	})
}

func baseCommit(ctx context.Context, root, branch string) (string, int, error) {
	n := 0
	for _, ref := range []string{"refs/remotes/origin/" + branch, "refs/heads/" + branch, "refs/remotes/origin/HEAD"} {
		n++
		out, err := gitOut(ctx, root, "rev-parse", "--verify", ref+"^{commit}")
		if err == nil {
			return strings.TrimSpace(string(out)), n, nil
		}
		if ctx.Err() != nil {
			return "", n, ctx.Err()
		}
	}
	return "", n, errors.New("Default/configured base branch unavailable")
}

// resolve looks up the snapshots for computed identities in two statements for all repositories: baselines, then
// overlays (whose identity names the baseline's id).
func (st *search) resolve(ctx context.Context, fs map[string]*freshness) error {
	key := func(name, identity string) [2]string {
		return [2]string{strconv.FormatInt(st.repos[name].RepositoryID, 10), identity}
	}
	var repoIDs []int64
	var idents, names []string
	for _, name := range st.order {
		if f := fs[name]; f != nil && f.err == nil {
			repoIDs, idents, names = append(repoIDs, st.repos[name].RepositoryID), append(idents, f.identity), append(names, name)
		}
	}
	base, err := st.snapshots(ctx, repoIDs, idents)
	if err != nil {
		return err
	}
	repoIDs, idents = nil, nil
	var overlays []string
	for _, name := range names {
		f, repo := fs[name], st.repos[name]
		b := base[key(name, f.identity)]
		if b == nil {
			continue
		}
		if repo.RunID == nil {
			f.snapshot = b
			continue
		}
		f.identity = fmt.Sprintf("overlay:%s:%d:%d:%s", st.req.InstanceID, *repo.RunID, b.ID, f.generation)
		repoIDs, idents, overlays = append(repoIDs, repo.RepositoryID), append(idents, f.identity), append(overlays, name)
	}
	if len(overlays) == 0 {
		return nil
	}
	over, err := st.snapshots(ctx, repoIDs, idents)
	if err != nil {
		return err
	}
	for _, name := range overlays {
		fs[name].snapshot = over[key(name, fs[name].identity)]
	}
	return nil
}

func (st *search) snapshots(ctx context.Context, repoIDs []int64, idents []string) (map[[2]string]*snapshotRow, error) {
	out := map[[2]string]*snapshotRow{}
	if len(repoIDs) == 0 {
		return out, nil
	}
	st.count()
	rows, err := st.s.DB.Query(ctx, `SELECT s.repository_id::text, s.identity, s.id, s.commit_sha, s.generation, s.run_id
		FROM unnest($1::bigint[], $2::text[]) AS x(repository_id, identity)
		JOIN code_intelligence.snapshots s ON s.repository_id=x.repository_id AND s.identity=x.identity AND s.index_version=$3`,
		repoIDs, idents, st.req.ParserVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var repo, ident string
		r := &snapshotRow{}
		if err := rows.Scan(&repo, &ident, &r.ID, &r.Commit, &r.Generation, &r.RunID); err != nil {
			return nil, err
		}
		out[[2]string{repo, ident}] = r
	}
	return out, rows.Err()
}

func (st *search) count() {
	st.mu.Lock()
	st.m.Statements++
	st.mu.Unlock()
}

// freshFor is fresh() of search.ts for the given repositories, computed once per request.
func (st *search) freshFor(ctx context.Context, names []string) map[string]*freshness {
	var todo []string
	for _, n := range names {
		if st.fresh[n] == nil {
			todo = append(todo, n)
		}
	}
	if len(todo) > 0 {
		fs := st.identities(ctx, todo)
		if err := st.resolve(ctx, fs); err != nil {
			for _, f := range fs {
				if f.err == nil {
					f.err = err
				}
			}
		}
		st.m.FreshnessRuns++
		for n, f := range fs {
			st.fresh[n] = f
		}
	}
	return st.fresh
}

// changed reports the repositories whose snapshot is no longer the one the request used (the recheck of
// search.ts): computed again from Git and PostgreSQL, never from this request's memory.
func (st *search) changed(ctx context.Context, names []string) map[string]bool {
	if len(names) == 0 {
		return nil
	}
	if st.deferred {
		for _, n := range names {
			st.pending[n] = true
		}
		return map[string]bool{}
	}
	return st.recheck(ctx, names)
}

// settle runs the deferred recheck: the repositories whose snapshot changed after this request read it.
func (st *search) settle(ctx context.Context) map[string]bool {
	var names []string
	for _, n := range st.order {
		if st.pending[n] {
			names = append(names, n)
		}
	}
	st.deferred = false
	return st.recheck(ctx, names)
}

func (st *search) recheck(ctx context.Context, names []string) map[string]bool {
	if len(names) == 0 {
		return map[string]bool{}
	}
	fs := st.identities(ctx, names)
	err := st.resolve(ctx, fs)
	st.m.FreshnessRuns++
	out := map[string]bool{}
	for _, n := range names {
		now, was := fs[n], st.fresh[n]
		out[n] = err != nil || now.err != nil || now.snapshot == nil || was.snapshot == nil || now.snapshot.ID != was.snapshot.ID
	}
	return out
}

func provenance(s *snapshotRow) Provenance {
	id := s.ID
	return Provenance{ID: &id, Commit: s.Commit, Generation: s.Generation, RunID: s.RunID}
}

// ---------------------------------------------------------------- SQL, all repositories per statement

// effectiveFor is effectiveSql of store.ts for the snapshot x.sid of the enclosing LATERAL.
const effectiveFor = `(SELECT fi.* FROM code_intelligence.files fi WHERE fi.snapshot_id=x.sid AND NOT fi.deleted
 UNION ALL SELECT b.* FROM code_intelligence.files b JOIN code_intelligence.snapshots sn ON sn.base_snapshot_id=b.snapshot_id
 WHERE sn.id=x.sid AND NOT b.deleted AND NOT EXISTS (SELECT 1 FROM code_intelligence.files o WHERE o.snapshot_id=sn.id AND o.file_path=b.file_path))`

type symbolRow struct {
	sid                              int64
	filePath, symbol, qualified, sig string
	start, end                       int
	hash, match                      string
}

func (st *search) symbolRows(ctx context.Context, sids []int64, terms []string, limit int) (map[int64][]symbolRow, error) {
	out := map[int64][]symbolRow{}
	if len(sids) == 0 {
		return out, nil
	}
	st.count()
	rows, err := st.s.DB.Query(ctx, `SELECT x.sid, q.file_path, q.symbol_name, q.qualified_name, q.signature, q.start_line, q.end_line, q.content_hash, q.match_type
		FROM unnest($1::bigint[]) AS x(sid) CROSS JOIN LATERAL (
		  SELECT f.file_path, s.symbol_name, s.qualified_name, s.signature, s.start_line, s.end_line, e.content_hash,
		    CASE WHEN s.qualified_name=ANY($2) THEN 'qualified' WHEN s.symbol_name=ANY($2) THEN 'exact_symbol' ELSE 'path' END AS match_type
		  FROM `+effectiveFor+` f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id
		  JOIN code_intelligence.extractions e ON e.id=f.extraction_id
		  WHERE s.symbol_name=ANY($2) OR s.qualified_name=ANY($2) OR EXISTS(SELECT 1 FROM unnest($2::text[]) t WHERE position(lower(t) in lower(f.file_path))>0)
		  ORDER BY CASE WHEN s.qualified_name=ANY($2) THEN 0 WHEN s.symbol_name=ANY($2) THEN 1 ELSE 2 END,f.file_path,s.start_byte,s.id LIMIT $3) q`,
		sids, terms, max(1, limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r symbolRow
		if err := rows.Scan(&r.sid, &r.filePath, &r.symbol, &r.qualified, &r.sig, &r.start, &r.end, &r.hash, &r.match); err != nil {
			return nil, err
		}
		out[r.sid] = append(out[r.sid], r)
	}
	return out, rows.Err()
}

type edgeRow struct {
	sid            int64
	filePath, name string
	line           int
	hash           string
}

func (st *search) importRows(ctx context.Context, sids []int64, terms []string) (map[int64][]edgeRow, error) {
	out := map[int64][]edgeRow{}
	if len(sids) == 0 {
		return out, nil
	}
	st.count()
	rows, err := st.s.DB.Query(ctx, `SELECT x.sid, q.file_path, q.target_name, q.line, q.content_hash
		FROM unnest($1::bigint[]) AS x(sid) CROSS JOIN LATERAL (
		  SELECT f.file_path, r.target_name, r.line, e.content_hash FROM `+effectiveFor+` f
		  JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id JOIN code_intelligence.extractions e ON e.id=f.extraction_id
		  WHERE r.relation_type IN ('IMPORTS','RPC_REQUEST','RPC_RESPONSE') AND EXISTS(SELECT 1 FROM unnest($2::text[]) t WHERE lower(t)=lower(r.target_name) OR lower(t)=lower(regexp_replace(r.target_name,'^.*/','')))
		  ORDER BY f.file_path,r.line,r.id LIMIT 8) q`, sids, terms)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r edgeRow
		if err := rows.Scan(&r.sid, &r.filePath, &r.name, &r.line, &r.hash); err != nil {
			return nil, err
		}
		out[r.sid] = append(out[r.sid], r)
	}
	return out, rows.Err()
}

func (st *search) relationRows(ctx context.Context, sids []int64, names []string, direction string) (map[int64][]Edge, error) {
	out := map[int64][]Edge{}
	if len(sids) == 0 {
		return out, nil
	}
	col := "r.source_name"
	if direction == "in" {
		col = "r.target_name"
	}
	st.count()
	rows, err := st.s.DB.Query(ctx, `SELECT x.sid, q.file_path, q.id, q.extraction_id, q.source_name, q.target_name, q.relation_type, q.resolution, q.line, q.content_hash
		FROM unnest($1::bigint[]) AS x(sid) CROSS JOIN LATERAL (
		  SELECT f.file_path, r.*, e.content_hash FROM `+effectiveFor+` f JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id
		  JOIN code_intelligence.extractions e ON e.id=f.extraction_id
		  WHERE `+col+`=ANY($2) ORDER BY f.file_path,r.line,r.id LIMIT 50) q`, sids, names)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sid int64
		var e Edge
		if err := rows.Scan(&sid, &e.FilePath, &e.ID, &e.ExtractionID, &e.SourceName, &e.TargetName, &e.RelationType, &e.Resolution, &e.Line, &e.ContentHash); err != nil {
			return nil, err
		}
		out[sid] = append(out[sid], e)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- operations

func (st *search) noteEnqueue(name string) {
	repo := st.repos[name]
	for _, e := range st.enqueue {
		if e.Repository == name {
			return
		}
	}
	st.enqueue = append(st.enqueue, EnqueueEntry{Repository: name, RunID: repo.RunID})
}

// symbols is searchSymbols(text, scope, limit) of search.ts.
func (st *search) symbols(ctx context.Context, text string, limit int) ([]Hit, int, error) {
	terms := queryTerms(text)
	if len(terms) == 0 {
		return []Hit{}, 0, nil
	}
	fallbacks := len(st.req.Unavailable)
	perRepo := map[string][]Hit{}
	exactFor := map[string]string{} // fallback exact searches: repository → pattern
	fs := st.freshFor(ctx, st.order)
	var sids []int64
	var indexed []string
	for _, name := range st.order {
		f := fs[name]
		switch {
		case f.err != nil:
			fallbacks++
			exactFor[name] = terms[0]
		case f.snapshot == nil:
			fallbacks++
			st.noteEnqueue(name)
			exactFor[name] = terms[0]
		default:
			sids, indexed = append(sids, f.snapshot.ID), append(indexed, name)
		}
	}
	var rows map[int64][]symbolRow
	var edges map[int64][]edgeRow
	var qerr error
	if len(sids) > 0 {
		rows, qerr = st.symbolRows(ctx, sids, terms, limit)
		if qerr == nil {
			edges, qerr = st.importRows(ctx, sids, terms)
		}
	}
	changed := map[string]bool{}
	if qerr == nil {
		changed = st.changed(ctx, indexed)
	}
	for _, name := range indexed {
		f := fs[name]
		switch {
		case qerr != nil:
			fallbacks++
			exactFor[name] = terms[0]
			continue
		case changed[name]:
			fallbacks++
			st.noteEnqueue(name)
			continue
		}
		sid := f.snapshot.ID
		if len(rows[sid]) == 0 && len(edges[sid]) == 0 {
			fallbacks++
			preferred := terms[0]
			for _, t := range terms {
				if mixedCase.MatchString(t) {
					preferred = t
					break
				}
			}
			exactFor[name] = preferred
		}
		p := provenance(f.snapshot)
		for _, r := range rows[sid] {
			confidence := 0.95
			if r.match == "path" {
				confidence = 0.4
			}
			perRepo[name] = append(perRepo[name], Hit{Repository: name, FilePath: r.filePath, LineRange: [2]int{r.start, r.end},
				MatchType: r.match, Confidence: confidence, Snapshot: p, SymbolName: ptr(r.symbol),
				QualifiedName: ptr(r.qualified), Signature: ptr(r.sig), ContentHash: ptr(r.hash)})
		}
		for _, e := range edges[sid] {
			perRepo[name] = append(perRepo[name], Hit{Repository: name, FilePath: e.filePath, LineRange: [2]int{e.line, e.line},
				MatchType: "dependency", Confidence: 0.4, Snapshot: p, Signature: ptr("syntax reference: " + e.name), ContentHash: ptr(e.hash)})
		}
	}
	// Fallback exact searches (bounded), each with its own limit, in repository order.
	text5 := map[string][]Hit{}
	if len(exactFor) > 0 {
		var names []string
		for _, n := range st.order {
			if _, ok := exactFor[n]; ok {
				names = append(names, n)
			}
		}
		results := parallel(names, func(name string) []Hit {
			hits, _ := st.exactRepo(ctx, name, exactFor[name], min(5, limit), false)
			return hits
		})
		for n, h := range results {
			text5[n] = h
		}
	}
	var all []Hit
	for _, name := range st.order {
		all = append(all, text5[name]...) // pushed before the index rows, as in search.ts
		all = append(all, perRepo[name]...)
	}
	sortHits(all)
	if len(all) > limit {
		all = all[:limit]
	}
	if all == nil {
		all = []Hit{}
	}
	return all, fallbacks, nil
}

var mixedCase = regexp.MustCompile(`[a-z][A-Z]|_|[./]`)

func ptr[T any](v T) *T { return &v }

// sortHits is the comparator of searchSymbols (Array#sort is stable).
func sortHits(h []Hit) {
	slices.SortStableFunc(h, func(a, b Hit) int {
		if a.Confidence != b.Confidence {
			if b.Confidence > a.Confidence {
				return 1
			}
			return -1
		}
		qa, qb := a.MatchType == "qualified", b.MatchType == "qualified"
		if qa != qb {
			if qb {
				return 1
			}
			return -1
		}
		if c := localeCompare(a.Repository, b.Repository); c != 0 {
			return c
		}
		if c := localeCompare(a.FilePath, b.FilePath); c != 0 {
			return c
		}
		return a.LineRange[0] - b.LineRange[0]
	})
}

// dependencies is findDependencies(symbol, scope, depth, direction, report) of search.ts.
func (st *search) dependencies(ctx context.Context, symbol string, depth int, direction string, unavailable *[]string) ([]Edge, error) {
	report := func(s string) {
		if !slices.Contains(*unavailable, s) {
			*unavailable = append(*unavailable, s)
		}
	}
	for _, u := range st.req.Unavailable {
		report(fmt.Sprintf("%s (%s)", u.Name, firstLine(u.Error, 120)))
	}
	result := []Edge{}
	frontier := []string{symbol}
	seen := map[string]bool{}
	levels := min(3, max(1, depth))
	for d := 0; d < levels && len(frontier) > 0; d++ {
		var next []string
		levelStart := len(result)
		names := frontier
		if direction == "in" {
			names = uniq(append(slices.Clone(frontier), mapStrings(frontier, func(n string) string {
				return n[strings.LastIndexByte(n, '.')+1:]
			})...))
		}
		fs := st.freshFor(ctx, st.order)
		var sids []int64
		var indexed []string
		for _, name := range st.order {
			switch f := fs[name]; {
			case f.err != nil:
				report(fmt.Sprintf("%s (%s)", name, firstLine(f.err.Error(), 120)))
			case f.snapshot == nil:
				report(name)
			default:
				sids, indexed = append(sids, f.snapshot.ID), append(indexed, name)
			}
		}
		rows, err := st.relationRows(ctx, sids, names, direction)
		if err != nil {
			for _, n := range indexed {
				report(fmt.Sprintf("%s (%s)", n, firstLine(err.Error(), 120)))
			}
			indexed = nil
		}
		changed := st.changed(ctx, indexed)
		for _, name := range indexed {
			if changed[name] {
				report(name + " (index changed during the query)")
				continue
			}
			f := fs[name]
			for _, r := range rows[f.snapshot.ID] {
				key := fmt.Sprintf("%s:%s:%d", name, r.FilePath, r.ID)
				if seen[key] {
					continue
				}
				seen[key] = true
				r.Repository, r.Snapshot, r.LineRange, r.MatchType, r.Depth = name, provenance(f.snapshot), [2]int{r.Line, r.Line}, "dependency", d+1
				r.Confidence = 0.4
				if r.Resolution == "resolved" {
					r.Confidence = 1
				}
				result = append(result, r)
				if direction == "out" {
					next = append(next, r.TargetName)
				} else {
					next = append(next, r.SourceName)
				}
				if len(result) >= 100 {
					return result, nil
				}
			}
		}
		frontier = uniq(next)
		if len(frontier) > 24 {
			frontier = frontier[:24]
		}
		candidates, _, err := st.symbols(ctx, strings.Join(mapStrings(frontier, func(n string) string { return strings.TrimPrefix(n, "./") }), " "), 60)
		if err != nil {
			return nil, err
		}
		for i := levelStart; i < len(result); i++ {
			target := result[i].TargetName
			var defs []Hit
			for _, h := range candidates {
				if (h.SymbolName != nil && *h.SymbolName == target) || (h.QualifiedName != nil && *h.QualifiedName == target) ||
					h.FilePath == strings.TrimPrefix(target, "./") || strings.HasSuffix(h.FilePath, "/"+target) {
					defs = append(defs, h)
					if len(defs) == 5 {
						break
					}
				}
			}
			if defs == nil {
				defs = []Hit{}
			}
			result[i].CandidateDefinitions = &defs
		}
		var qualified []string
		for _, h := range candidates {
			if h.QualifiedName != nil && *h.QualifiedName != "" {
				qualified = append(qualified, *h.QualifiedName)
			}
		}
		frontier = uniq(append(frontier, qualified...))
		if len(frontier) > 50 {
			frontier = frontier[:50]
		}
	}
	return result, nil
}

func uniq(xs []string) []string {
	var out []string
	for _, x := range xs {
		if !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

func mapStrings(xs []string, f func(string) string) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = f(x)
	}
	return out
}

func firstLine(s string, n int) string {
	s, _, _ = strings.Cut(s, "\n")
	return sliceUTF16(s, n)
}

// ---------------------------------------------------------------- exact search (ripgrep, streamed)

// exactRepo is one repository of searchCodeExact: the worktree generation before, ripgrep streamed and stopped at
// the limit, each match re-read through the symlink-safe reader, and the generation again after (results of a
// repository that changed meanwhile are dropped).
func (st *search) exactRepo(ctx context.Context, name, pattern string, limit int, anyFile bool) ([]Hit, error) {
	repo := st.repos[name]
	root := repo.Root // the run's worktree, or the primary checkout outside a run (resolved by TypeScript)
	headOut, err := gitOut(ctx, root, "rev-parse", "HEAD")
	st.gitCount(1)
	if err != nil {
		return nil, err
	}
	head := strings.TrimSpace(string(headOut))
	_, before, _, err := worktreeChanges(ctx, root, head, st.req.Limits)
	st.gitCount(3)
	if err != nil {
		return nil, err
	}
	args := []string{"--json", "--fixed-strings", "--sort", "path", "--max-count", "5", "--max-filesize", strconv.Itoa(st.req.Limits.MaxFileBytes)}
	if anyFile {
		args = append(args, "--glob", "!**/.env*", "--glob", "!**/*.{pem,key,p12,pfx,jks,keystore}", "--glob", "!**/*secret*",
			"--glob", "!**/node_modules/**", "--glob", "!**/vendor/**")
	} else {
		args = append(args, "--glob", "*.{go,ts,tsx,proto,sql}")
	}
	args = append(args, "--", pattern, ".")
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(rctx, "rg", args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "RIPGREP_CONFIG_PATH=")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, errors.New("ripgrep unavailable; install rg on the assigned worker")
		}
		return nil, err
	}
	st.mu.Lock()
	st.m.RgProcesses++
	st.mu.Unlock()
	var hits []Hit
	sc := bufio.NewScanner(io.LimitReader(out, 512*1024)) // the TypeScript maxBuffer
	sc.Buffer(make([]byte, 64*1024), 512*1024)
	for sc.Scan() && len(hits) < limit {
		var row struct {
			Type string `json:"type"`
			Data struct {
				Path struct {
					Text string `json:"text"`
				} `json:"path"`
				LineNumber int `json:"line_number"`
			} `json:"data"`
		}
		if json.Unmarshal(sc.Bytes(), &row) != nil || row.Type != "match" {
			continue
		}
		p := strings.TrimPrefix(row.Data.Path.Text, "./")
		if p == "" || (anyFile && !eligibleText(p, st.req.Limits)) || (!anyFile && !eligible(p, st.req.Limits)) {
			continue
		}
		source := st.worktreeSource(root, p)
		if source == nil {
			continue
		}
		lines := strings.Split(*source, "\n")
		n := row.Data.LineNumber
		if n < 1 || n > len(lines) || !strings.Contains(lines[n-1], pattern) {
			continue
		}
		run := repo.RunID
		hits = append(hits, Hit{Repository: name, FilePath: p, LineRange: [2]int{n, n}, MatchType: "text", Confidence: 0.5,
			Snapshot: Provenance{Commit: head, Generation: before, RunID: run},
			Snippet:  ptr(redactSecrets(sliceUTF16(lines[n-1], 400))), ContentHash: ptr(sha256Hex(*source))})
	}
	// Enough matches (or the output cap): stop ripgrep instead of letting it finish.
	cancel()
	_ = cmd.Wait()
	if rctx.Err() == context.DeadlineExceeded && ctx.Err() == nil && len(hits) < limit {
		return nil, errors.New("Bounded exact search unavailable")
	}
	_, after, _, err := worktreeChanges(ctx, root, head, st.req.Limits)
	st.gitCount(3)
	if err != nil || after != before {
		return nil, nil
	}
	return hits, nil
}

var secretFile = regexp.MustCompile(`(?i)(?:^|/)\.env(?:\.[^/]*)?$|\.(?:pem|key|p12|pfx|jks|keystore)$|(?:^|/)id_(?:rsa|dsa|ecdsa|ed25519)|(?:^|/)[^/]*secret[^/]*$|(?:^|/)\.npmrc$|(?:^|/)\.netrc$`)

// eligibleText is eligibleText() of search.ts: any non-secret file outside build output and dependencies.
func eligibleText(p string, lim Limits) bool {
	if secretFile.MatchString(p) {
		return false
	}
	for _, s := range strings.Split(p, "/") {
		if buildDir.MatchString(s) || (!lim.IncludeDependencies && dependencies.MatchString(s)) {
			return false
		}
	}
	for _, x := range lim.Excludes {
		if strings.Contains(p, x) {
			return false
		}
	}
	return true
}

// exact is searchCodeExact(pattern, scope, limit, {anyFile}) of search.ts: repositories taken in scope order, four
// at a time, results kept in repository order up to the limit (the sequential result, deterministically). Like the
// sequential loop it stops as soon as the repositories searched so far fill the limit: later repositories are not
// searched (and their errors, which TypeScript would never have reached, do not count).
func (st *search) exact(ctx context.Context, pattern string, limit int, anyFile bool) ([]Hit, error) {
	type res struct {
		hits []Hit
		err  error
	}
	hits := []Hit{}
	for start := 0; start < len(st.order) && len(hits) < limit; start += 4 {
		window := st.order[start:min(start+4, len(st.order))]
		results := parallel(window, func(name string) res {
			h, err := st.exactRepo(ctx, name, pattern, limit, anyFile)
			return res{h, err}
		})
		for _, name := range window {
			r := results[name]
			if r.err != nil {
				return nil, r.err
			}
			hits = append(hits, r.hits[:min(len(r.hits), limit-len(hits))]...)
			if len(hits) >= limit {
				break
			}
		}
	}
	return hits, nil
}

// ---------------------------------------------------------------- sources and code context

// worktreeSource reads a working-tree file once per request through the symlink-safe reader.
func (st *search) worktreeSource(root, p string) *string {
	key := root + "\x00" + p
	st.mu.Lock()
	if v, ok := st.sources[key]; ok {
		st.mu.Unlock()
		return v
	}
	st.mu.Unlock()
	v, err := readSource(root, p, st.req.Limits.MaxFileBytes)
	if err != nil {
		v = nil
	}
	st.mu.Lock()
	st.sources[key] = v
	st.m.SourceReads++
	if v != nil {
		st.m.SourceBytes += int64(len(*v))
	}
	st.mu.Unlock()
	return v
}

var commitID = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

// committedSources reads <commit>:<path> objects of one checkout in a single `git cat-file --batch`.
func (st *search) committedSources(ctx context.Context, root string, specs []string) {
	var todo []string
	for _, s := range specs {
		commit, p, _ := strings.Cut(s, ":")
		st.mu.Lock()
		_, done := st.sources[s]
		st.mu.Unlock()
		if done || !commitID.MatchString(commit) || p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "..") || strings.ContainsAny(p, "\n\x00") {
			continue
		}
		todo = append(todo, s)
	}
	if len(todo) == 0 {
		return
	}
	cmd := exec.CommandContext(ctx, "git", "-c", "core.fsmonitor=false", "-C", root, "cat-file", "--batch")
	cmd.Stdin = strings.NewReader(strings.Join(todo, "\n") + "\n")
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return
	}
	st.gitCount(1)
	r := bufio.NewReaderSize(out, 1<<16)
	for _, spec := range todo {
		header, err := r.ReadString('\n')
		if err != nil {
			break
		}
		f := strings.Fields(header)
		var content *string
		if len(f) == 3 && f[1] == "blob" {
			size, _ := strconv.Atoi(f[2])
			buf := make([]byte, size+1)
			if _, err := io.ReadFull(r, buf); err != nil {
				break
			}
			if size <= st.req.Limits.MaxFileBytes {
				content = ptr(decodeUTF8(buf[:size]))
			}
		}
		st.mu.Lock()
		st.sources[spec] = content
		st.m.SourceReads++
		if content != nil {
			st.m.SourceBytes += int64(len(*content))
		}
		st.mu.Unlock()
	}
	_ = cmd.Wait()
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// context is buildCodeContext(text, scope) of search.ts. The per-name dependency and caller lookups share this
// request's freshness and sources; committed sources are read in one batch per checkout.
func (st *search) context(ctx context.Context, text string) (string, []Hit, int, error) {
	primary, fallbacks, err := st.symbols(ctx, text, 25)
	if err != nil {
		return "", nil, 0, err
	}
	var qualified []string
	for _, h := range primary {
		if h.QualifiedName != nil && *h.QualifiedName != "" {
			qualified = append(qualified, *h.QualifiedName)
			if len(qualified) == 4 {
				break
			}
		}
	}
	var supporting []Hit
	var ignored []string
	for _, name := range qualified {
		edges, err := st.dependencies(ctx, name, 1, "out", &ignored)
		if err != nil {
			return "", nil, 0, err
		}
		for _, e := range edges {
			if e.CandidateDefinitions != nil {
				supporting = append(supporting, *e.CandidateDefinitions...)
			}
		}
		callers, err := st.dependencies(ctx, name, 1, "in", &ignored)
		if err != nil {
			return "", nil, 0, err
		}
		for _, e := range callers[:min(3, len(callers))] {
			supporting = append(supporting, Hit{Repository: e.Repository, FilePath: e.FilePath, LineRange: e.LineRange,
				MatchType: "caller_candidate", Confidence: 0.4, Snapshot: e.Snapshot, ContentHash: ptr(e.ContentHash)})
		}
	}
	// One validation for everything above: evidence of a repository whose snapshot changed is dropped.
	if changed := st.settle(ctx); len(changed) > 0 {
		keep := func(h Hit) bool { return h.Snapshot.ID == nil || !changed[h.Repository] }
		before := len(primary)
		primary = slices.DeleteFunc(primary, func(h Hit) bool { return !keep(h) })
		fallbacks += before - len(primary)
		supporting = slices.DeleteFunc(supporting, func(h Hit) bool { return !keep(h) })
	}
	candidates := append(slices.Clone(primary), supporting...)
	// Read every committed source the context may need in one cat-file batch per checkout.
	specs := map[string][]string{}
	for _, h := range candidates {
		if repo := st.repos[h.Repository]; repo != nil && h.Snapshot.RunID == nil && h.Snapshot.ID != nil {
			specs[repo.Primary] = append(specs[repo.Primary], h.Snapshot.Commit+":"+h.FilePath)
		}
	}
	for root, s := range specs {
		st.committedSources(ctx, root, uniq(s))
	}
	remaining := st.req.ContextChars
	used := map[string][][2]int{}
	var parts []string
	for _, h := range candidates {
		if remaining < 200 {
			break
		}
		repo := st.repos[h.Repository]
		if repo == nil {
			continue
		}
		id := "null"
		if h.Snapshot.ID != nil {
			id = strconv.FormatInt(*h.Snapshot.ID, 10)
		}
		key := fmt.Sprintf("%s:%s:%s:%s", h.Repository, h.FilePath, id, h.Snapshot.Generation)
		first, last := h.LineRange[0], h.LineRange[1]
		end := min(last, first+18)
		if slices.ContainsFunc(used[key], func(r [2]int) bool { return first <= r[1] && end >= r[0] }) {
			continue
		}
		var source *string
		if h.Snapshot.RunID != nil || h.Snapshot.ID == nil {
			root := repo.Primary
			if h.Snapshot.RunID != nil {
				root = repo.Root
			}
			source = st.worktreeSource(root, h.FilePath)
		} else {
			st.mu.Lock()
			source = st.sources[h.Snapshot.Commit+":"+h.FilePath]
			st.mu.Unlock()
		}
		if source == nil || h.ContentHash == nil || sha256Hex(*source) != *h.ContentHash {
			continue
		}
		lines := strings.Split(*source, "\n")
		lo, hi := max(0, first-1), min(len(lines), max(0, end))
		snippet := ""
		if lo < hi {
			snippet = strings.Join(lines[lo:hi], "\n")
		}
		run := "base"
		if h.Snapshot.RunID != nil {
			run = strconv.FormatInt(*h.Snapshot.RunID, 10)
		}
		sig := ""
		if h.Signature != nil {
			sig = *h.Signature
		}
		block := fmt.Sprintf("%s/%s:%d-%d commit=%s worktree_run=%s generation=%s\n%s\n%s",
			h.Repository, h.FilePath, first, end, h.Snapshot.Commit, run, h.Snapshot.Generation, sig, redactSecrets(snippet))
		selected := sliceUTF16(block, remaining)
		parts = append(parts, selected)
		remaining -= utf16Len(selected) + 2
		used[key] = append(used[key], [2]int{first, end})
	}
	body := sliceUTF16(strings.Join(parts, "\n\n"), st.req.ContextChars)
	return body, primary[:min(10, len(primary))], fallbacks, nil
}

// Search answers one request. Slots bound concurrent requests; the caller's deadline bounds the work.
func (s *Searcher) Search(ctx context.Context, req *SearchRequest) (*SearchResponse, error) {
	select {
	case s.Slots <- struct{}{}:
		defer func() { <-s.Slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	start := time.Now()
	st := &search{s: s, req: req, repos: map[string]*SearchRepo{}, fresh: map[string]*freshness{},
		sources: map[string]*string{}, pending: map[string]bool{}}
	for i := range req.Repositories {
		r := &req.Repositories[i]
		st.repos[r.Name] = r
		st.order = append(st.order, r.Name)
	}
	resp := &SearchResponse{Unavailable: []string{}, Enqueue: []EnqueueEntry{}}
	var err error
	switch req.Op {
	case "symbols":
		resp.Hits, resp.FallbackCount, err = st.symbols(ctx, req.Text, req.Limit)
	case "dependencies":
		st.deferred = true
		resp.Edges, err = st.dependencies(ctx, req.Symbol, req.Depth, cmpOr(req.Direction, "out"), &resp.Unavailable)
		if err == nil {
			changed := st.settle(ctx)
			resp.Edges = dropChangedEdges(resp.Edges, changed, &resp.Unavailable)
		}
	case "exact":
		resp.Hits, err = st.exact(ctx, req.Pattern, req.Limit, req.AnyFile)
	case "context":
		st.deferred = true
		var body string
		body, resp.Hits, resp.FallbackCount, err = st.context(ctx, req.Text)
		resp.Body = &body
	}
	if err != nil {
		return nil, err
	}
	resp.Enqueue = append(resp.Enqueue, st.enqueue...)
	st.m.TookMs = time.Since(start).Milliseconds()
	resp.Metrics = st.m
	return resp, nil
}

func cmpOr(a, b string) string {
	if a == "" {
		return b
	}
	return a
}

// dropChangedEdges removes edges (and candidate definitions) from repositories whose snapshot changed during the
// request, reporting them like the per-query recheck of search.ts does.
func dropChangedEdges(edges []Edge, changed map[string]bool, unavailable *[]string) []Edge {
	if len(changed) == 0 {
		return edges
	}
	for name, c := range changed {
		if c && !slices.Contains(*unavailable, name+" (index changed during the query)") {
			*unavailable = append(*unavailable, name+" (index changed during the query)")
		}
	}
	edges = slices.DeleteFunc(edges, func(e Edge) bool { return changed[e.Repository] })
	for i := range edges {
		if edges[i].CandidateDefinitions != nil {
			defs := slices.DeleteFunc(slices.Clone(*edges[i].CandidateDefinitions), func(h Hit) bool {
				return h.Snapshot.ID != nil && changed[h.Repository]
			})
			edges[i].CandidateDefinitions = &defs
		}
	}
	return edges
}
