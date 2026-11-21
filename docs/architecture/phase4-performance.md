# Phase 4 performance: workflow engine, replay, Run Detail, observability (2026-11)

Phase 4 of the performance roadmap, after Phase 4A (Chat, [`chat-performance.md`](chat-performance.md)). The rule
throughout: optimize only what code evidence or a reproducible measurement shows, keep every durable state transition,
audit row, event, fencing check and authorization check, and publish the numbers with their conditions. Raw numbers:
[`phase4-performance.json`](phase4-performance.json).

Conditions: WSL2 host, local PostgreSQL 17 (no added latency), stub executors and stub chat providers (no model is
called), real provider readiness CLIs where stated, production web bundle in headless Chromium 1148. `before` is the
previous commit (`badb5d0`) run with the same benchmark files; `after` is this change.

## 0. Audit and baseline

Every number in the roadmap was re-measured before changing code.

| Reported                                           | Re-measured (before)                                              | Classification                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 935 SQL statements for a 12-step workflow          | 935.6                                                             | confirmed; but only part of the latency (see the attribution below)                                                                 |
| ~73 ms orchestration overhead per step             | 74 ms (p50), executor 10 ms per step                              | confirmed bottleneck                                                                                                                |
| ~1 s warm 12-step workflow                         | 1 008 ms p50                                                      | confirmed                                                                                                                           |
| cold p95 ~5.4 s "partly provider health probing"   | 4.3–5.1 s for the first run of a process                          | confirmed, and it is _all_ readiness probing: the first `cursor` (2.3 s) and `antigravity` (3.0 s) capability checks of the process |
| 996 SQL, 1.05 s p50 to replay 12 steps             | 995.7, 1 026 ms                                                   | confirmed                                                                                                                           |
| (not reported) queue wait under the real scheduler | 1 111 ms of a 1 398 ms run (p50) with the production worker loops | **new finding**: `drain()` in the benchmark hid it                                                                                  |

Attribution of a warm run (SQL timed per call site, `BENCH_SQL_TOP` and a call-site profiler; 727 statements, ~250 ms
serial SQL, 120 ms executor, rest JavaScript):

| Cost                                                                   | Share of a warm run                                         | Classification                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a readiness probe per agent step (`claude auth status` + 3 other CLIs) | ~400 ms (12 × ~30 ms warm; ~0.3 s each on a cold host)      | confirmed bottleneck                                                                                                                                                                 |
| budget gates: the full `execution_attempt_telemetry` view, 25×/run     | ~50 ms (2 ms each: the view plans tool-interval laterals)   | confirmed; spent even when no budget is configured                                                                                                                                   |
| repeated reads (step type, run id, checkpoint size, budget run row)    | 64 statements/run                                           | confirmed redundant                                                                                                                                                                  |
| replay fencing: 4 UPDATEs per invalidated step                         | 52 statements per 13-step replay                            | confirmed redundant                                                                                                                                                                  |
| instance ownership check in every transaction (`ownsInstance`)         | 40/run                                                      | **intentional**: it must run after the run lock is granted; folding it into the lock statement would evaluate it on the snapshot taken before a lock wait (a stale fencing decision) |
| owner `active` check per attempt, run/step/job/attempt `FOR UPDATE`    | ~5/step                                                     | **intentional**: revocation and fencing                                                                                                                                              |
| one event row per transition, checkpoint and decision per attempt      | ~6/step (already batched before COMMIT by `insertDeferred`) | **intentional**: audit and recovery evidence                                                                                                                                         |
| automatic-handoff scan before every claim                              | 1/claim                                                     | acceptable: one indexed UPDATE, singleflight                                                                                                                                         |
| "pool wait / lock contention"                                          | pool waiters 0, no lock waits observed                      | not a bottleneck at this scale                                                                                                                                                       |

Frontend baseline (production bundle, Chromium): see §4C. API baseline: `loadRunDetail` and `loadStepDetail` already
project JSON columns and run their reads in parallel (earlier work); a 240-step run with 2 651 attempts was **1.5 MB of
uncompressed JSON** because the server compressed nothing (neither API results nor the 700 KB UI bundle).

