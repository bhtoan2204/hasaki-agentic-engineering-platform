# ADR 0003: Engineering analytics in Go (migration phase 2)

Status: accepted, behind `ANALYTICS_ENGINE=go` (default `typescript`) · Date: 2026-11-20

## Context

`src/api/analytics/` serves the engineering dashboards: usage and cost, provider/model performance, workflow
execution, production health (all services, one service) and the filter options. Each is a read-only SQL read model
over `workflow_runs`, `workflow_step_attempts` (through the `execution_attempt_telemetry` view) and the production
error tables, cached for 30 s per scope and filter set (`CacheAside`, invalidated by writes to those tables).

Before moving anything we profiled both the API and PostgreSQL (`auto_explain`, `EXPLAIN (ANALYZE, BUFFERS)`) on a
generated dataset with the production shape (`test/fixtures/analyticsDataset.ts`). The TypeScript runtime is not
the bottleneck: Node spends a few milliseconds per dashboard. Almost all time is PostgreSQL, and two SQL problems
dominate it:

1. **Production health is quadratic.** `service_trends` joins the materialized `hours` CTE to `incidents`. Both are
   CTEs whose row estimates are far too low (`incidents` with `period='current'` is estimated at 2 rows, actually
   1,500), so the planner nests a full scan of `hours` (~52k rows) inside every incident: 598 loops, **2.7–3.0 s of a
   3.0–3.4 s dashboard** at 1,500 error groups. It grows with groups × observed hours.
2. **Usage runs its cohort four times.** Summary, trend, breakdown and details are four statements, each
   re-materializing the whole `executionCte` (runs → telemetry attempts → provider invocations): 4 × ~420 ms of
   database time and 4 pool connections for one dashboard. Health with engineering filters does the same (up to four
   statements), and a selected service always costs a second statement over the same scans.

A Go rewrite that ran the same SQL would change nothing measurable. The migration is therefore the SQL fixed and
consolidated, placed in the existing `platform-go` service so the dashboards stop competing for the Node pool.

## Decision

### Split: TypeScript keeps the boundary, Go reads

| Stays in TypeScript (`src/api/analytics`) | Moves to `go/internal/analytics` |
|---|---|
| routing, authentication, authorization, filter parsing (400s) | dashboard SQL and its composition (health comparisons, coverage, freshness, service shares) |
| scope derivation (`ownerId` = actor, `all` only for an admin `scope=all`) and the support audit (every read, cache hits included) | defensive re-validation of the filters and scope it receives |
| `CacheAside` (30 s, write invalidation, singleflight), the public envelope (`filters`, `pagination`, `semantics`, `can_manage_incidents`, `generated_at`) | bounded concurrency, request deadline, cancellation |
| incident lifecycle mutation (`updateIncidentLifecycle`), redaction of scan errors (`safeDiagnostics`) | |
| migrations (no schema change in this phase) | |

`loadDashboard` (`src/api/analytics/engine.ts`) calls `POST /internal/v1/analytics/{dashboard}` (contract
`go/contracts/analytics-v1.schema.json`) when the flag is `go`. The scope is computed from the authenticated actor
before the call; Go never reads a user id or support flag from the public request. There is no Go cache: the
TypeScript cache sits in front of both engines, so cache hits, invalidation and the audit are unchanged.

### SQL changes (Go engine)

- **Linear service trends.** `hours` carries its group's normalized namespace/service from `observations` (and the
  split scope flag), so service trends need no join to `incidents`; the incident-status filter is an uncorrelated
  `IN` under `OR` (a hashed subplan). Same rows, no nested CTE rescans.
- **One statement for usage.** The cohort is materialized once; summary, trend, breakdown and details come back as
  four `json` columns (column order preserved, timestamps rendered as `Date.toISOString()`).
- **One statement for a selected service** (health-service, and health with `service`): incidents are built once for
  every service with an `in_scope` flag; the service table and its error-share denominator use all services, the
  rest uses `in_scope` rows. TypeScript runs two statements over the same scans.
- **Narrow projections.** The cohort CTEs select the columns the dashboards read instead of `r.*` / `t.*` / `g.*`,
  so materialized CTEs carry no run inputs, graphs, error samples or details, and unused derived columns of the
  telemetry view (provenance, cost availability, terminal status) are not computed.
- **Exact cost sums.** Costs are summed as `numeric` and rounded to `float8` once. A `float8` sum of decimal costs
  depends on row order: TypeScript returns one of several last-digit variants depending on the plan.
- **Deterministic ties** (both engines): `top_fingerprints` orders by `events DESC NULLS LAST, fingerprint` and linked
  pull requests by id; before, equal counts came back in plan order.
- Options: two statements become one.

No index was added: every dashboard query is bounded by `workflow_runs_owner_created` (member scope) or scans the
date range (support scope), and the remaining time is CTE work, not lookups. No rollup or materialized view either:
with the quadratic step gone, the most expensive dashboard is well under a second at 20,000 runs, which does not
justify a second source of truth with its own freshness problem. Revisit only if the measured statement time grows
past the request deadline at production volume.

### Resources and the connection budget

