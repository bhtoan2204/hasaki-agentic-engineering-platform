# Engineering analytics and agent observability

Phase 2 extends the existing Insights page with four routes. Existing quality, tool, failure, registry, harness evaluation and evaluation comparison views remain available through **Quality, tools & evaluations**. The existing Production Errors and Evaluation pages remain in place.

| Route | Purpose |
| --- | --- |
| `#/insights/health` (default) | Observed production errors, severity, recurring fingerprints, lifecycle coverage and owner-protected evidence |
| `#/insights/usage` | Provider/model/user/workflow/repository/project usage, estimated reported cost, missing metrics and token inspection signals |
| `#/insights/performance` | Completion versus verification, invocation latency, workflow latency, queue/human/tool clocks, failure distributions and tool errors |
| `#/insights/workflows` | Workflow throughput, slow steps, retry/blocked/approval hotspots, context preparation and labeled repository-selection evidence |

All four routes reuse Hasaki tokens, typography, cards, tabs, tables, skeletons, errors, authentication, support mode and the bilingual message dictionary. Applied filters are encoded in the route URL and survive tab changes and reloads. Tables scroll within cards on small screens. Charts use aggregate buckets, native tooltips and an accessible data-table disclosure; missing values are not drawn as zero.

## API and filters

The authenticated read endpoints are `/api/analytics/health`, `/usage`, `/performance`, `/workflows`, and `/options`. For example:

```text
/api/analytics/usage?from=2026-11-01&to=2026-11-03&timezone=Asia/Bangkok&bucket=day&provider=codex&project=OMS&group_by=model&page=1&page_size=25
```

Shared filters: `from`, `to`, `timezone`, `bucket` (`hour`/`day`), `provider`, `model`, `user` (ID), `workflow` (key), `repository`, `project`, and `service`. Dimension filters are exact matches. Usage `group_by` accepts provider/model/user/workflow/repository/project. Details are paginated on the server, with a default of 25 rows, a maximum of 100, and stable ordering. Usage anomaly flags and cohort medians are computed in SQL before pagination. Each detail table retains its total count even on an empty page.

Ranges are half-open **[from, to)**. Date-only boundaries mean local midnight in the requested IANA timezone; ISO timestamps must contain an explicit offset. Daily/hourly buckets use PostgreSQL's timezone-aware `date_trunc`; repeated daylight-saving hours retain distinct instants. Chart labels show the selected timezone's offset. Ranges are bounded to 366 days (a timezone transition can add an hour); hourly charts are limited to 31 days.

Engineering tabs use the same **run-created-at cohort**, then aggregate that cohort's durable attempts and invocations. This includes the cohort's retries, repairs and resumed usage, even if a later invocation is outside the creation interval. Throughput charts show that cohort's completions occurring in the selected interval. This definition is displayed with the filters; these charts are not a provider invoice by billing date. Production Health selects scan windows overlapping the interval instead. Execution dimension filters restrict production groups to linked, accessible runs in the same cohort. Project/service filters also work for shared production data without private run links.

Queries aggregate in PostgreSQL; no raw transcript/event stream is downloaded into the browser. SQL parameters carry all user dimensions and boundaries; grouping expressions are allowlisted. The cache reuses bounded `CacheAside` (200 keys, 30 seconds), keyed by owner, explicit team scope, dashboard and normalized filters. Existing write invalidation and cross-process production-observation notifications are reused; TTL bounds freshness for other remote writes. `generated_at` identifies the cached query result's creation time. Normal refresh respects this cache.

## Ownership and access

Run, attempt, invocation and evaluation data is isolated by owner. Administrators see their own data by default. The existing support-mode `scope=all` is required for team-wide reads and writes an `audit_log` entry before a cached or uncached analytics read. Ownerless legacy runs stay hidden. Existing HTTP singleflight may combine identical concurrent reads of the same actor, as elsewhere in the application.

Production error fingerprints and source counts are shared, matching the existing Production Errors page. Private work items, runs, PRs, repository-change snapshots and verification outcomes are joined only through accessible owners. Filtering by another user's ID does not widen member access. Labeled evaluation evidence is joined through the actual `evaluation_runs.workflow_run_id` and matching owner; the legacy `eval_results.run_id` can refer to another database and is not trusted for authorization.

## Usage, cost and verification

The SQL read model flattens Phase 1 invocation snapshots, preserving each session's original provider and model. Old attempts with no snapshot fall back to their persisted provider fields; no token/model/price reconstruction is attempted. Cost and token sums are **known subtotals**. Entirely unreported metrics remain null, rendered as `—`; explicit reported zero remains zero. Missing counts accompany each usage field. Cache reads, cache writes and optional reasoning tokens are separate counters, with provider-defined subset semantics.

All displayed cost is labeled **provider-reported estimate**, not an invoice. Codex CLI usage under a ChatGPT subscription is not converted into API billing; Cursor's unreported price stays unavailable. Cost per completed run is the known cost of completed runs divided by those runs, with coverage shown. Cost per verified task is the known cost of completed, verified runs divided by distinct non-null linked work-item IDs. Partial coverage can underestimate both ratios and is disclosed alongside them.

