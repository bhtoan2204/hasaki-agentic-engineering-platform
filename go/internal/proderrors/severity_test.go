package proderrors

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The vectors are shared with test/prod-errors-severity.test.ts.
func TestSeverityV2Vectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/severity-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string `json:"name"`
		Input struct {
			Level             string   `json:"level"`
			Signature         string   `json:"signature"`
			Sample            string   `json:"sample"`
			Today             float64  `json:"today"`
			Yesterday         float64  `json:"yesterday"`
			Baseline          bool     `json:"baseline"`
			WindowHours       float64  `json:"windowHours"`
			BaselineHours     float64  `json:"baselineHours"`
			FirstSeenAgeHours *float64 `json:"firstSeenAgeHours"`
		} `json:"input"`
		Expect struct {
			Severity string   `json:"severity"`
			Reasons  []string `json:"reasons"`
		} `json:"expect"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 20 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, v := range vectors {
		in := v.Input
		sev, _, reasons := assessV2(in.Level, in.Signature, in.Sample, in.Today, in.Yesterday, in.Baseline,
			in.WindowHours, in.BaselineHours, in.FirstSeenAgeHours, DefaultThresholds())
		if sev != v.Expect.Severity {
			t.Errorf("%s: severity %s, want %s", v.Name, sev, v.Expect.Severity)
		}
		want := v.Expect.Reasons
		if want == nil {
			want = []string{}
		}
		if !reflect.DeepEqual(reasons, want) {
			t.Errorf("%s: reasons %v, want %v", v.Name, reasons, want)
		}
	}
}
