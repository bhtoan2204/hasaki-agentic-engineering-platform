# Phase 4 final validation (2026-11-21)

## 1. Commit

Validated tree: `ee23690` (Phase 4A–4D, CI run 44884568461 **success** on GitHub) plus the uncommitted changes of this
round listed in §3. Nothing was pushed; the new CI job has not run on GitHub yet.

## 2. Requirements checklist

| #   | Requirement                                                     | Status           | Evidence                                                                                                                         |
| --- | --------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Audit current status, latest CI                                 | PASS             | CI on `ee23690`, `badb5d0`, `e1efb08`: success (public Actions API). Previous report re-checked: two claims corrected (§3.3, §5) |
| 2a  | `smoke:run-view` fixed at the root cause                        | PASS             | 12/12 (§3.1)                                                                                                                     |
| 2b  | `smoke:ui-quality` overflow fixed, 320/375/390/768/desktop      | PASS             | 17 pages × 8 widths (1920 → 320), 674 measurements, 0 overflow (§3.2)                                                            |
| 3   | Browser regression tests in CI                                  | **NOT VERIFIED** | `browser` job added to `.github/workflows/ci.yml` (5 suites); YAML valid, commands run locally; not yet run on GitHub            |
| 4   | Backend / replay regression suites                              | PASS             | integration 869/869 incl. recovery, replay, handoff, reliability, instances, fencing, wake-up, revocation (§4)                   |
| 5a  | Benchmarks at 0 ms, 1/8/16 concurrent, mixed load, cold vs warm | PASS             | `bench:runtime` before/after (§5)                                                                                                |
| 5b  | Benchmarks at 10 ms and 20 ms database RTT                      | **NOT VERIFIED** | Stopped on request to finish sooner; command in §9                                                                               |
| 5c  | `bench:api`                                                     | **BLOCKED**      | Reads the configured database, which is the shared RDS (`hasaki-workflow-db…rds`); not authorized to run there                   |
| 5d  | `bench:live-updates`                                            | NOT RUN          | Superseded by `smoke:live-updates` 4/4 (same stream behaviour, counts asserted); request budget not re-measured                  |
| 5e  | `smoke:run-detail`, `smoke:chat`                                | PASS             | 3/3, 5/5; Run Detail medians of 3 (§5.3)                                                                                         |
| 6   | Remaining measured bottlenecks                                  | PASS (partly)    | First-load "regression" root-caused as an artifact; precompression added; cold CLI probes measured, not reducible here (§3.3)    |
| 7   | Observability review                                            | PASS             | coverage and caveats §6; admin-only and fixed-label test added                                                                   |
| 8   | Production readiness checklist, canary criteria                 | PASS (document)  | §8; **production validation pending** (not authorized, not performed)                                                            |
| 9   | Final verification                                              | PASS             | §4                                                                                                                               |
| 10  | Final report                                                    | PASS             | this file                                                                                                                        |

## 3. Bugs fixed and root causes

### 3.1 `smoke:run-view` timeout (test fixture drift)

Root cause: the page threw `Cannot read properties of undefined (reading 'tokens')` in `CostPanel`. The smoke mocks every
API route and answered `[]` for routes it did not list; `/api/runs/:id/cost` returns an object with `total` (the card
reads `total.tokens`). The fixture predates the cost card on Run Detail. The UI is correct for the API contract, so the
fixture now returns exactly what `runCost()` returns for a run without attempts (`summarize([])` + budget lines,
verified against the real function). No assertion or timeout changed.

### 3.2 `smoke:ui-quality` horizontal overflow (application layout defects)

Measured with an offender scan (elements whose right edge passes the viewport, excluding content inside its own scroll
container):

| Page (width)     | Overflow | Element                                                                             | Fix                                                                                                                                                               |
| ---------------- | -------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every page (390) | 265 px   | top bar: five provider chips with names, live pill, language switch, icons          | ≤ 900 px: provider and live state as dots, names kept visually hidden for screen readers and in the tooltip; ≤ 520 px: one pill of dots, tighter gaps and buttons |
| production (320) | 26 px    | service toggle pills with long `service · namespace` labels (`white-space: nowrap`) | pills wrap their label within the width                                                                                                                           |
| evaluation (375) | 4 px     | a `.row` button with a long label                                                   | buttons in `.row` may wrap their label instead of widening the page                                                                                               |

