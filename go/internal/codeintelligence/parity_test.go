package codeintelligence

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"testing"
)

// The reference records come from the TypeScript extractor (src/cli/codeIndexParity.ts). Regenerate the fixture
// golden after changing extraction rules on purpose:
//
//	node src/cli/codeIndexParity.ts files go/internal/codeintelligence/testdata/parity/src go/internal/codeintelligence/testdata/parity/golden.jsonl
type parityRecord struct {
	Path         string          `json:"path"`
	Blob         string          `json:"blob"`
	SourceBase64 string          `json:"source_base64"`
	Extraction   json.RawMessage `json:"extraction"`
	Error        string          `json:"error"`
}

func readParity(t *testing.T, file string) (Limits, string, []parityRecord) {
	t.Helper()
	f, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<20), 64<<20)
	var header struct {
		Limits Limits `json:"limits"`
		Commit string `json:"commit"`
	}
	if !sc.Scan() || json.Unmarshal(sc.Bytes(), &header) != nil {
		t.Fatal("parity file has no header")
	}
	var records []parityRecord
	for sc.Scan() {
		var r parityRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		records = append(records, r)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return header.Limits, header.Commit, records
}

// compare returns "" when the Go extraction of source equals the TypeScript record.
func compare(p Parsers, r parityRecord, source string, lim Limits) string {
	got, err := p.Extract(context.Background(), r.Path, source, lim)
	if r.Error != "" || err != nil {
		if err == nil || err.Error() != r.Error {
			return fmt.Sprintf("error: go %v, typescript %q", err, r.Error)
		}
		return ""
	}
	var want, have any
	_ = json.Unmarshal(r.Extraction, &want)
	body, _ := json.Marshal(got)
	if got == nil {
		body = []byte("null")
	}
	_ = json.Unmarshal(body, &have)
	if reflect.DeepEqual(want, have) {
		return ""
	}
	return firstDifference(want, have)
}

func firstDifference(want, have any) string {
	w, _ := want.(map[string]any)
	h, _ := have.(map[string]any)
	if w == nil || h == nil {
		return fmt.Sprintf("typescript %v, go %v", want, have)
	}
	for _, k := range []string{"language", "content_hash", "parse_errors", "symbols", "relations"} {
		if reflect.DeepEqual(w[k], h[k]) {
			continue
		}
		ws, _ := w[k].([]any)
		hs, _ := h[k].([]any)
		for i := 0; i < max(len(ws), len(hs)); i++ {
			if i >= len(ws) || i >= len(hs) || !reflect.DeepEqual(ws[i], hs[i]) {
				var a, b any
				if i < len(ws) {
					a = ws[i]
				}
				if i < len(hs) {
					b = hs[i]
				}
				return fmt.Sprintf("%s[%d] (counts %d/%d):\n  typescript %v\n  go         %v", k, i, len(ws), len(hs), a, b)
			}
		}
		return fmt.Sprintf("%s: typescript %v, go %v", k, w[k], h[k])
	}
	return "differs"
}

func TestParityFixtures(t *testing.T) {
	lim, _, records := readParity(t, "testdata/parity/golden.jsonl")
	p := Parsers{}
	defer p.Close()
	if len(records) == 0 {
		t.Fatal("no fixtures")
	}
	for _, r := range records {
		raw, err := base64.StdEncoding.DecodeString(r.SourceBase64)
		if err != nil {
			t.Fatal(err)
		}
		if diff := compare(p, r, decodeUTF8(raw), lim); diff != "" {
			t.Errorf("%s: %s", r.Path, diff)
		}
	}
}

// TestParityRepository compares every eligible file of a real commit:
//
//	node src/cli/codeIndexParity.ts repo ~/src/oms-src/oms-api HEAD /tmp/oms-api.jsonl
//	CODE_INDEX_PARITY_REPO=~/src/oms-src/oms-api CODE_INDEX_PARITY_DUMP=/tmp/oms-api.jsonl go test -run TestParityRepository ./internal/codeintelligence/
func TestParityRepository(t *testing.T) {
	repo, dump := os.Getenv("CODE_INDEX_PARITY_REPO"), os.Getenv("CODE_INDEX_PARITY_DUMP")
	if repo == "" || dump == "" {
		t.Skip("CODE_INDEX_PARITY_REPO and CODE_INDEX_PARITY_DUMP not set")
	}
	lim, commit, records := readParity(t, dump)
	ctx := context.Background()
	var m Metrics
	files, err := treeFiles(ctx, repo, commit, lim, &m)
	if err != nil {
		t.Fatal(err)
	}
	var goPaths, tsPaths []string
	for _, f := range files {
		goPaths = append(goPaths, f.Path)
	}
	for _, r := range records {
		tsPaths = append(tsPaths, r.Path)
	}
	sort.Strings(goPaths)
	sort.Strings(tsPaths)
	if !reflect.DeepEqual(goPaths, tsPaths) {
		t.Fatalf("eligible files differ: go %d, typescript %d", len(goPaths), len(tsPaths))
	}
	reader, err := newBlobReader(ctx, repo, lim.MaxFileBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	p := Parsers{}
	defer p.Close()
	failures := 0
	for _, r := range records {
		source, err := reader.Read(r.Blob)
		if err != nil {
			t.Fatal(err)
		}
		if diff := compare(p, r, source, lim); diff != "" {
			failures++
			if failures <= 10 {
				t.Errorf("%s: %s", r.Path, diff)
			}
		}
	}
	t.Logf("%d files compared, %d differ", len(records), failures)
}
