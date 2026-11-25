package retrieval

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"hasaki-orbit/go/internal/platform"
)

const testToken = "test-token-0123456789abcdef-0123456789"

var discard = slog.New(slog.DiscardHandler)

func contractSchema(t testing.TB, def string) *jsonschema.Schema {
	t.Helper()
	path, err := filepath.Abs("../../contracts/retrieval-v1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	s, err := c.Compile("file://" + path + "#/$defs/" + def)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func assertContract(t testing.TB, def string, body []byte) {
	t.Helper()
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("%s: invalid JSON %q: %v", def, body, err)
	}
	if err := contractSchema(t, def).Validate(v); err != nil {
		t.Fatalf("%s does not match the contract: %v\n%s", def, err, body)
	}
}

// testServer wires the handlers exactly like cmd/platform-go.
func testServer(svc *Service) http.Handler {
	internal := http.NewServeMux()
	Routes(internal, svc, discard)
	mux := http.NewServeMux()
	mux.Handle("/internal/", platform.RequireBearer(testToken, platform.WithDeadline(2*time.Second, internal)))
	return mux
}

func call(t testing.TB, h http.Handler, method, path, body string, header ...string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestContractExamples(t *testing.T) {
	for file, def := range map[string]string{
		"search-request.json":  "SearchRequest",
		"search-response.json": "SearchResponse",
		"status.json":          "Status",
		"error.json":           "Error",
	} {
		body, err := os.ReadFile(filepath.Join("../../contracts/examples", file))
		if err != nil {
			t.Fatal(err)
		}
		assertContract(t, def, body)
	}
	body, _ := os.ReadFile("../../contracts/examples/search-request.json")
	var req SearchRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || validateSearch(req) != nil {
		t.Fatalf("example request rejected by the handler: %v %v", err, validateSearch(req))
	}
}

type stubEmbedder struct {
	err   error
	delay time.Duration
}

func (s stubEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	select {
	case <-time.After(s.delay):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return nil, s.err
}

func TestErrorResponsesMatchContract(t *testing.T) {
	newSvc := func(vector bool, e Embedder) http.Handler {
		svc, err := newService(store{}, e, "ollama/fake@8", vector, discard)
		if err != nil {
			t.Fatal(err)
		}
		return testServer(svc)
	}
	down := newSvc(true, stubEmbedder{err: context.Canceled})
	valid := `{"owner_id":1,"query":"q","top_k":5}`
	tests := []struct {
		name   string
		h      http.Handler
		body   string
		header []string
		status int
		code   string
	}{
		{"unknown field", down, `{"owner_id":1,"query":"q","top_k":5,"candidate_keys":[]}`, nil, 400, "bad_request"},
		{"missing top_k", down, `{"owner_id":1,"query":"q"}`, nil, 400, "bad_request"},
		{"owner zero", down, `{"owner_id":0,"query":"q","top_k":5}`, nil, 400, "bad_request"},
		{"empty query", down, `{"owner_id":1,"query":"","top_k":5}`, nil, 400, "bad_request"},
		{"long query", down, `{"owner_id":1,"query":"` + strings.Repeat("é", 8001) + `","top_k":5}`, nil, 400, "bad_request"},
		{"top_k too big", down, `{"owner_id":1,"query":"q","top_k":101}`, nil, 400, "bad_request"},
		{"bad kind", down, `{"owner_id":1,"query":"q","top_k":5,"source_kinds":["code"]}`, nil, 400, "bad_request"},
		{"bad similarity", down, `{"owner_id":1,"query":"q","top_k":5,"min_similarity":2}`, nil, 400, "bad_request"},
		{"trailing data", down, valid + `{}`, nil, 400, "bad_request"},
		{"no auth", down, valid, []string{"Authorization", ""}, 401, "unauthorized"},
		{"no pgvector", newSvc(false, stubEmbedder{}), valid, nil, 503, "vector_unavailable"},
		{"embedder down", down, valid, nil, 503, "embedder_unavailable"},
		{"deadline", newSvc(true, stubEmbedder{delay: time.Second}), valid, []string{"X-Request-Timeout-Ms", "20"}, 504, "timeout"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := call(t, tt.h, http.MethodPost, "/internal/v1/retrieval/search", tt.body, tt.header...)
			if w.Code != tt.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tt.status, w.Body)
			}
			assertContract(t, "Error", w.Body.Bytes())
			var e struct{ Code string }
			_ = json.Unmarshal(w.Body.Bytes(), &e)
			if e.Code != tt.code {
				t.Fatalf("code %q, want %q", e.Code, tt.code)
			}
		})
	}
	w := call(t, down, http.MethodPost, "/internal/v1/retrieval/reindex", `{}`)
	if w.Code != 400 {
		t.Fatalf("empty reindex: %d", w.Code)
	}
	assertContract(t, "Error", w.Body.Bytes())
}
