// Command platform-go serves the Go modules of the platform (semantic retrieval) on a loopback address.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

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
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           platform.Observe(log, mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.RequestTimeoutMax + 5*time.Second,
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
