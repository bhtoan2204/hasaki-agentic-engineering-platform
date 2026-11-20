# ADR 0004: Durable background jobs in platform-go, starting with production error scans (migration phase 3)

Status: accepted, behind `PROD_ERRORS_ENGINE=go` (default `typescript`) · Date: 2026-11-20

## Context

Three TypeScript workers poll external systems: production error scans (`src/prodErrors/scan.ts`), pull request
lifecycle sync (`src/workflow/prLifecycle.ts`) and intake dispatch (`src/workitems/intake.ts`). Before choosing what
to move we read and measured them (`npm run bench:prod-scan`, fake Splunk/SigNoz, 20 ms injected database latency).

**Production error scans** had correctness and efficiency defects, none caused by the language:

| Finding                                                                                                                      | Effect                                                                                                                                                   | Measured (before)                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Process-local lock (`let running`), schedule slot (`lastSlot`) and progress object                                           | Two instances scan at once; the "5 minutes" schedule check is a check-then-insert race; the page of instance B shows no progress of a scan on instance A | two instances starting a scan: **2 scans, 2 Splunk searches**, both write every group |
| Per-group persistence: 2 statements per group inside one transaction                                                         | ~2 × 300 round trips per scan                                                                                                                            | **648 statements per scan, 28.5 s**, nearly all of it database round trips at 20 ms   |
| No lease: a crashed scan stays `finished_at IS NULL` forever                                                                 | analytics freshness reports "scanning" forever; no automatic retry                                                                                       | —                                                                                     |
| Last writer wins on `prod_error_groups`                                                                                      | an older, slower scan overwrites a newer scan's counts                                                                                                   | —                                                                                     |
| Trace gap reads for the five slowest groups run one after another                                                            | sequential provider I/O                                                                                                                                  | —                                                                                     |
| `safeRequest` retried 429/5xx with a fixed small backoff, ignoring `Retry-After`; SigNoz 429 surfaced as "unexpected status" | retry storms against a throttling provider                                                                                                               | —                                                                                     |
| One failure notice per day held in process memory                                                                            | duplicate notices from several instances or after a restart                                                                                              | —                                                                                     |

The scan never blocked the Node event loop (p99 11–12 ms in every configuration, before and after): it is
I/O-bound, and the language it runs in is not what made it slow.

**PR lifecycle sync** already claims due rows with `FOR UPDATE SKIP LOCKED` and a `next_sync_at` lease, and backs
off with jitter; it is coupled to repository authorization (`requireRunRepositoryAccess` per PR) and to delivery
decisions (`runDelivery`). **Intake dispatch** uses optimistic revisions and crash adoption of `starting` items; it
_is_ workflow decision-making (triage, start runs). Neither has a defect of the kind above; both stay in
TypeScript in this phase (see "Next candidates").

## Decision

### 1. The scan row is the job

Migration `085_prod_error_scan_jobs.sql` turns `prod_error_scans` into the job table (no generic job framework, no
broker): `status` (queued, running, succeeded, failed, canceled), `engine`, `requested_by`, the window fixed at
enqueue (`request`), `attempts`/`max_attempts`, `available_at`, `lease_owner`/`lease_expires_at`/`heartbeat_at`, a
`fencing_token`, `cancel_requested`, shared `progress`, and `stage` (`collect` → `published`).

- **One scan at a time, globally**: a unique partial index admits one queued or running scan across all instances
  and engines (the old in-process rule, now enforced by PostgreSQL). Duplicate submissions get `started: false`.
- **Schedule slots are idempotent**: `dedupe_key = 'schedule:<local date> <HH:MM>'` is unique, so every instance can
  tick and exactly one scan is queued per slot. Ticks cost one statement when nothing is queued or running.
