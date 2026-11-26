# Go migration hardening review (2026-11)

Scope: the completed migrations of ADR 0001–0007 (semantic retrieval, indexing, analytics, production-error scans,
process supervision, code search, knowledge import). No new module moved. Every fix below has a regression test; every
number has a reproducible benchmark (16 CPUs / 15.5 GiB WSL2, local PostgreSQL, isolated test databases).

## Fixes (verified root causes)

| #   | Finding                                                                    | Root cause                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                | Evidence                                                                                                                                                            |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An unreadable file or directory **retired** its knowledge                  | Every filesystem error (EACCES, EIO, EMFILE…) was treated as absence; `existsSync` reports `false` when a parent is unreadable                                                                                                                                            | Both engines classify errors: ENOENT/ENOTDIR/ELOOP = absent; anything else = `unreadable (CODE)`, repository incomplete, nothing retired                                                           | `test/knowledge-import-go.integration.ts` "unreadable is not deleted" (chmod 000 on a directory, a file, a skill, a companion; both engines)                        |
| 2   | An incomplete scan could still _change_ items                              | Reading failures changed other decisions: a shared skill lost a repository (narrowed), an unreadable `.claude` skill fell back to `.agents`, an unreadable companion split a skill into variants, AGENTS.md was no longer recognized as a copy of an unreadable CLAUDE.md | Updates that drop a source repository whose scan was incomplete are deferred (reported); skills with a read failure are not emitted; later agent-instruction files after a failure are not emitted | same test (asserts no retire, no narrowing, no variant created, then a real deletion still retires)                                                                 |
| 3   | The first read failure stopped the rest of the repository's scan           | `exhausted()` returned `incomplete`, so a failure looked like a spent budget                                                                                                                                                                                              | Budgets (`stopped`) and failures (`incomplete`) separated in both engines                                                                                                                          | same test (every unreadable path is reported, other files still imported)                                                                                           |
| 4   | Cross-instance import serialization was skipped with a one-connection pool | The advisory lock took a pool connection (deadlock with `poolMax=1`, so it was skipped)                                                                                                                                                                                   | Lock on a dedicated connection outside the pool; `importGuard()` before every write refuses to write once that connection is gone                                                                  | `test/knowledge-import-concurrency.integration.ts`: two processes with `DATABASE_POOL_MAX=1`, SIGKILL while holding the lock, lock connection terminated mid-import |
| 5   | The indexing endpoint read **any** checkout on the host                    | `/internal/v1/code-intelligence/index` only checked that paths were non-empty; `base` reached `git ls-tree` unchecked                                                                                                                                                     | `primary`/`root` must be clean checkouts inside the trusted roots; `base` a commit id; no trusted roots → 503 (ADR 0002 amended)                                                                   | `TestIndexJobsStayInsideTheTrustedRoots`                                                                                                                            |
| 6   | Verification commands could fail with `admission_timeout` while queued     | In-process verification slots (CPUs/4 = 4) exceeded the host-wide Go admission slots (1): three commands waited inside the launcher and were refused after 10 minutes                                                                                                     | With the Go engine the in-process default is `min(CPUs/4, host slots)`: the queue is in-process, cancellable, without deadline; an explicit `VERIFY_MAX_CONCURRENT` still wins                     | `test/verification-slots.test.ts`                                                                                                                                   |
| 7   | Every "local" benchmark figure was inflated                                | The benchmark proxy delayed each PostgreSQL packet by a 0 ms timer (~1 ms each way) even without injected latency                                                                                                                                                         | Forward immediately without latency; ADR 0006/0007 local tables re-measured (the earlier ones overstated the gains, e.g. knowledge import unchanged at 30 repositories: −97% → −87%)               | `test/fixtures/benchHarness.ts`; re-measured JSON in `docs/architecture/`                                                                                           |
| 8   | Duplicated client logic                                                    | `goSearch.ts` (twice) and `goKnowledge.ts` each implemented call/classify/fallback                                                                                                                                                                                        | `platformGoCall()` in `src/retrieval/semantic.ts`                                                                                                                                                  | existing parity suites                                                                                                                                              |

## Memory (Node and Go)

No leak and no retention regression. Knowledge import at 30 repositories, forced GC after each scenario: peak RSS
186.7 MiB (pre-change) vs 187.6 MiB, retained heap 27–40 MiB in both; 21 consecutive imports keep the retained heap
flat (15.1 → 15.5 MiB). The reported "252 → 370 MiB" compared cumulative `maxRSS` across four scales without GC: V8
heap growth under a higher allocation rate, not retention. platform-go peaked at 46 MiB RSS (knowledge) and 181 MiB
(code search at 30 repositories). `npm run bench:knowledge-import` now records retained heap per scenario.

## Boundaries of platform-go (reviewed)

