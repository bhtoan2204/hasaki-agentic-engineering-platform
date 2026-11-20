# Gradual TypeScript → Go migration roadmap

The platform moves to Go one module at a time (Strangler Fig). TypeScript stays the system of record for every
module that has not moved. Phase 1 is semantic retrieval ([ADR 0001](adr/0001-go-backend-semantic-retrieval.md)).

## Rules for every migration

1. **One owner per table.** A module writes only its own schema. Other modules read it, or call its API.
2. **One migration authority.** `src/db/migrate.ts` applies all SQL. Go checks the schema version at startup.
3. **Versioned internal contract** (`/internal/v<N>/…`, JSON Schema, contract tests on both sides). Breaking
   changes add `v<N+1>` and keep `v<N>` until TypeScript no longer calls it.
4. **Feature flag** in `.env`, default off, with the TypeScript implementation as the fallback path.
5. **Independent rollout and rollback**: turning the flag off restores the previous behaviour with no data
   migration. The Go process can be stopped at any time.
6. **Measured** before and after: latency, CPU, RSS, DB connections, and the module's own quality metric.

## Candidates

| Module | Phase | Why / why not now | Prerequisite |
|---|---|---|---|
| Semantic retrieval | **1 (this change)** | New capability, CPU/IO-bound, no workflow state | pgvector, embedding model |
| Code intelligence indexing (`src/codeIntelligence/indexer.ts`) | **2 (done, flag `CODE_INTELLIGENCE_ENGINE=go`)** | Long CPU-bound parsing on the event loop; already queue-driven and owns its schema. [ADR 0002](adr/0002-go-code-intelligence-indexing.md) | Parity: 6,554 files / 27 repositories identical |
| Code search, dependency traversal, exact search, code context (`src/codeIntelligence/search.ts`) | **2 (done, flag `CODE_SEARCH_ENGINE=go`)** | Per-repository freshness, sequential loops and ~17 searches per code context; TypeScript keeps authorization and scope resolution. [ADR 0006](adr/0006-go-code-search.md) | Parity suite on identical repositories and worktrees (`test/code-search-go.integration.ts`) |
| Knowledge ingestion (`src/knowledge/importer.ts`) | **2 (done: publication path on both engines; scan behind `KNOWLEDGE_IMPORT_ENGINE=go`)** | The cost was the registry comparison (4–5 statements per candidate), not the filesystem; the scan moved to Go for CPU and event-loop time. Governance, scope and publication stay in TypeScript. [ADR 0007](adr/0007-go-knowledge-scan.md) | Parity suite (`test/knowledge-import-go.integration.ts`), text golden |
| Observability/analytics aggregation (`src/api/analytics`) | **2 (done, flag `ANALYTICS_ENGINE=go`)** | Read-heavy SQL, no write coupling; the cost was PostgreSQL, so the move is the SQL fixed and consolidated, off the Node pool. [ADR 0003](adr/0003-go-analytics.md) | Parity suite on identical data (`test/analytics-go.integration.ts`) |
| Background workers without run coupling (prod-error scans, PR lifecycle sync, intake polling) | **3: prod-error scans done (flag `PROD_ERRORS_ENGINE=go`)**; PR lifecycle and intake stay | Scans: durable jobs with leases and fencing, providers through the TypeScript gateway. [ADR 0004](adr/0004-go-background-workers.md). PR lifecycle and intake are coupled to authorization and workflow decisions | Per-worker ownership of its tables; idempotency tests |
| Process supervision and resource limits (bubblewrap, process trees) | **3 (done, flag `PROCESS_SUPERVISION_ENGINE=go`)** | Per-process launcher: delegated cgroup leaf, `cgroup.kill`, limits, host-wide admission; providers keep their protocols. [ADR 0005](adr/0005-go-process-supervision.md) | Isolation regression suite (`go test ./internal/supervise`, `test/process-supervision.integration.ts`) |
| Workflow scheduling (`src/workflow/scheduler.ts`) | later | Tightly coupled to fencing, leases and the engine's transactions | Engine contract for claim/complete |
| Workflow execution, checkpoints, replay, agent harness, provider adapters | **stay in TypeScript** | Core state machine with the most behaviour and test coverage; moving it buys little | Re-evaluate only after phases 2–3 |

