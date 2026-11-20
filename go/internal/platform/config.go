package platform

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"time"
)

type Config struct {
	Addr              string
	DatabaseURL       string
	PoolMax           int32
	Token             string
	RequestTimeoutMax time.Duration
	EmbeddingProvider string
	EmbeddingURL      string
	EmbeddingModel    string
	EmbeddingDims     int
	EmbeddingAPIKey   string
	EmbedConcurrency  int
	EmbedBatch        int
	WorkerEnabled     bool
	IndexParseWorkers int
	IndexJobs         int
	OTLPEndpointIsSet bool
	remoteAuthorized  bool
	allowNonLoopback  bool
}

// ModelID identifies an embedding space: vectors are only comparable within one model id.
func (c Config) ModelID() string {
	return fmt.Sprintf("%s/%s@%d", c.EmbeddingProvider, c.EmbeddingModel, c.EmbeddingDims)
}

// LoadConfig reads and validates the environment through getenv (os.Getenv in production).
func LoadConfig(getenv func(string) string) (Config, error) {
	str := func(k, def string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return def
	}
	var errs []error
	num := func(k string, def, min, max int) int {
		v := getenv(k)
		if v == "" {
			return def
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < min || n > max {
			errs = append(errs, fmt.Errorf("%s must be an integer in [%d, %d]", k, min, max))
			return def
		}
		return n
	}
	flag := func(k string, def bool) bool {
		switch getenv(k) {
		case "":
			return def
		case "true", "1":
			return true
		case "false", "0":
			return false
		}
		errs = append(errs, fmt.Errorf("%s must be true or false", k))
		return def
	}

	c := Config{
		Addr:              str("PLATFORM_GO_ADDR", "127.0.0.1:4646"),
		DatabaseURL:       getenv("DATABASE_URL"),
		PoolMax:           int32(num("DATABASE_POOL_MAX", 4, 1, 16)),
		Token:             getenv("RETRIEVAL_INTERNAL_TOKEN"),
		RequestTimeoutMax: time.Duration(num("REQUEST_TIMEOUT_MAX_MS", 2000, 1, 60000)) * time.Millisecond,
		EmbeddingProvider: str("EMBEDDING_PROVIDER", "ollama"),
		EmbeddingModel:    str("EMBEDDING_MODEL", "bge-m3"),
		EmbeddingDims:     num("EMBEDDING_DIMS", 1024, 1, 16000),
		EmbeddingAPIKey:   getenv("EMBEDDING_API_KEY"),
		EmbedConcurrency:  num("EMBEDDING_CONCURRENCY", 2, 1, 32),
		EmbedBatch:        num("EMBEDDING_BATCH", 16, 1, 256),
		WorkerEnabled:     flag("WORKER_ENABLED", true),
		IndexParseWorkers: num("CODE_INDEX_PARSE_WORKERS", 0, 0, 64),
		IndexJobs:         num("CODE_INDEX_JOBS", 1, 1, 8),
		OTLPEndpointIsSet: getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "",
		remoteAuthorized:  getenv("EMBEDDING_REMOTE_AUTHORIZED") == "true",
		allowNonLoopback:  flag("PLATFORM_GO_ALLOW_NONLOOPBACK", false),
	}
	defaultURL := "http://127.0.0.1:11434"
	if c.EmbeddingProvider == "openai" {
		defaultURL = "https://api.openai.com"
	}
	c.EmbeddingURL = str("EMBEDDING_URL", defaultURL)

	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}
	if len(c.Token) < 32 {
		errs = append(errs, errors.New("RETRIEVAL_INTERNAL_TOKEN must be at least 32 characters"))
	}
	host, _, err := net.SplitHostPort(c.Addr)
	if err != nil {
		errs = append(errs, fmt.Errorf("PLATFORM_GO_ADDR is not host:port"))
	} else if !isLoopback(host) && !c.allowNonLoopback {
		errs = append(errs, errors.New("PLATFORM_GO_ADDR must be a loopback address unless PLATFORM_GO_ALLOW_NONLOOPBACK=true"))
	}
	if c.EmbeddingProvider != "ollama" && c.EmbeddingProvider != "openai" {
		errs = append(errs, errors.New("EMBEDDING_PROVIDER must be ollama or openai"))
	}
	u, err := url.Parse(c.EmbeddingURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, errors.New("EMBEDDING_URL must be an http(s) URL"))
	} else if (c.EmbeddingProvider == "openai" || !isLoopback(u.Hostname())) && !c.remoteAuthorized {
		errs = append(errs, errors.New("remote embedding requires EMBEDDING_REMOTE_AUTHORIZED=true"))
	}
	if c.EmbeddingProvider == "openai" && c.EmbeddingAPIKey == "" {
		errs = append(errs, errors.New("EMBEDDING_API_KEY is required for the openai provider"))
	}
	return c, errors.Join(errs...)
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
