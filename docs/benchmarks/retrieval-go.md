# platform-go retrieval benchmarks

Measured 2026-11-20. Machine: Intel i7-13700 (24 logical cores), 15 GiB RAM, WSL2 (Linux 6.18). PostgreSQL 17.11
with pgvector 0.8.7, throwaway cluster on a Unix socket with `fsync=off`, default `shared_buffers` and
`max_parallel_workers_per_gather=2`. Go 1.26.11. The embedder is the in-process fake (hashed bag of words over
HTTP, `internal/testutil`), so embedding latency is close to zero: numbers below are the service and SQL cost
only. A real `bge-m3` on Ollama adds its own latency per query and per indexing batch.

Reproduce: `go/scripts/test-integration.sh -run '^$' -bench . -benchtime 100x ./internal/retrieval/`.

## Search (exact scan, 1024 dims, one chunk per source, top_k 30, 100 random queries)

| Chunks | SQL p50 | SQL p95 | Service p50 (embed + SQL) | Service p95 |
|---:|---:|---:|---:|---:|
| 1 000 | 10.7 ms | 12.6 ms | 10.0 ms | 10.8 ms |
| 5 000 | 49.6 ms | 247.8 ms* | 50.4 ms | 60.5 ms |
| 20 000 | 197.0 ms | 226.8 ms | 189.1 ms | 201.8 ms |

\* a few outliers in the first run after seeding (cause not isolated; likely cache warm-up or autovacuum); the
service run on the same data right after shows the steady state.

Latency is linear in the number of chunks of the current model: about 10 µs per 1024-dim chunk. `EXPLAIN ANALYZE`
at 20k chunks (132 ms in psql) shows the time is the per-row `real[] → vector` cast plus the distance (psql over
20k rows: scanning the arrays 37 ms, casting them 87 ms, cast + distance 98 ms); the DISTINCT ON sort and the joins
add little. With the
default `timeoutMs: 800` the exact scan stays within budget up to roughly 50–60k chunks on this machine. Beyond
~10k chunks a typed `vector(1024)` column (no cast) and then HNSW are the next steps, as the ADR anticipates.

## Storage

`pg_total_relation_size('retrieval.chunks')`: 5.52 MiB per 1k chunks at 1k, 5.43 at 5k, 5.42 at 20k
(1024 × 4-byte floats ≈ 4 KiB per row plus TOAST and the primary key index).

## Indexing (worker, fake embedder, batch 16, concurrency 2)

500 sources of about 4 200 characters (3 chunks each), 10 runs: **790 sources/s, 3 160 chunks/s** (claim, chunk,
secret scan, embed over HTTP, transactional replace of chunks + sources row, dequeue). With a real embedder the
provider is the bottleneck.

Chunking alone: 231 MB/s (`BenchmarkChunkText`, 41 KB input, 222 KB and 37 allocations per call).

## Memory

| Process | State | RSS |
|---|---|---|
| `platform-go` binary (`CGO_ENABLED=0`, 28.9 MB, `GOMEMLIMIT=128MiB`) | idle after start, worker on, 20k chunks in DB | 18.0 MiB |
| same | after 2 000 searches from 8 concurrent clients over 20k chunks (pool max 4) | 27.8 MiB (= VmHWM) |
| `go test` benchmark process | after the 20k search runs | 28.8 MiB |
| `go test` benchmark process | after 10 × 500-source indexing runs | 29.6 MiB |

The binary was measured from `/proc/<pid>/status` with a Python Ollama emulator. Under that load (8 concurrent
clients, 4 pool connections, every query a cache miss) end-to-end latency was p50 419 ms / p95 544 ms: requests
queue for the 4 connections, each holding a ~190 ms scan. Search memory is bounded by `top_k`; indexing memory by
the claim size (2 × `EMBEDDING_BATCH` sources, at most 32 chunks each).

## End-to-end with the real model (2026-11-20)

`platform-go` + PostgreSQL 17.11/pgvector 0.8.7 + Ollama `bge-m3` (CPU, compose container), corpus = the seeded
knowledge plus `skills/external` (26 sources, 27.6k tokens).

| Measure | Value |
|---|---|
| Initial indexing | 26 sources → 106 chunks in 43 s (≈ 2.5 chunks/s; bound by the model on CPU) |
| `retrieval.chunks` size | 664 kB |
| Search, new query (embedding + scan) | p50 31 ms, max 38 ms (15 requests) |
| Search, repeated query (LRU hit) | p50 2 ms |
| `platform-go` RSS after indexing | 24.4 MiB |

Retrieval quality (`npm run eval:retrieval`, 31 labelled VI/EN queries in `test/fixtures/retrieval-eval.json`):

| Mode | minSimilarity | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
| lexical | — | 0.704 | 0.747 | 0.614 |
| hybrid (RRF) | 0.35 | 0.909 | 0.957 | 0.933 |
| hybrid (RRF) | **0.45** (default) | 0.925 | 0.957 | 0.938 |
| hybrid (RRF) | 0.55 | 0.909 | 0.941 | 0.927 |

Inline tokens per query were unchanged (1220 on average): fusion re-orders within the same budget. The corpus and
labels are small and written for this evaluation; treat the numbers as a regression baseline, not a general claim.
Token use per successful run has not been measured yet: it needs real runs with the flag on (`npm run bench:tokens`).
