# Gradual TypeScript → Go migration roadmap

The platform moves to Go one module at a time (Strangler Fig). TypeScript stays the system of record for every
module that has not moved. Phase 1 is semantic retrieval ([ADR 0001](adr/0001-go-backend-semantic-retrieval.md)).

## Rules for every migration

1. **One owner per table.** A module writes only its own schema. Other modules read it, or call its API.
2. **One migration authority.** `src/db/migrate.ts` applies all SQL. Go checks the schema version at startup.
3. **Versioned internal contract** (`/internal/v<N>/…`, JSON Schema, contract tests on both sides). Breaking
   changes add `v<N+1>` and keep `v<N>` until TypeScript no longer calls it.
4. **Feature flag** in `config.json`, default off, with the TypeScript implementation as the fallback path.
5. **Independent rollout and rollback**: turning the flag off restores the previous behaviour with no data
   migration. The Go process can be stopped at any time.
6. **Measured** before and after: latency, CPU, RSS, DB connections, and the module's own quality metric.

## Candidates

| Module | Phase | Why / why not now | Prerequisite |
|---|---|---|---|
| Semantic retrieval | **1 (this change)** | New capability, CPU/IO-bound, no workflow state | pgvector, embedding model |
| Code intelligence indexing (`src/codeIntelligence/indexer.ts`) | 2 | Long CPU-bound parsing; already queue-driven (`code_intelligence.runs`, SKIP LOCKED) and owns its schema | Parser parity tests against the current index |
| Observability/analytics aggregation (`src/api/analytics`, telemetry rollups) | 2 | Read-heavy batch SQL, no write coupling | Snapshot tests of current API responses |
| Background workers without run coupling (prod-error scans, PR lifecycle sync, intake polling) | 3 | Periodic IO; each must keep its own outbox/lease semantics | Per-worker ownership of its tables; idempotency tests |
| Process supervision and resource limits (bubblewrap, process trees) | 3 | Go is a better fit for process control | Isolation regression suite; the TypeScript harness still spawns agents |
| Workflow scheduling (`src/workflow/scheduler.ts`) | later | Tightly coupled to fencing, leases and the engine's transactions | Engine contract for claim/complete |
| Workflow execution, checkpoints, replay, agent harness, provider adapters | **stay in TypeScript** | Core state machine with the most behaviour and test coverage; moving it buys little | Re-evaluate only after phases 2–3 |

## Phase exit criteria

- Feature flag on in daily use for two weeks without fallback activations caused by the Go side.
- Contract tests green on both sides in CI.
- Rollback rehearsed (flag off, Go stopped) with workflow and chat suites green.