| Boundary                | State                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication          | Every `/internal/*` route behind `RequireBearer` (constant-time compare); the TypeScript gateway for Go (production scans) accepts loopback only, a ≥ 32-character token, timing-safe                                                                                     |
| Refused credentials     | Code search, knowledge scan, analytics: 401/403 raised, never answered by fallback. Semantic retrieval degrades to lexical ranking by design (ADR 0001: never fails a step); a 401 is counted (`http_401`), logged and shown in the admin status                          |
| Trusted roots           | Indexing (fixed, #5), code search and knowledge scans read only below `PLATFORM_TRUSTED_ROOTS`, resolved through symlinks when checked; empty → 503                                                                                                                       |
| Fencing / idempotency   | Index publication fenced by run token and instance session; production-error scans by fencing token (`FOR UPDATE` check in the publication transaction); knowledge publication by the import lock + guard (#4); retrieval dequeue only if not re-enqueued since the claim |
| Pool use                | No Go transaction acquires a second pool connection (no nested acquisition, so no pool deadlock); the knowledge import lock no longer uses a pool connection                                                                                                              |
| Timeouts / cancellation | `X-Request-Timeout-Ms` bounds every route; the request context cancels queries and kills subprocesses (git, rg); a canceled knowledge scan returns nothing and frees its slot (tested)                                                                                    |
| Fallback / rollback     | Engine flags read per call; fallbacks only for availability (network, timeout, 409, 5xx, malformed); read-only operations only — no publication is retried after a partial write                                                                                          |

## Resource budgets

- Supervision (ADR 0005 amended earlier): host services keep their memory, the limits of all agent and verification
  slots together never exceed the rest (`test/supervision-budget.test.ts`); pressure past the admission timeout refuses.
- Verification: in-process slots aligned with host slots (#6).
- platform-go: 4 concurrent code searches × 4 subprocesses, 2 knowledge scans, indexing jobs, all on its 4-connection
  pool (queueing, no nested acquisition); analytics on its own read-only pool.

## End-to-end measurements (`npm run bench:runtime`, `docs/architecture/runtime-e2e.json`)

Stub providers and executors (no model), 10 iterations, local database; "under load" = a knowledge import of 5
repositories and code searches over 3 checkouts of `src/`, in a loop on the same process. SQL counts are the platform's
only (the benchmark's own polling no longer goes through the counting proxy).

| p50 (re-measured after `chat-performance.md`)                           | alone                               | under load       |
| ----------------------------------------------------------------------- | ----------------------------------- | ---------------- |
| chat turn: first visible delta (first batch at once, then every 200 ms) | 22 ms (was 224)                     | 22 ms (was 225)  |
| chat turn: completion (provider streams ~450 ms)                        | 493 ms                              | 492 ms           |
| 8 concurrent chat turns: all complete                                   | 503 ms                              | 543 ms           |
| 8 new conversations with titles: last first delta                       | 81 ms                               | 95 ms            |
| 12-step workflow run (10 ms stub steps)                                 | 1.00 s (73 ms/step, 935 statements) | 1.08 s           |
| checkpoint replay of 12 steps                                           | 1.05 s                              | 1.25 s           |
| Node event-loop p99 / max                                               | 6 / 7–59 ms                         | 13–16 / 20–31 ms |

The workflow p95 (4.6–5.4 s) is the first run of the process: the provider health probe spawns every CLI before the first
agent step (`healthyProviderSwitch`, by design, outside the run lock). Agent process start (`npm run bench:process`,
8 concurrent): first output after 73 ms (TypeScript supervisor) / 175 ms (Go launcher with a systemd scope).
Code search and knowledge import: ADR 0006 / 0007 (re-measured).

## Remaining production risks

1. ~~**Chat title generation competes with the turn.**~~ Resolved in `chat-performance.md` (#6, #7): titles wait for
   the first turn, run at most two at a time and yield to running turns; admissions share one readiness probe. 8 new
   conversations: last first delta 456 → 81 ms p50. The "156 statements per chat turn" above was a benchmark artifact
   (#8 there): 78 real, now 65.
2. **Synchronous `process.report.getReport()` in the Claude Agent SDK**: confirmed in 0.3.316, once per `query()` and
   only when `pathToClaudeCodeExecutable` is unset; mitigation (`CLAUDE_CODE_EXECUTABLE`) in `chat-performance.md`.
3. **Docker deployments must set `PLATFORM_TRUSTED_ROOTS`**: without it indexing jobs now fail (fail closed) and
   search/scans fall back to TypeScript.
4. **Retrieval integration tests need pgvector**, which the local toolchain lacks; their search assertions (including
   the new re-tag test's search step) ran only up to the search call here. CI runs `go test ./...` without a
   database, so these integration tests do not run in CI at all.
5. **Import lock fencing is probe-based**: the guard checks the lock connection at most once a second; a write in that
   window after a silent connection loss is possible (each item stays a complete transaction; the next import
   reconciles).
6. **Exit criteria of ADR 0006/0007 not yet met**: two weeks of daily use with the Go engines on; TypeScript fallbacks
   remain.