## Changes

### 4B — workflow engine

1. **Shared readiness for workflow admission** (`healthyProviderSwitch`, `src/workflow/engine.ts`). Workflow steps read
   the same singleflight, 10 s reading as chat admission (`sharedAgentHealth`). It only ever _keeps_ the chosen
   provider: when the reading says that provider is unusable, a **fresh probe** of the policy's providers decides the
   switch, so a reused reading never moves a step. Unchanged: fallback disabled or `auto_health: false` never probes;
   frozen provider flags, delegation and policy order apply as before; the probe still runs outside the run lock.
   Invalidation: an attempt that fails as `AUTHENTICATION`, `QUOTA_EXHAUSTED` or `PROVIDER_UNAVAILABLE` drops the
   shared reading (chat already did this for its failures); the handoff continuation keeps its own fresh probe.
2. **Idle workers wake on a committed job** (`src/workflow/scheduler.ts`, `JOBS_RUNNABLE` in `mutations.ts`,
   `noteCommitted` in `src/db/pool.ts`). `ensureJob`, a run resuming, and a lease-expired job handed back raise a
   signal that is emitted only after COMMIT (never on rollback). One idle worker per lane kind wakes; a worker that
   claims wakes the next idle one (fan-out for parallel branches); a signal that arrives between an empty claim and the
   sleep is not lost (generation counter). Claims are unchanged (`FOR UPDATE SKIP LOCKED`, fencing token, instance
   ownership); the 1 s poll remains for writes by other instances. No new queue or broker.
3. **Budget gates read spend only when a limit applies** (`budgetsForRun`, `src/report/cost.ts`), as one
   `sum(reported_cost_usd)` over the same view (PostgreSQL prunes the unused laterals), and reuse the run row the caller
   holds locked when the run has no work item. Cost reports pass their rows and are unchanged.
4. **Redundant reads removed**: the job preview is read once and serves both the branch lease and the health check;
   `finishAttempt` takes the attempt's run id from the worker (an attempt never changes run); the checkpoint envelope
   size comes from `INSERT … RETURNING octet_length(execution::text)` instead of a second SELECT.

### 4B.2 — checkpoint and replay

5. **Replay fences invalidated steps in bulk** (`reexecuteTx`). Jobs, running attempts, attempt invalidation and open
   questions of every invalidated step are updated with one statement each (`step_id = ANY(…)`), in the same
   transaction under the run lock; each step's own status transition, generation bump and `status` event still follow in
   plan order, target last. Replay planning (`planReplay`), the REUSE / REEXECUTE / FORCE_REEXECUTE / VERIFY_ONLY /
   RECONCILE / RESTORE meanings, fingerprint checks at dispatch and workspace reconciliation are untouched.
6. Checkpoint persistence was audited and left as it is apart from (4): envelopes are bounded (result ≤ 128 KiB, the
   workspace as an encrypted artifact), superseded `executor_returned` checkpoints are already retired per step, and
   the hashes, fingerprints and provenance are what recovery reads. No incremental checkpoint format: there is no large
   payload to save at this point (see "not implemented").

### 4C — Run Detail and API

7. **Graph identity** (`web/src/pages/RunView.tsx`, `useStableById` in `web/src/graph.tsx`). Attempts are indexed in
   one pass (count and latest per step) instead of copying and scanning the attempt list for every node. The graph is
   built without the selection; selecting a step replaces only the selected node. Nodes and edges whose content did not
   change keep their object across reloads, so React Flow re-renders only the steps that changed. Deep links, saved
   layouts, the auto-layout toggle, pan/zoom, keyboard and ARIA labels are unchanged.
8. **One icon chunk** (`web/vite.config.ts`). Lucide icons shared by lazy pages had become one tiny chunk per icon.
9. **Response compression** (`src/http/compression.ts`). The UI bundle (compressed once per file and build) and GET
   route results ≥ 8 KiB are sent with brotli (quality 4) or gzip when the client accepts it, compressed on libuv's
   thread pool. Never compressed: SSE, artifact downloads, the session routes (`/api/auth/*`, which carry the CSRF
   token; BREACH), non-GET responses. `HTTP_COMPRESSION=off` disables it.

