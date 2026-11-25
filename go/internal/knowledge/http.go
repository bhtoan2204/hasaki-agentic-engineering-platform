// Package knowledge is the repository knowledge scan of KNOWLEDGE_IMPORT_ENGINE=go (ADR 0007): discovery of agent
// instructions, conventions, skills and wiki documents in repositories TypeScript selected, read inside the roots this
// platform-go was configured with. It only reads; scope, applicability, governance and publication stay in TypeScript.
package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"hasaki-orbit/go/internal/platform"
)

// ScanVersion is KNOWLEDGE_SCAN_VERSION of src/knowledge/goKnowledge.ts: the discovery rules both engines implement.
const ScanVersion = "knowledge-scan-1"

// ScanRequest is the knowledge-v1 ScanRequest.
type ScanRequest struct {
	Version       string       `json:"version"`
	Repositories  []Repository `json:"repositories"`
	UserSkillsDir *string      `json:"user_skills_dir"`
	Limits        Limits       `json:"limits"`
}

// ScanResponse is the knowledge-v1 ScanResponse.
type ScanResponse struct {
	Discovery
	Metrics Metrics `json:"metrics"`
}

var (
	ErrVersion      = errors.New("knowledge scan version mismatch")
	ErrUnconfigured = errors.New("no trusted roots configured (PLATFORM_TRUSTED_ROOTS)")
)

// Scanner answers scans inside Roots (real paths, from this process's configuration — never from a request).
type Scanner struct {
	Roots []string
	slots chan struct{}
}

// NewScanner allows `concurrent` scans at once; more wait for a slot (or their request's end).
func NewScanner(roots []string, concurrent int) *Scanner {
	return &Scanner{Roots: roots, slots: make(chan struct{}, concurrent)}
}

// Validate refuses anything TypeScript would never send: another rules version, paths outside the trusted roots
// (after resolving symlinks), checkouts without .git, duplicate or malformed names, limits beyond the hard caps.
func (s *Scanner) Validate(r *ScanRequest) error {
	if r.Version != ScanVersion {
		return ErrVersion
	}
	if len(s.Roots) == 0 {
		return ErrUnconfigured
	}
	l := r.Limits
	if l.MaxFileBytes <= 0 || l.MaxFileBytes > 16<<20 || l.MaxEntries <= 0 || l.MaxEntries > 200_000 ||
		l.MaxTotalBytes <= 0 || l.MaxTotalBytes > 4<<30 || l.DeadlineMs <= 0 || l.DeadlineMs > 600_000 ||
		l.MaxChars <= 0 || l.MaxChars > 1_000_000 {
		return errors.New("limits out of bounds")
	}
	if len(r.Repositories) > 500 {
		return errors.New("at most 500 repositories per scan")
	}
	seen := map[string]bool{}
	for _, repo := range r.Repositories {
		if repo.Name == "" || len(repo.Name) > 200 || strings.ContainsAny(repo.Name, "/\x00") || seen[repo.Name] {
			return fmt.Errorf("invalid repository name %q", repo.Name)
		}
		seen[repo.Name] = true
		if err := s.trusted(repo.Root); err != nil {
			return fmt.Errorf("repository %q: %w", repo.Name, err)
		}
		if _, err := os.Lstat(filepath.Join(repo.Root, ".git")); err != nil {
			return fmt.Errorf("repository %q: not a Git checkout", repo.Name)
		}
	}
	if r.UserSkillsDir != nil {
		if err := s.trusted(*r.UserSkillsDir); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("user skills directory: %w", err)
		}
	}
	return nil
}

// trusted: p is absolute and clean and its real path lies inside one of the configured roots.
func (s *Scanner) trusted(p string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return errors.New("path is not absolute and clean")
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return err
	}
	if !platform.Inside(real, s.Roots) {
		return errors.New("path outside the trusted roots")
	}
	return nil
}

// Scan validates and runs one request.
func (s *Scanner) Scan(ctx context.Context, r *ScanRequest) (*ScanResponse, error) {
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	dir := ""
	if r.UserSkillsDir != nil {
		dir = *r.UserSkillsDir
	}
	d, m, err := Discover(ctx, r.Repositories, dir, r.Limits)
	if err != nil {
		return nil, err
	}
	return &ScanResponse{Discovery: d, Metrics: m}, nil
}

// Routes mounts POST /internal/v1/knowledge/scan. The caller's X-Request-Timeout-Ms bounds the request; the scan's own
// deadline (limits.deadline_ms) ends it earlier with the unfinished repositories reported incomplete.
func Routes(mux *http.ServeMux, s *Scanner, log *slog.Logger) {
	mux.HandleFunc("POST /internal/v1/knowledge/scan", func(w http.ResponseWriter, r *http.Request) {
		timeout := 10 * time.Minute
		if ms, err := strconv.Atoi(r.Header.Get("X-Request-Timeout-Ms")); err == nil && ms > 0 {
			timeout = min(timeout, time.Duration(ms)*time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(timeout + 5*time.Second))
		var req ScanRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body")
			return
		}
		if err := s.Validate(&req); err != nil {
			switch {
			case errors.Is(err, ErrVersion):
				platform.WriteError(w, http.StatusConflict, "version_mismatch", err.Error())
			case errors.Is(err, ErrUnconfigured):
				platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", err.Error())
			default:
				platform.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			}
			return
		}
		res, err := s.Scan(ctx, &req)
		switch {
		case err == nil:
			platform.WriteJSON(w, http.StatusOK, res)
		case errors.Is(err, context.DeadlineExceeded):
			platform.WriteError(w, http.StatusGatewayTimeout, "timeout", "knowledge scan exceeded its deadline")
		default:
			log.Warn("knowledge scan failed", "error", err)
			platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", "knowledge scan failed")
		}
	})
}
