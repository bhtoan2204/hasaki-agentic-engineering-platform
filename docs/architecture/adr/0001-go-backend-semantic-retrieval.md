# ADR 0001: Go backend foundation and pgvector semantic retrieval

Status: proposed · Date: 2026-11-20

## Context

All knowledge-like data already lives in one place: `knowledge_items` + `knowledge_versions`. Business knowledge,
skills/docs, run (task) memory, engineering lessons and chat memory differ only by category, key prefix and
`metadata.memory.trust`. Retrieval is lexical (`scoreKnowledge`, `src/context/plan.ts:100`: token overlap plus a
VI→EN synonym map) and runs in four places:

| Consumer                                      | Code                                                               | Corpus                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Workflow context                              | `resolveContext` → `planKnowledge` (`src/workflow/context.ts:422`) | items that passed visibility + `resolveKnowledge` + memory/lesson filters |
| Agent `search_knowledge` / `platform.*` tools | `src/agent/platformTools.ts:687`, `src/agent/contextTools.ts:266`  | the step's snapshot                                                       |
| Chat knowledge                                | `knowledgeForTurn` / `searchKnowledge` (`src/chat/knowledge.ts`)   | `discoverable()`                                                          |
| Chat memory                                   | `recallMemories` (`src/chat/memory.ts:230`)                        | the user's `memory.chat.*` items                                          |

Lexical matching misses paraphrases and cross-language matches (a Vietnamese request against an English skill).
The operator runs a single PostgreSQL 17 instance that ships pgvector 0.8.2 (not yet enabled).

## Decision

### 1. One Go binary, one module per strangled responsibility

`go/` in the monorepo, a single binary `platform-go`, first module `retrieval`. No microservices.

```
go/
  cmd/platform-go/main.go        wiring, signals, graceful shutdown
  internal/platform/             config (env, validated), pgxpool, slog, OpenTelemetry, auth middleware, health
  internal/retrieval/
    http.go                      transport: /internal/v1/retrieval/*
    service.go                   application: search, index orchestration
    store.go                     SQL (pgx), retrieval schema only
    worker.go                    queue consumer: claim, embed, store, retry
    chunk.go                     deterministic chunking + content hashing
    embed/ollama.go, embed/openai.go   the one interface with two real implementations
```

Layering is by file inside the module (transport → service → store); no generic repository, no interface
per struct. The only interface is `Embedder`, because it has two implementations.

### 2. Data ownership and migration authority

- `src/db/migrate.ts` stays the **only** migration runner. Go never runs DDL; at startup it checks
  `schema_migrations` ≥ its required version and refuses to serve otherwise.
- New schema `retrieval`, owned by the Go module. TypeScript never writes it. Go reads `knowledge_items` /
  `knowledge_versions` read-only and never writes them.
- Migration 084: `CREATE EXTENSION vector` when `pg_available_extensions` has it (otherwise a NOTICE and semantic
  retrieval reports `unavailable`), and:
  - `retrieval.sources(source_id → knowledge_items ON DELETE CASCADE, model, source_version, content_hash, status,
chunks, error)` and `retrieval.chunks(source_id, model, chunk, dims, embedding real[])`
  - `retrieval.queue(source_id PK, reason, enqueued_at, attempts, next_attempt_at, claimed_until)`: deduplicated
    by primary key, so it is bounded by the number of knowledge items.
  - AFTER ROW triggers on `knowledge_items` (insert/update) and `knowledge_versions` (insert) that upsert into
    `retrieval.queue`. A trigger catches every write path (about 30 call sites, raw SQL in proposals, importers,
    rollback) without touching them. Deletes cascade.
- Embeddings are stored as `real[]` and cast to `vector` at query time (`embedding::vector <=> $1::vector`).
  This keeps the schema valid when pgvector is missing, supports several models and dimensions side by side
  during re-indexing, and costs nothing for exact search (a sequential scan either way). If a benchmark later
  justifies HNSW, a migration adds a typed `vector(N)` column per model plus the index.

### 3. What gets embedded (eligibility is owned by the knowledge module)

A view `retrieval.eligible_sources`, defined in the migration next to the knowledge schema, is the contract:
current version of enabled, non-expired items, except

- `task_memory` items whose trust is not `verified`/`approved` (unverified run conclusions, rejected memory);
- `memory.chat.*` items are included (they are only recalled for their owner);
- supporting files with no prose are included; binary/encrypted metadata never.

Every chunk runs through a high-confidence secret detector (tokens, keys, connection strings, card numbers);
a match marks the document `skipped_sensitive` instead of embedding it. Content was already checked at write
time (`looksSecret`, `unsafeToStore`, lesson redaction); this is defense in depth, not a second policy.

Source code is never embedded in this phase.

### 4. Embedding providers

- Default `ollama` + `bge-m3` (multilingual, 1024 dims, local).
- `openai`-compatible remote is allowed only with `EMBEDDING_REMOTE_AUTHORIZED=true` **and** an API key; the
  service refuses to start otherwise. Nothing leaves the machine by default.
