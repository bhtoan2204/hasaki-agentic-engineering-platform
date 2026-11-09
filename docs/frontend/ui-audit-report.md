# Frontend UI audit and remediation

Audited fetched main `45c53e25e6f4` (both repository URLs resolve to the same main). The starting workspace was clean. The work changes frontend presentation, layout, focus and scroll handling; no backend logic, database schema, authorization, production error calculations, navigation destinations or API caching implementation changed.

## Method and scope

The browser harness runs the actual built React application against an isolated local HTTP server/PostgreSQL database. Seeded data includes 34 incidents, 13 services, the requested long service/repository names, a long work-item/run title and long knowledge content. It opens 17 routes: Overview; Work Items and detail; Runs and Run View; Workflows and Workflow Studio editor; Knowledge and detail; Repositories and detail; Integrations; Production Errors; Insights; Agent Evaluation; Agent Office; Account.

Before screenshots and measurements were captured across 16 routes on unchanged main in English/light at 1440px and 390px; the after run also adds Knowledge detail and additional long-content fixtures. After verification covers VI/EN × light/dark × six requested viewports, populated/empty/loading/error states, chart geometry, table geometry, filter baselines, keyboard actions, normal/long scrolling, history, sidebar expanded/collapsed, CSS zoom stress and viewport/DPR browser-zoom emulation at 125%/150%. No live external integrations or business mutations are triggered.

Sources inspected include App, shared styles/UI, Production Errors and analytics directories, Insights, Run View, Work Items, Workflows/Workflow Editor, Repositories, Knowledge, Integrations, Account/dialogs, Agent Office/companion styles, theme tokens, tooltip portal and existing browser tests. Cascade inspection was followed by browser measurements; screenshots alone were not treated as proof.

## Issue inventory

No P0 issue was found in the audited scenarios. P0 means blocked interaction/unreadable essential content; P1 means overlap/clipping/broken layout; P2 means consistency/spacing/type; P3 means cosmetic enhancement.

| ID | Severity | Area and cause | Fix and shared owner | Evidence / result |
| --- | --- | --- | --- | --- |
| UI-01 | P1 | Production Overview: broad `.ins .tabs` makes every descendant tab strip sticky; scrolling controls pass beneath it. | Normal analytics tabs remain in flow. Removed inherited sticky positioning and redundant overflow rule. Intentional inspector tabs remain local. | Before/after scrolling captures; static positioning and range-control hit-testing pass. |
| UI-02 | P1 | Refresh inserts/removes a roughly 25px row above data; scroll anchoring changes a restored 650px position to 625px. | Refresh activity occupies the existing `Button` icon slot; no extra row. | History regression now measures **650 → 650**. |
| UI-03 | P1 | App focuses main on every hash change, including every search edit, and shares scroll across unrelated routes. Native history restoration competes with SPA restoration. | Focus only on route changes with `preventScroll`; manual history policy and per-route scroll positions. Query edits preserve input focus. | Typing and browser back checks pass; document stays at scrollY 0. |
| UI-04 | P1 | Top Services: inherited `white-space: nowrap` defeats wrapping, and per-row auto metric tracks shift bar origins. Mobile hides share percentages. | `ServiceVolumeBar`, fixed metric tracks, shrinkable identity, shared `ServiceIdentityCell`; narrow container layout stacks name above bar/count/share. | Ten long-name rows: pairwise rectangle overlap checks, common bar origin and visible shares pass at all six widths. |
| UI-05 | P1 | Donut legend inherits nowrap and primary-button shadow, allowing long names to collide with metrics. | Legend wraps in shrinkable tracks and explicitly removes action-button chrome. | Long-name before/after screenshots; no document/main overflow. |
| UI-06 | P1 | Service table names inherit global primary green buttons; header nowrap and absent numeric metadata produce poor column hierarchy. | Shared transparent `link-button`; consistent identity cell; DataTable align/width/min/max metadata and wrapped headers. | Service links are transparent, focusable and keyboard-navigable; numeric cell right edges align. |
| UI-07 | P1 | Service table tries to expose every column on mobile; initial fixed minimum widths also made the three primary columns 352px wide inside 324px. | Explicit column priorities and accessible Show all metrics toggle. Responsive primary identity width; every optional metric remains revealable in the named scroll region. | Primary mobile table now **324px / 324px**, no horizontal scrolling; revealing all metrics is verified. |
| UI-08 | P2 | Incident toolbar mixes an unlabelled segmented control, selects and search. Search is 39.69px versus 38px selects, with different vertical positions. | `FilterToolbar` / `FilterField`: primary labelled grid and separate secondary row, consistent control line-height and sizing. | All five controls measure **38px**; four desktop selects share y=276.8125px. URL filter behavior is preserved. |
| UI-09 | P2 | Shared control sizes are minimums with inconsistent text metrics; segmented outer height and icon squares use unrelated values. Search inline width requires an important mobile override. | Shared token-backed button/icon sizes and input line-height; segmented 32px child + 6px container = 38px. Search uses shrinkable width/max-width; removed Workflows important override. | XS/SM/MD/LG measure exactly **28/32/38/44px**. |
| UI-10 | P1 | Workflow Studio uses viewport breakpoints despite sidebar and inspector consuming workspace width; at 150% zoom the canvas becomes **45px** wide. | Full workspace supplies inline-size containment; editor responsive rules use container width. | Expanded-sidebar 150% CSS zoom canvas now **1068px**; minimum usable canvas assertion is 240px. |
| UI-11 | P1 | Drawer has no accessible title association/focus containment/restoration, and a constrained workspace could become its fixed-position containing block. | Existing Drawer now portals to body, has an accessible name, traps Tab, handles Escape and restores focus without scrolling. | Desktop/mobile drawer bounds and keyboard checks pass. Existing native dialogs are retained. |
| UI-12 | P1 | Dark theme bright brand buttons use white foreground inherited from light theme. | `--on-brand` foreground token; warning actions use `--on-warning`; theme-specific foreground remains independent of layout. | Primary action contrast measures 6.29:1 light and 7.80:1 dark; all four tested action variants meet 4.5:1. |
| UI-13 | P2 | Interactive stat cards declare role/button/tabIndex but ignore Enter/Space. | Shared `StatCard` keyboard activation. | Native focus remains visible; keyboard activation uses the existing action. |
| UI-14 | P2 | Duplicated `.ins-grid` declarations, superseded service-bar mobile rules, scanner `.pe-opt` overrides split between stylesheets, fallback production colors bypassing status tokens. | Merged grid declaration; replaced obsolete chart rules; consolidated scanner layout in ProdErrors.css; reused status tokens. | No new important/negative-offset/global overflow-hiding fixes. Typecheck/build and browser regressions pass. |

