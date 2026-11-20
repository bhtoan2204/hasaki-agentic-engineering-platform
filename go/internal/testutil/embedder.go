// Package testutil provides a deterministic embedding provider emulator for tests and benchmarks.
package testutil

import (
	"encoding/json"
	"hash/fnv"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"unicode"
)

// FakeEmbedder emulates Ollama POST /api/embed and OpenAI POST /v1/embeddings with hashed bag-of-words vectors,
// so texts sharing words are similar.
type FakeEmbedder struct {
	*httptest.Server
	Dims     int
	Requests atomic.Int64
	Texts    atomic.Int64
	Fail     atomic.Bool
	WrongDim atomic.Bool
}

func NewFakeEmbedder(dims int) *FakeEmbedder {
	f := &FakeEmbedder{Dims: dims}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/embed", func(w http.ResponseWriter, r *http.Request) {
		vecs, ok := f.embed(w, r)
		if ok {
			_ = json.NewEncoder(w).Encode(map[string]any{"model": "fake", "embeddings": vecs})
		}
	})
	mux.HandleFunc("POST /v1/embeddings", func(w http.ResponseWriter, r *http.Request) {
		vecs, ok := f.embed(w, r)
		if !ok {
			return
		}
		data := make([]map[string]any, len(vecs))
		for i, v := range vecs {
			data[len(vecs)-1-i] = map[string]any{"object": "embedding", "index": i, "embedding": v}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
	})
	f.Server = httptest.NewServer(mux)
	return f
}

func (f *FakeEmbedder) embed(w http.ResponseWriter, r *http.Request) ([][]float32, bool) {
	f.Requests.Add(1)
	if f.Fail.Load() {
		http.Error(w, "model not loaded", http.StatusInternalServerError)
		return nil, false
	}
	var in struct {
		Input []string `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return nil, false
	}
	f.Texts.Add(int64(len(in.Input)))
	dims := f.Dims
	if f.WrongDim.Load() {
		dims++
	}
	vecs := make([][]float32, len(in.Input))
	for i, t := range in.Input {
		vecs[i] = Vector(t, dims)
	}
	return vecs, true
}

// Vector is the unit-length hashed bag-of-words embedding of text.
func Vector(text string, dims int) []float32 {
	v := make([]float32, dims)
	for _, tok := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		h := fnv.New64a()
		_, _ = h.Write([]byte(tok))
		x := h.Sum64()
		sign := float32(1)
		if x>>63 == 1 {
			sign = -1
		}
		v[x%uint64(dims)] += sign
	}
	var norm float64
	for _, x := range v {
		norm += float64(x * x)
	}
	if norm == 0 {
		v[0] = 1
		return v
	}
	n := float32(math.Sqrt(norm))
	for i := range v {
		v[i] /= n
	}
	return v
}
