package proderrors

import (
	"encoding/json"
	"os"
	"testing"
)

// The vectors are shared with test/prod-errors-classify.test.ts: both ports must classify every text the same way.
func TestClassifyVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/classify-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string `json:"name"`
		Text  string `json:"text"`
		Crash bool   `json:"crash"`
		Money bool   `json:"money"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 30 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, v := range vectors {
		if got := isCrash(v.Text); got != v.Crash {
			t.Errorf("crash %q: got %v want %v", v.Name, got, v.Crash)
		}
		if got := isMoney(v.Text); got != v.Money {
			t.Errorf("money %q: got %v want %v", v.Name, got, v.Money)
		}
	}
}

// A crash group must survive the per-source cap even with a tiny count (TypeScript capSourceRows).
func TestCapRowsKeepsCrashGroups(t *testing.T) {
	var rows []Row
	for i := range 400 {
		rows = append(rows, Row{"ns": "n", "svc": "s", "lv": "ERROR", "sig": "sig " + numberToString(float64(i)), "today": float64(1000 - i)})
	}
	rows = append(rows, Row{"ns": "n", "svc": "s", "lv": "ERROR", "sig": "rare panic", "today": float64(1), "is_crash": "1"})
	kept, truncated := capRows(rows, 300)
	if !truncated || len(kept) != 300 {
		t.Fatalf("truncated=%v kept=%d", truncated, len(kept))
	}
	found := false
	for _, r := range kept {
		if r["sig"] == "rare panic" {
			found = true
		}
	}
	if !found {
		t.Fatal("the crash group was cut")
	}
	if kept2, tr := capRows(rows[:10], 300); tr || len(kept2) != 10 {
		t.Fatalf("under the cap: truncated=%v kept=%d", tr, len(kept2))
	}
}