### Reported scrolling gap

An independent large dark/empty region outside the content did **not** reproduce in the baseline at the audited widths. Baseline document height equalled the viewport and main began at y=60px. The concrete reproducible problems were sticky tabs occluding scrolling controls, inherited route positions and the refresh-row scroll shift. Those were fixed. After checks measure stable shell bounds through multiple long-scroll positions and test that range buttons receive pointer hit tests. This report does not assign a speculative cause to an unavailable original screenshot.

## Page audit coverage

| Pages | Findings and treatment |
| --- | --- |
| Overview | Shared control, contrast, keyboard-stat and shrinkable-grid improvements apply. Long page scrolling checked. |
| Work Items / detail | Long titles, responsive side rail, forms and toolbar inspected; no remaining measured P0/P1 overflow. Existing intake/workflow behavior retained. |
| Runs / Run View | Shared control sizes, stat keyboard support, full workspace and local inspector scrolling checked. Transcript/code scroll regions remain intentional. |
| Workflows / Workflow Studio | Search override removed; creation drawer focus/bounds fixed; editor responds to workspace width. |
| Knowledge / detail | Long list/detail content, sticky list and bounded code/content regions checked; no unrelated editor changes. |
| Repositories / detail | Long repository identifier and description checked; shared search, text/control and grid improvements apply. |
| Integrations | Responsive fields and shared action colors/sizes checked; no live connection actions performed. |
| Production Errors | Bars, donut labels, service table, toolbar, tabs, refresh feedback, scrolling and keyboard drilldown fixed and measured. Scanner control behavior remains covered by existing analytics smoke. |
| Insights / Agent Evaluation | Shared DataTable and controls, normal tabs, empty/loading/error/retry states checked. Existing evaluation navigation retained. |
| Agent Office | Scene keeps its own scoped palette and intentional scene/panel scrolling. Theme/responsiveness checked; no scene redesign. |
| Account / settings | Shared controls, native dialogs and responsive page bounds inspected; no account mutation submitted. |

## Shared component and CSS changes

- `ui.tsx`: compatible `Button` variants/sizes/loading, `FilterToolbar`, `FilterField`, flexible SearchInput, explicit Tabs button semantics, stat keyboard activation and drawer portal/focus behavior.
- `components/ServiceVolumeBar.tsx` / `.css`: presentation-only chart row, stable tracks and container-driven stacking.
- `components/ServiceIdentityCell.tsx`: consistent full-value identity presentation for both chart and table.
- `analytics/shared.tsx`: column alignment/dimension/priority metadata, optional-metric reveal toggle, semantic headers and named keyboard-scrollable table region.
- `styles.css`: existing control/spacing scale retained; foreground tokens, control metrics, text-link reset, filter/identity primitives and shrinkable grids. Shell owns viewport height. Existing business-specific CSS remains in its domain.
- Insights/analytics CSS: removed the broad sticky descendant rule and competing tab overflow; wrapped table headers; prioritised-column rules scoped to DataTable.
- Production Errors CSS: removed superseded bar layout, consolidated scanner controls and used existing status colors.
- WorkflowEditor.css: responsive rules now refer to the available full-workspace container.

