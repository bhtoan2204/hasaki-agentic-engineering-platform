package retrieval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"unicode/utf8"

	"hasaki-orbit/go/internal/platform"
)

var sourceKinds = []string{"knowledge", "skill", "task_memory", "lesson", "chat_memory"}

// Routes registers the /internal/v1/retrieval endpoints on mux. Authentication and deadlines are applied by the
// caller.
func Routes(mux *http.ServeMux, svc *Service, log *slog.Logger) {
	h := handler{svc: svc, log: log}
	mux.HandleFunc("POST /internal/v1/retrieval/search", h.search)
	mux.HandleFunc("POST /internal/v1/retrieval/reindex", h.reindex)
	mux.HandleFunc("GET /internal/v1/retrieval/status", h.status)
}

type handler struct {
	svc *Service
	log *slog.Logger
}

func (h handler) search(w http.ResponseWriter, r *http.Request) {
	var req SearchRequest
	if !decode(w, r, &req) {
		return
	}
	if err := validateSearch(req); err != nil {
		platform.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	resp, err := h.svc.Search(r.Context(), req)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if resp.Results == nil {
		resp.Results = []SearchHit{}
	}
	platform.WriteJSON(w, http.StatusOK, resp)
}

func validateSearch(req SearchRequest) error {
	switch {
	case req.OwnerID < 1:
		return errors.New("owner_id must be a positive integer")
	case req.Query == "" || utf8.RuneCountInString(req.Query) > 8000:
		return errors.New("query must have 1 to 8000 characters")
	case req.TopK < 1 || req.TopK > 100:
		return errors.New("top_k must be in [1, 100]")
	case req.MinSimilarity != nil && (*req.MinSimilarity < -1 || *req.MinSimilarity > 1):
		return errors.New("min_similarity must be in [-1, 1]")
	case len(req.SourceIDs) > 5000:
		return errors.New("source_ids accepts at most 5000 ids")
	case slices.ContainsFunc(req.SourceIDs, func(id int64) bool { return id < 1 }):
		return errors.New("source_ids must be positive integers")
	case slices.ContainsFunc(req.SourceKinds, func(k string) bool { return !slices.Contains(sourceKinds, k) }):
		return fmt.Errorf("source_kinds must be among %v", sourceKinds)
	}
	return nil
}

type reindexRequest struct {
	SourceIDs []int64 `json:"source_ids"`
	All       bool    `json:"all"`
}

func (h handler) reindex(w http.ResponseWriter, r *http.Request) {
	var req reindexRequest
	if !decode(w, r, &req) {
		return
	}
	switch {
	case !req.All && len(req.SourceIDs) == 0:
		platform.WriteError(w, http.StatusBadRequest, "bad_request", "set all or source_ids")
		return
	case len(req.SourceIDs) > 5000 || slices.ContainsFunc(req.SourceIDs, func(id int64) bool { return id < 1 }):
		platform.WriteError(w, http.StatusBadRequest, "bad_request", "source_ids must be at most 5000 positive integers")
		return
	}
	n, err := h.svc.Reindex(r.Context(), req.SourceIDs, req.All)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	platform.WriteJSON(w, http.StatusOK, map[string]int64{"enqueued": n})
}

func (h handler) status(w http.ResponseWriter, r *http.Request) {
	st, err := h.svc.Status(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	platform.WriteJSON(w, http.StatusOK, st)
}

func (h handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, errVectorUnavailable):
		platform.WriteError(w, http.StatusServiceUnavailable, "vector_unavailable", err.Error())
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(r.Context().Err(), context.DeadlineExceeded):
		platform.WriteError(w, http.StatusGatewayTimeout, "timeout", "request deadline exceeded")
	case errors.Is(err, errEmbedder):
		h.log.WarnContext(r.Context(), "embedder unavailable", "error", err)
		platform.WriteError(w, http.StatusServiceUnavailable, "embedder_unavailable", "embedding provider unavailable")
	case errors.Is(err, context.Canceled):
		h.log.InfoContext(r.Context(), "request canceled by client", "path", r.URL.Path)
		platform.WriteError(w, 499, "timeout", "request canceled")
	default:
		h.log.ErrorContext(r.Context(), "request failed", "path", r.URL.Path, "error", err)
		platform.WriteError(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		platform.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: "+err.Error())
		return false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		platform.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: trailing data")
		return false
	}
	return true
}
