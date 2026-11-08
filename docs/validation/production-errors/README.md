# Production Errors consolidation

Implemented against latest main `b08a01f23350a98a47162d0e2c7006a4938bc54f`. Both the workspace origin and the requested `hasaki-agentic-engineering-platform` repository URL were fetched and resolved to this commit, newer than the request's `fa4730b08e38`.

## Files and organization

- Moved `pages/insights/HealthDashboard.tsx` to `pages/prodErrors/ProductionOverview.tsx`; the Services route uses the same chart and service breakdown implementations with a services-only presentation.
- Moved `ServiceDetails.tsx` and `ProductionIncident.tsx` from Insights to `pages/prodErrors/`.
- Added `prodErrors/ProductionErrorsPage.tsx`, `routes.ts`, and `production-errors.css`. Production-specific dashboard styles now live in this domain stylesheet.
- Moved genuinely shared `shared.tsx`, `AnalyticsFilters.tsx`, and `analytics.css` to `pages/analytics/`; updated consumer imports, including evaluation components.
- Modified `App.tsx`, `Insights.tsx`, `ProdErrors.tsx`, and `insights/AnalyticsInsights.tsx` for routing, workspace navigation, operational filters, and scanner separation.
- Updated `i18n/analytics.ts`, `catalog.ts`, and `messages.ts` for VI/EN workspace and filter labels.
- Added `test/production-navigation.test.ts`; extended `test/analytics.smoke.ts`; updated the Insights destination in `test/spa-verification.browser.ts`.

## Navigation and compatibility

| Destination | Route |
| --- | --- |
| Overview (default) | `#/prod-errors` or `#/prod-errors/overview` |
| Operational incident list | `#/prod-errors/incidents` |
| Service comparisons | `#/prod-errors/services` |
| Service details | `#/prod-errors/service?namespace=...&service=...` |
| Historical incident details | `#/prod-errors/incident/:fingerprint` |
| Scan & Settings | `#/prod-errors/settings` |
| Insights default | `#/insights` → Usage & Cost content |

All Production Errors child routes select Production Errors in the global sidebar. Insights primary tabs are Usage & Cost, Agent Performance, and Workflow Analytics. Existing Agent Evaluation and advanced quality navigation remain available.

| Legacy URL | New behavior |
| --- | --- |
| `#/insights/health?...` | Replaces the history entry with `#/prod-errors/overview?...` |
| `#/insights/health?view=service&...` | Replaces the history entry with `#/prod-errors/service?view=service&...` |
| `#/prod-errors/:fingerprint` | Maps to historical incident details within the Production Errors workspace |
| `#/prod-errors/incident/:fingerprint` | Continues to open incident details |

Legacy redirect queries are preserved verbatim. Service details carry `return_query` and `return_tab`; incident details carry a validated `return_to`. Return links accept only known internal Production Errors pages, including translated legacy Health destinations. Routing preserves embedded question marks in query values. Browser back/forward is verified.

Analytics filters retain URL state and never start a Splunk scan. Operational filters use separate `list_*` parameters for namespace, service, severity, lifecycle status, ignored groups, and search. Scan configuration retains its existing local preferences and independent time range. Historical incident pages link back to the operational interface using `list_focus`.

## Functionality and data

All ten existing comparison KPIs remain: total error events, unique fingerprints, new incidents, active incidents, resolved incidents, critical/high incidents, recurring incidents, affected services, mean time to acknowledge, and mean time to resolve.

All seven existing chart implementations remain: Errors by Service donut, Top Services bars, Error Volume Trend, Severity Distribution, Service Error Trends, Incident Lifecycle, and AI Remediation Outcomes. Service comparison tables, error shares, top fingerprints, incident history, related work items/runs/PRs, freshness indicators, and observation coverage warnings remain available.

The operational interface retains inspection, Splunk evidence/query copying, ignore/unignore, investigation/work item creation, attach/unlink, and run/PR references. Scanner controls and schedule/notifications are under Scan & Settings. Older scan records with missing namespace metadata render safely.