No heavy dependency or framework migration was introduced. Table formatting remains in DataTable rather than adding speculative Numeric/Percentage/Severity wrappers. Existing call sites keep working while refreshed components demonstrate the new primitives.

## Files modified

`package.json`; `web/src/App.tsx`; `web/src/styles.css`; `web/src/ui.tsx`; `web/src/i18n/analytics.ts`; `web/src/pages/Insights.css`; `ProdErrors.tsx`; `ProdErrors.css`; `WorkflowEditor.css`; `Workflows.css`; `pages/analytics/analytics.css`; `pages/analytics/shared.tsx`; `pages/insights/AnalyticsInsights.tsx`; `pages/prodErrors/ProductionErrorsPage.tsx`; `ProductionOverview.tsx`; `production-errors.css`.

Added `web/src/components/ServiceVolumeBar.tsx`, `ServiceVolumeBar.css`, `ServiceIdentityCell.tsx`, `test/ui-quality.browser.ts`, this report, [UI standards](ui-quality-standards.md), and browser evidence under `docs/validation/ui-quality/`.

## Before / after evidence

Screenshots retain the actual application scroll container; the quality harness does not change layout CSS to produce full-page images.

| Area | Before | After |
| --- | --- | --- |
| Scrolling / chart overlap | [Before scrolled Overview](../validation/ui-quality/before/overview-scrolled.png) | [After scrolled Overview](../validation/ui-quality/after/overview-scrolled.png), [restored scroll](../validation/ui-quality/after/scroll-restored.png) |
| Top Services | [Before long chart labels](../validation/ui-quality/before/overview-scrolled.png) | [Desktop](../validation/ui-quality/after/production-overview-1440.png), [mobile](../validation/ui-quality/after/production-overview-390.png) |
| Service table | [Before desktop](../validation/ui-quality/before/services-1440.png), [mobile](../validation/ui-quality/before/services-390.png) | [After desktop](../validation/ui-quality/after/production-services-1440.png), [mobile](../validation/ui-quality/after/production-services-390.png) |
| Incident filters | [Before desktop](../validation/ui-quality/before/incidents-1440.png), [mobile](../validation/ui-quality/before/incidents-390.png) | [After desktop](../validation/ui-quality/after/production-incidents-1440.png), [mobile](../validation/ui-quality/after/production-incidents-390.png) |
| Dark / Vietnamese | Baseline captures are English/light | [Production VI/dark mobile](../validation/ui-quality/after/production-vi-dark-390.png), [Insights VI/dark](../validation/ui-quality/after/insights-vi-dark-1440.png) |
| Workflow Studio zoom | Before measured canvas width: 45px | [150% expanded-sidebar editor](../validation/ui-quality/after/zoom-1.5-sidebar-false.png) |
| Drawer and states | Existing component audit | [Mobile drawer](../validation/ui-quality/after/workflow-drawer-390.png), [loading](../validation/ui-quality/after/production-loading.png), [empty](../validation/ui-quality/after/empty-table.png), [error](../validation/ui-quality/after/error-state.png) |

All major pages also have desktop/mobile screenshots. Raw evidence: [baseline measurements](../validation/ui-quality/before/measurements.json), [after measurements](../validation/ui-quality/after/measurements.json).

## Automated validation

- Targeted analytics/navigation/localization/SPA/companion tests: **31 passed**.
- Full `npm test`: **496 passed**, zero failed/skipped (approximately 339 seconds).
- `npm run typecheck` and `npm run build`: passed.
- Existing analytics real-browser smoke: passed, including deep links, metrics, filters, scanner controls with simulated external connection, history, empty/error recovery and no refresh flicker.
- `npm run smoke:ui-quality`: real Chromium layout audit with 640 measurement records, including 408 page/theme/language/viewport combinations and targeted geometry/focus/zoom/state regressions; see after measurements for the complete final run.
- `git diff --check`: passed.

Example invocation in this environment:

```bash
CHROMIUM_BIN=/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium npm run smoke:ui-quality
```

`UI_QUALITY_PHASE=before` records baseline evidence without after-only assertions. `UI_QUALITY_FAST=1` is a local diagnostic shortcut that skips the broad page/theme matrix; release validation runs without it.

## Remaining scope and recommendations

No remaining measured P0/P1 defect is known in the audited scenarios. This is not a claim about every possible external payload, browser or workflow state. Existing intentional transcript/code/scene scrolling and graph-resize behavior remain.

Zoom checks use Chromium CSS zoom stress plus viewport/DPR emulation of desktop zoom. They do not operate the browser chrome's zoom menu. Native headed-browser zoom/menu testing, Safari/Firefox and touch-device screen readers remain useful release checks. External integration execution, paid agent runs, production data and real notifications were not exercised.

Future work: apply these documented primitives when touching legacy toolbars; add task-specific long-data fixtures alongside new pages; keep geometry checks in CI; add broader automated accessibility/contrast scanning when justified. Preserve Agent Office's purposeful scene palette and deliberate bounded evidence viewers rather than normalizing them into generic forms.
