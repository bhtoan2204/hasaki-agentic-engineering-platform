package codeintelligence

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"hasaki-orbit/go/internal/platform"
)

// maxJobDuration bounds one request whatever the caller asks (the TypeScript job timeout is far below it).
const maxJobDuration = time.Hour

// Routes registers POST /internal/v1/code-intelligence/index. It runs outside the short internal request deadline:
// the caller's X-Request-Timeout-Ms (its job timeout) bounds the job, and a disconnect cancels it.
func Routes(mux *http.ServeMux, ix *Indexer, log *slog.Logger) {
	routeSearch(mux, ix.searcher, log)
	mux.HandleFunc("POST /internal/v1/code-intelligence/index", func(w http.ResponseWriter, r *http.Request) {
		timeout := maxJobDuration
		if ms, err := strconv.Atoi(r.Header.Get("X-Request-Timeout-Ms")); err == nil && ms > 0 {
			timeout = min(timeout, time.Duration(ms)*time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(timeout + 5*time.Second))
		var req Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body")
			return
		}
		if req.RepositoryID <= 0 || req.Primary == "" || req.Base == "" || (req.RunID != nil && req.Root == "") ||
			req.Limits.MaxFileBytes <= 0 || req.Limits.MaxSymbols <= 0 || req.Limits.MaxFiles <= 0 ||
			req.Limits.MaxScanBytes <= 0 || req.Limits.TimeoutMs <= 0 {
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", "repository, paths, base and limits are required")
			return
		}
		if err := ix.trustedJob(req); err != nil {
			if errors.Is(err, ErrVersion) {
				platform.WriteError(w, http.StatusConflict, "version_mismatch", err.Error())
			} else if errors.Is(err, ErrUnconfigured) {
				platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", err.Error())
			} else {
				platform.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			}
			return
		}
		res, err := ix.Index(ctx, req)
		switch {
		case err == nil:
			platform.WriteJSON(w, http.StatusOK, res)
		case errors.Is(err, ErrVersion):
			platform.WriteError(w, http.StatusConflict, "version_mismatch", err.Error())
		case errors.Is(err, errLeaseLost):
			platform.WriteError(w, http.StatusConflict, "lease_lost", err.Error())
		default:
			// Only the TypeScript-compatible category reaches the caller: Git and database errors can embed paths.
			log.Warn("code intelligence index failed", "repository_id", req.RepositoryID, "error", err)
			platform.WriteError(w, http.StatusUnprocessableEntity, "index_failed", publicMessage(err))
		}
	})
}

// trustedJob: the checkouts an indexing job reads lie inside the trusted roots of this process's configuration
// (never only where a request says) and its base is a commit id, not something git could take as an option.
func (ix *Indexer) trustedJob(r Request) error {
	if !strings.HasPrefix(r.ParserVersion, ExtractorVersion+"/") {
		return ErrVersion // another extractor answers 409 whatever the paths
	}
	if len(ix.searcher.Roots) == 0 {
		return ErrUnconfigured
	}
	if !commitID.MatchString(r.Base) {
		return errors.New("base must be a commit id")
	}
	paths := []string{r.Primary}
	if r.Root != "" {
		paths = append(paths, r.Root)
	}
	for _, p := range paths {
		if !filepath.IsAbs(p) || filepath.Clean(p) != p {
			return errors.New("checkout path is not absolute and clean")
		}
		real, err := filepath.EvalSymlinks(p)
		if err != nil || !platform.Inside(real, ix.searcher.Roots) {
			return errors.New("checkout path outside the trusted roots")
		}
		if _, err := os.Lstat(filepath.Join(p, ".git")); err != nil {
			return errors.New("checkout path is not a Git checkout")
		}
	}
	return nil
}

var publicMessages = []string{
	"limit exceeded", "Index timeout", "lease lost", "changed while indexing", "Parser unavailable",
	"Parser deadline exceeded", "Blob size limit exceeded", "Invalid Git",
}

func publicMessage(err error) string {
	msg := err.Error()
	for _, m := range publicMessages {
		if strings.Contains(strings.ToLower(msg), strings.ToLower(m)) {
			return msg
		}
	}
	return "Indexing failed; check local parser/database/Git availability"
}

// maxSearch bounds one search request whatever the caller asks.
const maxSearch = 60 * time.Second

// routeSearch registers POST /internal/v1/code-intelligence/search (contract code-intelligence-v1 SearchRequest):
// min(X-Request-Timeout-Ms, 60 s) bounds it, a disconnect cancels it (Git and ripgrep included).
func routeSearch(mux *http.ServeMux, s *Searcher, log *slog.Logger) {
	if s == nil {
		return
	}
	mux.HandleFunc("POST /internal/v1/code-intelligence/search", func(w http.ResponseWriter, r *http.Request) {
		timeout := maxSearch
		if ms, err := strconv.Atoi(r.Header.Get("X-Request-Timeout-Ms")); err == nil && ms > 0 {
			timeout = min(timeout, time.Duration(ms)*time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(timeout + 5*time.Second))
		var req SearchRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body")
			return
		}
		if err := ValidateSearch(&req, s.Roots); err != nil {
			if errors.Is(err, ErrVersion) {
				platform.WriteError(w, http.StatusConflict, "version_mismatch", err.Error())
				return
			}
			if errors.Is(err, ErrUnconfigured) {
				platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", err.Error())
				return
			}
			platform.WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		res, err := s.Search(ctx, &req)
		switch {
		case err == nil:
			platform.WriteJSON(w, http.StatusOK, res)
		case errors.Is(err, context.DeadlineExceeded):
			platform.WriteError(w, http.StatusGatewayTimeout, "timeout", "code search exceeded its deadline")
		case r.Context().Err() != nil:
			return // caller gone
		case errors.Is(err, ErrRipgrepUnavailable):
			platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", err.Error())
		default:
			// Paths and SQL stay in the log; the caller reports the search as unavailable.
			log.Warn("code search failed", "op", req.Op, "error", err)
			platform.WriteError(w, http.StatusServiceUnavailable, "unavailable", "code search failed")
		}
	})
}
