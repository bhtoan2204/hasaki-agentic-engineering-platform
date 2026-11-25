package embed

import (
	"context"
	"slices"
	"strings"
	"testing"

	"hasaki-orbit/go/internal/testutil"
)

func TestProviders(t *testing.T) {
	f := testutil.NewFakeEmbedder(8)
	defer f.Close()
	texts := []string{"alpha beta", "gamma", "delta epsilon"}
	for name, e := range map[string]interface {
		Embed(context.Context, []string) ([][]float32, error)
	}{
		"ollama": Ollama{URL: f.URL, Model: "m", Dims: 8},
		"openai": OpenAI{URL: f.URL + "/", Model: "m", Dims: 8, APIKey: "k"},
	} {
		vecs, err := e.Embed(context.Background(), texts)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for i, v := range vecs {
			if !slices.Equal(v, testutil.Vector(texts[i], 8)) {
				t.Fatalf("%s: vector %d out of order", name, i)
			}
		}
	}
}

func TestProviderErrors(t *testing.T) {
	f := testutil.NewFakeEmbedder(8)
	defer f.Close()
	o := Ollama{URL: f.URL, Model: "m", Dims: 8}
	f.WrongDim.Store(true)
	if _, err := o.Embed(context.Background(), []string{"x"}); err == nil || !strings.Contains(err.Error(), "dims") {
		t.Fatalf("wrong dims: err = %v", err)
	}
	if _, err := (OpenAI{URL: f.URL, Model: "m", Dims: 8}).Embed(context.Background(), []string{"x"}); err == nil {
		t.Fatal("openai wrong dims accepted")
	}
	f.WrongDim.Store(false)
	f.Fail.Store(true)
	if _, err := o.Embed(context.Background(), []string{"x"}); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("server error: err = %v", err)
	}
	f.Close()
	if _, err := o.Embed(context.Background(), []string{"x"}); err == nil {
		t.Fatal("closed server accepted")
	}
}
