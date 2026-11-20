package platform

import (
	"strings"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef"

func env(kv map[string]string) func(string) string {
	base := map[string]string{"DATABASE_URL": "postgres://localhost/platform", "RETRIEVAL_INTERNAL_TOKEN": testToken}
	for k, v := range kv {
		base[k] = v
	}
	return func(k string) string { return base[k] }
}

func TestLoadConfigDefaults(t *testing.T) {
	c, err := LoadConfig(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != "127.0.0.1:4646" || c.PoolMax != 4 || c.EmbeddingURL != "http://127.0.0.1:11434" ||
		c.EmbedConcurrency != 2 || c.EmbedBatch != 16 || !c.WorkerEnabled || c.RequestTimeoutMax != 2*time.Second {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if got := c.ModelID(); got != "ollama/bge-m3@1024" {
		t.Fatalf("ModelID = %q", got)
	}
}

func TestLoadConfigRejects(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing database", map[string]string{"DATABASE_URL": ""}, "DATABASE_URL is required"},
		{"short token", map[string]string{"RETRIEVAL_INTERNAL_TOKEN": "short"}, "at least 32"},
		{"pool above cap", map[string]string{"DATABASE_POOL_MAX": "17"}, "DATABASE_POOL_MAX"},
		{"non-numeric dims", map[string]string{"EMBEDDING_DIMS": "big"}, "EMBEDDING_DIMS"},
		{"bad worker flag", map[string]string{"WORKER_ENABLED": "maybe"}, "WORKER_ENABLED"},
		{"non-loopback bind", map[string]string{"PLATFORM_GO_ADDR": "0.0.0.0:4646"}, "loopback"},
		{"all-interfaces bind", map[string]string{"PLATFORM_GO_ADDR": ":4646"}, "loopback"},
		{"unknown provider", map[string]string{"EMBEDDING_PROVIDER": "cohere"}, "EMBEDDING_PROVIDER"},
		{"remote ollama unauthorized", map[string]string{"EMBEDDING_URL": "http://gpu.lan:11434"}, "EMBEDDING_REMOTE_AUTHORIZED"},
		{"openai unauthorized", map[string]string{"EMBEDDING_PROVIDER": "openai", "EMBEDDING_API_KEY": "k"}, "EMBEDDING_REMOTE_AUTHORIZED"},
		{"openai loopback still unauthorized", map[string]string{"EMBEDDING_PROVIDER": "openai", "EMBEDDING_URL": "http://127.0.0.1:8080", "EMBEDDING_API_KEY": "k"}, "EMBEDDING_REMOTE_AUTHORIZED"},
		{"openai without key", map[string]string{"EMBEDDING_PROVIDER": "openai", "EMBEDDING_REMOTE_AUTHORIZED": "true"}, "EMBEDDING_API_KEY"},
		{"authorized needs exact true", map[string]string{"EMBEDDING_URL": "https://emb.example.com", "EMBEDDING_REMOTE_AUTHORIZED": "1"}, "EMBEDDING_REMOTE_AUTHORIZED"},
		{"bad url", map[string]string{"EMBEDDING_URL": "ftp://x"}, "EMBEDDING_URL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := LoadConfig(env(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestLoadConfigAccepts(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{"localhost ollama", map[string]string{"EMBEDDING_URL": "http://localhost:11434"}},
		{"ipv6 loopback bind", map[string]string{"PLATFORM_GO_ADDR": "[::1]:4646"}},
		{"container bind", map[string]string{"PLATFORM_GO_ADDR": "0.0.0.0:4646", "PLATFORM_GO_ALLOW_NONLOOPBACK": "true"}},
		{"authorized remote ollama", map[string]string{"EMBEDDING_URL": "http://gpu.lan:11434", "EMBEDDING_REMOTE_AUTHORIZED": "true"}},
		{"authorized openai", map[string]string{"EMBEDDING_PROVIDER": "openai", "EMBEDDING_REMOTE_AUTHORIZED": "true", "EMBEDDING_API_KEY": "k"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := LoadConfig(env(tt.env)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLoadConfigErrorHidesSecrets(t *testing.T) {
	_, err := LoadConfig(env(map[string]string{"RETRIEVAL_INTERNAL_TOKEN": "s3cr3t-short", "EMBEDDING_PROVIDER": "openai", "EMBEDDING_API_KEY": "sk-hidden-value"}))
	if err == nil || strings.Contains(err.Error(), "s3cr3t-short") || strings.Contains(err.Error(), "sk-hidden-value") {
		t.Fatalf("err = %v", err)
	}
}