## Phase exit criteria

- Feature flag on in daily use for two weeks without fallback activations caused by the Go side.
- Contract tests green on both sides in CI.
- Rollback rehearsed (flag off, Go stopped) with workflow and chat suites green.

## Phase 2 status: code intelligence indexing

Implemented behind `CODE_INTELLIGENCE_ENGINE=go` ([ADR 0002](adr/0002-go-code-intelligence-indexing.md)).
TypeScript keeps the queue, leases, provisioning, authorization and search; Go runs each claimed job (discovery,
parsing, persistence, fenced publication) through `POST /internal/v1/code-intelligence/index`. Extraction is
byte-identical, so both engines share snapshots and the extraction cache and the flag can flip either way without
reindexing.

| Measure (`npm run bench:code-index`) | TypeScript → Go |
|---|---|
| full index throughput | 2.7–3.0× |
| concurrent indexing (3 repositories) | 3.3× |
| peak indexing RSS | −48–57% |
| database statements per job | −61–69% |
| Node event-loop p99 during indexing | 230–534 ms → 10 ms |

Checks: `go test ./internal/codeintelligence/` (parity golden, contract, JS text semantics) in CI;
`test/code-intelligence-go.integration.ts` runs the whole code intelligence integration suite against a real
platform-go, plus rollback, stale-fence and cancellation cases (skipped without a Go toolchain). Remaining before
the exit criteria: two weeks of daily use with the flag on, then removing the TypeScript extraction path.

## Phase 2 status: engineering analytics

Implemented behind `ANALYTICS_ENGINE=go` ([ADR 0003](adr/0003-go-analytics.md)). Profiling showed the cost was
PostgreSQL, not Node (1–9 ms CPU per dashboard), so the phase is the SQL fixed and consolidated, running on
platform-go's own read-only pool. TypeScript keeps routing, authorization, the support audit, the cache and the
incident mutation; availability failures fall back to it (bounded), validation and authentication failures do not.

| Measure (`npm run bench:analytics`, 20k runs, 30 days) | TypeScript → Go |
|---|---|
| health p95 | 2.6–2.7 s → 0.32 s (−88%) |
| usage SQL time / statements | −76–80% / 4 → 1 |
| health-service SQL time / statements | −57% / 2 → 1 |
| SQL time per request under 8 concurrent clients | −74% |
| Node pool probe p95 during that load | 1,858 ms → 1 ms |
| performance, workflows | −0–38% p95 (PostgreSQL-bound) |
| health with provider filter + service | +16–55% p95 (4 statements on 2 slots) |

Checks: `go test ./internal/analytics/` (validation, DST, value mapping, contract) and
`test/analytics-go.integration.ts` (parity of every dashboard on identical data, fallback, timeout, cancellation,
audit, rollback) in CI; both fail without Go. Remaining before the exit criteria: two weeks of daily use with the
flag on, then removing the TypeScript SQL (or porting the fixes to it if Go is rolled back).

## Phase 3 status: background workers, production error scans

Implemented ([ADR 0004](adr/0004-go-background-workers.md)). Scans are durable jobs on both engines (one active scan
across instances, leases, fencing, crash recovery, idempotent schedule slots, batch publication); with
`PROD_ERRORS_ENGINE=go` platform-go owns the job and reads providers through the TypeScript gateway.

| Measure (`npm run bench:prod-scan`, 20 ms database latency) | legacy → TypeScript / Go |
|---|---|
| scan latency | 28.5 s → 2.0 s / 2.3 s |
| database statements per scan | 648 → 27 / 35 |
| two instances starting a scan | 2 scans → 1 |
| idle statements per minute | 1.8 → 1.8 / 3.6 |

The gain is the queue and batching (both engines). The Go engine is slightly slower than the TypeScript engine and
stays opt-in; it is the runtime the next workers will use. PR lifecycle sync and intake stay in TypeScript (coupled
to authorization and workflow decisions); their isolated provider polling is the next candidate.

## Phase 3 status: process supervision

