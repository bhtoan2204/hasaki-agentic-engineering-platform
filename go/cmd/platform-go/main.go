// Command platform-go serves the Go modules of the platform (semantic retrieval, code intelligence indexing,
// engineering analytics) on a loopback address.
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"claude-task-platform/go/internal/analytics"
	"claude-task-platform/go/internal/codeintelligence"
	"claude-task-platform/go/internal/platform"
	"claude-task-platform/go/internal/retrieval"
	"claude-task-platform/go/internal/retrieval/embed"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("platform-go stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := platform.LoadConfig(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if os.Getenv("PLATFORM_GO_EXIT_ON_STDIN_EOF") == "true" {
		// The supervising platform holds our stdin open; EOF means it died (even by SIGKILL), so do not outlive it.
		ctx, stop = context.WithCancel(ctx)
		defer stop()
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	shutdownTelemetry, err := platform.SetupTelemetry(ctx, cfg.OTLPEndpointIsSet)
	if err != nil {
		return err
	}
	defer func() { _ = shutdownTelemetry(context.Background()) }()

	db, err := platform.OpenPool(ctx, cfg.DatabaseURL, cfg.PoolMax)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := platform.CheckSchema(ctx, db); err != nil {
		return err
	}

	var embedder retrieval.Embedder = embed.Ollama{URL: cfg.EmbeddingURL, Model: cfg.EmbeddingModel, Dims: cfg.EmbeddingDims}
	if cfg.EmbeddingProvider == "openai" {
		embedder = embed.OpenAI{URL: cfg.EmbeddingURL, Model: cfg.EmbeddingModel, Dims: cfg.EmbeddingDims, APIKey: cfg.EmbeddingAPIKey}
	}
	svc, err := retrieval.NewService(ctx, db, embedder, cfg.ModelID(), log)
	if err != nil {
		return err
	}

	internal := http.NewServeMux()
	retrieval.Routes(internal, svc, log)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", platform.Healthz)
	mux.HandleFunc("GET /readyz", platform.Readyz(db))
	mux.Handle("/internal/", platform.RequireBearer(cfg.Token, platform.WithDeadline(cfg.RequestTimeoutMax, internal)))
	// Indexing jobs run for minutes: bounded by the caller's own job timeout instead of the short request deadline.
	indexing := http.NewServeMux()
	codeintelligence.Routes(indexing, codeintelligence.NewIndexer(db, cfg.IndexParseWorkers, cfg.IndexJobs), log)
	mux.Handle("/internal/v1/code-intelligence/", platform.RequireBearer(cfg.Token, indexing))
	// Dashboards outlast the short retrieval deadline but are bounded by their own. They run on a separate read-only
	// pool of ANALYTICS_MAX_CONCURRENT connections, so expensive dashboards never take a connection from retrieval
	// or indexing (the shared pool keeps DATABASE_POOL_MAX).
	analyticsDB, err := platform.OpenReadOnlyPool(ctx, cfg.DatabaseURL, int32(cfg.AnalyticsMaxConcurrent), cfg.AnalyticsTimeout)
	if err != nil {
		return err
	}
	defer analyticsDB.Close()
	dashboards := http.NewServeMux()
	analytics.Routes(dashboards, analytics.NewService(analyticsDB, cfg.AnalyticsMaxConcurrent), cfg.AnalyticsTimeout, log)
	mux.Handle("/internal/v1/analytics/", platform.RequireBearer(cfg.Token, dashboards))
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           platform.Observe(log, mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      max(cfg.RequestTimeoutMax, cfg.AnalyticsTimeout) + 5*time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	workerCtx, stopWorker := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	if cfg.WorkerEnabled {
		w := retrieval.NewWorker(svc, cfg.EmbedBatch, cfg.EmbedConcurrency)
		wg.Go(func() { w.Run(workerCtx) })
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	log.Info("platform-go listening", "addr", cfg.Addr, "model", cfg.ModelID(), "worker", cfg.WorkerEnabled)
	// A local model loads on first use (seconds); load it now so the first search fits the caller's deadline.
	go func() {
		if _, err := embedder.Embed(ctx, []string{"warm up"}); err != nil {
			log.Warn("embedding model warm-up failed", "error", err)
		}
	}()

	select {
	case <-ctx.Done():
		err = nil
	case err = <-serveErr:
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if serr := srv.Shutdown(shutdownCtx); serr != nil {
		log.Error("http shutdown", "error", serr)
	}
	stopWorker()
	wg.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}
