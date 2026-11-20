# platform-go

Go backend of the platform. Modules: semantic retrieval over `knowledge_items` with pgvector
(ADR `docs/architecture/adr/0001-go-backend-semantic-retrieval.md`, contract `contracts/retrieval-v1.schema.json`,
examples in `contracts/examples/`), code intelligence indexing (ADR
`docs/architecture/adr/0002-go-code-intelligence-indexing.md`, contract `contracts/code-intelligence-v1.schema.json`)
and read-only engineering analytics dashboards (ADR `docs/architecture/adr/0003-go-analytics.md`, contract
`contracts/analytics-v1.schema.json`).

```
cmd/platform-go/          wiring, signals, graceful shutdown
internal/platform/        config, pgxpool, OpenTelemetry, bearer auth, request deadline, /healthz /readyz
internal/retrieval/       http.go → service.go → store.go; worker.go (queue consumer); chunk.go; secrets.go
internal/retrieval/embed/ Ollama and OpenAI-compatible embedding clients
internal/codeintelligence/ index.go (job) → git.go, extract.go (tree-sitter), store.go; jstext.go (JS string rules);
                          grammar/sql (vendored generated parser); testdata/parity (TypeScript golden)
internal/analytics/       http.go → service.go (read-only pool, slots, node-postgres value mapping);
                          execution.go (usage, performance, workflows), health*.go, options.go
internal/testutil/        deterministic embedding provider emulator for tests and benchmarks
```

The schema (`retrieval.*`, migration `084_semantic_retrieval.sql`) is created only by the TypeScript migration
runner. The binary refuses to start below schema version 84.

## Run locally

Requires Go 1.26 with a C compiler (CGO: the tree-sitter grammars), a migrated database (`npm start` migrates on boot) and an embedding provider
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

```sh
curl -s -H "Authorization: Bearer $RETRIEVAL_INTERNAL_TOKEN" -H 'X-Request-Timeout-Ms: 15000' \
  -d '{"scope":{"owner_id":1,"all":false},"prod_namespaces":[],"filters":{"from":"2026-11-01","to":"2026-11-08",
  "timezone":"Asia/Bangkok","bucket":"day","provider":null,"model":null,"user":null,"workflow":null,"repository":null,
  "project":null,"service":null,"namespace":null,"severity":null,"incident_status":null,"environment":null,
  "group_by":"provider","page":1,"page_size":25}}' localhost:4646/internal/v1/analytics/usage
curl -s -H "Authorization: Bearer $RETRIEVAL_INTERNAL_TOKEN" localhost:4646/internal/v1/analytics/stats
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

## Build

`npm run build:go` writes `go/bin/platform-go` (CGO, `-trimpath`). Set `PLATFORM_GO_BIN` to a prebuilt binary
(this one or the Docker image's) and `npm start` runs it as is; without it, the supervisor reuses
`<dataDir>/bin/platform-go` and rebuilds only when a Go source is newer than the binary.

## Analytics parity

`test/analytics-go.integration.ts` loads every dashboard through a real platform-go and compares it with the
TypeScript engine on the same database (fixtures and a generated dataset, owner and support scopes, time zones
including a DST change, pagination, empty ranges), plus fallback, timeout, cancellation and contract checks.
Engine benchmark: `npm run bench:analytics` (isolated local database; `BENCH_DB_LATENCY_MS=20` adds latency).

## Code intelligence parity

The Go extractor must match the TypeScript one byte for byte (shared index). Compare a whole repository:

```sh
node src/cli/codeIndexParity.ts repo ~/src/oms-src/oms-api HEAD /tmp/oms-api.jsonl
cd go && CODE_INDEX_PARITY_REPO=~/src/oms-src/oms-api CODE_INDEX_PARITY_DUMP=/tmp/oms-api.jsonl \
  go test -run TestParityRepository ./internal/codeintelligence/
```

After an intended extraction change, update both extractors and regenerate `testdata/parity/golden.jsonl`
(`node src/cli/codeIndexParity.ts files go/internal/codeintelligence/testdata/parity/src <golden>`).
Engine benchmark: `npm run bench:code-index -- <checkout>...` (isolated local database).

## Docker

```sh
docker compose --profile go up -d --build platform-go
```

Debian bookworm-slim image (CGO binary, git for indexing), non-root, `GOMEMLIMIT=256MiB`, published on
`127.0.0.1:4646` only. Indexing receives absolute paths: compose mounts `~/src` and `~/.claude-task-platform`
read-only at the same paths. Compose sets
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
| `CODE_INDEX_PARSE_WORKERS` | `0` | parse goroutines per indexing job; 0 = half the cores, at most 4 |
| `CODE_INDEX_JOBS` | `1` | indexing jobs at a time (callers beyond it wait: backpressure) |
| `ANALYTICS_MAX_CONCURRENT` | `2` | 1–8: connections of the separate read-only analytics pool = statements at once |
| `ANALYTICS_TIMEOUT_MS` | `15000` | analytics request deadline (slot wait included) and the pool's `statement_timeout` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | enables OTLP/HTTP traces and metrics (standard `OTEL_*` variables apply) |

The model id stored with every embedding is `<provider>/<model>@<dims>`. Changing any part re-queues every eligible
source at startup; rows of the previous model are removed per source once the new model has handled it.