The suite now also checks 375 and 320 px (stricter than before). Keyboard focus checks of the suite pass unchanged.

### 3.3 Correction of the previous report: "first page load 316 → 452 ms"

Not static compression (disabling compression did not change it). Request timing showed the shell's first three API
calls at ~170 ms instead of ~65 ms, all waiting together: `/api/agent-providers` (the top bar) ran the cold readiness
CLIs of cursor and antigravity (2.9 s) during the page load. In the old code the seeded workflow had already run them;
after Phase 4B it used the shared reading, so the first page paid them. With the status warmed in both versions the
page is faster after the change (283 → 246 ms). The cold CLI cost itself is once per process in both versions.

Also added: build-time precompression (`scripts/precompress-web.ts`, run by `npm run build`; the server serves
`<file>.br|.gz` while not older than the file, otherwise compresses on first request). Transfer 233 → 218 KB on the
small page; no load-time change (localhost).

### 3.4 Benchmark race

`checkpoint_replay` under the mixed load aborted in the previous round's baseline: the background `drain()` could still
hold a replayed job when the scenario read the run status. Scenarios now wait for the run to settle.

## 4. Test and CI results (local, this tree)

| Check                                                                    | Result                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| typecheck, lint, build                                                   | pass                                                                                                   |
| arch:check                                                               | 5 cycles, 6 violations: the pre-existing baseline (identical before Phase 4); 0 new                    |
| `npm test`                                                               | 1 071/1 071                                                                                            |
| `npm run test:integration`                                               | 869/869 (`GIT_CONFIG_GLOBAL=/dev/null` on this host); `workflow-performance` 6/6 after the access test |
| `eval:autonomy:ci`                                                       | pass                                                                                                   |
| `smoke:run-view` / `ui-quality` / `run-detail` / `chat` / `live-updates` | 12/12 · 674 measurements, 0 overflow · 3/3 · 5/5 · 4/4                                                 |
| Go tests                                                                 | not run locally: no Go code or shared contract changed; `go test ./...` green in CI on `ee23690`       |
| GitHub CI with the new `browser` job                                     | NOT VERIFIED (not pushed)                                                                              |

## 5. Before / after benchmarks

Local PostgreSQL 17, 0 ms injected latency, stub executors and chat providers, real readiness CLIs in workflow
scenarios, N = 10. Before: `badb5d0`; after: this tree. Mixed load: knowledge import of 5 repositories, exact and symbol
code search over 3 checkouts, a concurrent 12-step workflow.

### 5.1 Workflow (p50 / p95)

| Scenario                  | alone before     | alone after      | under load before | under load after     |
| ------------------------- | ---------------- | ---------------- | ----------------- | -------------------- |
| 12-step run               | 956 / 3 717 ms   | 534 / 3 134 ms   | 1 076 / 3 466 ms  | 798 / 891 ms         |
| replay of 12 descendants  | 1 048 / 1 372 ms | 540 / 662 ms     | 1 404 / 1 938 ms  | 841 / 1 096 ms       |
| run under the scheduler   | 1 462 / 1 779 ms | 443 / 551 ms     | 1 087 / 1 382 ms  | 722 / 1 088 ms       |
| queue wait, sum per run   | 1 158 / 1 458 ms | 131 / 190 ms     | 765 / 1 060 ms    | 229 / 399 ms         |
| 8 runs at once, all done  | 2 575 / 2 793 ms | 958 / 1 054 ms   | 2 451 / 2 673 ms  | 1 745 / 2 639 ms     |
| 16 runs at once, all done | 4 361 / 4 603 ms | 1 927 / 2 317 ms | 4 065 / 4 309 ms  | 2 772 / **6 842** ms |
| SQL per 12-step run       | 935              | 846              |                   |                      |
| empty claims, 8 / 16 runs | not counted      | 84 / 176         |                   | 93 / 179             |

Cold vs warm: the first run of a process (cold provider CLIs) 3 717 → 3 134 ms alone; warm runs as above.

**Unexplained tail**: one of ten samples of 16 concurrent runs under load had a 4.3 s queue wait (p95 6 842 ms, p50
improved 4 065 → 2 772 ms). It exceeds the 1 s poll, so it is not a missed wake-up alone; the background load's own
`drain()` also claims these jobs. Not reproduced or explained in this round; recorded as a risk to check in the canary
(queue-wait p99, §8).