The live-update layer was audited against the Phase 4A lessons and needed no change: one shared `EventSource` per tab
with a stable subscription (`useLive` depends on the run id only), cursor replay after a gap, polling fallback, hidden
tabs closed and caught up on return, and transcript-only events never reload the run (asserted again below).

### 4D — observability and gates

10. **Runtime metrics** (`src/runtimeMetrics.ts`, `GET /api/metrics/runtime`, admin only, beside `/api/metrics/cache`).
    The platform process has no OpenTelemetry SDK (the OTel references in the code query _external_ telemetry), so no
    dependency was added; this is a fixed-name, fixed-label registry: SQL statements, transactions (duration, pool
    connect wait, rollbacks), pool gauges, scheduler claims / empty claims / wake-ups / queue wait / busy and idle
    workers, attempt duration, shared-health probes / reuse / invalidations / switch probes, replay-plan duration,
    decisions per action, checkpoint bytes, API route time, response bytes and compression, event-loop delay, RSS. No
    run, user, repository, prompt or path value is ever a label.
11. **Regression gates** (deterministic counts, in the integration suite that CI runs):
    `test/workflow-performance.integration.ts` — SQL per step ≤ 60 (measured 53.5), one shared readiness probe per
    12-step run and no switch probe, a fresh probe before any switch (kept / switched / fallback disabled), invalidation
    on an authentication failure, wake-up within a 10 s poll and bounded empty claims, bulk replay fencing with history
    kept (≤ 40 statements, measured 28), compression on/off and never on the session route.
    `test/run-detail.browser.ts` (`npm run smoke:run-detail`) — every DAG node drawn, one stream per page, no run reload
    for 200 transcript events, one reload per state change; timings published, not asserted.

## Results

Reproduce: `npm run bench:runtime` (add `BENCH_LOAD_WORKFLOW=1` for the mixed load, `BENCH_SCENARIOS=…`,
`BENCH_SQL_TOP=40` for the statement breakdown), `npm run build && npm run smoke:run-detail`
(`RUN_DETAIL_BENCH_OUT=…` writes the measurements).

### Workflow engine (alone, N = 10, p50 / p95)

| Scenario                                   | before            | after                           | change    |
| ------------------------------------------ | ----------------- | ------------------------------- | --------- |
| 12-step run (`drain`)                      | 928 / 4 193 ms    | 536 / 3 715 ms                  | p50 −42 % |
| SQL statements per run                     | 935               | 846                             | −9.5 %    |
| replay of 12 descendants                   | 1 043 / 1 522 ms  | 642 / 741 ms                    | p50 −38 % |
| SQL statements per replay                  | 996               | 858                             | −14 %     |
| run under the production scheduler         | 1 323 / 2 665 ms  | 406 / 546 ms                    | p50 −69 % |
| queue wait, sum over the run's 13 jobs     | 1 020 / 2 383 ms  | 125 / 207 ms                    | −88 %     |
| SQL statements, scheduled run (incl. idle) | 952               | 929                             | −2 %      |
| readiness probes per run                   | 13 (one per step) | ≤ 1 (0.1–0.2/run: one per 10 s) |           |
| Node CPU per run (`drain`)                 | 269 ms            | 240 ms                          | −11 %     |

The cold p95 (first run of a process, 3.7–4.2 s) is the one-time `cursor`/`antigravity` capability checks; it now
happens once per process instead of being repeated, but a first run still pays it. Under the mixed load (knowledge
import, code search and a concurrent workflow), the 12-step run went 1 024 / 1 567 → 576 / 979 ms; the baseline's replay
and scheduled scenarios under that load did not complete (benchmark race in `drain()`, see the JSON), the new ones did:
604 / 778 ms and 560 / 673 ms.

### Phase 4A under the mixed load (p50 / p95, before → after)

