# ADR 0002: Code intelligence indexing in Go (migration phase 2)

Status: accepted, behind `CODE_INTELLIGENCE_ENGINE=go` (default `typescript`) · Date: 2026-11-20

## Context

`src/codeIntelligence/` indexes repositories into the `code_intelligence` schema: per-commit base snapshots,
per-run worktree overlays, symbols and relations extracted with tree-sitter (Go, TypeScript, TSX, JavaScript,
proto, SQL), cached per `(language, parser_version, content_hash)`. Jobs come from `code_intelligence.runs`
(SKIP LOCKED claim, fencing token, 60 s lease with heartbeat), claimed by the scheduler's idle loop.

Measured on real repositories (`npm run bench:code-index`, local PostgreSQL 17, 24 cores): the TypeScript
indexer parses with `web-tree-sitter` (WASM) on the Node event loop. While a job runs the event loop is blocked for
200–500 ms at p99, so the API, SSE streams and chat stall; one job peaks at ~220 MB RSS; persistence costs 54–67
statements per job.

## Decision

### Split: TypeScript keeps the job, Go does the work

| Stays in TypeScript | Moves to `go/internal/codeintelligence` |
|---|---|
| queue claim, lease, heartbeat, retries, cancellation (`runIndexOnce`) | file discovery (`git ls-tree`), eligibility and limits |
| repository provisioning (fetch with credentials) and authorization (`localScope`: run ownership, allowed repositories, worktree common-dir check) | streaming blob reads (one `git cat-file --batch` per job), worktree overlay detection with the symlink-safe reader |
| search, ranking, context building (`search.ts`) | parsing on a bounded worker pool, extraction cache lookups |
| migrations (`code_intelligence` schema, unchanged) | batch persistence (`unnest` + `COPY`) and atomic, fenced publication |

`indexRepository` calls `POST /internal/v1/code-intelligence/index` (contract
`go/contracts/code-intelligence-v1.schema.json`) when the flag is `go`. The flag decides per job which
implementation runs it, inside the one TypeScript worker that holds the lease: there is never a second claimer,
and Go never reads the queue. The fencing token travels with the request and Go re-checks it (and instance
ownership) in the publication transaction, exactly like `publish()` in `store.ts`, so a stale request cannot
publish. Closing the request (lease lost, shutdown) cancels the Go job through its context.

Moving the queue too would have meant re-implementing provisioning and authorization in Go: two copies of the
security-relevant code for no throughput gain (claiming is a single statement per job).

### Byte-identical extraction, shared index

Go produces exactly the TypeScript extraction and uses the same `parser_version`, so snapshots and the extraction
cache are shared: switching the flag either way reuses everything already indexed (no reindex, no dual write).
That requires:

- the grammars bundled in `tree-sitter-wasm` 2.0.4 (go 0.25.0, javascript 0.25.0, typescript/tsx 0.23.2,
  proto `coder3101@be5691cf`, sql 0.3.11). The SQL Go module ships no generated parser, so
  `grammar/sql/src` is the npm package's `src/` unmodified;
- **parsing UTF-16**, like web-tree-sitter parses JavaScript strings. Error recovery weighs skipped input by its
  byte length, so a UTF-8 parse recovers differently from syntax errors (it changed symbols in 3 SQL migrations);
- JavaScript string semantics wherever they show: WHATWG UTF-8 decoding of blobs, UTF-16 slicing of signatures,
  `String#trim`, the JS regular expressions of `redactSecrets` and the quoted-string mask (backreference and
  backtracking reproduced by hand; RE2 has neither).

Upstream go-tree-sitter (runtime 0.25) with UTF-16 input matched runtime 0.27.1 on every file tested, so no fork is
needed. `TestParityFixtures` (CI) pins the output to a TypeScript golden; `TestParityRepository` compares whole
repositories (`src/cli/codeIndexParity.ts`): **6,554 files in 27 repositories, 0 differences**. The TypeScript unit
test fails when `INDEX_VERSION` changes without the Go `ExtractorVersion`.

### CGO

The grammars are C; go-tree-sitter is the official binding. Two measured fixes: tree-sitter's allocator is set to
libc (go-tree-sitter routes every malloc through a Go callback: C→Go→C per allocation), and the walker uses one
tree cursor with cached kind and field ids instead of per-node cgo string calls. Together −34% CPU per parse. The
Docker image builds with CGO on Debian bookworm and runs on `debian:bookworm-slim` (glibc, git).

## Results (docs/architecture/code-index-engines.json)

| oms-api / oms-frontend / oms-background | TypeScript | Go |
|---|---|---|
| full index throughput | 263–585 files/s | 781–1,593 files/s (**2.7–3.0×**) |
| 3 repositories concurrently | 4.5 s | 1.4 s (**3.3×**) |
| CPU time, full index | 1.2–2.0 s | 0.8–1.35 s (**−28–35%**) |
| peak RSS of the indexing process | 178–226 MB | 79–99 MB (**−48–57%**) |
| database statements per job | 54–67 | 21 (**−61–69%**) |
| Node event-loop delay p99 while indexing | 230–534 ms | 10 ms (the sampling resolution) |
| symbols | identical | identical |

## Rollback

Set `CODE_INTELLIGENCE_ENGINE=typescript` (or remove it) and restart. Nothing else: the index is shared, the
schema is unchanged, the Go process may keep running for semantic retrieval or be stopped. Jobs failing in Go
are retried by the TypeScript worker like any failed job; there is no automatic fallback mid-job, which would put
two writers on one lease.

## Consequences

- `go build` needs a C compiler (gcc/clang); the first build compiles the SQL grammar (≈17 MB of generated C).
- A Go indexer reads checkouts by absolute path: in Docker, mount the repositories and the data directory at the
  same paths (compose does, read-only).
- Changing extraction rules now means changing both extractors and regenerating the parity golden until the
  TypeScript implementation is removed (after the phase exit criteria in the roadmap).