Implemented ([ADR 0005](adr/0005-go-process-supervision.md)). One TypeScript adapter now starts and stops provider CLIs
(Codex, Cursor, Copilot, Antigravity) and verification commands; with `PROCESS_SUPERVISION_ENGINE=go` each runs under
`platform-supervise` in its own delegated cgroup leaf. The Claude Agent SDK path is unchanged (its sandbox already
runs in a systemd scope and a PID namespace).

| Measure (`npm run bench:process`) | legacy → TypeScript / Go |
|---|---|
| stopping a tree with double-forked daemons | 50 survivors, never closes → 50, never closes / **0, closed in 22.5 ms** |
| process start (first output) | 46 ms → 29 ms / 78 ms |
| streaming, flooding, CPU-bound work, Node event loop | unchanged within noise |

The gain is correctness (no surviving descendants, no PID confusion, limits, host-wide admission), not speed; the Go
engine costs a systemd scope per process. Default stays `typescript` until daily use; enforced isolation should use
`go`.

## Phase 2 status: code search

Implemented behind `CODE_SEARCH_ENGINE=go` ([ADR 0006](adr/0006-go-code-search.md)), completing the code intelligence
migration. TypeScript authorizes the scope and resolves every repository and worktree once per call; platform-go
re-validates the paths, memoizes freshness per request, batches the SQL across snapshots, runs repositories four at a
time, streams ripgrep and reads sources with one `git cat-file --batch`. Results are identical to the TypeScript
engine; unavailable, slow or outdated platform-go falls back to it.

| Measure (`npm run bench:code-search`, p50) | 5 repositories | 30 repositories |
|---|---|---|
| `buildCodeContext` (3 queries) | 14.8 s → 2.8 s (−81%) | 53.5 s → 5.5 s (−90%) |
| `searchSymbols` (4 queries) | −59% | −74% |
| `findDependencies`, `findReferences` | −73%, −74% | −81%, −45% |
| `searchCodeExact` (limit 20) | −55% | +7% (scope resolution of all 30 repositories) |
| SQL statements per `buildCodeContext` | 814 → 76 | 3,025 → 54 |

Checks: `go test ./internal/codeintelligence/` (validation, collation, contract) and
`test/code-search-go.integration.ts` (the whole code intelligence suite on the Go engine, engine parity on base and
overlay snapshots, path/symlink/ref refusal, revocation, redaction, fallback, timeout) in CI; both fail without Go.
Remaining before the exit criteria: two weeks of daily use with the flag on; lazy scope resolution for exact search;
then removing the TypeScript search engine.

## Phase 2 status: knowledge ingestion

[ADR 0007](adr/0007-go-knowledge-scan.md). Profiling showed the filesystem scan at 0.5% of an import; the database
comparison was the cost. Fixed in TypeScript for both engines (one batched registry read with contents compared by
hash, writes without read-back, serialized publications), plus one set of safe scan rules (symlinks, size and entry
budgets, incomplete scans never retire). The scan itself runs in platform-go with `KNOWLEDGE_IMPORT_ENGINE=go`, inside
trusted roots configured by the server.

| Measure (`npm run bench:knowledge-import`, p50) | 5 repositories | 30 repositories |
|---|---|---|
| unchanged re-import | 2.9 s → 0.15 s (−95%) | 19.0 s → 0.49 s (−97%) |
| 1% / 10% modified | −93% / −80% | −96% / −84% |
| cold import | −41% | −47% |
| SQL statements, unchanged | 1,103 → 10 | 6,339 → 17 |
| scan, Go vs TypeScript | 24 → 21 ms | 140 → 95 ms (−32%), Node CPU −78% |

Also in this phase (ADR 0007 §9): code search validates request roots against platform-go's trusted roots, raises
401/403 instead of falling back, and authorizes exact-search scopes lazily with the sequential semantics; the
supervision budget reserves memory for the host's services and never overcommits across classes. Remaining before the
exit criteria: two weeks with `KNOWLEDGE_IMPORT_ENGINE=go` in daily use; the Go scan stays opt-in unless it shows a
latency benefit on real repositories.
