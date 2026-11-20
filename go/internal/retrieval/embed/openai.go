package embed

import (
	"context"
	"fmt"
	"strings"
)

// OpenAI talks to any OpenAI-compatible /v1/embeddings endpoint.
type OpenAI struct {
	URL    string
	Model  string
	Dims   int
	APIKey string
}

func (o OpenAI) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	in := map[string]any{"model": o.Model, "input": texts, "encoding_format": "float"}
	if err := postJSON(ctx, strings.TrimRight(o.URL, "/")+"/v1/embeddings", o.APIKey, in, &out); err != nil {
		return nil, err
	}
	if len(out.Data) != len(texts) {
		return nil, fmt.Errorf("embedding provider returned %d vectors for %d inputs", len(out.Data), len(texts))
	}
	vecs := make([][]float32, len(texts))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(vecs) || vecs[d.Index] != nil {
			return nil, fmt.Errorf("embedding provider returned an invalid index %d", d.Index)
		}
		vecs[d.Index] = d.Embedding
	}
	if err := checkVectors(vecs, len(texts), o.Dims); err != nil {
		return nil, err
	}
	return vecs, nil
}