A completed run is not automatically verified. Verification requires every current coding step's latest non-invalidated attempt to have a supported harness result or independent review verdict. Independent review takes precedence over a conflicting harness result. Missing/skipped checks remain unknown. Verified success rate uses completed, verified runs over fully evaluated runs, not over all completed runs. The UI also exposes the distinct count of verified tasks.

Repository usage uses **full run membership**, never an invented cost allocation. A run in two repositories contributes to both repository groups, so those groups are explicitly non-additive. Token anomalies require at least five reported input+output observations in the same provider/model cohort and exceed both 10,000 tokens and three times its median. A flag is an investigation aid, not proof of waste or error.

## Timing and workflow semantics

- Agent p50/p95 compares measured **provider invocation** durations from Phase 1; provider/model comparisons retain invocation attribution.
- End-to-end workflow p95 is separately measured from run start to finish. It includes orchestration and human waits.
- Model/provider filters select matching invocations for usage and latency comparisons. Attempt detail clocks remain whole-attempt measurements; they are not apportioned among models.
- Tool elapsed time reuses Phase 1's union of paired tool intervals. Tools overlap provider execution; these values must not be added together.
- Queue and human waits retain nulls when historical clocks were not captured. Averages and percentiles exclude missing values rather than substituting zero.
- Retry metrics count non-first attempts, excluding explicit human/resume attempts identified by the durable input's `pending.resume` checkpoint. Re-executions are retained in engineering effort.
- Blocked-step hotspots include recorded waits or current waiting status. Approval bottlenecks use known human-approval waits. Top-ten hotspot lists are independent of slow-step pagination.
- New attempts measure input/context preparation with a monotonic clock around `buildStepInput` and `resolveContext`, persisted in attempt metrics before provider execution. Historical durations stay unknown.
- Repository selection accuracy uses only actual labeled evaluation `repository_correct` booleans. It remains null with zero labeled observations. Provider switches use ordered invocations with recorded timestamps; no switch is inferred from a model change or final run configuration.

## Production history and lifecycle

Migration **030_engineering_analytics.sql** adds observations keyed by successful scan and fingerprint, explicit incident lifecycle status/timestamps, and an audited lifecycle event ledger. It preserves the latest genuinely retained successful pre-migration observation where available; there is no fabricated historical backfill.

Future Splunk scans retain the existing fingerprint grouping and count behavior, adding reported per-hour counts using `eventstats`. PostgreSQL stores those histogram points with the scan's actual window. For overlapping scans, analytics selects the widest observed coverage for each fingerprint/hour, using the latest scan to break a coverage tie. It does not sum repeated snapshots. Partial hours are counted as partial observations; scan and ingestion gaps remain unknown, not zero. The existing top-300 group cap still applies, so totals are **observed errors**, not a claim to count every event in the production estate.

When hourly history is unavailable, a snapshot's full count is used only if its entire window fits inside the requested range. A narrow subrange never receives a whole-day legacy count. Trend charts stay empty when no real hourly history exists. Coverage reports missing hourly snapshots and partial hours. First/last occurrence timestamps come from observed scans; initial group detection time is retained separately. Recurrence means positive baseline frequency or observations on multiple local dates, not merely duplicate scans.

Resolution is **never inferred from agent success, verification of source code, a completed run, or an open/merged PR**. Administrators can explicitly acknowledge, resolve, or reopen a fingerprint through the authenticated, CSRF-protected endpoint:

```text
POST /api/prod-errors/:fingerprint/lifecycle
{"action":"resolve","evidence":"Production incident INC-123: deployment verified by operator"}
```

Resolution requires an evidence reference/explanation (8–4000 characters). The action, actor, time and redacted evidence are persisted transactionally and audited. Evidence is displayed in incident drill-downs. Repeated identical status requests are idempotent. Scans do not silently change an operator's lifecycle decision. Ignored triage status is separate from resolved status. No external system is updated by this action.

Lifecycle cards show the current supported status of fingerprints observed in the selected interval, rather than claiming each resolution happened inside that interval.

MTTA and MTTR measure initial platform detection (`first_seen_at`) to the recorded acknowledgement or latest currently recorded resolution. They are **not** reconstructed per-episode incident metrics. Unknown or invalid timestamp pairs are excluded and explicitly counted. Reopening retains the event history and clears the current resolution timestamp.

## Migration and operational scope

Apply migration 030 through the existing migration runner before serving the new routes. Historical migrations and Phase 1 storage are unchanged. The owner/created-at index supports the common owner+date cohort predicate; existing owner/id indexes cannot constrain that time range. Fingerprint/scan and fingerprint/event indexes support the observation and lifecycle lookups; no broad transcript indexes were added. No live provider calls, production scan, deployment, push, or remote repository mutation is required for validation.

See [validation results](validation.md) and [browser smoke evidence](screenshots/smoke-results.txt). Screenshots show deterministic, isolated test fixtures, not production data:

- [Production Health, English desktop](screenshots/health-en-desktop.png)
- [AI Usage & Cost, English desktop](screenshots/usage-en-desktop.png)
- [Agent Performance, English desktop](screenshots/performance-en-desktop.png)
- [Workflow Insights, English desktop](screenshots/workflows-en-desktop.png)
- [AI Usage & Cost, Vietnamese mobile](screenshots/usage-vi-mobile.png)