- Analytics runs on **its own read-only pool** in platform-go (`ANALYTICS_MAX_CONCURRENT`, default 2 connections,
  opened on demand, closed after 1 min idle). Retrieval and indexing keep the shared pool (`DATABASE_POOL_MAX` = 4
  under the supervisor) untouched, so a burst of dashboards cannot starve them. Each statement holds one analytics
  slot; waiting for a slot is bounded by the request deadline and reported as `503 busy`.
- The pool's sessions set `default_transaction_read_only=on` (a write fails in PostgreSQL, `25006`),
  `plan_cache_mode=force_custom_plan` (the catch-all filters `($7 IS NULL OR provider=$7)` must be planned for the
  actual parameters; pgx's prepared statements would otherwise switch to a generic plan after five executions),
  `jit=off` (JIT compilation of these large CTE statements costs more than it saves at dashboard sizes; managed
  PostgreSQL such as RDS enables JIT by default) and `statement_timeout` = `ANALYTICS_TIMEOUT_MS` (the server stops
  the statement even if the client vanished).
- Deadline: `min(X-Request-Timeout-Ms, ANALYTICS_TIMEOUT_MS)` (default 15 s). A client disconnect cancels the Go
  request and pgx cancels the statement in PostgreSQL. Disconnects propagate from the browser: the HTTP layer and the
  analytics cache share a reference-counted signal (`src/http/sharedAbort.ts`), so a load shared by several tabs is
  canceled only when all of them are gone.
- Responses are bounded by the existing pagination (≤ 100 rows per table, `LIMIT` on every list) and the request
  body by 1 MiB.
- Connection budget: Node pool `DATABASE_POOL_MAX` (default 10) + platform-go shared pool 4 + analytics pool 2 = 16
  at most. With `ANALYTICS_ENGINE=go` the Node pool no longer runs dashboard statements at all (TypeScript usage
  held 4 Node connections per dashboard load).

### Fallback

Only availability failures fall back to the TypeScript engine: unreachable, timeout, `503 busy|unavailable`,
`504`, other 5xx, or a response without the dashboard's required fields. A `400` (validation) is raised as a 400 and
`401` (token mismatch) as a 502; neither is ever retried in TypeScript. Fallbacks are bounded and observable:

- at most `analytics.maxFallbackConcurrency` (config, default 2) TypeScript loads at once; more are rejected with 503
  so an outage cannot move the whole dashboard load onto the Node pool;
- after a failure Go is skipped for 10 s (`cool_down`) instead of adding a timeout to every request;
- counters by reason in `GET /api/admin/analytics/engine` (with platform-go's pool and slot statistics) and one log
  line per reason per minute.

### Parity

`test/analytics-go.integration.ts` (CI, fails without Go) compares every dashboard from both engines on the same
database: the analytics fixtures plus a small generated dataset (retries, invalidated and resumed attempts,
multi-repository and repository-less runs, missing tokens, reported zero cost, review sessions, overlapping hourly and
daily scans, failed scans, scans without hourly data, reopened incidents), owner/other-owner/admin-support scopes,
every filter and grouping, pagination beyond the last page, empty ranges, partial-hour and uncovered ranges, and
time zones including the 2026-11-01 America/New_York DST end. Values must be identical (numeric strings, nulls vs
zero, key sets, ordering); JSON numbers may differ by 1e-9 relative (float sums depend on row order in both
engines), and the four fields measured up to `now()` (open waits) by the time between the two reads. It also covers
the contract (requests, every response, errors), redaction on the Go path, no fallback on validation and
authentication errors, bounded fallback and cool-down, Go deadline → fallback, cancellation reaching PostgreSQL,
HTTP owner scope and support audit with Go, and rollback by flag. Go unit tests cover validation, DST boundaries,
node-postgres value mapping, health composition helpers, slots and the read-only pool.

## Results

RESULTS_PLACEHOLDER

## Rollback

Set `ANALYTICS_ENGINE=typescript` (or remove it) and restart. Nothing else: there is no schema change and no cache
or table owned by Go; the TypeScript SQL is unchanged except for the two deterministic tie-breaks. platform-go may
keep running for retrieval or indexing, or be stopped. Rehearsed by the last test of
`test/analytics-go.integration.ts` (same request, both engines, equal responses).

## Consequences and remaining limitations

- Two implementations of the dashboard SQL exist until the phase exit criteria are met (two weeks with the flag on,
  no Go-caused fallbacks); the parity suite keeps them equal. The SQL fixes above could be ported to the TypeScript
  engine if Go is ever rolled back for long; until then the TypeScript path stays the known-good fallback.
- The member-scope `options` user order keeps TypeScript's first-seen order, which PostgreSQL does not define among
  runs of the same workflow; the parity test compares users by id.
- Date-only boundaries in a zone whose midnight falls into a DST gap resolve like TypeScript's `boundaryInstant`
  only where Go's `time.Date` agrees with it (all zones that change at night, not at midnight).
- `ANALYTICS_TIMEOUT_MS` above `REQUEST_TIMEOUT_MAX_MS` is fine: analytics has its own handler deadline and the
  server write timeout is the larger of the two.
- JIT: the effect could not be measured locally (the PostgreSQL build has no LLVM); the setting is a safeguard for
  managed databases.