### 5.2 Chat (Phase 4A, p50 / p95)

| Scenario                        | alone before   | alone after    | under load before | under load after |
| ------------------------------- | -------------- | -------------- | ----------------- | ---------------- |
| one turn, first delta           | 22.2 / 41.4 ms | 20.8 / 41.1 ms | 24.0 / 67.7 ms    | 20.4 / 71.2 ms   |
| 8 concurrent, last first delta  | 35.6 / 51.8 ms | 37.2 / 54.0 ms | 43.8 / 57.8 ms    | 44.3 / 77.5 ms   |
| 16 concurrent, last first delta | 63.6 / 86.8 ms | 65.8 / 70.8 ms | 90.0 / 112 ms     | 95.6 / 110 ms    |
| 8 new conversations with titles | 75.8 / 103 ms  | 75.5 / 94.6 ms | 102 / 157 ms      | 105 / 158 ms     |

Unchanged within noise. Pool waiters (max of 5 ms samples) moved 0 → 6 (8 turns alone) and 8 → 10 (16 turns) with no
change in first delta; under load 3 → 1 and 8 → 8. With 16 concurrent turns the 10-connection pool is the limit in both
versions (`DATABASE_POOL_MAX`, §8).

### 5.3 Run Detail (Chromium, medians of 3, provider status warmed)

| Metric                                | small (13 nodes) | medium (61 nodes) | large (241 nodes, 2 651 attempts) |
| ------------------------------------- | ---------------- | ----------------- | --------------------------------- |
| load until every node drawn           | 283 → 246 ms     | 308 → 272 ms      | 505 → 456 ms                      |
| requests on load                      | 87 → 45          | 87 → 45           | 87 → 45                           |
| bytes on load                         | 686 → 218 KB     | 1 921 → 241 KB    | 7 715 → 301 KB                    |
| slowest of 5 step switches            | 73 → 70 ms       | 84 → 66 ms        | 183 → 56 ms                       |
| script, one state change              | 54 → 37 ms       | 103 → 85 ms       | 173 → 111 ms                      |
| run reloads per 200 transcript events | 0 → 0            | 0 → 0             | 0 → 0                             |

## 6. Security and reliability verification

- Fencing, lease expiry, multi-instance ownership, crash recovery (mid-edit, after commit, after remote PR, two
  reapers), stale workers: recovery, reliability, instances suites pass; Phase 4 did not change claim, fencing or
  ownership checks (`ownsInstance` deliberately kept per transaction).
- Replay semantics (REUSE / REEXECUTE / FORCE_REEXECUTE / VERIFY_ONLY / RECONCILE / RESTORE), conditional reuse,
  checkpoint integrity: replay and engine suites, bulk-fencing test.
- Provider fallback: switches only on a fresh probe; fallback disabled never probes (test).
- Side effects: no change to PR, push or integration paths; nothing replays an uncertain step automatically.
- Permissions: repository revocation and owner deactivation checks unchanged (per attempt); runtime metrics admin-only
  (403 for members, test) and contain no run, user or path values.
- Compression: never on `/api/auth/*` (CSRF token), SSE or artifacts; `HTTP_COMPRESSION=off`.
- Browser CI: stub providers only, no credentials on the runner, titles fall back in tests (no model calls).

## 7. Observability review (`GET /api/metrics/runtime`)

| Required                  | Metric                                                                       | Caveat                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| queue wait                | `scheduler.queue_wait_ms`                                                    | database `available_at` vs the Node clock                                                         |
| worker saturation         | gauges `scheduler.busy_workers`, `idle_workers`; claims, empty claims, wakes |                                                                                                   |
| provider health probes    | `health.shared_probes`, `shared_reused`, `invalidated`, `switch_probes`      |                                                                                                   |
| replay duration           | `workflow.replay_plan_ms`; re-executed attempts in `workflow.attempt_ms`     | no single "replay to completion" histogram                                                        |
| checkpoint size           | `workflow.checkpoint_bytes`                                                  |                                                                                                   |
| SQL, transaction duration | `db.statements`, `db.transactions`, `db.transaction_ms`                      | statements through `q()`/`one()` only: BEGIN/COMMIT and direct `pool.query` calls are not counted |
| pool wait                 | `db.pool_connect_wait_ms` (transactions), pool gauges                        | single statements outside transactions are not timed                                              |
| API latency               | `http.route_ms`, `http.response_bytes`, compression counters                 | route handler time, aggregate (no per-route label, by design)                                     |
| event loop, memory        | `event_loop_ms` p50/p99/max, `memory_mb`                                     | since process start                                                                               |

