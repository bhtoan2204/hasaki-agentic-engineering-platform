# Unified execution telemetry (Phase 1)

The existing PostgreSQL attempts, transcript events, metrics endpoints, and Insights UI remain in use. Migration `029_unified_telemetry.sql` adds lifecycle clock columns and a canonical `execution_attempt_telemetry` view. Apply it through the normal application migration runner; no manual usage backfill or pricing configuration is required. PostgreSQL 14+ supports the interval union used by the view (the repository uses PostgreSQL 17).

## Storage and integrity

`workflow_step_attempts.metrics.provider_sessions` contains invocation snapshots keyed by a generated ID. A resumed session is a new invocation within its executing attempt; recovery creates a new attempt and does not copy prior usage. A fallback after failed resume has its own invocation. Each snapshot retains its original provider, resolved model, usage, completion marker, duration, cost provenance, and redacted failure diagnostics. Auxiliary ranking/advisor snapshots use stable `aux:<purpose>:<completion-id>` keys; text-only report completions use `executor:<completion-id>`. Distinct completions have distinct IDs; repeated persistence of a completion replaces its snapshot. These helpers write snapshots, not increments.

Writes merge session keys, replace the same snapshot, retry transient database errors, and check the attempt status, fencing token, and live job lease. Repeating a write does not add usage twice. Canceled or recovered attempts reject late writers. Claude result UUIDs are deduplicated within the collector. Partial invocations are recorded before launch; result events checkpoint reported usage before finalization. Abrupt worker loss can leave an incomplete snapshot: unreceived or unpersisted usage stays unknown. Finalization records current partial data even when a provider throws or is canceled.

Provider result usage describes the invocation, not the lifetime of the resumed thread. Cached reads and creations remain separate fields; reasoning usage is optional. Counts preserve provider semantics: cached input can be a subset of input and reasoning can be a subset of output. Do not sum these counters into a synthetic total. Codex parser fields are nullable individually. Cursor usage stays unavailable. No token or price estimator is introduced. A mixed-model attempt has a null canonical model; the session records and model aggregates retain each model.

## API

`GET /api/metrics/runs/:id` adds `telemetry.attempts`, `telemetry.totals`, `telemetry.by_step`, `telemetry.by_provider`, `telemetry.by_model`, and `telemetry.daily`.

`GET /api/metrics/summary?days=30` adds the same aggregates under `telemetry` (without raw attempts). Days are bounded to 1–366. Daily buckets use UTC and attempt start dates. Provider/model usage groups use invocation attribution; their `attempts` count is the number of contributing invocation records, including auxiliary calls. Attempt/step/daily totals count durable attempt records.

Every numeric aggregate is a known subtotal, or null if no values were reported. `coverage.<field>` includes reported attempts, missing attempts, partially reported attempts, and missing invocation fields. An explicit provider-reported zero is a value. Missing data is never evidence of zero usage. Cost is the provider's reported estimate, not an invoice: `cost_source` is `provider_reported` or `unavailable`; `cost_availability` is `reported`, `partial`, or `unavailable`. `provenance` distinguishes measured clocks from provider-reported usage and estimated cost. No local cost estimates are mixed into this field.

Failure distributions and nearest-rank p50/p95/p99 wall latency are included with each aggregate. Raw diagnostics are redacted with the shared credential redactor plus provider token masking and limited to 4 KB. They are retained in owner-protected attempt session snapshots, not aggregate responses. Structured failure codes take priority over diagnostic text. A timeout is `EXECUTION_TIMEOUT`, never sufficient evidence of `QUOTA_EXHAUSTED`. The taxonomy is independent of existing retry policy and does not change execution decisions.

Routes retain owner checks and owner-keyed caches. Admins must explicitly request `scope=all`; each team-wide metrics summary request is audited, including cached responses. Run-level support reads use the existing audited `requireRun` path. Ownerless legacy runs stay hidden through HTTP until explicitly claimed.

## Duration semantics

- `queue_duration_ms`: job availability/creation to attempt start, captured at insertion so recovery cannot rewrite history. Includes contention after availability, excludes configured retry delay.
- `provider_execution_ms`: sum of measured elapsed invocation intervals, including CLI startup, provider time, and tools inside that invocation. Missing for old records and external collectors without a clock. Auxiliary completions measure their invocation elapsed time.
- `tool_execution_ms`: union of paired transcript tool start/result intervals. Overlapping tools and repeated matching result events do not multiply elapsed time. Unpaired or unreported tools remain unavailable; event timestamps have write-time granularity.
- `human_wait_ms`: entry into waiting to resolution, cancellation, or now. New lifecycle columns preserve this interval when approval changes `finished_at`.
- `wall_duration_ms`: attempt start to final resolution, cancellation, or now. Includes human wait, excludes pre-start queueing. Parallel attempts overlap; summed attempt wall time is not run wall time.

Provider and tool time overlap; never add them together or add them to wall time. Queue, machine activity, and human waiting have different boundaries. Latency includes observed/in-progress attempt wall time and can change until resolution. Legacy `claude_ms` fields remain compatibility aliases for historical all-provider duration; new consumers should use canonical telemetry. Legacy usage totals now remain null when nothing was reported; known subtotals remain compatible with Insights. Canonical totals and coverage are authoritative for partial telemetry.

Historical timestamps and JSON remain untouched. Queue and resolved human intervals not originally captured are unavailable in the canonical view. Old SDK-default model labels cannot be reconstructed; new resolved models are captured from provider init events where available. There is no dashboard change in this phase.

## Validation

Run `npm run typecheck`, `npm run build`, and `npm test`. Tests need an isolated local PostgreSQL admin connection; override `TEST_DATABASE_ADMIN_URL` when the compose port 55432 is unavailable. Added coverage exercises nullable usage, replayed results, all failure categories, redaction, three-provider attribution, partial multi-model sessions, migration idempotence, stale writers, recovery, cancellation, and explicit audited admin access.

## Audit notes

- `src/agent/metrics.ts`: initial zero usage and absent-result defaults concealed missing reporting. Nullable counters now add only finite nonnegative reported fields; SDK UUID replay is ignored.
- `src/agent/provider.ts`: persisted run provider and default-to-Claude compatibility remain the routing authority.
- `src/agent/claude.ts`: resume fallback, verification repair, and independent-review loops share an attempt. Each provider invocation now has a separate snapshot; telemetry persistence failures are logged and do not change the execution result.
- `src/agent/codex/`: optional fields previously became zero in the stream parser; text completions also initialized fabricated usage. Both collectors now preserve unknowns. Tool IDs include invocation identity and replayed item/turn events are ignored.
- `src/agent/cursor/`: direct metric writes were overwritten by the shared executor. The shared collector now retains each invocation's tools, failures, model, and session count while keeping cost/tokens unavailable.
- `src/workflow/engine.ts` and `scheduler.ts`: durable attempts already separate retries and recovery; scheduler lease/fencing behavior is retained. Metric writes now use the same live attempt/job fencing constraints. Failure categorization is observational and does not replace retry decisions.
- Migration `007_attempt_metrics.sql` and subsequent profile/provider/auth/worker migrations remain unchanged. Migration 029 adds clocks and a read model over those records.
- Existing Insights APIs and `web/src/pages/Insights.tsx`: existing response keys remain; canonical aggregates are additive. Legacy usage sums now expose null for entirely missing data. The existing UI is retained without a new dashboard.