- **Atomic claim** (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`) increments `attempts` and the fencing
  token and sets a 30 s lease. Heartbeats every 10 s renew it and carry progress and cancellation.
- **Fenced publication**: groups and observations are written in one transaction that first locks the job row and
  checks the token. A worker that lost its lease writes nothing and notifies nobody (the gateway checks the fence
  too). Group upserts only overwrite rows whose `last_scan_id` is not newer, so a stale scan can never replace a
  newer scan's numbers.
- **Batch persistence**: one `jsonb_to_recordset` upsert for all groups and one insert for all observations (both
  engines, `publishGroups`), instead of two statements per group.
- **Crash recovery**: an expired lease (crash, kill -9, partition) is requeued by any instance with capped
  exponential backoff and full jitter (`floor(random() × min(300 s, 5 s × 2^attempts))`) until `max_attempts` (3),
  then failed with an explicit message. A scan that crashed after publishing resumes at `finalize` and never
  collects again. Notifications are idempotent per group (`notified_day`) and failure notices per day are claimed
  atomically in `settings`.
- **Cancellation**: `cancelScan` cancels a queued scan at once and a running one at its next heartbeat.

### 2. Who owns what

| TypeScript (unchanged ownership)                                                                | platform-go (`go/internal/worker`, `go/internal/proderrors`)                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| authentication, authorization, the scan API and schedule, enqueueing                            | claiming, leases, heartbeats, recovery of its own jobs, graceful release on shutdown                                                     |
| **provider credentials and every provider call** (Splunk, SigNoz, personal integrations, audit) | fan-out over the gateway: Splunk ‖ SigNoz, then latency groups, then trace gaps (bounded, 3 at once)                                     |
| PII redaction of provider rows, notification (Telegram), intake, incident lifecycle             | retries with a per-job budget, full-jitter backoff, `Retry-After` (also pausing the provider's rate limiter), per-provider token buckets |
| the TypeScript engine (rollback and fallback)                                                   | grouping, severity and fingerprints (`merge.go`, port of `toGroups`/`mergeSourceRows`), fenced batch publication, persistent progress    |

The provider reads stay in TypeScript because they are inseparable from personal credentials, their audit and the
user-scoped access rules (requirement: never duplicate credentials or bypass user scope). platform-go calls the
**internal gateway** of its own supervising server (`POST /internal/v1/prod-errors/scans/{id}/{op}`, contract
`go/contracts/prod-errors-v1.schema.json`, `src/prodErrors/gateway.ts`), loopback only, with the internal bearer
token. Before every provider read the gateway checks the caller's fence and that the requesting user may still run
the scan (active; admin for a manual scan; still the configured user for a scheduled one), then performs the read
as that user. A revoked permission (`403 revoked`) or a lost lease (`409 lease_lost`) ends the job and is never
retried. Errors are classified once, at the gateway: `429 rate_limited` (with `retry_after_ms`), `502
provider_unavailable`, `504 provider_timeout` are retryable; `424 provider_rejected` (expired login, missing
permission, invalid query) is not. TypeScript wakes platform-go after enqueueing (`POST /internal/v1/jobs/wake`); a
60 s poll covers missed wake-ups.

Only one implementation owns a job: `engine` is set at enqueue from `PROD_ERRORS_ENGINE`, the TypeScript worker
claims only `typescript` rows and platform-go only `go` rows. A queued (unowned) Go job is handed to TypeScript when
the flag is rolled back or when nobody claimed it within 120 s (platform-go down); a running job is never moved, its
lease expires and recovery requeues it first.

### 3. Resource budget

- Database: no new connection. The Go runner uses the shared platform-go pool (claim, a heartbeat per 10 s, one
  publication transaction); there is no `LISTEN` connection. Idle cost: TypeScript one statement per 30 s tick per
  instance (as before), platform-go one claim per minute.
- One scan at a time (index), `PROD_SCAN_WORKERS` = 1 by default (bounded pool; a full pool does not claim, so
  excess work waits in the table: backpressure). The scan does not touch the analytics pool, the retrieval worker or
  indexing (different code paths and pools).
- Provider pressure is bounded per scan: at most `MaxAttempts` (3) tries per gateway call and a budget of 6 retries
  per scan across all calls, under the SigNoz client's own bounded retries; a `Retry-After` longer than 2 min fails
  the call instead of holding a lease.

### 4. Telemetry

OpenTelemetry (when `OTEL_EXPORTER_OTLP_ENDPOINT` is set): spans `job.claim`, `job.run`, `gateway.<op>` (client,
`traceparent` propagated to TypeScript), `db.query` (existing pgx tracer); metrics `worker.jobs` (kind, outcome),
`worker.queue_wait`, `worker.job.duration`, `worker.retries` (op), `worker.busy` (saturation = busy / size),
`worker.claim.errors`. Spans carry ids, operation names and status codes only: no request or response bodies, no
SPL, no tokens; provider credentials never reach platform-go at all. TypeScript keeps per-operation gateway counters
(`gatewayStats`).

## Results

`npm run bench:prod-scan` (`docs/architecture/prod-scan-{legacy,typescript,go}.json`): fake Splunk (317 groups) and
SigNoz, 50 ms per provider request, 20 ms per database packet each way (remote RDS), 5 scans after a warm-up. The
"legacy" row is the pre-migration commit (`b3e47cc`) running the same benchmark file. Statements are counted by a
proxy in front of PostgreSQL, separately for Node and platform-go; the benchmark's own polling is not counted.

| One scan                            | legacy     | TypeScript engine (now) | Go engine                                                         |
| ----------------------------------- | ---------- | ----------------------- | ----------------------------------------------------------------- |
| completion latency p50              | 28.5 s     | **2.0 s (−93%)**        | **2.3 s (−92%)**                                                  |
| database statements                 | 648 (Node) | **27 (−96%)**           | 25 Node (gateway checks, Splunk progress) + 10 Go = **35 (−95%)** |
| provider requests (Splunk / SigNoz) | 5 / 8      | 5 / 8                   | 5 / 8                                                             |
| Node CPU                            | 1,456 ms   | 186 ms                  | 202 ms + 36 ms in platform-go                                     |
| Node event-loop p99                 | 11.1 ms    | 12.5 ms                 | 12.1 ms                                                           |
| platform-go RSS high-water          | —          | —                       | 26 MB                                                             |

| Two instances start a scan at once | legacy    | now (either engine)       |
| ---------------------------------- | --------- | ------------------------- |
| scans run / Splunk searches        | **2 / 2** | **1 / 1**                 |
| database statements                | 1,289     | 27 (TypeScript) / 35 (Go) |
| wall time                          | 55.3 s    | 2.0 / 2.3 s               |

| Idle (65 s, schedule and job pollers) | legacy | TypeScript engine | Go engine        |
| ------------------------------------- | ------ | ----------------- | ---------------- |
| Node statements per minute            | 1.8    | 1.8               | 1.8              |
| platform-go statements per minute     | —      | —                 | 1.8 (claim poll) |

**What the numbers say.** The improvement is the durable queue and batch publication, and both engines have it:
the root causes were a process-local lock and two round trips per group, not TypeScript. The Go engine is
**+0.3 s and +8 statements per scan slower than the new TypeScript engine** (every provider read crosses the gateway,
which re-checks the fence and the user each time) and adds one poll per minute. What it adds is the job runtime
itself (bounded pool, full-jitter retries with a per-job budget, provider rate limits and `Retry-After`, OpenTelemetry
job metrics) in the process that will run the next background workers; for production error scans alone it is not a
performance gain, so `PROD_ERRORS_ENGINE` stays `typescript` by default.

## Verification

`test/prod-errors-go.integration.ts` (CI; fails without Go) runs real platform-go processes against fake Splunk and
SigNoz servers: parity with the TypeScript engine on identical provider data (groups, observations and scan row);
two platform-go instances plus the TypeScript engine and six duplicate submissions for one job (claimed once, one
provider search); three schedule ticks of one slot; a stale fence refused by the gateway and by the group upsert; an
expired lease recovered and finished by another instance; kill -9 mid-scan and recovery; SIGTERM releasing a
running scan; HTTP 429 with `Retry-After` honoured; provider 504s exhausting a call while the other source
completes (partial failure); a failing SigNoz bounded to three gateway reads; cancellation of a running and a queued
scan; permission revoked mid-scan; rollback handing queued Go scans to TypeScript; the gateway contract (auth, fence,
schemas). `test/prodErrors.integration.ts` keeps the TypeScript engine's behaviour. `go test ./internal/worker`
covers backoff bounds, budgets, `Retry-After`, the limiter, lease loss and cancellation, the bounded pool, wake-up
and shutdown (race detector clean). `go test ./internal/proderrors` pins grouping to a TypeScript-generated golden
(`testdata/golden.json`; `test/prod-errors-golden.test.ts` fails if TypeScript changes without it) and JavaScript
number and string semantics.

## Rollback

Set `PROD_ERRORS_ENGINE=typescript` (or remove it) and restart. Queued Go scans are handed to TypeScript on the next
tick; a running Go scan finishes or its lease expires and it is requeued for TypeScript. The schema change is
additive and used by both engines, so no data migration is needed either way. platform-go can keep running for
retrieval, indexing and analytics, or be stopped.

## Next candidates

- **PR lifecycle sync**: keep authorization and delivery decisions in TypeScript; if profiling ever shows the
  provider polling matters (today ≤ 10 PRs per tick, sequential), move only the remote state reads behind the same
  gateway pattern and give `pull_requests` a fencing token so a slow sync cannot overwrite a newer one.
- **Intake polling**: the external fetch is a candidate, triage and run creation are workflow decisions and stay.
- The `worker` package is the shared runtime for both: a module brings its own table, claim and handler.

## Consequences and limitations

- Two grouping implementations exist until the exit criteria (the golden and parity tests keep them identical).
- The gateway does not abort a running Splunk search when platform-go cancels its call (cancel, shutdown, lost
  lease); the search runs to its own timeout and its result is discarded by the fence.
- A Telegram message sent just before a crash may be sent again by the resumed finalize (at-least-once); groups are
  then marked notified and not repeated afterwards.
- Under `engine = typescript` a scan that crashed after publishing collects again on retry (it does not resume at
  finalize like the Go engine); publication is idempotent, so the result is the same.
