package codeintelligence

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"claude-task-platform/go/internal/platform"
)

// maxJobDuration bounds one request whatever the caller asks (the TypeScript job timeout is far below it).
const maxJobDuration = time.Hour

// Routes registers POST /internal/v1/code-intelligence/index. It runs outside the short internal request deadline:
// the caller's X-Request-Timeout-Ms (its job timeout) bounds the job, and a disconnect cancels it.
func Routes(mux *http.ServeMux, ix *Indexer, log *slog.Logger) {
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