Cardinality: fixed names, decision actions from a fixed list (unknown values dropped). No distributed tracing: no
OpenTelemetry SDK in the process; future work, not required by a Phase 4 criterion.

## 8. Production rollout and rollback

Not performed and not authorized. Checklist for the operator:

**Configuration**

- `DATABASE_POOL_MAX` (default 10) × instances + platform-go pools (4 + analytics `ANALYTICS_MAX_CONCURRENT`) below the
  RDS `max_connections` with headroom; 16 concurrent chat turns already saturate 10 connections (§5.2).
- Go engine flags stay at their current values (`ANALYTICS_ENGINE`, `PROD_ERRORS_ENGINE`, `CODE_INTELLIGENCE_ENGINE`,
  `CODE_SEARCH_ENGINE`, `KNOWLEDGE_IMPORT_ENGINE`, `PROCESS_SUPERVISION_ENGINE`); Phase 4 needs none of them flipped.
- `PLATFORM_TRUSTED_ROOTS` set on Docker deployments (indexing fails closed without it).
- Process supervision limits as in ADR 0005 (agent + verification slots within the host budget).
- `HTTP_COMPRESSION`: leave on unless a proxy compresses; `npm run build` must run (precompressed assets).
- `CLAUDE_CODE_EXECUTABLE` set (SDK `getReport()` mitigation).

**Canary (one instance, ≥ 1 business day), exit criteria vs the pre-canary week**

- Workflow: `scheduler.queue_wait_ms` p99 ≤ 1 s; run duration p95 not worse than baseline; no run stuck RUNNING
  without a live lease (reaper log).
- Chat: first visible delta p95 ≤ 250 ms at observed concurrency; zero increase in SSE reconnects per turn.
- Replay: every replay decision has its planned/applied pair; zero REUSE after a changed fingerprint (decision log).
- Workers: zero orphan provider processes after shutdown; zero worker crashes attributable to the change.
- Database: `db.pool_waiting` p95 = 0, `db.pool_connect_wait_ms` p99 ≤ 50 ms, no `max_connections` alarms.
- Memory: RSS steady (no growth over the day beyond the cache bound); event-loop p99 ≤ 50 ms.
- Provider errors: authentication / quota failures no higher than baseline; `health.invalidated` follows failures.
- Side effects: zero duplicate PRs, pushes or integration writes; zero authorization failures exposed as successes.

**Rollback**: `HTTP_COMPRESSION=off` (runtime); everything else by reverting the Phase 4 commits and rebuilding (no
migration, no data format change).

## 9. Remaining limitations and how to close them

1. **CI `browser` job**: push and confirm it passes (Chromium install, PostgreSQL, 5 suites).
2. **10 / 20 ms database RTT**: `BENCH_DB_LATENCY_MS=5` and `=10` (each way), `BENCH_N=3 BENCH_SKIP_LOAD=1
BENCH_SCENARIOS=chat_turn,chat_concurrent,chat_concurrent_16,workflow_run,checkpoint_replay,workflow_scheduled,workflow_concurrent_8,workflow_concurrent_16 npm run bench:runtime`, on both commits.
3. **`bench:api`**: needs explicit authorization to read the shared RDS, or a production-like copy.
4. **Real providers and the real RDS**: BLOCKED from this environment; the canary above covers them.
5. **Tail of 16 concurrent runs under load** (§5.1): investigate with queue-wait p99 in the canary.
6. Wake-ups are per process; jobs enqueued by another instance wait for the poll (≤ 1 s).
7. Cold provider readiness CLIs (2–3 s for cursor/antigravity on this host) are paid once per process.

## 10. Verdict

**INCOMPLETE.** All implementation and local regression requirements pass, and the two browser regressions are fixed
at their root causes. Not yet satisfied: the new CI browser job has not run on GitHub (item 3), and the 10/20 ms
latency benchmarks were not run (item 5b). Production validation (real RDS, real providers, canary) is **BLOCKED /
pending authorization**; Phase 4 is not claimed production-ready. Closing items 1–2 of §9 turns the code verdict into
COMPLETE with the rollout obligations of §8 outstanding.
