# Phase 2 validation

Validated on **2026-11-08**, continuing from latest main **`1b199e8`** fetched from the requested repository. The working tree was clean at the beginning of Phase 2. Phase 1 telemetry, historical migrations, the existing HTTP authentication model, and the old advanced Insights routes were retained.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed for backend, tests, smoke script and web |
| `npm run build` | Passed, Vite production build |
| Full `npm test`, final run | **409 passed, 0 failed, 0 skipped**, 288.19 seconds |
| Focused analytics queries and HTTP/RBAC, after final query refinements | **14 passed, 0 failed** |
| Analytics + existing production-error/locale checks | **31 passed, 0 failed** at that checkpoint |
| Final Playwright browser smoke | All checks passed; no browser page errors |
| `git diff --check` | Passed |

The full suite includes the existing migrations, provider fixtures, engine/scheduler recovery, authentication, caching, production-error scanner, evaluation, and verification tests. Focused analytics tests additionally cover the final scan-histogram and resume/retry refinements made during full-suite execution.

## Deterministic query coverage

The isolated fixture has separate member owners, an administrator, Claude/Codex/Cursor runs, mixed-model invocations, partial usage, missing cost, completed-but-unverified execution, failed execution, labeled timing, and overlapping scan snapshots. Assertions cover:

- Owner isolation, unauthorized HTTP reads, exact dimension filtering across all dashboards, and explicit audited admin team reads including cache hits.
- Provider/model attribution, non-additive repository membership, nullable cost/cache/reasoning, explicit reported zero, completed versus verified tasks, and missing lifecycle timestamps.
- Half-open timezone boundaries, equivalent ISO-offset ranges, 25-hour daylight-saving days, and distinct repeated hourly instants.
- Overlapping production scans, no whole-window count assigned to a partial-hour range, unknown historical histograms, supported operator resolution, and transactional reopen behavior.
- Server pagination with totals on empty pages, bounded filter inputs, peer-based anomaly detection, and explicit resume separated from retry effort.
- New reported hourly histograms without fabricated legacy buckets; malformed histogram points are ignored.

Migration 030 was applied by the normal migration runner in isolated test databases. Existing migration tests also checked additive upgrade and reapplication behavior.

## Browser evidence

`npm run smoke:analytics` starts the actual built application against a fresh isolated PostgreSQL test database. Playwright logs in through the real login form, calls real analytics endpoints, and verifies:

1. All four dashboards render deterministic aggregate data at **1440 px**, with no horizontal page overflow.
2. Applied date/project filters survive tab changes and reloads; Codex-only unreported cost renders `—`, not `$0`.
3. Vietnamese UI at **390 px** has no horizontal page overflow.
4. An unmatched model filter shows the empty state.
5. A deliberately simulated HTTP 503 displays the error state, followed by successful recovery.
6. No browser JavaScript page errors occur.

The screenshots are synthetic fixture evidence, not production data. Filters are collapsed in screenshots to show dashboard content; the smoke test exercises the expanded filter form before capturing them.

- [Production Health](screenshots/health-en-desktop.png)
- [AI Usage & Cost](screenshots/usage-en-desktop.png)
- [Agent Performance](screenshots/performance-en-desktop.png)
- [Workflow Insights](screenshots/workflows-en-desktop.png)
- [Vietnamese mobile usage](screenshots/usage-vi-mobile.png)
- [Smoke results](screenshots/smoke-results.txt)

To reproduce using a local PostgreSQL admin endpoint and installed Chromium:

```bash
npm run typecheck
npm run build
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform npm test
CHROMIUM_BIN=/path/to/chromium \
  TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform \
  npm run smoke:analytics
```

`CHROMIUM_BIN` is optional when the expected Playwright browser is already installed. `ANALYTICS_SCREENSHOTS` can override the screenshot output directory.

Validation used an isolated local PostgreSQL 18.6 cluster on loopback port 55433; repository compose defaults remain unchanged. Browser validation used installed Chromium 156. The temporary database cluster was stopped afterward. No live Splunk search, paid agent call, production lifecycle update, production migration, deployment, Git commit, or remote push was performed. The hourly Splunk query extension is covered by parser/scanner fixtures; its live query load has not been benchmarked against the production Splunk estate.