| Scenario                                | before         | after          |
| --------------------------------------- | -------------- | -------------- |
| one turn, first visible delta           | 22.8 / 51.5 ms | 23.8 / 67.3 ms |
| 8 concurrent turns, last first delta    | 45.0 / 51.5 ms | 45.8 / 77.1 ms |
| 8 new conversations with titles         | 92.2 / 160 ms  | 94.0 / 155 ms  |
| all 8 titles settled                    | 14.6 s         | 14.6 s         |
| pool waiters (max), 8 new conversations | 3              | 0              |

Chat is unchanged within run-to-run noise (the p95s of 10 samples move by ±20 ms between identical runs); its SQL per
turn is 64–65 as after Phase 4A. One alone-run sample showed 8 pool waiters for 8 concurrent turns (3 before); the
under-load runs showed 2 → 2 and 3 → 0, so no regression is claimed or excluded at that resolution.

### Run Detail (Chromium, production bundle, median of 3 runs, before → after)

| Metric                                | small (13 nodes) | medium (61 nodes, 366 attempts) | large (241 nodes, 2 651 attempts, 11 k events) |
| ------------------------------------- | ---------------- | ------------------------------- | ---------------------------------------------- |
| requests on load                      | 87 → 45          | 87 → 45                         | 87 → 45                                        |
| bytes transferred on load             | 673 → 233 KB     | 1 909 → 248 KB                  | 7 715 → 331 KB                                 |
| run payload on the wire               | 33 → 3 KB        | 259 → 9 KB                      | 1 495 → 33 KB                                  |
| load until every node drawn           | 316 → 452 ms ¹   | 312 → 283 ms                    | 504 → 420 ms                                   |
| step switch, slowest of 5             | 59 → 62 ms       | 85 → 70 ms                      | 177 → 58 ms                                    |
| script time, 5 step switches          | 100 → 93 ms      | 136 → 83 ms                     | 341 → 111 ms                                   |
| script time, one state change         | 38 → 38 ms       | 103 → 72 ms                     | 168 → 109 ms                                   |
| script time, 200 transcript events    | 87 → 117 ms      | 132 → 126 ms                    | 187 → 135 ms                                   |
| run reloads for 200 transcript events | 0 → 0            | 0 → 0                           | 0 → 0                                          |
| EventSources opened                   | 1 → 1            | 1 → 1                           | 1 → 1                                          |
| heap after load                       | 8.8 → 9.1 MB     | 12.1 → 11.6 MB                  | 32.7 → 33.2 MB                                 |

¹ **Corrected in the final validation** ([`phase4-final-validation.md`](phase4-final-validation.md)): the slower first
load was a benchmark artifact, not static compression. The page's top bar calls `/api/agent-providers`, whose first call
in a process runs every provider's readiness CLI (2.9 s cold here). Before this change the seeded workflow had already
run those CLIs (each step probed them); after it, the seed used the shared reading, so the page paid the cold CLIs and
its concurrent requests waited for CPU. With the status warmed first in both versions: **283 → 246 ms** (small),
308 → 272 ms (medium), 505 → 456 ms (large), medians of 3. Build-time precompression was added anyway (it removes the
on-request compression and shrinks the transfer, 233 → 218 KB) but did not change load time.

### Final validation (2026-11-21): concurrency and mixed load

Same fixtures, N = 10, before `badb5d0` → after; full table and raw numbers in
[`phase4-final-validation.md`](phase4-final-validation.md) and `phase4-performance.json` (`final_validation`).

| p50 (alone)                                | before   | after    |
| ------------------------------------------ | -------- | -------- |
| 8 runs at once, all complete               | 2 575 ms | 958 ms   |
| 16 runs at once, all complete              | 4 361 ms | 1 927 ms |
| one run under the production scheduler     | 1 462 ms | 443 ms   |
| replay of 12 descendants                   | 1 048 ms | 540 ms   |
| 16 concurrent chat turns, last first delta | 63.6 ms  | 65.8 ms  |

## Correctness evidence

- Integration suite (863 existing + 6 new), including the recovery, replay, provider-handoff, reliability, instances,
  micro, context and budget suites: see "CI status".