- Model identity = provider + model + dims, stored per document. A model change re-queues every document;
  old rows are kept until the new model has covered the source, so search never goes empty mid-reindex.

### 5. Worker

Inside `platform-go`: claim N rows with `FOR UPDATE SKIP LOCKED` and `claimed_until` (the `workflow_run_effects`
pattern), batch-embed with a bounded semaphore (default 2 concurrent requests, 16 texts per request),
compare `content_hash` (unchanged → no embedding call), write in one transaction, delete the queue row.
Failures back off exponentially up to 5 attempts, then `status = failed` with the error. `LISTEN retrieval_queue`
wakes the worker; a 30 s poll is the fallback. Memory is bounded by the batch size.

### 6. Internal API (versioned contract)

Listens on `127.0.0.1` only. Every request needs `Authorization: Bearer <RETRIEVAL_INTERNAL_TOKEN>`
(constant-time compare). Request deadline = min(client `X-Request-Timeout-Ms`, server cap); the context is
propagated to pgx and the embedder. Trace context via W3C `traceparent`.

```
POST /internal/v1/retrieval/search
  { owner_id, query, source_ids?: number[], source_kinds?: string[], top_k, min_similarity }
→ { model, results: [{ source_id, key, source_kind, version, content_hash, similarity, chunk }], took_ms }
POST /internal/v1/retrieval/reindex { source_ids?: number[], all?: bool }   (operator)
GET  /internal/v1/retrieval/status → { vector_extension, model, queue_depth, documents, failed, stale }
GET  /healthz  /readyz
```

The contract lives in `go/contracts/retrieval-v1.schema.json` (JSON Schema) with shared examples in
`go/contracts/examples/`. A TypeScript contract test and a Go contract test both validate against it.
Freshness is checked by version: Go only returns hits whose indexed version equals the item's current version,
and TypeScript drops any hit whose version differs from the item it loaded. `content_hash` is for traceability.

### 7. Hybrid ranking stays where lexical ranking is

Lexical scoring, precedence, mandatory rules and access control are TypeScript business logic, so fusion is
done in TypeScript and Go only returns a semantic ranking. Nothing is duplicated.

- TypeScript sends `source_ids`: the items the existing authorization and resolution already produced.
  Go filters by `owner_id IS NULL OR owner_id = $owner` as well. Semantic search can only re-order
  authorized items; it can never add one.
- TypeScript drops any hit whose `version`/`content_hash` differs from the item it loaded (stale embedding).
- Reciprocal Rank Fusion, k = 60: `fused = 1/(60 + lexical_rank) + 1/(60 + semantic_rank)`, applied only to
  non-mandatory items inside `planKnowledge`. Mandatory/enforced/business-rule items keep their position and
  budget exemption; unverified suggestions stay pinned to the index. Hits below `min_similarity` don't count.
- The fused rank and its inputs are written to `prompt_plan.knowledge` so a step's context stays reproducible.
- Integration points: workflow `resolveContext`, agent `search_knowledge` and `platform.search_*`, chat
  `knowledgeForTurn`/`searchKnowledge`, chat `recallMemories`. All agent providers receive the result through
  the same context pack and platform tools.
- Config `retrieval.semantic` = `{ enabled: false, url, timeoutMs: 1500, topK: 30, minSimilarity: 0.45 }`.
  Disabled, unreachable, timed out or `vector_extension = false` → lexical only, logged once per minute,
  counted in a metric. A step never fails because of semantic retrieval.

### 8. Observability and resources

slog JSON logs; OpenTelemetry traces and metrics exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
(no-op otherwise). pgxpool `MaxConns = 4` (TypeScript keeps its pool of 10). Docker image: distroless static,
`GOMEMLIMIT=128MiB`.

### 9. Measurement (no claims without numbers)

- `go test -bench` for chunking, fusion inputs, search latency over N synthetic documents (exact scan cost
  vs. corpus size, which decides when HNSW is worth it).
- A labelled retrieval set `test/fixtures/retrieval-eval.json` (queries in VI and EN → expected keys) built
  from the seeded knowledge, scored as Recall@5/@10 and MRR for lexical vs. hybrid.
- Indexing throughput, process RSS/CPU, `pg_total_relation_size('retrieval.chunks')`.
- Context size: `estimated_tokens` of the pack per step with the flag on and off on the same fixtures;
  provider tokens per successful run with `bench:tokens` once real runs exist.

## Consequences

- A second runtime to build and operate; mitigated by one binary, one schema, loopback-only, optional.
- Retrieval quality depends on the local model; the eval set makes regressions visible.
- Workflow, chat and agents behave exactly as today with the flag off or the service down.

## Alternatives rejected

- Separate vector database: unnecessary at this scale; adds a second source of truth.
- Fusion in Go: would duplicate `scoreKnowledge`, precedence and access logic.
- Reusing `workflow_jobs`: bound to run/step/instance and fencing semantics that don't apply.
- Application-level enqueue at each write site: about 30 call sites including raw SQL; easy to miss one.
- `vector(1024)` column: ties the schema to one model and fails the migration without pgvector.
