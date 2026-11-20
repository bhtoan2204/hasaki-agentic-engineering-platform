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
| Observability/analytics aggregation (`src/api/analytics`, telemetry rollups) | 2 | Read-heavy batch SQL, no write coupling | Snapshot tests of current API responses |
| Background workers without run coupling (prod-error scans, PR lifecycle sync, intake polling) | 3 | Periodic IO; each must keep its own outbox/lease semantics | Per-worker ownership of its tables; idempotency tests |
| Process supervision and resource limits (bubblewrap, process trees) | 3 | Go is a better fit for process control | Isolation regression suite; the TypeScript harness still spawns agents |
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