- Crash boundaries: the recovery suite's scripted crashes (mid-edit, after commit and sealed checkpoint, after the
  remote PR, two reapers at once) run unchanged; the executor-return checkpoint and finish transaction keep their
  fencing (the run id now comes from the claimed attempt, the job/attempt/step fencing checks are unchanged).
- Replay: `test/replay.integration.ts` and the engine suite, plus the bulk-fencing test (generations bumped once, every
  earlier attempt invalidated, open questions dismissed, one status event per step, run completes again).
- External side effects are not touched: PR creation, pushes and integrations still go through their reconciliation
  paths; nothing here replays an uncertain step automatically.

## CI status (local run of the CI commands, 2026-11-21)

| Command                                                      | Result                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`, `lint`, `build`                         | pass                                                                                                      |
| `npm run arch:check`                                         | 5 cycles, 6 violations — unchanged from before                                                            |
| `npm test`                                                   | 1 070 / 1 070                                                                                             |
| `npm run test:integration`                                   | 869 / 869 (`GIT_CONFIG_GLOBAL=/dev/null` on this host, as before)                                         |
| `npm run eval:autonomy:ci`                                   | pass                                                                                                      |
| `smoke:run-detail` (new), `smoke:chat`, `smoke:live-updates` | 3/3, 5/5, 4/4                                                                                             |
| `smoke:run-view`, `smoke:ui-quality`                         | failed before and after this change; **fixed in the final validation** (see `phase4-final-validation.md`) |
| Go tests                                                     | not run: no Go code or shared contract changed                                                            |

GitHub CI itself was not run from here (nothing is pushed).

## Feature flags and rollback

| Change                     | Switch / rollback                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| response compression       | `HTTP_COMPRESSION=off` (runtime, no deploy)                                                                                                                     |
| shared readiness, wake-up  | no flag: revert the commit. Worst case without a revert: a reading up to 10 s old keeps a provider that just failed (the attempt then fails and invalidates it) |
| budget, reads, replay bulk | revert the commit; no schema change, no migration, no data format change                                                                                        |
| frontend                   | revert the commit and rebuild                                                                                                                                   |

## Remaining risks and production validation needed

- **Remote database latency**: every removed round trip is worth more on RDS than here (0 ms injected). Re-run
  `BENCH_DB_LATENCY_MS=20 npm run bench:runtime` in the target network before claiming the remote numbers.
- **Real providers**: readiness CLIs were real; executors and chat providers were stubs. The share of orchestration in a
  real agent step (minutes) is small; the gains matter for short steps, approvals, conditions and queue wait.
- **Multiple instances**: wake-ups are per process; a job enqueued by another instance for a run this instance owns
  still waits for the poll (≤ `pollMs`).
- **Wake-up cost**: woken workers that find nothing go back to sleep; measured 27 empty claims per 13-step run with 3
  lanes (cheap, `SKIP LOCKED`, no lock waits). The scheduled scenario still uses 2 % fewer statements than before,
  because the run spends less time polling.
- Browser tests run in the CI `browser` job since the final validation (not yet observed on GitHub at the time of
  writing).

## Not implemented, and why

- OpenTelemetry SDK and exporters: none in the process today; adding the dependency, exporter configuration and
  sampling is a separate decision. The registry above answers the latency questions without it.
- Folding `ownsInstance` into the run lock statement: would weaken fencing (pre-lock snapshot).
- Caching run/step rows or workflow configuration in memory: mutable durable state without a proven invalidation path.
- Incremental checkpoints, a new artifact store, retention changes: the envelopes are small and bounded already.
- Combining per-transition events or status updates into fewer rows: they are the audit history.
- Pagination or a summary endpoint for Run Detail attempts: with compression the 2 651-attempt run is 33 KB on the wire
  and parses in a few ms; splitting it would add requests for every view that uses attempts.
- DAG virtualization (`onlyRenderVisibleElements`): 241 nodes render within the load budget; virtualization would
  change pan/zoom and keyboard behaviour for no measured gain.
