package codeintelligence

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func assertContract(t *testing.T, def string, body []byte) {
	t.Helper()
	path, err := filepath.Abs("../../contracts/code-intelligence-v1.schema.json")
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

const validRequest = `{"repository_id":1,"primary":"/r","root":"/r","base":"` +
	"0123456789abcdef0123456789abcdef01234567" + `","run_id":null,"parser_version":"%s","instance_id":"i",
	"fence":null,"limits":{"max_file_bytes":1,"max_symbols":1,"max_files":1,"max_scan_bytes":1,"timeout_ms":1000,
	"excludes":[],"include_generated":false,"include_dependencies":false}}`

func TestContractErrors(t *testing.T) {
	mux := http.NewServeMux()
	Routes(mux, NewIndexer(nil, 1, 1), slog.New(slog.DiscardHandler))
	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/internal/v1/code-intelligence/index", strings.NewReader(body)))
		return w
	}
	assertContract(t, "IndexRequest", []byte(strings.Replace(validRequest, "%s", ExtractorVersion+"/x", 1)))
	for body, status := range map[string]int{
		`{`:                   http.StatusBadRequest,
		`{"repository_id":1}`: http.StatusBadRequest,
		strings.Replace(validRequest, "%s", "extractor-9/other", 1): http.StatusConflict,
	} {
		w := post(body)
		if w.Code != status {
			t.Fatalf("%s: status %d, want %d", body, w.Code, status)
		}
		assertContract(t, "Error", w.Body.Bytes())
	}
}

func TestContractResponse(t *testing.T) {
	body, err := json.Marshal(Response{
		Snapshot: json.RawMessage(`{"id":1,"repository_id":2,"commit_sha":"abc","index_version":"v","identity":"base:abc","indexed_files":3}`),
		Metrics:  Metrics{IndexedFiles: 3, ParseWorkers: 2, DBStatements: 21},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertContract(t, "IndexResponse", body)
}