No backend, SQL, database migration, endpoint, cache, or authorization implementation changed. Existing `/api/analytics/health`, `/api/analytics/health-service`, `/api/prod-errors`, and incident endpoints remain unchanged. Error Share remains service observed events / total observed events × 100, not request failure rate. Coverage, deduplication, unknown attribution, missing data, historical fingerprints, and owner-scoped links retain existing semantics.

## Validation

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Initial targeted analytics baseline: 17/17 passed before frontend changes.
- Targeted analytics/navigation tests: 19/19 passed after migration.
- Expanded targeted analytics/navigation/production errors/localization tests: 38/38 passed.
- `npm test`: 496 passed, zero failed/skipped; approximately 350 seconds.
- `npm run smoke:analytics` with installed Chromium: see [browser results](smoke-results.txt).
- `git diff --check`: passed.

Deterministic API comparison ran latest main from an isolated detached worktree and the refactored workspace against separate seeded PostgreSQL databases. Scan timestamps were fixed, and only `generated_at` was excluded. Five response scenarios were compared: all services, service detail, high severity, alternate timezone, and missing service. Complete normalized responses were byte-for-byte identical (50,030 bytes):

```text
main:     e45bcf9449df2d65cbc12db71355acf217162cd3d988f154322e83c2abeff1d3
refactor: e45bcf9449df2d65cbc12db71355acf217162cd3d988f154322e83c2abeff1d3
```

The browser test uses the real application, HTTP server, isolated fixtures, and PostgreSQL. It checks legacy routes, sidebar selection, URL filters, chart/service/fingerprint drilldowns, browser history, evaluation/quality navigation, empty/error recovery, one service-detail request, reuse of health data between Overview/Services, and retaining metrics during refresh. All six production views are checked in VI and EN at 1440, 1280, 1024, 768, and 390px with no document or application scroll-area overflow. Scan time-window buttons wrap within their card on mobile.

The default Playwright binary lacked shared libraries in this environment; verification used:

```bash
CHROMIUM_BIN=/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium npm run smoke:analytics
```

## Screenshots

| View | English | Vietnamese | Mobile |
| --- | --- | --- | --- |
| Overview | [EN](overview-en.png) | [VI](overview-vi.png) | [EN](overview-en-mobile.png), [VI](overview-vi-mobile.png) |
| Incidents (expanded operational evidence/actions) | [EN](incidents-en.png) | [VI](incidents-vi.png) | [EN](incidents-en-mobile.png), [VI](incidents-vi-mobile.png) |
| Services | [EN](services-en.png) | [VI](services-vi.png) | [EN](services-en-mobile.png), [VI](services-vi-mobile.png) |
| Service Details | [EN](service-en.png) | [VI](service-vi.png) | [EN](service-en-mobile.png), [VI](service-vi-mobile.png) |
| Incident Details | [EN](incident-en.png) | [VI](incident-vi.png) | [EN](incident-en-mobile.png), [VI](incident-vi-mobile.png) |
| Scan & Settings | [EN](settings-en.png) | [VI](settings-vi.png) | [EN](settings-en-mobile.png), [VI](settings-vi-mobile.png) |
| Scan controls (simulated connection) | [EN](scan-controls-en.png) | [VI](scan-controls-vi.png) | [EN](scan-controls-en-mobile.png), [VI](scan-controls-vi-mobile.png) |
| Updated Insights | [Usage](insights-usage-en.png), [Performance](insights-performance-en.png), [Workflows](insights-workflows-en.png) | [Workflows VI](insights-workflows-vi.png) | — |

[Scanner progress (simulated)](scan-progress-en.png).

## Limitations

No external Splunk scan or real notification delivery was started. Scanner control submission/progress was exercised with a simulated connected response; analytics, incidents, schedules display, routes, and database-backed metrics used the real local backend. Existing backend operational tests cover scan configuration, persistence, and incident actions. The broad companion SPA browser script was updated for the new Insights destination but was not separately run; the focused analytics browser suite exercised the actual application shell.
