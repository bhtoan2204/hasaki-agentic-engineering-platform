# platform-go

Go backend of the platform (ADR `docs/architecture/adr/0001-go-backend-semantic-retrieval.md`). First module:
semantic retrieval over `knowledge_items` with pgvector. Internal API contract:
`contracts/retrieval-v1.schema.json` (examples in `contracts/examples/`, shared with the TypeScript tests).

```
cmd/platform-go/          wiring, signals, graceful shutdown
internal/platform/        config, pgxpool, OpenTelemetry, bearer auth, request deadline, /healthz /readyz
internal/retrieval/       http.go → service.go → store.go; worker.go (queue consumer); chunk.go; secrets.go
internal/retrieval/embed/ Ollama and OpenAI-compatible embedding clients
internal/testutil/        deterministic embedding provider emulator for tests and benchmarks
```

The schema (`retrieval.*`, migration `084_semantic_retrieval.sql`) is created only by the TypeScript migration
runner. The binary refuses to start below schema version 84.

## Run locally

Requires Go 1.26, a migrated database (`npm start` migrates on boot) and an embedding provider
(`ollama pull bge-m3`, or the `ollama` compose service).

```sh
cd go
DATABASE_URL=postgresql://platform:platform@127.0.0.1:55432/platform \
RETRIEVAL_INTERNAL_TOKEN=$(openssl rand -hex 32) \
go run ./cmd/platform-go
```

```sh
curl -s localhost:4646/readyz
curl -s -H "Authorization: Bearer $RETRIEVAL_INTERNAL_TOKEN" localhost:4646/internal/v1/retrieval/status
curl -s -H "Authorization: Bearer $RETRIEVAL_INTERNAL_TOKEN" -H 'X-Request-Timeout-Ms: 800' \
  -d '{"owner_id":1,"query":"order confirmation deadline","top_k":10,"min_similarity":0.35}' \
  localhost:4646/internal/v1/retrieval/search
```

Without pgvector the worker still indexes (embeddings are stored as `real[]`) and search answers
`503 {"code":"vector_unavailable"}`.

## Test

```sh
cd go && go test ./...                 # unit + contract tests; integration tests skip without a database
go/scripts/test-integration.sh         # from the repo root: throwaway PG17 clusters (with and without pgvector),
                                       # migrated by the TypeScript runner, then go test -p 1 ./...
go/scripts/test-integration.sh -run '^$' -bench . -benchtime 100x ./internal/retrieval/
```

The script uses `PG_VECTOR_BIN` / `PG_PLAIN_BIN` (PostgreSQL `bin` directories, defaults point at the local Nix
store) and `GO`. Integration tests read `PLATFORM_GO_TEST_DATABASE_URL` and `PLATFORM_GO_TEST_NOVECTOR_DATABASE_URL`
and truncate `users` and `knowledge_items`: never point them at a real database. Benchmark results:
`docs/benchmarks/retrieval-go.md`.

## Docker

```sh
docker compose --profile go up -d --build platform-go
```

Distroless static image, non-root, `GOMEMLIMIT=128MiB`, published on `127.0.0.1:4646` only. Compose sets
`DATABASE_URL` to the `postgres` service (image `pgvector/pgvector:pg17`) and `EMBEDDING_URL` to the `ollama`
service; the rest comes from `.env` (at least `RETRIEVAL_INTERNAL_TOKEN`).

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PLATFORM_GO_ADDR` | `127.0.0.1:4646` | must be loopback unless `PLATFORM_GO_ALLOW_NONLOOPBACK=true` (container only) |
| `DATABASE_URL` | required | |
| `DATABASE_POOL_MAX` | `4` | 1–16 |
| `RETRIEVAL_INTERNAL_TOKEN` | required | ≥ 32 characters; `Authorization: Bearer` on `/internal/*` |
| `REQUEST_TIMEOUT_MAX_MS` | `2000` | request deadline = min(`X-Request-Timeout-Ms`, this) |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` (any OpenAI-compatible `/v1/embeddings`) |
| `EMBEDDING_URL` | `http://127.0.0.1:11434` | `https://api.openai.com` for `openai` |
| `EMBEDDING_MODEL` | `bge-m3` | |
| `EMBEDDING_DIMS` | `1024` | every returned vector is checked |
| `EMBEDDING_API_KEY` | | required for `openai` |
| `EMBEDDING_REMOTE_AUTHORIZED` | | must be `true` for `openai` or a non-loopback `EMBEDDING_URL`, else startup fails |
| `EMBEDDING_CONCURRENCY` | `2` | concurrent embedding requests of the worker |
| `EMBEDDING_BATCH` | `16` | texts per embedding request; the worker claims 2× this many sources at a time |
| `WORKER_ENABLED` | `true` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | enables OTLP/HTTP traces and metrics (standard `OTEL_*` variables apply) |

The model id stored with every embedding is `<provider>/<model>@<dims>`. Changing any part re-queues every eligible
source at startup; rows of the previous model are removed per source once the new model has handled it.
