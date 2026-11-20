// Package embed holds the embedding provider clients.
package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

var client = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 8}}

func postJSON(ctx context.Context, url, apiKey string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("embedding provider returned %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func checkVectors(vecs [][]float32, n, dims int) error {
	if len(vecs) != n {
		return fmt.Errorf("embedding provider returned %d vectors for %d inputs", len(vecs), n)
	}
	for _, v := range vecs {
		if len(v) != dims {
			return fmt.Errorf("embedding provider returned %d dims, configured %d", len(v), dims)
		}
	}
	return nil
}
