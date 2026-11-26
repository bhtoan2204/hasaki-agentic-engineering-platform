# Production health analytics validation

The screenshots and browser smoke results in this directory were generated from the SPA backed by the existing PostgreSQL production-error tables and deterministic analytics fixtures. No dashboard metric is hardcoded.

## Metric definitions

- **Error events**: sum the observed hourly counts for each fingerprint and hour. When overlapping scan windows observe the same fingerprint/hour, use the scan covering the widest part of that hour, then the greatest scan ID as a stable tie-break. For legacy observations without hourly counts, use the most recent complete observation in the selected range; never spread its total across invented hours.
- **Service identity**: `(namespace, service)`, with missing values grouped as `unknown`. The Splunk source is kept separate from application service attribution.
- **Service share**: `service observed events / all observed events in the same selected scope with the service filter removed × 100`. Namespace, environment, severity, status, project, and other filters still apply. It describes the distribution of observed errors, not a request failure rate.
- **Unique fingerprints**: distinct observed fingerprints in the selected range. New means `first_seen_at` is in `[from,to)`. Recurring means a nonzero comparison baseline or observations spanning more than one local date.
- **Period comparisons**: use the immediately preceding half-open range with the same elapsed duration and timezone interpretation. Null remains null when event history is unavailable. A zero event count is reported only when scan windows cover the selected time range; partial periods show unknown when no errors were observed.
- **Coverage**: successful scan windows are clipped to the selected range and unioned before calculating observed time, so overlapping scans do not inflate coverage. A partial/stale indicator and differing-coverage warning qualify comparisons.
- **Lifecycle**: explicit operator statuses are mutually exclusive. Reopened and recurring are separate signals. Mean acknowledge/resolve time uses only groups with valid lifecycle timestamps; absent timestamps are excluded and remain visible in missing-metric counts.
- **AI remediation**: links, completed runs, verified runs, and created PRs are evidence counts. A created PR or agent success is never a production resolution. Merged PRs are unavailable because the current PR integration has no reliable merge state.

## API and access

- `GET /api/analytics/health`: owner-scoped summary, comparisons, service aggregates, time series, severity, lifecycle, fingerprints, remediation, coverage, and paginated incidents.
- `GET /api/analytics/health-service`: the same server-side filters, restricted to the selected service and namespace, with service history and incident drilldown data.
- `GET /api/analytics/options`: configured production environments, namespaces, services, and filter dimensions.
- `GET /api/prod-errors/:fingerprint`: bounded observation history and lifecycle evidence. Work items, runs, and PRs are removed when the incident's work item is outside the authenticated owner's scope.

Support-wide analytics continues to use the existing explicit `scope=all` admin access and audit log. Query inputs are validated and PostgreSQL aggregation is parameterized.

## Query plan and index

On an isolated PostgreSQL database populated with 25,009 hourly scan rows, `EXPLAIN (ANALYZE, BUFFERS)` for the selected-window overlap query measured:

| Plan | Execution | Buffers | Rows |
|---|---:|---:|---:|
| Sequential scan | 1.621 ms | 309 hits | 48 |
| Partial `window_end` index scan | 0.053 ms | 3 hits + 3 reads | 48 |

The partial index `prod_error_scans_window_end_ok` was added in migration 037. It supports the existing overlap predicates on successful scans; no observation/history rows were deleted or rewritten. The experiment used an ephemeral test database and the index was compared before and after on that same fixture.

## Browser evidence

- [Dashboard overview (English)](./01-dashboard-overview-en.png)
- [Errors by service](./02-errors-by-service-en.png)
- [Service details](./03-service-details-en.png)
- [Incident drilldown](./04-incident-drilldown-en.png)
- [Vietnamese dashboard](./05-dashboard-overview-vi.png)
- [English dashboard](./06-dashboard-overview-en.png)
- [Narrow viewport dashboard](./07-dashboard-overview-mobile.png)
- [Dark theme dashboard](./08-dashboard-overview-dark.png)
- [Smoke test results](./smoke-results.txt)

Browser checks covered existing Insights tabs, service and incident navigation, 390 px width, dark/light themes, URL filters across tabs, missing-cost presentation, empty results, and recovery from a simulated 503. The smoke browser used the installed Nix Chromium wrapper.

## Known data limits

- Production errors are available only for stored Splunk scan windows. Gaps are not reconstructed from current fingerprint counters.
- Older rows created before hourly observation capture support fingerprint-level totals but cannot provide a fabricated hourly trend.
- Namespace is the scanner's available environment grouping. There is no separate environment column in the existing schema, so this endpoint exposes the configured `production` scope.
- The schema does not reliably record PR merge state or prove that a production deployment resolved a fingerprint.
- Time coverage measures the union of successful scan windows; it cannot prove that every configured namespace was included in each scan if a scan recorded no namespace list.
