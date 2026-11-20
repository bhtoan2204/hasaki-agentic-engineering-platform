package embed

import (
	"context"
	"strings"
)

type Ollama struct {
	URL   string
	Model string
	Dims  int
}

func (o Ollama) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	var out struct {
		Embeddings [][]float32 `json:"embeddings"`
	}
	in := map[string]any{"model": o.Model, "input": texts, "truncate": true}
	if err := postJSON(ctx, strings.TrimRight(o.URL, "/")+"/api/embed", "", in, &out); err != nil {
		return nil, err
	}
	if err := checkVectors(out.Embeddings, len(texts), o.Dims); err != nil {
		return nil, err
	}
	return out.Embeddings, nil
}
