# UI checklist audit (§12)

Audit of the web UI against `docs/frontend/ui-quality-standards.md` §12 (11 items) and §1–§11. The audit pass itself changed no application file; the fixes listed under _Remediation status_ were made afterwards. **Static pass only**: the headless Chromium in this environment cannot start (missing system libraries, no root), so nothing was rendered, measured or screenshotted. Every layout, overflow, sticky and contrast statement below comes from reading code and CSS, and says so where it matters.

Method: five reviewers each read an assigned set of files line by line against the checklist, backed by grep patterns (`<button` without `type`, `onClick` on non-buttons, `space-between`, `!important`, hex colours, `title=` near `disabled`, literal JSX text). The lead spot-checked high-severity findings against the code (`Dialog.css:1`, `childWorkflows.tsx:126`, `Investigations.tsx:227/595`, `Chat.tsx:1924/1978`) and ran a script that compares every literal `t("…")` key with the vi and en catalogs. Findings keep the reviewer's original ID in brackets, e.g. `UI-033 (G2-007)`.

## 1. Summary

- **Routes audited statically: all 17 route families plus the login screen** (table below). Audited dynamically: **0**.
- **126 findings: 9 high, 55 medium, 62 low.**
- Positive checks: `Drawer` (name, Escape, focus restore), Login/Account/Users forms (labels, busy state, explicit types), the Account menu and a global `:focus-visible` rule are compliant. Mutations that go through `act()` are protected against a second press of the _same_ button.

### Findings per checklist item and severity

| Checklist item | high | medium | low | total |
| -------------- | ---- | ------ | --- | ----- |
| 1              | 0    | 2      | 4   | 6     |
| 2              | 0    | 0      | 1   | 1     |
| 3              | 0    | 7      | 6   | 13    |
| 4              | 0    | 0      | 4   | 4     |
| 5              | 0    | 10     | 2   | 12    |
| 6              | 2    | 7      | 3   | 12    |
| 7              | 0    | 6      | 25  | 31    |
| 8              | 0    | 4      | 4   | 8     |
| 9              | 7    | 11     | 7   | 25    |
| 10             | 0    | 6      | 2   | 8     |
| 11             | 0    | 2      | 3   | 5     |
| §11            | 0    | 0      | 1   | 1     |
| **all**        | 9    | 55     | 62  | 126   |

(Items 1–11 are the §12 checklist numbers; `§11` is a React-structure rule outside the checklist. Findings with several items are counted under their first.)

### The 10 most valuable fixes

1. **Fix the stray `c` in `Dialog.css:1`** (UI-079, G4-002). `c.ui-dialog.dialog` never matches, so the sizing/overflow rule for every dialog is dead. One-character fix, shared.
2. **Add `type="button"` to every native button** (UI-004, UI-038, UI-071, UI-078, UI-113): 30+ files. Prefer moving call sites to `Button`.
3. **Give icon-only controls an accessible name**: Chat Copy, Regenerate and composer "advanced" toggle (UI-001, G1-001); WorkflowEditor Validate/Save draft collapse to icons below a 1280 px container (UI-053, G3-003).
4. **Chat modals** (UI-002, G1-002): two hand-rolled `.chat-modal` dialogs lack Escape, focus handling, portal and (one) an accessible name. Reuse `Drawer` or `dialog`.
5. **Child workflow cards** (UI-033, G2-007): Enter on the inner Start/Cancel buttons bubbles to the card's `role="link"` handler and navigates away.
6. **Keyboard access to clickable rows and links**: Investigations history `<tr onClick>` (UI-034, G2-008), the same `tr.click` pattern in Runs/Questions/Changes (UI-010), and the Insights run link `<a onClick>` without `href` (UI-098, G5-001).
7. **Report evidence upload** (UI-003, G1-003): `display:none` file input, so keyboards cannot attach files.
8. **WorkflowEditor double submit** (UI-051, UI-052): Publish/Save draft lose their busy state after `validate`; the three launch buttons can each create a run.
9. **Disabled controls with no visible reason** (UI-005, UI-006, UI-030, UI-057, UI-087, UI-105): about 12 groups across 15+ files. One small shared pattern (hint text + `aria-describedby`) fixes them.
10. **Missing translation keys and hard-coded copy**: `an.in` and `an.time` exist in neither locale (UI-100, G5-003 — rendered as the raw key); hard-coded strings in 20+ files (UI-007, UI-045, UI-063, UI-086).

## 2. Coverage table

Routes come from the `switch (section)` in `web/src/App.tsx:285–374`. "Dynamic" is impossible here (see §5), so every row is **static**.

| Route                              | File                                                                                                                                                                         | Audited | Notes                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (login, signed out)                | `pages/Login.tsx`, `Auth.css`                                                                                                                                                | static  | G1                                                                                                                                                                                          |
| `#/overview` (default)             | `pages/Overview.tsx`, `OverviewTimesheet.tsx`, `Overview.css`                                                                                                                | static  | G1                                                                                                                                                                                          |
| `#/work-items`, `#/work-items/:id` | `pages/WorkItems.tsx`, `Intake.tsx` (queue embedded), `WorkItems.css`, `Intake.css`                                                                                          | static  | G1; detail is the reference                                                                                                                                                                 |
| `#/runs`                           | `pages/Runs.tsx`, `Runs.css`                                                                                                                                                 | static  | G1                                                                                                                                                                                          |
| `#/runs/:id[/:step]`               | `pages/RunView.tsx`, `StepInspector.tsx`, `Transcript.tsx`, `TraceExplorer.tsx`, `Changes.tsx`, `Report.tsx`, `ExecutionCards.tsx`, `childWorkflows.tsx`, `ScanProgress.tsx` | static  | G1/G2; StepInspector lines ~1260–2270 and Transcript 1–230 only skimmed                                                                                                                     |
| `#/questions`                      | `pages/Questions.tsx`, `Questions.css`                                                                                                                                       | static  | G1                                                                                                                                                                                          |
| `#/workflows`                      | `pages/Workflows.tsx`, `Workflows.css`                                                                                                                                       | static  | G3                                                                                                                                                                                          |
| `#/workflows/:key`                 | `pages/WorkflowEditor.tsx`, `WorkflowEditor.css`                                                                                                                             | static  | G3                                                                                                                                                                                          |
| `#/knowledge[/…]`                  | `pages/Knowledge.tsx`, `KnowledgeProposals.tsx`, `Knowledge.css`                                                                                                             | static  | G3                                                                                                                                                                                          |
| `#/repositories[/:name]`           | `pages/Repositories.tsx`, `RepositoryAccess.tsx`, `RepositoryWorkspace.tsx`, `ProfilePreview.tsx`, `Repositories.css`                                                        | static  | G3/G1                                                                                                                                                                                       |
| `#/prod-errors/*`                  | `pages/prodErrors/**`, `ProdErrors.tsx`, `ProdErrors.css`, `analytics/**`                                                                                                    | static  | G5; ProdErrors.css 118–290, 460–540 skimmed                                                                                                                                                 |
| `#/investigations[/:id]`           | `pages/Investigations.tsx`, `Investigations.css`                                                                                                                             | static  | G2                                                                                                                                                                                          |
| `#/integrations`                   | `pages/Integrations.tsx`, `Integrations.css`                                                                                                                                 | static  | G4                                                                                                                                                                                          |
| `#/settings` (admin)               | `pages/Settings.tsx`, `AgentSettings.tsx`, `AutonomyPolicies.tsx`, `AgentIsolation.tsx`, `Settings.css`                                                                      | static  | G4/G1                                                                                                                                                                                       |
| `#/insights/*`                     | `pages/Insights.tsx`, `insights/**`, `Insights.css`                                                                                                                          | static  | G5; `autonomy`, `learning` → `AutonomyInsights`, `LearningInsights` (G4); `evaluation` → `AgentEvaluation`/`EvaluationBenchmarks` (G5/G2); `/insights/health` redirects to `/prod-errors/*` |
| `#/users` (admin)                  | `pages/Users.tsx`                                                                                                                                                            | static  | G1                                                                                                                                                                                          |
| `#/account[/password]`             | `pages/Account.tsx`, `shell-account.css`                                                                                                                                     | static  | G1                                                                                                                                                                                          |
| `#/office`                         | `office/**`                                                                                                                                                                  | static  | G4; scene palette, animation and pixel art intentionally not audited (accepted exception in `docs/frontend/ui-audit-report.md`)                                                             |
| `#/chat[/:id]`                     | `pages/Chat.tsx`, `ChatDelegations.tsx`, `ChatImportReview.tsx`, `Chat.css`                                                                                                  | static  | G1                                                                                                                                                                                          |
| Shell                              | `App.tsx`, `styles.css` (read for context), `Dialog.tsx/.css`, `dialog/**`, `ui.tsx`, `components/**`                                                                        | static  | G1/G4                                                                                                                                                                                       |

Not audited at all: `web/dist`, `node_modules`, generated files, and the server. Chat helper modules (`chatStream.ts`, `chatOperationBatch.ts`, `chatOptimistic.ts`) hold logic only.

**Existing UI smoke coverage (item 11).** `test/ui-quality.browser.ts` covers 17 routes (overview, work-items, work-item detail, runs, run view, workflows, workflow editor, knowledge, knowledge detail, repositories, repository detail, integrations, production overview, insights usage, evaluation, office, account). Not covered by it: login, questions, chat, investigations, users, settings, the other prod-errors tabs, and the other insights tabs. See UI-014, UI-050, UI-076, UI-097, UI-121.

## 3. Findings

Severity: high = users blocked, data loss risk, double submit, inaccessible; medium = confusing or inconsistent; low = polish. "Scope: shared" means the fix touches a shared component or stylesheet.

## Group 1 — Chat, Work Items, Questions, Intake, Runs, Changes, Report, Overview, Login/Account/Users, App shell

### UI-001 (G1-001) | item 9 | severity high | Chat, WorkItems

- `pages/Chat.tsx:617-624` (assistant bubble Copy and Regenerate), `pages/Chat.tsx:1723-1733` (composer "advanced" toggle), `pages/WorkItems.tsx:909-915` (run summary refresh)
- Problem: icon-only buttons have no accessible name (Chat x3: no `aria-label`, no `title`) or only a `title` (WorkItems). DESIGN.md and §2/§8 require an accessible name on icon-only controls. Screen-reader and voice users cannot tell Copy from Regenerate.
- Evidence:

```
<button className="ghost xs" onClick={() => actions.copy(m.content)}><Copy size={14} /></button>
<button className="ghost xs" onClick={() => actions.regenerate(m.turn_id!)}><RefreshCw size={14} /></button>
<button className={`ghost sm${advanced ? " on" : ""}`} aria-expanded={advanced}><Settings2 .../><ChevronRight .../></button>
```

- Fix: add `aria-label` (keys `chat.copy`/`chat.regenerate` or existing copy strings; `chat.provider`/`chat.advanced` for the toggle). `ui.tsx` `Button` with `icon` plus `aria-label` also works.
- Scope: local

### UI-002 (G1-002) | item 9 (§8) | severity high | Chat

- `pages/Chat.tsx:1923-1975` (memory modal), `pages/Chat.tsx:1977-2003` (delegation preview modal), `pages/Chat.css:629-648` (`.chat-modal`, `.chat-modal-card`)
- Problem: two hand-rolled `role="dialog" aria-modal="true"` overlays. There is no Escape handler (only the list menu has one, Chat.tsx:1237), no focus move into the dialog, no focus trap or restoration, and no portal; the preview dialog has no accessible name at all (`aria-label`/`aria-labelledby` missing). §8: drawers/dialogs need a name, focus containment, Escape and focus restoration. The page already has `Drawer` and a native-dialog `dialog` service.
- Evidence:

```
<div className="chat-modal" role="dialog" aria-modal="true" aria-label={t("chat.memory")}>
...
<div className="chat-modal" role="dialog" aria-modal="true">   // preview: no name
```

- Fix: render both with `Drawer` (title `t("chat.memory")` / `t("chat.preview")`) or the existing `Dialog` component (`web/src/Dialog.tsx`, used by Account/Users), and delete `.chat-modal*` CSS.
- Scope: local

### UI-003 (G1-003) | item 9 | severity high | Report (embedded in StepInspector)

- `pages/Report.tsx:119-143` (`EvidenceAdder`)
- Problem: the file upload is a native `<input type="file">` hidden with `style={{ display: "none" }}` inside a `<label>`. A `display:none` input cannot receive keyboard focus, so a keyboard-only user cannot attach evidence; the visible `.rp-upload` span is not a control.
- Evidence:

```
<label className="small" style={{ cursor: "pointer" }}>
  <input type="file" ... style={{ display: "none" }} disabled={busy} .../>
  <span className="rp-upload"><Upload size={12} /> {t("rp.upload")}</span>
```

- Fix: use a real `<button type="button" className="ghost xs">` that calls `inputRef.current?.click()` (the pattern Chat.tsx:1755-1767 already uses with `hidden`), keeping the input `hidden`.
- Scope: local

### UI-004 (G1-004) | item 9 (§8) | severity medium | Chat, ChatImportReview, WorkItems, Questions, Report, Users, Changes

- Problem: `<button>` without `type` (90 occurrences across the audited files, found by a script that parses each `<button ...>` tag; Chat ~36, WorkItems ~22, Questions 6, App 5, Users 4, Account 4, Report 4, Changes 4, Intake 4, Login 2, ChatImportReview 2, Runs 1, RepositoryWorkspace 1). §8 and checklist 9 require an explicit type. No live bug today because every button inside a `<form>` already declares a type, but any future wrapping in a form submits it. `ui.tsx` `Button` defaults to `type="button"` and `loading`, and is used 0 times in these files.
- Evidence: e.g. `pages/Chat.tsx:399 <button className="sm" onClick={() => onDecide(op.id, "confirm")}`, `pages/Runs.tsx:254 <button disabled={!wf} onClick=...>`, `pages/Questions.tsx:162`.
- Fix: add `type="button"` (or migrate to `Button`). Consider an ESLint `react/button-has-type` rule to stop regressions.
- Scope: shared (pattern; all pages)

### UI-005 (G1-005) | item 5 (§8) | severity medium | Questions, Users, Chat

- `pages/Questions.tsx:272-277` (Approve), `pages/Users.tsx:111-120` (Deactivate self), `pages/Chat.tsx:1755-1766` (Attach)
- Problem: the disabled reason is available only as a tooltip (`title` / `data-tip`), never as visible text with `aria-describedby`. On Questions the Approve button stays disabled until a risk checkbox and a comment are filled, and the explanation (`ev.ackHint`) is hover-only; touch and keyboard users never see it. Users: why Deactivate is disabled for your own row is hover-only (`data-tip`). Chat Attach is disabled while a turn is active or limits are reached with `title={t("chat.attach")}`, which describes the action, not the reason.
- Evidence:

```
<button className="ok" disabled={busy || blocked} title={blocked ? t("ev.ackHint") : undefined} onClick={() => send(true)}>
<button className="ghost sm" disabled={u.id === me.id} data-tip={u.id === me.id ? t("auth.noSelfDeactivate") : undefined} ...>
```

- Fix: render the hint as a `<span className="muted small" id=...>` beside the control and add `aria-describedby`, as WorkItems.tsx:1376-1387 (`wi-bug-reason`) already does. Questions can show `t("ev.ackHint")` inside `.qx-consequence`.
- Scope: local (pattern for the WorkItems reference exists)

### UI-006 (G1-006) | item 5 | severity medium | WorkItems, Chat, ChatImportReview, Runs, Report, Questions, OverviewTimesheet

- `pages/WorkItems.tsx:726` (Create drawer, disabled until title), `:755` (Import drawer, disabled until paste), `:369` (token Save), `:389` (import by task id), `pages/Runs.tsx:254` (Open and run, disabled until a workflow is picked), `pages/Chat.tsx:1997` (Confirm delegation, disabled with no workflow), `pages/ChatImportReview.tsx:198` (Approve, disabled with nothing selected), `pages/Questions.tsx:162`, `pages/Report.tsx:150`, `pages/OverviewTimesheet.tsx:121` (next month disabled in current month)
- Problem: primary actions are disabled with no visible text saying what is missing. The required-field case is guessable, but Chat.tsx:1997 (no workflow in preview) and Runs.tsx:254 have no adjacent explanation, and none uses `aria-describedby`.
- Evidence: `<button className="ghost" disabled={!paste} onClick={() => importJson("hasaki_work")}>` ; `<button disabled={!wf} onClick={() => navigate(`/workflows/${wf}`)}>`.
- Fix: one muted hint line per control ("Enter a title to create", "Pick a workflow first"), linked by `aria-describedby`.
- Scope: local, repeated

### UI-007 (G1-007) | item 10 | severity medium | Changes, Questions, Overview, Report, Intake, ChatImportReview, App, Chat

- Problem: hard-coded user-visible copy not in the catalogs. Locations:
  - `pages/Changes.tsx:406` "PR preview", `:433` "Validation", `:463` "Pull requests"; `pages/Changes.tsx:109` `{s.files_scanned} file · {s.detector_ms} ms`
  - `pages/Questions.tsx:98,212` "Run #", `:387` `<th>Run</th>`; `pages/Overview.tsx:266,329,575` "Run #"
  - `pages/Overview.tsx:214` `<h1>Welcome to {BRAND.product}</h1>`; `:212` `BRAND.tagline` (English constant shown to vi users); `App.tsx:417` `aria-label={`${BRAND.product} — Overview`}`
  - `pages/Report.tsx:237` "suggest", `:446` "attempt", `:449` "final", `:68-72` `ST` map shows "VERIFIED/PARTIAL/MISSING" raw
  - `pages/Intake.tsx:173` "run #", `:301` "owner", `:343` "rev", `:312` and `:373` mode names OFF/SHADOW/AUTOPILOT raw
  - `pages/ChatImportReview.tsx:158-159` option labels `PROJECT`/`REPOSITORY`
  - `pages/Chat.tsx:177` (`base64Of`) throws `"could not read the image"` which is shown in the pending bubble (`p.error`)
  - `pages/WorkItems.tsx:744,751` `Field label="JSON"` (technical term; ambiguous, quoted as-is)
- Evidence: `<ListChecks size={14} /> Validation`, `<h1>Welcome to {BRAND.product}</h1>`, `<th>Run</th>`.
- Fix: add `ch.prPreview/ch.validation/ch.pullRequests`, `ov.welcome`, `qx.col.run`, `common.run` etc. to both catalog locales; use `t()`.
- Scope: local

### UI-008 (G1-008) | item 9 | severity medium | Chat

- `pages/Chat.tsx:1394-1475` (`.chat-item`)
- Problem: a `div role="button" tabIndex=0` contains a real `<button>` (the "..." menu) and a `role="menu"` popup. Interactive content nested in `role="button"` is invalid ARIA (children of role=button are presentational), so assistive tech may not expose the menu button. Escape closes the menu but focus is not returned to the trigger and arrow keys are not handled.
- Evidence:

```
<div key={c.id} className="chat-item ..." role="button" tabIndex={0} onClick=...>
  ...<button type="button" className="ghost icon sm chat-item-menu-btn" aria-haspopup="menu" ...>
```

- Fix: make the row an `<a href="#/chat/{id}">` (a link is the directly available destination, §3) with the menu button as a sibling, not a child.
- Scope: local

### UI-009 (G1-009) | item 9 | severity medium | Chat, Report, WorkItems

- `pages/Chat.tsx:1845-1887` (composer textarea), `pages/Report.tsx:144-149` (note input), `:379-384` (markdown textarea), `:465-471` (approve comment), `pages/WorkItems.tsx:827-833` (description textarea), `:896-900` (`wi-sum-pick` select)
- Problem: inputs with only a `placeholder` (or nothing) and no `<label>`/`aria-label`. Placeholder is not an accessible name and disappears on input. (Questions.tsx:141 and WorkItems create drawer via `Field` do label correctly.)
- Evidence: `<textarea value={draft} ... placeholder={t("chat.placeholder")} .../>`; `<select className="wi-sum-pick" value={current ?? ""} ...>`.
- Fix: add `aria-label` using the existing placeholder keys, or wrap in `Field`.
- Scope: local

### UI-010 (G1-010) | item 9 | severity medium | Changes, Runs, Questions

- `pages/Changes.tsx:362-371` (`tr.click` with `onClick` only), `pages/Runs.tsx:117-123` and `pages/Questions.tsx:397-405` (`tr.click` `tabIndex=0` with `Enter` only)
- Problem: Changes file rows are mouse-only (no `tabIndex`, no key handler, no role); the diff toggle cannot be reached by keyboard. Runs/Questions rows are focusable but respond only to Enter (a `tr` has no button semantics, Space does nothing) and have no role/name for the row action. Interactive stat cards are required to support Enter/Space (§8); rows follow the same intent.
- Evidence: `<tr key={f.path} className={"click"+...} onClick={() => setFile({...})}>`; `onKeyDown={(e) => e.key === "Enter" && navigate(...)}`.
- Fix: put a real `<a>`/`<button>` in the first cell (path text) and keep the row click as enhancement; Changes should use a button with `aria-pressed`.
- Scope: local; same `tr.click` pattern elsewhere

### UI-011 (G1-011) | item 6 | severity medium | RepositoryWorkspace, App, Overview, ChatImportReview, WorkItems

- `pages/RepositoryWorkspace.tsx:30-33` (no error/loading state at all), `App.tsx:217` (`.catch(() => {})` on badge counts), `pages/Overview.tsx:516` (`.catch(() => null)` per run drops failed lookups silently), `pages/ChatImportReview.tsx:72`, `pages/WorkItems.tsx:1140`
- Problem: RepositoryWorkspace calls `useApi` but destructures only `data, reload`; when the request fails the opened `<details>` shows the explanatory text and nothing else, so the user sees an empty panel with no cause or retry (§12.6: failure shows its cause). The other four swallow background-lookup errors silently (low impact individually).
- Evidence: `const { data, reload } = useApi<{...}>(open ? "/api/workspace/repositories" : null);`
- Fix: read `error`/`loading` and render `SkeletonRows` / `ErrorBox onRetry={reload}` like AgentIsolation.tsx:35-37 does.
- Scope: local

### UI-012 (G1-012) | item 1, 3, 4 | severity medium | Chat

- `pages/Chat.tsx:617-640` (`.chat-bubble-actions`)
- Problem: under every assistant message five equal-weight `ghost xs` buttons mix utility actions (Copy, Regenerate) with three different launch actions ("Create task", "Delegate", "Investigate"). "Delegate" and "Create task" have no hint explaining the difference or outcome; only Investigate has a tooltip (`title`, hover-only). Launch actions are parked in a message toolbar (checklist 1) rather than with the proposal/launch area (`.chat-proposal`, Chat.tsx:1813) and the labels do not state the outcome (checklist 4).
- Evidence:

```
<button className="ghost xs" onClick={() => actions.delegate("task")}><Workflow size={14} /> {t("chat.createTask")}</button>
<button className="ghost xs" onClick={() => actions.delegate("delegate")}>{t("chat.delegate")}</button>
<button className="ghost xs" title={t("chat.investigateTip")} ...>
```

- Fix: split utility (icon+label Copy/Regenerate) from a single "Start..." group with one-line hint (reuse `chat.investigateTip` text as visible helper), or move to the existing delegation preview step.
- Scope: local

### UI-013 (G1-013) | item 8 (§5/§7) | severity medium | WorkItems

- `pages/WorkItems.css:10-19` (`.wi-aside`)
- Problem: `.wi-aside` is `position: sticky; top: 0` with no `max-height`/`overflow`, unlike `.wi-detail-side` (max-height 100vh + overflow-y: auto, line ~496). It holds `HasakiPanel` (login, token form, fetch, inbox up to 360px, note). On a 768px-high viewport the card can be taller than the scroll container, so the lower part (inbox, note) cannot be scrolled into view while the sticky column is pinned. Also `.wi-aside` is declared twice (dead duplicate at line 10 `min-width: 0` merged with line 15).
- Evidence:

```
.wi-main,
.wi-aside { min-width: 0; }
.wi-aside { position: sticky; top: 0; display: flex; ...}
```

- Fix: add `max-height: 100%; overflow-y: auto` like `.wi-detail-side`, and merge the duplicate rule. (Not measured in a browser; see Not verified.)
- Scope: local

### UI-014 (G1-014) | item 11 | severity medium | Chat, Questions, Users, Login, Changes, Report, Intake, AgentIsolation, LearningInsights

- `test/ui-quality.browser.ts:174-192` `routes` list
- Problem: the overflow/screenshot matrix covers only `/overview`, `/work-items`, `/work-items/:id`, `/runs`, `/account` of the audited pages. Not covered: `/chat`, `/chat/:id`, `/questions`, `/users`, login screen, `/work-items?view=intake`, the run Changes tab, the Report panel, `/settings` (AgentIsolation), `/insights/learning`. `chat.browser.ts` and `auth-ui.browser.ts` exist but are functional tests, not part of the 1920-320 overflow/theme matrix.
- Fix: add routes `["chat","/chat"]`, `["questions","/questions"]`, `["users","/users"]`, `["intake","/work-items?view=intake"]`, `["insights-learning","/insights/learning"]`.
- Scope: shared (test harness)

### UI-015 (G1-015) | item 7 (§8, DESIGN tokens) | severity low | WorkItems, Questions, Intake, Overview (CSS)

- `pages/WorkItems.css:89,621,758` , `pages/Questions.css:176`, `pages/Intake.css:267` (`color: #fff`)
- Problem: hard-coded `#fff` on brand/err backgrounds instead of `--on-brand` (§8: `--on-brand` handles the dark theme's bright brand background; `--brand` is bright in dark mode, so white text can fall below 4.5:1). `.wi-prod .pe-critical` also uses `#fff` on `--st-err`. Overview.tsx:241 hard-codes an `rgba(160, 60, 40, .16)` ellipse fill.
- Evidence: `.wi-sf.on .wi-sf-n { background: var(--brand); color: #fff; }`, `.qx-opt.on {... color: #fff; }`, `.in-mode.on { background: var(--brand); color: #fff; }`.
- Fix: `color: var(--on-brand)`.
- Scope: local

### UI-016 (G1-016) | item 7 (§1, §10) | severity low | Changes, Report, Overview, Chat, App, LearningInsights

- Inline `style={{...}}` counts: Changes 30, Report 21, Overview 5, Chat 3, LearningInsights 2, Questions/Runs/App/OverviewTimesheet 1 each. Examples: `pages/Changes.tsx:307 style={{ marginTop: 14 }}`, `:337,355,386 marginTop: 16`, `:437 padding: "8px 12px", margin: "6px 0"`; `pages/Report.tsx:118,220,240 ...`; `pages/LearningInsights.tsx:30 <h2 style={{display:"flex",gap:8,...}}>`; `App.tsx:515 <div className="scrim" style={{ zIndex: 55 }}>`.
- Problem: page spacing hard-coded as px in JSX instead of `--sp-*` tokens on a page-prefixed CSS class (§1, checklist 7); Changes and Report have no CSS file of their own (they reuse `RunView.css` `rv-*`/`rp-*`). `zIndex: 55` is an inline escalated z-index (§10).
- Fix: move to `ch-*` / `rp-*` classes with `gap`/`--sp-*`; `.scrim` z-index in CSS.
- Scope: local

### UI-017 (G1-017) | item 7 | severity low | WorkItems, Runs, Overview, Chat, Auth, WorkItems.css

- `!important`: `pages/WorkItems.css:134,385`, `pages/Overview.css:179` (`text-decoration: none !important` on link rows; a plain `a.wi-row` selector would suffice), `pages/WorkItems.css:719` and `pages/Runs.css:181` (`.search { width: 100% !important }` to defeat the inline width that `SearchInput width=` sets).
- Negative offsets: `pages/WorkItems.css:269` (`margin: -4px 0 8px`), `:348` (`margin: 0 -8px`), `:637` (`margin: -2px 0 10px`).
- Dead CSS: `.auth-feedback` (Auth.css:~58, no usage), `.chat-toolbar select, .chat-toolbar input` (Chat.css:233, toolbar contains no select/input), duplicate `.wi-aside` (see G1-013).
- Problem: §10 forbids new `!important` and negative offsets; dead rules should be deleted.
- Fix: remove duplicates; for the `.search` width use `SearchInput`'s `width` prop with `min(300px,100%)` (already used on Runs/WorkItems) so the override is unnecessary.
- Scope: local

### UI-018 (G1-018) | item 7 | severity low | WorkItems, Intake, Chat, ChatDelegations, Changes

- Hand-rolled equivalents of `ui.tsx` primitives: `.wi-sf` status filter buttons (WorkItems.tsx:603-624), `.in-tab` tabs (Intake.tsx:101-115), `.in-modes` segmented mode switch (Intake.tsx:303-315), `Chip` (`.in-chip`, Intake.tsx:55-64) and `.pill chat-run-status` (ChatDelegations.tsx:97-101, raw `d.run_status` untranslated) instead of `Segmented`, `Tabs`, `Badge`; emoji used as status icons in `RunSummaryView` (`pages/WorkItems.tsx:1042,1077,1082` ⏭ ✅ ❌ ❓ ✋; DESIGN.md "never emoji as primary icons").
- Problem: parallel controls drift in size/focus styling from the shared ones. Counts in `.wi-sf` are a legitimate extra, so only the pattern is flagged (ambiguous whether Segmented should grow a count).
- Fix: `Segmented` for in-modes, `Tabs` for in-tabs, `Badge s=... label` for run status, lucide icons (CheckCircle2/XCircle) for results.
- Scope: local

### UI-019 (G1-019) | item 3 | severity low | Chat, Users, Questions, ChatImportReview

- `pages/Chat.tsx:1497-1510` (Archive next to Delete in the toolbar, both `ghost sm`, Delete only gets `.danger` modifier), `:1942-1961` (memory Disable/Edit next to Delete), `pages/Users.tsx:103-120` (Reset password next to Deactivate), `pages/Questions.tsx:269-279` (Reject `danger sm` adjacent to Approve `ok` md; `.qx-foot > button` overrides padding for both, `Questions.css:219-222`, so size differs only by `sm`), `pages/ChatImportReview.tsx:170` (per-row Reject next to link)
- Problem: destructive controls sit directly beside safe ones with the same weight and no separator (checklist 3, §2 "avoid choosing padding separately for two controls meant to align"). Deletions already confirm (Chat removeConversation, Questions reject use `dialog.confirm`), so risk is mitigated; memory delete and Users deactivate rely on the dialog only.
- Fix: group destructive action to the end behind `.divider`/margin-left:auto; drop the `.qx-foot > button` padding override and use size tokens.
- Scope: local

### UI-020 (G1-020) | item 3 | severity low | Chat, WorkItems

- `pages/Chat.tsx:1376` ("New chat" primary in sidebar) and `:1520` (primary "New chat" in `.chat-empty` when no conversation selected); `pages/WorkItems.tsx:547` (PageHeader primary "New request") and `:636` (EmptyState primary "Create first request")
- Problem: two filled primary buttons for the same action visible together (checklist 3: one primary per area).
- Fix: make the empty-state one the only primary or give the header one `ghost`; both are same-outcome duplicates. WorkItems empty state is arguably an "area" of its own (ambiguous).
- Scope: local

### UI-021 (G1-021) | item 6 | severity low | WorkItems

- `pages/WorkItems.tsx:1150-1164` (`start`)
- Problem: Step mode performs two sequential `act()` calls; `act()` re-enables the clicked button in its `finally`, then the second call runs with no trigger (consumed), so between the two requests the Start/Step/Pending/Analyze buttons are enabled and the first run exists already. A second click in that window creates another run. Single-mode start is fine.
- Evidence: `const r = await act(() => api(.../runs ...)); ... if (mode === "step") await act(() => api(`/api/runs/${r.id}/start`, { step_mode: true }));`
- Fix: wrap both calls in one `act(async () => {...})`.
- Scope: local

### UI-022 (G1-022) | item 8 (§5) | severity low | Overview

- `pages/Overview.css:112` (`.ov-main { grid-template-columns: minmax(0, 1.35fr) minmax(500px, 1fr) }`)
- Problem: a 500px minimum on the right track without a documented role (§5: fixed tracks need a role). Between the 1100px breakpoint and roughly 1300px viewport (sidebar 240px) the left column (mini office) is squeezed to about 280-400px. Not measured.
- Fix: `minmax(0, 1fr)` and rely on the 1100px collapse, or move the breakpoint to a container query.
- Scope: local

### UI-023 (G1-023) | item 8 / §6 | severity medium | AgentIsolation, RepositoryWorkspace

- `pages/AgentIsolation.tsx:48-72` and `pages/RepositoryWorkspace.tsx:64-97`
- Problem: `<table>` placed directly in a card/details, not in `.table-wrap` (DESIGN.md responsive rule and §6: tables own horizontal scrolling inside a named region). At 390px the provider/index columns can force horizontal overflow of the settings/repositories page (not measured). RepositoryWorkspace also has an empty `<th />` for the action column (no accessible header text).
- Evidence: `<table className="small">` and `<table className="repo-ws-table">` with no wrapper.
- Fix: wrap in `<div className="table-wrap">` and give the last `th` visually-hidden text (`t("common.actions")`/`auth.actions`).
- Scope: local

### UI-024 (G1-024) | item 8 / §6 | severity low | Runs, Questions, Users, OverviewTimesheet, Changes

- `pages/Runs.tsx:101`, `pages/Questions.tsx:383`, `pages/Users.tsx:71`, `pages/OverviewTimesheet.tsx:184`, `pages/Changes.tsx:358`
- Problem: every `.table-wrap` here is a plain div with no `tabIndex`, `role="region"` or `aria-label`, but §6 requires the scroll region to be focusable and named (a keyboard user cannot scroll `runs-table table{min-width:860px}` / `.qx-history{min-width:760px}` without a mouse). In OverviewTimesheet the hint `<p className="ts-hint">` (line 253) also sits inside the scrolling region instead of below it.
- Fix: add `role="region" tabIndex={0} aria-label={...}` (ideally once in a shared wrapper) and move the hint outside.
- Scope: shared (all `.table-wrap` users)

### UI-025 (G1-025) | item 4 | severity low | Runs

- `pages/Runs.tsx:238-259` (`.runs-launch` in `PageHeader actions`)
- Problem: select plus a button labelled "Open and run..." (vi "Mo & chay...") that only navigates to the workflow editor (`navigate(`/workflows/${wf}`)`); the label promises running while the action opens a page, and there is no hint line. (The reference launch card on WorkItems states the outcome with `run.launchHint`.) Placement in PageHeader actions is acceptable.
- Fix: label "Open workflow" or add a one-line hint "Pick a workflow, then start it from its page".
- Scope: local

### UI-026 (G1-026) | §11 (state ownership) | severity low | WorkItems, Runs

- `pages/WorkItems.tsx:435-478` (filters and view mirrored from the `query` prop into `useState` once, then `history.replaceState`), `pages/Runs.tsx:192,204` (`status`, `q` local only)
- Problem: §11 says the URL owns navigable state. WorkItems reads `query` only in the `useState` initializer, so navigating to `#/work-items?status=open` while already on the page (link, back/forward) does not update the filter; Runs filters are not in the URL at all, so a status filter is lost on back-navigation.
- Fix: derive `source/q/status/view` from `query` with `URLSearchParams` during render and write with `navigate`/`replaceState`.
- Scope: local

---

## Group 2 — Run view, Step inspector, Transcript, Trace, Investigations, Benchmarks, ScanProgress, child workflows

### UI-027 (G2-001) | item 3 | severity medium | Investigations / Evaluation (Insights)

- EvaluationBenchmarks.tsx:191 (Run safe evaluation) and :264 (Compare results) are both brand-filled primaries in one card; the three `ins-bench-form` rows plus the toolbar have no `.ghost` among the submit buttons.
- Problem: two filled primary buttons in one `.card` (run a benchmark, compare two runs) compete as the area's main action.
- Evidence:
  `<button disabled={!runs.data.enabled || !suites.data.length} onClick={create}>` (:191)
  `<button disabled={!baseline || !candidate || baseline === candidate} onClick={() =>` (:264)
- Smallest fix: keep "Run" as primary; make "Compare" `className="ghost"` (Button variant="secondary").
- Scope: local

### UI-028 (G2-002) | item 3 | severity medium | Run view header, Step inspector

- RunView.tsx:745,763 (Start / Resume primary), :772 and :780 (Changes / Trace use `"sm"` when active), :787 (Cancel `danger` in same row).
- Problem: navigation toggles `Changes`/`Trace` turn brand-filled when active (`stepKey === "~trace" ? "sm" : "sm ghost"`), so with Start or Resume visible there are two filled primaries in `.rv-actions`. Same pattern: RunView.tsx:1244 (step button `waiting ? "sm" : "sm ghost"`) and Transcript.tsx:311 (`filter === k ? "" : "ghost"`) are state-driven fills, which is ambiguous against the "one primary" rule (the toggles have aria-pressed only in Transcript).
- Evidence:
  `className={stepKey === "~trace" ? "sm" : "sm ghost"}` (RunView.tsx:780)
  `<button className="sm" onClick={() => runAction("resume")}>` (:763)
- Smallest fix: use `.ghost` for the Changes/Trace buttons in every state and mark the active one with `aria-pressed`/`aria-current`, not the primary fill (or move to `Segmented`/`Tabs`).
- Scope: local

### UI-029 (G2-003) | item 3 | severity medium | Run view, Step inspector, Child cards, Benchmarks

- Destructive action adjacent to safe ones without visual separation, or destructive but styled neutral:
  RunView.tsx:787 (Cancel run, last item of the same flex row as Trace/Changes);
  RunView.tsx:1786 (Close PR is `sm ghost` with `variant: "destructive"` dialog, right after Merge :1767);
  StepInspector.tsx:864 (Reject directly after Approve/Skip in `.rv-attn-actions`), :1105 (Stop in `.si-actions`);
  childWorkflows.tsx:205 (Cancel child run is `xs ghost`, next to Open);
  EvaluationBenchmarks.tsx:356 (Cancel evaluation `ghost sm`, next to "Open workflow", no confirm).
- Problem: standards §12.3 asks destructive actions to be visually separate; here they only differ by colour (or not at all for the three `ghost` ones, which look like harmless buttons).
- Evidence:
  `<button className="sm ghost" onClick={async () => { const ok = await dialog.confirm({ title: t("rv.pr.close.title"), ... variant: "destructive"` (RunView.tsx:1786)
  `<button className="xs ghost" onClick={cancel}>` (childWorkflows.tsx:205)
- Smallest fix: `className="danger"` for the ghost-styled destructive ones; wrap destructive buttons in a separate group (`margin-left: auto` on `.rv-actions`/`.si-actions`).
- Scope: local

### UI-030 (G2-004) | item 5 (§8) | severity medium | Run view, Step inspector

- Disabled controls whose reason is only a tooltip: RunView.tsx:772-775 (Changes disabled, reason `title={hasWorkspaces ? "" : t("rv.noChanges")}`); StepInspector.tsx:835-841 (Approve disabled until risk is acknowledged and a comment is given, reason only in `title={t("ev.ackHint")}`).
- Problem: reason is hover-only, invisible on touch/keyboard; the Approve button blocks the user with no visible text and no `aria-describedby`. (For Approve the checkbox label next to it does say "ev.ack" but not that a comment is also required.)
- Evidence:
  `disabled={req?.requires_risk_acknowledgement && (!ackRisk || !comment.trim())}`
  `title={ req?.requires_risk_acknowledgement && (!ackRisk || !comment.trim()) ? t("ev.ackHint") : undefined }` (StepInspector.tsx:836-841)
- Smallest fix: render the same `t("ev.ackHint")` / `t("rv.noChanges")` in a `muted small` line with an id and `aria-describedby` on the button.
- Scope: local

### UI-031 (G2-005) | item 5 | severity medium | Investigations, Benchmarks, Re-execute

- Disabled with no reason at all: Investigations.tsx:382 (Start investigation disabled while text < 5 chars; the Field hint "inv.requestHint" does not mention a minimum); EvaluationBenchmarks.tsx:191 (disabled when no suite; only the "disabledLocally" note, far away in the toolbar and not linked, explains `!enabled`; nothing for empty suites) and :264 (disabled when baseline === candidate or unset); StepInspector.tsx:2473 (Confirm re-run disabled when `preview?.can_reexecute === false`, no text states why; the preview list may show a per-step reason, ambiguous).
- Problem: user sees a dead button and cannot tell what to fix.
- Evidence:
  `<button disabled={request.trim().length < 5} onClick={start}>` (Investigations.tsx:382)
  `<button disabled={busy || preview?.can_reexecute === false}` (StepInspector.tsx:2473)
- Smallest fix: one visible muted line under/next to the button (id + `aria-describedby`) stating the missing condition, using new catalog keys in vi and en.
- Scope: local

### UI-032 (G2-006) | item 6 | severity medium | Benchmarks

- EvaluationBenchmarks.tsx:100-103 `inspect()` and its callers :135-139 (Refresh), :218 (row button `#id`), :360 (after cancel).
- Problem: `inspect` awaits `api()` with no try/catch and is called from onClick outside `act()`: a failure becomes an unhandled promise rejection with no toast/ErrorBox; the click is also not guarded against double fire.
- Evidence:
  `const inspect = async (id: number) => { setSelected(id); setDetail(await api<EvaluationRunDetail>(...)); };` (:100-103)
  `<button className="ghost sm" onClick={() => inspect(r.id)}>` (:218)
- Smallest fix: wrap the body in `act(...)` (the other handlers in this file already do).
- Scope: local

### UI-033 (G2-007) | item 9 (§8) | severity high | Child workflow cards on the run DAG

- childWorkflows.tsx:178-212 (`.node.gc` card, `role="link"`, `onKeyDown`, nested buttons).
- Problem: the card is `role="link"` with `onKeyDown={e => e.key === "Enter" && open()}`, and contains Start/Cancel/Approve/Open buttons. The inner `.gc-actions` stops `onPointerDown`/`onClick` but not `onKeyDown`, so pressing Enter on "Start" or "Cancel" also bubbles to the card and navigates to the child run while the action starts or the confirm dialog opens. Interactive controls nested in a link role are also invalid ARIA.
- Evidence:
  `role="link" tabIndex={0} ... onKeyDown={(e) => e.key === "Enter" && open()}` (:178-184)
  `<div className="gc-actions" onPointerDown={stop} onClick={stop}>` (:190, no onKeyDown stop)
- Smallest fix: ignore the key event when `e.target !== e.currentTarget` (or stop propagation in `.gc-actions`), and drop `role="link"` in favour of a titled heading link/button inside the card.
- Scope: local (also shown in Workflow Studio only if reused; graph.tsx imports RunView.css, not checked)

### UI-034 (G2-008) | item 9 (§8) | severity high | Investigations list

- Investigations.tsx:223-228 (`<tr className="click" onClick={() => navigate(...)}>`).
- Problem: the only way to open a past investigation is clicking a table row; the row has no link, button, tabindex or key handler, so it is unreachable by keyboard and not announced as actionable.
- Evidence:
  `<tr key={r.id} className="click" onClick={() => navigate(`#/investigations/${r.id}`)}>`
  `<td>{r.id}</td> <td className="inv-title-cell">{r.title}</td>`
- Smallest fix: render the title cell as `<a href={`#/investigations/${r.id}`}>` (keep row click as a convenience).
- Scope: local

### UI-035 (G2-009) | item 9 (§8) | severity medium | Run view, Step inspector, Investigations

- Inputs with placeholder only, no label or aria-label: RunView.tsx:1128 (feedback textarea `#rv-feedback`), StepInspector.tsx:565 (question answer), :775 (common branch input; a visible `<span>` precedes it but is not a label), :808 (approval comment), :2414 (add-skill `<select>` inside a `div.field` with a `<span>`, not a `<label>`), Investigations.tsx:786 (pasted result textarea).
- Problem: accessible name is missing/unstable (placeholder disappears; `div.field` + span is not associated).
- Evidence:
  `<textarea rows={2} placeholder={gate ? t("si.gateCommentPh") : t("si.commentPh")} value={comment}` (StepInspector.tsx:808)
  `<select value="" onChange={(e) => e.target.value && setSkills([...skills, e.target.value])}>` (:2414)
- Smallest fix: `aria-label={...same key}` or wrap in the existing `Field`/`<label className="field">`.
- Scope: local

### UI-036 (G2-010) | item 9 (§8, DESIGN.md) | severity medium | Run view header

- RunView.tsx:699-722 (edit "continue on" branch button).
- Problem: icon-only button whose content is the text glyph `✎` and whose only name is `title`; DESIGN.md forbids emoji/glyphs as icons and requires `aria-label` on icon-only buttons.
- Evidence:
  `<button type="button" className="quiet" title={t("rv.editBranch")} onClick={async () => {` ... `✎`
- Smallest fix: `<Pencil size={12}/>` from lucide plus `aria-label={t("rv.editBranch")}`, `className="quiet icon xs"`.
- Scope: local

### UI-037 (G2-011) | item 9 (§8) | severity medium | ScanProgress (Production errors, code scan)

- ScanProgress.tsx:159 and :269 (`role="status" aria-live="polite"` on the whole card).
- Problem: the card includes the elapsed clock updated every second (`setNow` 1s interval), so assistive tech is told to re-announce the card each second; the bar itself is only `div`s with no `role="progressbar"`/`aria-valuenow`.
- Evidence:
  `<div className="sp-card" role="status" aria-live="polite">`
  `const t = setInterval(() => setNow(Date.now()), 1000);` (:136) and `{clock(elapsed)}` inside the live region
- Smallest fix: drop `aria-live` from the card, put `role="progressbar" aria-valuenow={pct}` on `.sp-track` and keep a separate sr-only live line for phase changes only.
- Scope: shared (used by ProdErrors.tsx and prodErrors/CodeScan.tsx)

### UI-038 (G2-012) | item 9 (§8) | severity low | all nine files

- `<button>` without explicit `type` (not inside any `<form>` in these files, so no behaviour bug today). Locations (file:line): RunView.tsx 745,748,758,763,768,772,780,787,845,855,1136,1244,1292,1346,1644,1746,1767,1786; StepInspector.tsx 548,578,702,835,848,864,1045,1061,1066,1071,1088,1105,1205,2338,2357,2404,2473,2493; Transcript.tsx 311; TraceExplorer.tsx 365,377,418,437,457,489,512,609,620,665,723,740; childWorkflows.tsx 195,200,205,210; Investigations.tsx 200,382,750,792,1006; EvaluationBenchmarks.tsx 123,135,191,218,264,350,356.
- Problem: §8/§12.9 require explicit button types; these rely on the HTML default.
- Evidence: `<button className="sm" onClick={() => runAction("start")}>` (RunView.tsx:745)
- Smallest fix: add `type="button"` (or migrate to `Button`, which sets it by default).
- Scope: local

### UI-039 (G2-013) | item 7 (§2) | severity low | all pages above

- Hand-rolled `<button className="sm ...">` everywhere instead of `Button` from ui.tsx (supports loading/aria-busy/size/variant). Representative: RunView.tsx:745-787, StepInspector.tsx:1061-1105, TraceExplorer.tsx:377, Investigations.tsx:382, EvaluationBenchmarks.tsx:191. The docs say existing `.btn/.ghost/.sm` call sites remain compatible, so this is not a violation, only drift; `act()` covers the busy state.
- Problem: ambiguous per the standard (call sites are "compatible"); listed for completeness, new code should use `Button`.
- Smallest fix: none required; use `Button` when touching these.
- Scope: local

### UI-040 (G2-014) | item 7 (§2, §10) | severity medium | Trace explorer

- TraceExplorer.css:6-13 (`.trace-explorer button`), :31-34 (`.tx-actions > button:first-child`), :170-190 (`.tx-search` re-implements SearchInput).
- Problem: a blanket rule re-styles every button in the explorer (`padding: 7px 12px; min-height: 32px; display:inline-flex`), overriding the `.xs` (28px) / `.sm` control tokens so `xs` buttons render 32px, plus a hard-coded `width: 34px` for the icon-only refresh instead of `.icon`. The search field with icon, clear button and focus ring is rebuilt by hand instead of `SearchInput` (§9).
- Evidence:
  `.trace-explorer button { ... padding: 7px 12px; min-height: 32px; line-height: 1.5; }`
  `.tx-actions > button:first-child { width: 34px; padding: 7px; }`
- Smallest fix: delete the blanket rule and use `className="sm"`/`xs icon`; use `SearchInput` for the log filter.
- Scope: local

### UI-041 (G2-015) | item 7 (§1, §10) | severity low | Run view, Trace, Step inspector

- Hard-coded px spacing and font sizes instead of `--sp-*`/`--fs-*`: RunView.css (165 `padding/margin/gap` declarations with px, 0 uses of `--sp-`; 32 `font-size: Npx`), TraceExplorer.css (72 px spacing, 0 `--sp-`; 34 `font-size: Npx`, down to 9-11px: lines 12, 41-48, 442 `font-size: 10px/11px`, 607-:627 `font-size: 9px`), and inline `style={{...}}` with px margins/padding (RunView.tsx 35 occurrences, StepInspector.tsx 101, e.g. RunView.tsx:1115 `style={{ marginTop: 8 }}`, StepInspector.tsx:2306-2310). Investigations.css is the compliant counterpart (27 `--sp-` uses).
- Problem: breaks the 4/8/12/16/20/24/32 scale (§1) and makes text 9-11px, below the readable sizes of the type tokens; inline styles bypass the page-prefixed CSS (§10).
- Evidence:
  `.tx-panel-footer {... gap: 12px; padding: 12px 14px; ... font-size: 10px; }` (TraceExplorer.css)
  `<div className="rv-card soft" style={{ margin: "10px 0 0", padding: "10px 12px" }}>` (StepInspector.tsx:~2455)
- Smallest fix: move inline styles into `.rv-*`/`.si-*` rules using `var(--sp-n)`, replace px font sizes with `--fs-xs/sm`.
- Scope: local

### UI-042 (G2-016) | item 7 (§10) | severity low | Run view

- RunView.css:1440 `margin-right: -3px` on `.rv-resize`; RunView.css:1585 `top: -11px` on `.gc-lane-label`.
- Problem: §10 says not to fix layout with arbitrary negative offsets. (A 6px resize handle straddling the pane border and a label breaking a lane border are intentional here; ambiguous, quoted for the owner to decide.)
- Evidence: `.rv-resize { flex: none; width: 6px; margin-right: -3px; ...` / `.gc-lane-label { position: absolute; top: -11px;`
- Smallest fix: if kept, add a one-line rationale comment; otherwise use `translate`/padding.
- Scope: local

### UI-043 (G2-017) | item 7 (§10) | severity low | ScanProgress, Execution cards

- ScanProgress.tsx has no CSS file: its `.sp-*` rules live in ProdErrors.css (pages/ProdErrors.css), and ExecutionCards.tsx:75,152,... uses `.pe-warn` from the same file, so these components only style correctly when ProdErrors.css happens to be loaded (RunView.css does not provide it). ScanProgress.tsx:59-111 also hard-codes hex colours (`#fff`, `#1d2420`, `#ff8fa3`, `#7a5a3a`, `#9fd8ff`, `#5c6b73`) in the mascot SVG instead of tokens.
- Problem: CSS not colocated/prefixed with the owning component; hard-coded hex (DESIGN.md: never hard-code colours in pages). Hex inside an illustration is arguably acceptable (ambiguous).
- Evidence: `<span className="pe-warn">{t("ck.workspaceUnavailable")}</span>` (ExecutionCards.tsx, `pe-warn` defined only at ProdErrors.css:10)
- Smallest fix: add `.ec-warn` to RunView.css; move `.sp-*` to a ScanProgress.css imported by the component.
- Scope: shared (ProdErrors, CodeScan)

### UI-044 (G2-018) | item 7 (§2) | severity low | Transcript

- Transcript.tsx:307-320 hand-rolled filter chips (9 buttons, active = filled brand) with styles in styles.css:1928 and RunView.css:1025 (`.tl-filters button { font-size: 11.5px; padding: 2px 9px }`).
- Problem: this is a `Segmented`-style single-choice filter (§9); the padding override sits below the XS 28px control size (§2).
- Evidence: `<button key={k} className={filter === k ? "" : "ghost"} aria-pressed={filter === k} onClick={() => setFilter(k)}>` and `.tl-filters button { font-size: 11.5px; padding: 2px 9px; }`
- Smallest fix: `Segmented` with icon+label options, or at least `xs` class and drop the padding override.
- Scope: local

### UI-045 (G2-019) | item 10 | severity medium | Run view, Step inspector, Investigations, Benchmarks, Trace

- Hard-coded user-visible strings (no key in catalog.ts):
  RunView.tsx:609 `aria-label="Breadcrumb"` (ui.tsx PageHeader uses `t("common.breadcrumb")`); :615 `Run #{run.id}`; :874-880 `"UNKNOWN"`, `"ONLINE"`, `"WAITING_FOR_WORKER"`; :1197 `run #{j.run_id}`; :1387 `Agent configuration version ...`; :1394 `revision`; :1602 `"Claude"` (brand, ok).
  StepInspector.tsx:855 `reason: comment || "skipped by user"` (stored and later shown); :1910 `attempt #{a.number}`; :2476 `" [off]"`; :2542-2543 `Snapshot #`, `project`, `repos`.
  TraceExplorer.tsx: `RUN #{runId}` eyebrow; detailFields labels `"Provider"`, `"Model"`, `"Job"`.
  Investigations.tsx:339 `qc · Argo CD, Kafka UI, QC DB`, :353 `· Splunk`, :350 placeholder `k8s_prod`.
  EvaluationBenchmarks.tsx:211 `<EmptyState title="No benchmark evaluations yet" />` (English only, no next-step hint), :228 `"ON"`/`"OFF"`, `P1`.
- Problem: copy missing from the vi/en catalogs; Vietnamese users see English. All static `t()` keys used in these files exist in both locales (checked by script, including dynamic prefixes such as `rv.fbMode.`, `dec.action.`, `hx.stage.`; vi and en sets are identical).
- Evidence: `<nav className="rv-crumbs" aria-label="Breadcrumb">` (RunView.tsx:609); `<EmptyState title="No benchmark evaluations yet" />`
- Smallest fix: add keys in both locales of web/src/i18n/catalog.ts and use `t()`; for the empty state also add a hint pointing at "Run safe evaluation".
- Scope: local

### UI-046 (G2-020) | item 4 | severity low | Run view, Step inspector, Investigations

- Hints for consequential actions exist only as `title` tooltips: RunView.tsx:748 (step mode), :768 (Send feedback `rv.feedbackTip`); StepInspector.tsx:848 (Skip gate `si.skipGateHint`), :1071 (Retry baseline); Investigations.tsx:1006 ("Continue to fix", `inv.fixHint`, in the PageHeader actions).
- Problem: §12.4 asks for a visible one-line hint of what happens; here the hint is hover-only (the fix action does at least show a confirm dialog).
- Evidence: `<button className="sm" title={t("inv.fixHint")} onClick={async () => { const ok = await dialog.confirm({`
- Smallest fix: show the text as `muted small` beside/below the button; keep `title` optional.
- Scope: local

### UI-047 (G2-021) | item 3 §3 (tables) | severity low | Benchmarks, Execution cards

- EvaluationBenchmarks.tsx three tables (cases, progress `finished/tasks`, success, score, score/duration deltas, ~:98-190, :287-318) and ExecutionCards.tsx harness table duration column (`<td className="mono">{dur(s.ms)}`).
- Problem: numeric cells and headers are left-aligned (§3: right aligned, tabular numerals).
- Evidence: `<td>{number(r.average_score)}</td>` / `<th>{t("bench.col.score")}</th>`
- Smallest fix: `style="number"` equivalent class on those `th/td` (or move to `DataTable` with `style: "number"`).
- Scope: local

### UI-048 (G2-022) | item 7 (§4) | severity low | Investigations list

- Investigations.tsx:224 `<td className="inv-title-cell">{r.title}</td>` with Investigations.css:42-46 (`max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`).
- Problem: ellipsised request title with no `title` attribute or other way to read the full value (§4).
- Evidence: `.inv-title-cell { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`
- Smallest fix: `title={r.title}` on the cell (or let it wrap).
- Scope: local

### UI-049 (G2-023) | item 1 | severity low | Run view header

- RunView.tsx:772-785 inside `.rv-actions`.
- Problem: run-control actions (Start, Pause, Cancel) share one bar with view switches (Changes, Trace) and Feedback (which just scrolls to a textarea). Whether view switches belong in the action bar or in tabs is ambiguous under §12.1; quoted for the owner. RunView does not use `PageHeader` (hand-rolled `.rv-head`/`.rv-crumbs`), which DESIGN.md says every page starts with; likely intentional for the full-canvas workspace.
- Evidence: `<button className={stepKey === "~changes" ? "sm" : "sm ghost"} disabled={!hasWorkspaces}` next to `runAction("pause")` and `runAction("cancel")`
- Smallest fix: move Changes/Trace into a `Segmented`/`Tabs` row beside the crumbs; keep only run actions in `.rv-actions`.
- Scope: local

### UI-050 (G2-024) | item 11 | severity low | test coverage

- test/ui-quality.browser.ts:174-192 routes list contains `/runs/:id` (run-view) and `/insights/evaluation` (EvaluationBenchmarks), but not: `/runs/:id/<step>` (StepInspector, Transcript, ExecutionCards, child cards need delegation fixture), `/runs/:id/~trace` (TraceExplorer), `/runs/:id/~changes`, `/investigations`, `/investigations/:id`, and the production scan view that renders ScanProgress.
- Problem: these screens are not covered by the screenshot/overflow/focus smoke at 390 px.
- Smallest fix: add `["run-trace", `/runs/${id}/~trace`]`, `["run-step", ...]`, `["investigations", "/investigations"]` entries.
- Scope: shared (test harness)

## Group 3 — Workflows, Workflow editor, Knowledge, Proposals, Repositories, Repository access, Profile preview

### UI-051 (G3-001) | item 6 | severity high | WorkflowEditor

- WorkflowEditor.tsx:411-445 (`validate`, `saveDraft`, `publish`), buttons at 522-543
- Problem: Publish/Save draft call `act(validate)` first, which consumes the click trigger and re-enables the button when it returns. The draft `api()` call (L432) and the publish `act()` (L433) then run with no busy element, so Publish/Save draft can be pressed again while the request is in flight. Only Ctrl+S is guarded (`publishing` ref).
- Evidence:

```
const publish = async () => {
  if (!(await validate())) return;          // act #1 takes + releases the button
  await api(`/api/workflows/${wfKey}/draft`, ...).catch((e) => toast(e.message)); // raw api
  const r = await act(() => api(`.../publish`, ...)); // act #2: trigger already null
```

- Smallest fix: use `Button loading={saving}` (ui.tsx) driven by one local `saving` state wrapped around the whole sequence, or reuse the existing `publishing` ref as state for both buttons.
- Scope: local

### UI-052 (G3-002) | item 6 | severity high | WorkflowEditor (QuickRun)

- WorkflowEditor.tsx:1502-1525 (`start`), 1629-1639 (three launch buttons)
- Problem: Start / Step mode / Create (do not start) are three sibling buttons that each create a run. act() only disables the clicked one, so a second, different button can fire a second `POST /api/runs` while the first is pending. In step mode the second `act` (L1523) has no busy element at all.
- Evidence:

```
<button onClick={() => start("start")}>...
<button className="ghost" onClick={() => start("step")}>...
<button className="ghost" onClick={() => start("pending")}>...
if (mode === "step") await act(() => api(`/api/runs/${r.id}/start`, { step_mode: true }));
```

- Smallest fix: one `busy` state in QuickRun; pass `loading`/`disabled` to all three (use `Button`).
- Scope: local

### UI-053 (G3-003) | item 9 + 4 | severity high | WorkflowEditor

- WorkflowEditor.tsx:510-527; WorkflowEditor.css:795-797 (`.wfe-lbl{display:none}` inside `@container (max-width:1280px)`)
- Problem: Auto layout / Validate / Save draft keep only an icon when the `.page.full` container is <= 1280px (true at a 1440 viewport with the sidebar open). The label span is `display:none`, and Validate and Save draft have no `aria-label` or `title`, so they have no accessible name and no visible label. Auto layout has a `title` only.
- Evidence:

```
<button className="sm ghost" onClick={validate}>
  <ShieldCheck size={15} /> <span className="wfe-lbl">{t("wfe.validate")}</span>
</button>
```

- Smallest fix: add `aria-label={t("wfe.validate")}` / `t("wfe.saveDraft")` / `t("wfe.autoLayout")` (keys exist); optionally keep the `title`.
- Scope: local

### UI-054 (G3-004) | item 6 | severity medium | Workflows, Knowledge, WorkflowEditor

- Workflows.tsx:127-133 (`duplicate`); Knowledge.tsx:739-745 (`remove`, first `call(false)`); WorkflowEditor.tsx:432 (see G3-001)
- Problem: a mutation or the lookup preceding it is sent with a bare `api()` outside `act()`: no busy state, no spinner, and in Workflows a rejected GET is an unhandled rejection (no toast), so the drawer silently does nothing. Double submit is possible while the request is in flight.
- Evidence:

```
create(await api<WorkflowDefinition>(`/api/workflows/${src}`));   // Workflows.tsx:132
r = await call(false);   // Knowledge.tsx:743, call = api(`/api/knowledge/${itemKey}/delete`, ...)
```

- Smallest fix: wrap in `act()` (Workflows: `act(() => api(...))` then `create(def)`); Knowledge: run the first call inside `act` or give the delete button a busy state.
- Scope: local

### UI-055 (G3-005) | item 6 | severity medium | RepositoryAccess

- RepositoryAccess.tsx:75-95 (`AccessChecks`), 172-181 (`grant`), 205-213 (`share`)
- Problem: each checkbox change calls `act(...)`, but act() only marks a button as busy; a checkbox is not a button. Nothing is disabled while saving, so ticking several boxes quickly sends overlapping grant requests for the same user/repo cell. The controlled checkbox only updates after `reload()`.
- Evidence:

```
<input type="checkbox" checked={on} onChange={(e) => onChange(...)} />   // -> grant()/share() -> act(...)
```

- Smallest fix: keep a `pending` key set in `RepositoryAccessAdmin` and pass `disabled` to `AccessChecks` for that cell.
- Scope: local

### UI-056 (G3-006) | item 6 | severity medium | Repositories, Workflows

- Repositories.tsx:71-74 and 489 (`workspace` useApi, `workspace.error` never read); Workflows.tsx:328-331 and 383-387 (`useApi` error ignored in `WorkflowCard`)
- Problem: a failed request is swallowed. In Repositories the workspace card shows the fallback status text "remote_configured" (a plausible healthy state) when the API errors; in Workflows a failed definition read leaves the type chips as a permanent skeleton and the step count as "—".
- Evidence:

```
<p>{t(`repo.workspace.${workspace.data?.status ?? "remote_configured"}`)}</p>
{!def ? (<><Skeleton h={22} w={74} r={999} />...
```

- Smallest fix: render `ErrorBox`/`muted` error text when `workspace.error` / the card's `error` is set (the index panel in Repositories.tsx:523 already does this).
- Scope: local

### UI-057 (G3-007) | item 5 | severity medium | Workflows, WorkflowEditor, Knowledge, Repositories, KnowledgeProposals

- WorkflowEditor.tsx:545-553 (Run: `disabled` + `title={... t("wfe.publishFirst")}` only); Knowledge.tsx:534-539 (Import `disabled={busy || !(created+updated)}`, no reason); Knowledge.tsx:1305-1317 (Approve/Reject `disabled={!by.trim()}`; reason only implied by an input placeholder); Repositories.tsx:1200 (Save `disabled={!form.name || nameInvalid}`; hint only when invalid, nothing when empty); Workflows.tsx:303 (`disabled={!key}`; `wfs.keyHint` does not say the key is required); KnowledgeProposals.tsx:815-821 (Approve disabled until a checkbox elsewhere is ticked, not linked)
- Problem: disabled controls give no visible reason, or a tooltip only (§8), and none are linked with `aria-describedby`.
- Evidence:

```
<button className={`sm ok...`} disabled={!def.latest_version}
  title={def.latest_version ? "" : t("wfe.publishFirst")} ...>
<button disabled={busy || !(preview.created + preview.updated)} onClick={() => run(false)}>
```

- Smallest fix: add a `<small className="muted" id=...>` with the reason next to each control and `aria-describedby`; for the Knowledge import, show the existing "unchanged" count line as the reason.
- Scope: local

### UI-058 (G3-008) | item 5 (§8) | severity medium | RepositoryAccess, Repositories

- RepositoryAccess.tsx:135 (`BitbucketState`, `title={reason}`); used at Repositories.tsx:~173 (AccessCard), 888 and RepositoryAccess.tsx:288, 357
- Problem: the reason a host check is denied/unknown exists only in a native `title`, so it is hover-only and not exposed on touch or to keyboard users (§8 "inspectable without relying on hover").
- Evidence:

```
<span className={`repo-bb is-${state}...`} title={reason || undefined}>{t(key)}...</span>
```

- Smallest fix: render the reason as a `<small className="muted">` next to the label when present (AccessCard/detail views have room) and keep `title` as a bonus.
- Scope: local

### UI-059 (G3-009) | item 3 | severity medium | Repositories

- Repositories.tsx:375-396 (detail PageHeader `actions`)
- Problem: segmented tabs, a ghost Back, a ghost Add and a `danger` Delete are laid out in one flat row; the destructive action sits directly next to the safe ones and Add repository (a different-scope action) is mixed with page navigation.
- Evidence:

```
{tabs}<button className="ghost" ...>Back</button>
{manage && <button className="ghost" onClick={startNew}>...}
{manage && r && <button className="danger" onClick={() => remove(r.name)}>...}
```

- Smallest fix: wrap Delete in its own group with `margin-left:auto` or move it into the edit form footer (`repo-form-foot`) where the Save sits; keep Back and tabs in the header.
- Scope: local

### UI-060 (G3-010) | item 3 | severity low | WorkflowEditor, Knowledge, Workflows

- WorkflowEditor.tsx:536-553 (Publish brand-filled `sm` + Run `sm ok` filled in the same header); Knowledge.tsx:293-314 (Proposals button is brand-filled when `itemKey === "~proposals"` while "New" is also filled); Workflows.tsx:175 and 227 (header "New workflow" and the empty-state "createFirst" are both filled primaries on the same screen)
- Problem: more than one filled brand/ok button per area.
- Evidence:

```
className={itemKey === "~proposals" ? "" : "ghost"}   // Knowledge.tsx:294
```

- Smallest fix: use `ghost` for the active nav button (mark it with `aria-current`), `ghost` for the empty-state duplicate, keep one filled action per bar.
- Scope: local

### UI-061 (G3-011) | item 3 + 9 | severity medium | RepositoryAccess

- RepositoryAccess.tsx:314-321
- Problem: every user column header has the same two adjacent ghost buttons "Full access to all" / "Remove all"; the destructive one is not separated or styled differently, and with N users there are 2N buttons whose accessible names are identical (no user name).
- Evidence:

```
<button className="ghost sm" onClick={() => bulk(u, "pull_request")}>{t("repo.access.allFull")}</button>
<button className="ghost sm" onClick={() => bulk(u, "none")}>{t("repo.access.allNone")}</button>
```

- Smallest fix: add `aria-label={t(..) + " " + u.username}` and give the "Remove all" button `className="danger sm"` (the confirm dialog already exists).
- Scope: local

### UI-062 (G3-012) | item 10 | severity medium | KnowledgeProposals

- KnowledgeProposals.tsx:317, 458 (`t(`kp.source.${p.source_kind}`)`)
- Problem: the server emits `sourceKind` "chat" (src/chat/documentImport.ts:234, src/chat/memory.ts:155) and "failure_pattern" (src/learning/patterns.ts:254), but the catalogs only have `kp.source.manual|repository_import|skill_evolution|workflow`. These proposals render the raw key `kp.source.chat` / `kp.source.failure_pattern` in vi and en. The same applies to `kp.ev.${e.source}` if other evidence sources appear (catalog: answer, approval_comment, proposal, reexecute_feedback, repository_file, requirement; not verified against server).
- Evidence: `t(\`kp.source.${p.source_kind}\`)`with no`kp.source.chat` in web/src/i18n/catalog.ts (grep returns nothing).
- Smallest fix: add `kp.source.chat` and `kp.source.failure_pattern` to both locales in catalog.ts.
- Scope: local

### UI-063 (G3-013) | item 10 | severity medium | Workflows, WorkflowEditor, Knowledge, KnowledgeProposals, Repositories, RepositoryAccess

- Workflows.tsx:286 (`label="Key"`), 289 (`placeholder="key (lowercase-dashes)"`), 53-63 (`SHORT_LABEL` Agent/Coding/Input/Approval/...), 365 (`template`), 375 (`draft`), 392 (`title={t}` raw type); WorkflowEditor.tsx:471 (`aria-label="Breadcrumb"`), 501 (`<option>draft</option>`), 817 (`" [off]"`); Knowledge.tsx:307 (`Audit`), 1137 (`Revert to v{n}`), 1220 (`Run #`), 1276 (`confidence:`); KnowledgeProposals.tsx:334, 473, 560 (`Run #`); Repositories.tsx:1093 (`placeholder="payment-paypal"`, an example value, ambiguous); RepositoryAccess.tsx:275, 313 (`admin`)
- Problem: user-visible copy that is not in the vi/en catalogs. Static `t()` keys are all present; these literals are the gap.
- Evidence:

```
<Field label="Key" hint={t("wfs.keyHint")}>   // Workflows.tsx:286
<button ...>Revert to v{v.version}</button>   // Knowledge.tsx:1137
```

- Smallest fix: add catalog keys and use `t()`; reuse existing `kp.*`/`wfs.*` keys where equivalent.
- Scope: local

### UI-064 (G3-014) | item 8 (§7) | severity medium | Repositories

- Repositories.css:316-322 (`.repo-detail-side`)
- Problem: the sticky edit column is `max-height: 100vh` but the scrollport is `main.page` (shorter than the viewport by the topbar). The column is taller than its scrollport, so its lower part (Save button of the long edit form) is clipped until the user has scrolled the page to the end of the grid; the inner `overflow:auto` does not help because the visible window is smaller than its max-height.
- Evidence:

```
.repo-detail-side { min-width: 0; position: sticky; top: 0; max-height: 100vh; overflow: auto; }
```

- Smallest fix: `max-height: 100%` of the scroller is not available; use `max-height: calc(100dvh - var(--topbar-h) - var(--sp-8))` (token exists) so the column scrolls inside itself.
- Scope: local

### UI-065 (G3-015) | item 7 (§1, §2, §10) | severity low | WorkflowEditor

- WorkflowEditor.css (78 raw px `padding/margin/gap` declarations vs 2 `var(--sp-*)`; e.g. lines 11, 188-200, 480-520); `.wfe-publish input{padding:5px 10px}` (L145-152) and `.wfe-version select{padding:5px 10px 5px 0}` (L84-92) next to `.sm` buttons
- Problem: spacing is hard-coded off the 4/8/12/16/20/24/32 scale (14px, 9px, 11px, 5px) and the publish input/version select pick their own padding instead of the `--control-h-sm` height used by the adjacent buttons.
- Evidence:

```
.wfe-publish input { width: 170px; padding: 5px 10px; ... }
```

- Smallest fix: replace with `var(--sp-*)` and `min-height: var(--control-h-sm)` on those two inputs.
- Scope: local

### UI-066 (G3-016) | item 7 (§10) | severity low | WorkflowEditor, Workflows, Repositories

- WorkflowEditor.css:187-193 (`.wfe-pal-after` is not used by any tsx: dead); WorkflowEditor.css:587-590 (`color: var(--muted) !important` to beat `.wfe-sec-head svg`); WorkflowEditor.css:122, 481 (`margin-left:-1px`, `-8px`; the -1px joins button borders, so ambiguous); Workflows.css:150-168 (unprefixed `.tone-ai|human|logic|ship`, duplicated by `.wfe .tone-*` at WorkflowEditor.css:279-297); Repositories.css:417 (`.card-head + .repo-label`); ProfilePreview.tsx:20 imports all of `RunView.css` for the `.pp-*` rules at RunView.css:1296-1346
- Problem: dead CSS, an `!important`, a negative offset, and rules outside the page prefix/owner.
- Evidence:

```
.wfe-adv-chev { transition: transform 0.15s; color: var(--muted) !important; }
.tone-ai { --tone: var(--brand-700); --tone-bg: var(--brand-50); }   /* global, Workflows.css */
```

- Smallest fix: delete `.wfe-pal-after`; use `.wfe-sec-head .wfe-adv-chev` instead of `!important`; prefix/merge `.tone-*` into `.wfs-tone-*`/the `.wfe` copy; move `.pp-*` into a ProfilePreview.css.
- Scope: local (the `.tone-*` leak is shared)

### UI-067 (G3-017) | item 7 (§8, §10) | severity low | Repositories, Knowledge

- Repositories.css:537, 586 (`var(--text-2, inherit)` and `var(--border, rgba(0,0,0,0.08))`: neither `--text-2` nor `--border` is defined in styles.css, so the hard-coded fallback always wins and ignores the dark theme); Knowledge.css:60, 756 (`color: var(--surface)` on `background: var(--brand)`; §8 says use `--on-brand`)
- Problem: token misuse, hard-coded colour fallback and wrong foreground token.
- Evidence:

```
border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
.kp-count { background: var(--brand); color: var(--surface); }
```

- Smallest fix: `var(--line)`, `var(--ink-2)`, `var(--on-brand)`.
- Scope: local

### UI-068 (G3-018) | item 7 | severity low | Knowledge, Repositories, RepositoryAccess, ProfilePreview, WorkflowEditor, KnowledgeProposals

- Inline styles with hard-coded px: Repositories.tsx:491, 909; Knowledge.tsx:533, 1269-1271, 1306; WorkflowEditor.tsx:639, 921, 941, 974; KnowledgeProposals.tsx:541, 840; ProfilePreview.tsx:128, 138-160, 169, 187, 204, 210, 269, 274, 282
- Problem: spacing and layout set inline instead of the page stylesheet/tokens (`marginBottom: 8`, `width: 180`, `gap: 4`).
- Evidence: `<div className="muted small" style={{ marginBottom: 8 }}>` (Repositories.tsx:909)
- Smallest fix: move to prefixed classes using `--sp-*` (e.g. `pp-label`, `pp-chip`).
- Scope: local

### UI-069 (G3-019) | item 7 + 9 | severity low | KnowledgeProposals, RepositoryAccess, Knowledge

- KnowledgeProposals.tsx:219-232 (hand-rolled `role="tablist"` of `.kn-cat` buttons: no `aria-controls`, no arrow-key handling, no tabpanel); RepositoryAccess.tsx:247-253 (raw `<input>` search instead of `SearchInput`); Knowledge.tsx:1397-1426 (`KnowledgeAuditPanel`: unstyled `h2/p/div`, primary-filled refresh button with no loading state, `key={i}`)
- Problem: hand-rolled controls where `Tabs`/`Segmented`/`SearchInput`/`Button loading` exist; the tablist ARIA is half-implemented.
- Evidence:

```
<div className="kp-filter" role="tablist" ...><button role="tab" aria-selected={s === status} ...>
<button onClick={reload}>{t("kn.audit.refresh")}</button>
```

- Smallest fix: switch the filter to `Segmented` (or `Tabs`), the search to `SearchInput`, the audit refresh to `<Button variant="secondary" loading={loading}>`.
- Scope: local

### UI-070 (G3-020) | item 9 | severity medium | Workflows

- Workflows.tsx:336-359 (`WorkflowCard`)
- Problem: the whole card is `<article role="link" tabIndex=0 onKeyDown={e => e.key === "Enter" && open()}>` and contains a real `<button>` (Duplicate). Enter pressed on the Duplicate button bubbles to the article handler, so the page navigates to the workflow in addition to opening the drawer. Interactive content nested in `role="link"` is also invalid ARIA.
- Evidence:

```
onKeyDown={(e) => e.key === "Enter" && open()}
...<button className="ghost xs" onClick={(e) => (e.stopPropagation(), onDuplicate())} ...>
```

- Smallest fix: guard `e.target === e.currentTarget` in the key handler, or make the title an `<a href>` (anchor when the destination is directly available, §3) and keep the card click as a convenience.
- Scope: local

### UI-071 (G3-021) | item 9 | severity low | all files

- Untyped native `<button>` (no `type`; `Button` from ui.tsx defaults to `type="button"`). Workflows.tsx 175, 227, 241, 252, 353; WorkflowEditor.tsx 18 buttons (510, 522, 525, 536, 545, 571, 640, 643, 691, 710, 1031, 1048, 1169, 1202, 1545, 1630, 1633, 1636); Knowledge.tsx 293, 305, 311, 389, 474, 513, 534, 540, 677, 1089, 1125, 1140, 1312, 1315, 1404; KnowledgeProposals.tsx 200, 258, 267, 393, 815, 826, 842; Repositories.tsx 378, 386, 392, 405, 493, 513, 574, 593, 599, 739, 744, 823, 927, 1124, 1200; RepositoryAccess.tsx 233, 315, 318. ProfilePreview has none.
- Problem: §8 requires explicit button types; the Workflows create drawer is a `<form>` where this matters, the rest is latent.
- Evidence: `<button className="ghost sm" onClick={() => revalidate(only)}>` (RepositoryAccess.tsx:233)
- Smallest fix: add `type="button"` (or migrate to `Button`).
- Scope: local

### UI-072 (G3-022) | item 9 | severity low | WorkflowEditor, Repositories

- WorkflowEditor.tsx:969-985 (`JsonField` invalid state: red border via inline style, error `<small>` with no `aria-invalid`/`role="alert"`/`aria-describedby`); WorkflowEditor.tsx:650 (`.wfe-hint` is `aria-hidden` but carries the canvas help text); WorkflowEditor.tsx:1561-1591 (repo checkbox group is `div.field > span`, no `fieldset/legend` or `role="group"` label); Repositories.tsx:836-897 (`button.repo-card` contains `div`s, not phrasing content)
- Problem: state/labels not exposed to assistive tech.
- Evidence: `<div className="wfe-hint" aria-hidden><GitFork .../> {t("wfe.hint")}</div>`
- Smallest fix: add `aria-invalid`/`aria-describedby` to the textarea; use a `fieldset`; drop `aria-hidden` from the hint.
- Scope: local

### UI-073 (G3-023) | item 5 | severity low | Repositories, Knowledge, KnowledgeProposals

- Repositories.tsx:832 (`div.repo-none` "no match"); Knowledge.tsx:398 (`div.kn-none`); KnowledgeProposals.tsx:237-240 (empty list for a status filter, no action)
- Problem: empty/no-match states are a plain text box with no next step (clear filters / switch to "all"); Workflows already does this correctly (Workflows.tsx:235-246, `wfs.clearFilter`).
- Evidence: `<div className="repo-none">{t("repo.noMatch")}</div>`
- Smallest fix: use `EmptyState` with a `ghost sm` "clear filters" action like Workflows.
- Scope: local

### UI-074 (G3-024) | item 4 | severity low | WorkflowEditor, Repositories, Knowledge

- WorkflowEditor.tsx:1629-1639 (three launch buttons "Start", "Step mode", "Create (do not start)" with no hint of what each does); Repositories.tsx:491-514, 504 (test-connection / prepare / refresh all toast `repo.saved`, i.e. "saved"); Repositories.tsx:1200-1203 and Knowledge.tsx:1089-1091 (generic `kn.save` "Save"/"Lưu")
- Problem: labels or confirmations do not state the outcome.
- Evidence: `t("repo.saved")` used as the success message for `${action}` in `["test-connection","prepare","refresh"]`
- Smallest fix: a one-line `muted small` hint above the run buttons; per-action toast keys.
- Scope: local

### UI-075 (G3-025) | item 6 | severity low | ProfilePreview

- ProfilePreview.tsx:102-111, 185-186
- Problem: the preview request fires on every change of profile/inputs/repositories with no pending indicator; the previous graph stays visible while a new one loads, and an error `ErrorBox` (no retry) appears above stale data.
- Evidence: `api(...).then(d => !stop && (setData(d), setError(null))).catch(e => !stop && setError(e.message));` with no `loading` state.
- Smallest fix: `loading` state shown as a `Loader` in the existing profile row; pass `onRetry` to `ErrorBox`.
- Scope: shared (also used in WorkItems.tsx:1318)

### UI-076 (G3-026) | item 11 | severity low | all

- test/ui-quality.browser.ts:174-192 covers workflows, workflow-editor, knowledge, knowledge-detail, repositories, repository-detail, plus the workflow create drawer (L569-594).
- Not covered: `/knowledge/~proposals` (list and `/~proposals/:id` detail), `/knowledge/~audit`, `/knowledge/~new`, `/repositories?view=manage` (RepositoryAccessAdmin table, RepoForm, NewRepoDrawer), the workflow editor Run panel (QuickRun/ProfilePreview) and the repository-add drawer.
- Problem: these views have no overflow/second-scrollbar/screenshot check.
- Smallest fix: add the paths to the `routes` array (admin fixture needed for manage view).
- Scope: shared (test file)

### UI-077 (G3-027) | item 8 (§7) | severity low | Knowledge

- Knowledge.css:128-138 (`.kn-items { max-height: calc(100vh - 290px) }`) under the sticky `.kn-list` (L70-77)
- Problem: the list height is derived from `100vh` with a magic 290px instead of the `main.page` scroller; at short viewports or with the 3-row filter wrap the sticky column can exceed the scrollport.
- Evidence: `max-height: calc(100vh - 290px); min-height: 200px; overflow: auto;`
- Smallest fix: express the offset with `--topbar-h` and spacing tokens (`calc(100dvh - var(--topbar-h) - ...)`).
- Scope: local

---

## Checklist items with no finding

- Item 2: the only `justify-content: space-between` rules are Workflows.css:3 and Knowledge.css:103 (both have 2 children). Others use `margin-left:auto` groups (`.kp-bulk-actions`) or `.grow`.
- Item 8 tables: the only table (`.repo-access-table`) is inside `.table-wrap`; fixed widths found are icon sizes or have container/media fallbacks (`.wfs-grid` uses `min(100%,320px)`, `.repo-*` collapse at 1100/900px, editor collapses at container 900px).
- Item 9 focus: a global `:focus-visible` exists (styles.css:223); Drawer (ui.tsx) already handles name, Escape, focus trap and restore for the Workflows/Repositories/Knowledge drawers.
- Item 10 static keys: every static `t("...")` key in the 7 files resolves in vi and en.

## Group 4 — Integrations, Settings, Agent settings, Autonomy/Learning, dialogs, components, Agent Office

### UI-078 (G4-001) | item 9 | severity low | many pages

- Native `<button>` without `type` (the repo rule in §8 and checklist item 9 is "explicit button types"). None sits inside a `<form>` today, so no accidental submit, but it is a rule violation in ~75 places.
- Locations:
  - pages/Integrations.tsx 76, 140, 257, 326, 330, 410, 414, 557, 567, 578, 582, 641, 702, 767, 925, 929, 932, 1087, 1091, 1196, 1199, 1348, 1357, 1410, 1415, 1608, 1621, 1625, 1629
  - pages/Settings.tsx 315, 653, 660, 667
  - pages/AutonomyPolicies.tsx 62, 143; pages/AutonomyInsights.tsx 181; pages/RepositoryWorkspace.tsx 93
  - office/AgentOfficePage.tsx 160, 177; office/AgentDetailsPanel.tsx 100; office/OfficeToolbar.tsx 89, 97, 112, 127
  - office/GlobalChibiCompanion.tsx 249, 332, 390, 398, 402, 416
  - ProviderHandoff.tsx 110, 146, 163, 227; StepAgentOverride.tsx 29, 32; PageBoundary.tsx 31
- Evidence: `<button className="sm ghost" onClick={onEdit}>` (Integrations.tsx:929); `<button className="primary" onClick={reload}>` (PageBoundary.tsx:31)
- Smallest fix: add `type="button"`, or use `Button` from ui.tsx (it defaults to `type="button"`).
- Scope: shared (PageBoundary, ProviderHandoff, StepAgentOverride, GlobalChibiCompanion render on other pages)

### UI-079 (G4-002) | item 7 (§10) | severity medium | shared (every `<Dialog>` / `dialog.confirm`)

- Dialog.css:1 selector is `c.ui-dialog.dialog` (stray leading `c`), so the whole first rule never matches any element.
- Problem: `inset:0; margin:auto; height:fit-content; max-height: calc(100dvh - 32px); overflow:auto; border; color` are dead. The dialog falls back to the generic `.dialog` rule (styles.css:1236: `top: 12vh; transform: translateX(-50%)`), so a tall dialog is offset 12vh down and can run past the viewport bottom (not verified in a browser; native `dialog:modal` UA max-height is relative to the viewport, not to the 12vh offset).
- Evidence:

```
Dialog.css:1  c.ui-dialog.dialog {
Dialog.css:2    inset: 0;  transform: none;  margin: auto;
Dialog.css:5    max-height: calc(100dvh - 32px);  overflow: auto;
```

- Smallest fix: delete the leading `c`.
- Scope: shared (31 `dialog.*` call sites plus `Dialog` users)

### UI-080 (G4-003) | item 6 | severity medium | Integrations (Background Git, Telegram)

- Mutations fired from `onChange` of a checkbox/select have no busy/disabled guard. `act()` only protects the element found by its global click listener (`closest("button, [role=button]")`, ui.tsx:765), so for a checkbox/select it either does nothing or grabs a stale earlier click target.
- Problem: toggling "Background Git" or changing the Telegram mode twice quickly sends two requests. Because `act()` reuses the last clicked button (for example the accordion header `.ig-head` that opened the panel, for up to 60 s) the wrong control shows `aria-busy`/disabled while the real one stays editable.
- Evidence:

```
Integrations.tsx:1679  onChange={(e) => void toggle(e.target.checked)}   // BackgroundGit, no disabled while saving
Integrations.tsx:1857  onChange={async (e) => { if (await act(() => api("/api/integrations/telegram/mode", {...
```

- Smallest fix: keep a local `busy` state and `disabled={busy}` on those two controls (same pattern as Bitbucket/GitHub `busy`).
- Scope: local (the act() trigger quirk is shared: ui.tsx:765-790)

### UI-081 (G4-004) | item 3 (+6) | severity medium | Settings

- Settings stacks several independent "Save" paradigms with brand-filled primaries and two bottom-anchored bars:
  - fixed global bar `.set-savebar` (Settings.tsx:633, Settings.css:~825, `position: fixed; bottom: var(--sp-5); z-index: 30`) with primary Save;
  - AgentSettings header `Button` "Save provider" (primary, always enabled even when nothing is dirty, AgentSettings.tsx:~335) plus the selected provider tab drawn as `variant="primary"` (AgentSettings.tsx:~392) plus a second sticky bar `.agent-savebar` (Settings.css:449, `position: sticky; bottom: var(--sp-3)`) with another primary Save;
  - AutonomyPolicies primary Save (AutonomyPolicies.tsx:143), Intake policies not audited here.
- Problem: more than one primary per area; the user cannot tell what a given Save commits (provider doc vs operator settings vs one policy). When agent settings and any other section are dirty, `.agent-savebar` (sticky, z-index 5) and `.set-savebar` (fixed, z-index 30) both sit at the viewport bottom and overlap. Ctrl+S is bound twice (Settings.tsx:219 and AgentSettings.tsx:240).
- Evidence:

```
AgentSettings.tsx   <Button size="sm" loading={busy} onClick={() => void save()}>{t("set.saveProvider")}</Button>   (header, no dirty gate)
AgentSettings.tsx   variant={provider === key ? "primary" : "secondary"}   (provider tabs)
Settings.css:449    .agent-savebar { position: sticky; bottom: var(--sp-3); z-index: 5; ... }
```

- Smallest fix: make the header "Save provider" `variant="secondary"` or `disabled={!dirty}` with a visible reason, render selected provider tab with a non-primary selected style (`aria-selected` styling), and keep one bottom bar visible at a time.
- Scope: local (Settings)

### UI-082 (G4-005) | item 1/2 | severity low | Settings

- The section rail `SECTIONS` (Settings.tsx:56-67) lists 6 sections, but the page also renders `#set-autonomy`, `#set-isolation`, `#set-intake`, `#set-intake-queue` (AutonomyPolicies.tsx:36, AgentIsolation.tsx:21, Intake.tsx:87/284). They have no nav entry and no scroll-spy highlight; type `SectionId` also lists dead ids `"models" | "providers"` (Settings.tsx:54-55).
- Problem: four sections cannot be reached from the rail, and the rail highlight stays on the previous section while the user reads them. Their "unsaved/saved" flag pattern (`set-flag`) is also missing.
- Evidence: `{ id: "agents", icon: Bot, keys: [] }, { id: "budget", ...}, ... { id: "work", icon: Inbox, ...}` (no autonomy/isolation/intake)
- Smallest fix: add rail entries (and i18n keys `set.nav.*`) for the four existing sections; drop unused ids.
- Scope: local

### UI-083 (G4-006) | item 1 (+7) | severity medium | Insights: Autonomy, Learning

- `InsightsPage` renders `<AutonomyInsights/>` / `<LearningInsights/>` for `#/insights/autonomy` and `#/insights/learning` (pages/Insights.tsx:394-395) but nothing links to them: a grep for `insights/autonomy|insights/learning` in `*.tsx|*.ts` finds no `href`/`navigate`; the evaluation page tabs are only health/usage/performance/workflows (pages/insights/AgentEvaluation.tsx:112). Both pages also start with a hand-rolled `<h2 style=...>` instead of `PageHeader` (DESIGN.md: "every page starts with it") and have no way back (no crumbs/tabs).
- Evidence:

```
AutonomyInsights.tsx:51   <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
LearningInsights.tsx:27   <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
```

- Smallest fix: use `PageHeader` with crumbs back to Insights and add a link/tab from the evaluation tabs; or document them as deep-link only.
- Scope: local (needs an entry point in shared Insights nav if linked)

### UI-084 (G4-007) | item 7/8 (§6, §10) | severity medium | AutonomyInsights, AutonomyPolicies, AgentIsolation, RepositoryWorkspace

- Tables rendered without `.table-wrap` / focusable named scroll region, and with no page-prefixed CSS:
  - AutonomyInsights.tsx:~156 `<table className="table">` (6 columns, no wrapper; `#`/numeric ids left aligned)
  - AgentIsolation.tsx:48 `<table className="small">`
  - RepositoryWorkspace.tsx:~52 `<table className="repo-ws-table">` (CSS is in Repositories.css, ok) with an empty `<th />` (no accessible name for the action column)
- Problem: at 390 px only the global fallback `table:not(.ins-table){display:block; overflow-x:auto}` (styles.css:2177) applies, which turns the table into a block (against §6) and the scroll region has no name/focus. AutonomyPolicies renders policy rows as `div`s with ad-hoc inline flex instead of a table or list (AutonomyPolicies.tsx:46-77).
- Evidence: `<table className="table">` (AutonomyInsights.tsx) with no `.table-wrap` parent; `<th />` (RepositoryWorkspace.tsx:~57)
- Smallest fix: wrap in `<div className="table-wrap">`, give the empty header `<th><span className="sr-only">...</span></th>`.
- Scope: local

### UI-085 (G4-008) | item 7 (§1, §10) | severity low | AutonomyPolicies, AutonomyInsights, LearningInsights, EvidenceGate, HandoffPreview, ProviderHandoff, StepAgentOverride, Cost, AgentDetailsPanel

- Spacing, flex layout and scroll limits are set through inline `style={{...}}` with literal px instead of `--sp-*` tokens and page-prefixed CSS.
- Locations (style={{ lines): AutonomyPolicies.tsx 49, 70, 113, 116, 140; AutonomyInsights.tsx 51; LearningInsights.tsx 27, 59; EvidenceGate.tsx 60, 62, 65, 86, 91, 92, 124, 126, 137, 139, 146, 152, 156, 168, 173; HandoffPreview.tsx 56, 67, 81, 88; ProviderHandoff.tsx 104; StepAgentOverride.tsx 24; components/Cost.tsx 100; office/AgentDetailsPanel.tsx 141, 285.
- Evidence: `style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}` (EvidenceGate.tsx:60)
- Smallest fix: move to classes (`ag-*`, `ev-*`, `handoff-*`) using `--sp-*` / `.row` / `.stack`.
- Scope: local, but EvidenceGate/HandoffPreview/ProviderHandoff are shared with StepInspector/RunView.

### UI-086 (G4-009) | item 10 | severity medium | many

- Hard-coded visible copy (not through `t()`); all keys passed to `t()` that I could resolve exist in vi and en, so the gap is literals only.
- Locations:
  - Office toolbar: `Preview` (OfficeToolbar.tsx:95, key `office.preview` already exists and is used at AgentOfficePage.tsx:161), `Animation` (104, 108); `Run #` (AgentOfficePage.tsx:130); `attempt #` (AgentDetailsPanel.tsx:116); `Hasaki-chan` default/fallback name (GlobalChibiCompanion.tsx:34, 367); `aria-label="Hasaki (placeholder mark)"` (office/brand.tsx:18)
  - AgentSettings: toast `"Provider saved"` (229); `"loading"`, `"no cache"`, `Saved selections remain available when discovery fails.` (418-421); `aria-label` `... role configuration` (487), `... model` (593), `... reasoning effort` (612, 648), `... timeout (ms)` (659); `(saved; unavailable)` (637); `account/CLI default`, `model:`, `effort:`, `timeout:` (521, 560-580)
  - AgentValueFields.tsx:259 `${ariaLabel} suggestions`; StepAgentFields.tsx:168 `label="Step"`; raw enum option labels `disabled/manual/automatic` (66-68) and `MICRO/FAST/STANDARD/DEEP` (191-193)
  - AutonomyPolicies.tsx 52, 55, 80-82, ~108 (`global`, `owner`, `repository`, `shadow`, `≤`); AutonomyInsights.tsx 103-107 (`p50`, `p95`, `min`, `tokens`), 162 (`commit`), 174 (`PASS`/`FAIL`)
  - Integrations.tsx:1184 `TLS`; Settings.tsx:660/662 `title="Ctrl+S"`, `<kbd>Ctrl S</kbd>` (also wrong on macOS where Cmd+S is bound)
  - Example placeholders: Integrations.tsx 499, 621, 693, 1106, 1113, 1120, 1127, 1318 (`you@example.vn`), 1325, 1573, 1795ff (`123456789:AA…`); Settings.tsx 512, 539 (these are format examples; ambiguous under the rule "no hard-coded copy", listed for completeness)
- Evidence: `<Sparkles size={15} /> Preview` (OfficeToolbar.tsx:95); `setNote({ text: "Provider saved", ok: true })` (AgentSettings.tsx:229)
- Smallest fix: add catalog keys (vi + en) and use `t()`; for enum values reuse existing option labels.
- Scope: local per file; Office toolbar and GlobalChibiCompanion are shared.

### UI-087 (G4-010) | item 5 | severity medium | Integrations, ProviderHandoff, StepAgentFields

- Disabled controls without a visible reason, or with a visible reason not linked via `aria-describedby`.
- Locations:
  - Integrations.tsx 142 (PasteForm Save, disabled when empty), 560 (SigNoz enable/update: also requires `token` even in session mode, so Save stays disabled when only access/refresh tokens are typed; possible logic bug, outside this audit's remit), 1350, 1410, 1608, 1621, 1625, 1580, 1798, 1806 (Telegram "find chats"), 1952 (prefs Save)
  - Integrations.tsx:1880 Telegram Connect `disabled={st.mode === "off"}`: reason text exists (`ig.tg.modeOff`, ~1869) but is not linked
  - ProviderHandoff.tsx:227 "Confirm and resume": reason is shown in `<p role="status">{resumeHold}</p>` (221-225) but the button has no `aria-describedby`
  - StepAgentFields.tsx:252 retry backoff `disabled={!value.retry}` with no hint
- Evidence: `<button className="sm" disabled={busy || !token || !selected} onClick={save}>` (Integrations.tsx:1621); `{resumeHold && <p ... role="status">` followed by `<button ... disabled={... || !confirmed}>` (ProviderHandoff.tsx)
- Smallest fix: give the hint paragraph an `id`, add `aria-describedby` on the button; for "empty required field" disabled buttons a one-line hint under the field (or let the button stay enabled and validate on click). Rule is ambiguous for "disabled until required input is typed": quoted as-is from item 5 ("A disabled control shows why as visible text, linked with aria-describedby").
- Scope: local

### UI-088 (G4-011) | item 3 | severity low | Integrations

- Destructive actions (Disconnect, Remove, Delete, clear token) use the same `.sm ghost` style as the safe actions next to them (Test, Check session, Edit) inside the same `.ig-actions` / `.ig-db-actions` row, with no separation. Only DB delete and GitLab instance removal have a confirm dialog; the other 10 clear/disconnect calls act immediately.
- Locations: Integrations.tsx 257, 330, 414, 582, 702, 767 (`ig.disconnect`), 1357, 1415, 1629, ~1820 (`ig.removePlatform`), 932 (DB `common.delete`, between Edit and the card end), 1554 (GitLab remove instance icon button directly after the instance `select`).
- Evidence: `<button className="sm ghost" onClick={onEdit}>` then `<button className="sm ghost" onClick={onDelete}>` (Integrations.tsx:929-934)
- Smallest fix: use `Button variant="danger"` (or `.quiet` + `margin-left:auto` group) for the destructive item.
- Scope: local

### UI-089 (G4-012) | item 7 | severity low | Dialog, Integrations, Office

- Hard-coded colours/fallbacks and an undefined token instead of the theme tokens:
  - DialogHost.css: `var(--brand, #16a34a)`, `var(--st-err, #dc2626)`, `var(--st-warn, #d97706)` (`--st-warn` is not defined; the token is `--st-wait`, so warning dialogs always take the hex), `color: #fff` on `.app-dialog-confirm.danger` (should be a foreground token; and `button.danger` already provides the background, styles.css:299), px spacings (`gap: 16px`, `padding: 20px 20px 16px`)
  - Integrations.css:325 `border: 1px solid var(--border, rgba(0,0,0,0.08))`: `--border` is not a token (it is `--line`), so the card border is a fixed 8% black, nearly invisible in the dark theme
  - office.css:621-626 `.o-btn { color: #fff !important; text-decoration: none !important }` (links used at AgentDetailsPanel.tsx:153, 214); `.office-preview-ribbon` hex gradient `#fff4d6/#ffe8a8/#5b3b00/#f0b429` (a banner, not scene art)
  - Integrations.css:311 `animation: none !important` duplicates the intentional global reduced-motion override
  - Settings.css: `font-size: 11px` literal in ~10 rules where `--fs-xs` exists
- Evidence: `background: color-mix(in srgb, var(--st-warn, #d97706) 16%, transparent);` (DialogHost.css); `border: 1px solid var(--border, rgba(0, 0, 0, 0.08));` (Integrations.css:325)
- Smallest fix: switch to `--st-wait`, `--line`, `--on-brand`; drop `!important`.
- Scope: DialogHost.css is shared.

### UI-090 (G4-013) | item 7 (§10) | severity low | Settings.css, Integrations.css

- Dead CSS: Settings.css `.set-star` (671), `.set-matrix*` (686-740), `.set-providers` (745), `.set-provider*` (750-780): no `.tsx` uses these classes (grep over all of `web/src`). Integrations.css `.ig-note` (151) and `.ig-chats .is-sel` (168) are unused too.
- Evidence: `grep -rn "set-matrix\|set-providers\|ig-note" --include=*.tsx web/src` returns nothing.
- Smallest fix: delete the rules (§10 "delete superseded rules").
- Scope: local

### UI-091 (G4-014) | item 9 | severity medium | Settings, Integrations

- `Field` renders `<label class="field">` around its children (ui.tsx:585). Several call sites put more than one interactive control, or another `<label>`, inside it:
  - Settings.tsx:479-502 sensitive providers: `Field` > `span.set-chips` > five `<label class="set-chip">` with checkboxes (nested labels, invalid HTML; the field's accessible name is the whole text, clicking the outer label text toggles the first chip)
  - Integrations.tsx:1544-1560 and 1569-1585 (`select`/`input` plus a button inside one label), 1599-1612 (textarea plus "Save SSH key" button inside the label)
- Problem: assistive tech announces the control name as "Instance Remove instance ..." and label clicks can activate the wrong control.
- Evidence: `<Field label={t("ig.gl.sshKey")} ...><textarea .../><button className="sm ghost" ...>` (Integrations.tsx:1599-1609)
- Smallest fix: render the button after the `Field` (inside `.ig-actions`), and for chip groups use a `fieldset/legend` or a `div role="group" aria-labelledby` instead of `Field`.
- Scope: local

### UI-092 (G4-015) | item 9 (§8) | severity medium | AgentValueFields (ModelCombobox), used in Settings and StepInspector

- `role="combobox"` input has `aria-expanded`, `aria-controls` but no `aria-activedescendant`; options are `div role="option"` without ids (AgentValueFields.tsx:161-170, 262-275). Arrow-key focus moves only visually (`is-focused`), screen readers get no active option. The clear (`agent-combo-clear`, 220) and toggle (235) buttons are `tabIndex={-1}` and act on `onMouseDown` only, so they cannot be operated with keyboard or switch access (arrow keys are the only alternative).
- Evidence:

```
AgentValueFields.tsx:161  role="combobox" aria-expanded={open} aria-controls={open ? listId : undefined}
AgentValueFields.tsx:229  <div key={opt.key} role="option" aria-selected={opt.active} ...onMouseDown=...
```

- Smallest fix: give options `id={`${listId}-${idx}`}` and set `aria-activedescendant` on the input; use `onClick` (keep `onMouseDown preventDefault`) on the two icon buttons.
- Scope: shared (StepAgentFields in StepInspector/workflow editor)

### UI-093 (G4-016) | item 9 | severity low | AgentSettings, GlobalChibiCompanion, HandoffPreview

- ARIA wiring gaps:
  - AgentSettings provider tabs `role="tab"` (390) and profile tabs (462) have no `aria-controls`/`tabindex` roving/arrow-key support; the provider panel (`.agent-provider-panel`) has no `role="tabpanel"`; the profile `tabpanel` (486) has `aria-label` only.
  - GlobalChibiCompanion.tsx avatar `aria-controls="companion-title"` points at the heading, not the dialog; the panel (`role="dialog"`) does not receive focus on open (Escape and focus return exist).
  - HandoffPreview.tsx 56, 67, 81, 88: `<pre style="max-height; overflow:auto">` scroll regions have no `tabindex`/name (§6 asks for focusable named scroll regions).
- Evidence: `aria-controls="companion-title"` (GlobalChibiCompanion.tsx:~420); `<pre style={{ maxHeight: 140, overflow: "auto", ...}}>` (HandoffPreview.tsx:56)
- Smallest fix: use `Tabs` from ui.tsx for the provider/profile tabs, point `aria-controls` at the panel id, add `tabIndex={0}` + `aria-label` to the `pre` regions.
- Scope: local; GlobalChibiCompanion and HandoffPreview shared.

### UI-094 (G4-017) | item 5/6 | severity medium | Integrations (agent accounts), RepositoryWorkspace

- Failure cause or progress is not shown:
  - AgentAccounts (Integrations.tsx:2000-2020): the API type has `error?: string` but the card renders only `ig.cli.unavailable`, with no cause and no next step.
  - RepositoryWorkspace.tsx:28 `const { data, reload } = useApi(...)`: `error` and `loading` are ignored, so after opening the `<details>` nothing appears while loading and a failed request leaves an empty panel.
- Evidence: `{provider.ok ? t("ig.cli.available") : t("ig.cli.unavailable")}` (Integrations.tsx:2013); `const { data, reload } = useApi<{` (RepositoryWorkspace.tsx:28)
- Smallest fix: render `provider.error` as `.muted small`; use `SkeletonRows`/`ErrorBox onRetry={reload}` like the other sections.
- Scope: local

### UI-095 (G4-018) | item 1/3 | severity low | Integrations (Telegram), Office toolbar

- Telegram panel (Integrations.tsx:1730-1990): two primary buttons in one expanded row (bot `Save` 1795, `Connect` 1880), connection actions in two separate `.ig-actions` rows, the preferences `Save` is a lone `ghost sm` after the grid (1950), and "Send test message" (`ig.tg.test`) sits at the very bottom after the collapsible legacy block (1975), far from Connect/Disconnect that it tests.
- Office: "Preview" exists as a select option (`office.preview`, OfficeToolbar.tsx:70), as a toolbar toggle button (89-96) and as a link in the idle card (AgentOfficePage.tsx:160): three entry points for one mode; the toolbar is `position: sticky` and wraps (office.css:93-103) so at 390 px it can occupy several rows (not verified).
- Smallest fix: put Test next to Connect/Disconnect; make Connect secondary until Save is done; keep one Preview entry.
- Scope: local

### UI-096 (G4-019) | item 3 (§3) | severity low | Cost

- components/Cost.css:99-103 `.cost-table th, td { text-align: left }`; numeric columns (attempts, cost, wasted, tokens, run count) in the three tables in Cost.tsx:~265-345 are left aligned and without `font-variant-numeric: tabular-nums` (only `.cost-cell` has it). §3 requires right-aligned tabular numbers including headers. Status column prints the raw status string (`r.status`, `.small`) instead of `Badge`.
- Evidence: `.cost-table th, .cost-table td { text-align: left; ... white-space: nowrap; }`
- Smallest fix: add `.cost-table .num { text-align: right; font-variant-numeric: tabular-nums }` (or `DataTable` numeric format), use `<Badge s={r.status}/>`.
- Scope: shared (CostPanel appears in RunView and WorkItems)

### UI-097 (G4-020) | item 11 | severity low | routing/verification

- `test/ui-quality.browser.ts` routes (lines 174-192) include integrations, office, repositories, insights/usage, evaluation, but not `/settings` (AgentSettings, AutonomyPolicies, AgentIsolation, Settings savebars), `/insights/learning`, `/insights/autonomy`, `/office/preview`, nor the Dialog host (confirm/prompt). The heaviest findings above (G4-002, G4-004, G4-014) are in uncovered areas.
- Smallest fix: add `["settings", "/settings"]`, `["office-preview", "/office/preview"]`, `["autonomy", "/insights/autonomy"]`, `["learning", "/insights/learning"]` to `routes`.
- Scope: shared test

## Group 5 — Production errors, Insights, analytics, Bug hunter, Code scan

### UI-098 (G5-001) | item 9 | severity high | Insights (legacy, Failures tab)

- Insights.tsx:838-846 (Table column render for run link)
- Problem: The run link is an `<a>` with `onClick` and no `href`, so it is not focusable and not keyboard operable (and not a real link: no middle-click/copy). Presentation is faked with inline `cursor: pointer`.
- Evidence:

```
<a onClick={() => navigate(`/runs/${r.run_id}/${r.step_key}`)}
   style={{ cursor: "pointer" }} className="mono">#{r.run_id} · {r.step_key}</a>
```

- Smallest fix: `<a className="mono" href={`#/runs/${r.run_id}/${r.step_key}`}>` (same pattern as `runLink` in analytics/shared.tsx:219); drop the inline style.
- Scope: local

### UI-099 (G5-002) | item 9 | severity medium | Production Errors > Incidents

- ProdErrors.tsx:539 (`button.pe-head`) containing :569-581 (`span.pe-wi role="link" tabIndex={0} onClick`)
- Problem: An interactive pseudo-link is nested inside a `<button>` (invalid, unreliable for AT). Its `onKeyDown` handles only Enter, and Enter on the focused inner span also bubbles to the outer button semantics, so keyboard users cannot reliably open the work item without toggling the row.
- Evidence:

```
<button className="pe-head" aria-expanded={open} onClick={onToggle}> ...
  <span className="pill chip-brand pe-wi" role="link" tabIndex={0}
    onClick={(e) => (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))}
    onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), navigate(...))}>
```

- Smallest fix: render the work-item pill as plain text inside the row header (the same link already exists in the expanded body, ProdErrors.tsx:378 `a.pe-fix-code`), or restructure the head so the toggle button and the pill are siblings.
- Scope: local

### UI-100 (G5-003) | item 10 | severity medium | Insights > Agent Evaluation; Production incident detail

- insights/AgentEvaluation.tsx:95 uses `t("an.in")`: key exists in neither vi nor en (checked against messages merge of catalog.ts + analytics.ts + messages.ts). prodErrors/ProductionIncident.tsx:177 `label: "time"` goes through `DataTable` which renders `t("an.time")`: also missing in both locales.
- Problem: Users see raw keys ("an.in", "an.time") as visible text (a table header and part of a cell).
- Evidence:

```
`... · ${t("an.in")} ${r.token_samples}/${r.samples}; ...`        // AgentEvaluation.tsx:95
{ key: "created_at", label: "time", render: ... }                 // ProductionIncident.tsx:177
```

- Smallest fix: add `in` and `time` to the `copy` map in i18n/analytics.ts (both languages), or pick an existing key.
- Scope: local (catalog files are shared but only these two call sites are affected)
- Note: all other static `t("...")` keys (686 checked) and the `label: "x"`/`<Metric label="x">` keys resolve in vi and en.

### UI-101 (G5-004) | item 10 | severity low | several pages

- Hard-coded visible English, not in either catalog:
  - insights/EvaluationEvidence.tsx:23 `label: "Provider"` (table header); :60 `?? "pending"`; :67 `workflow #`
  - insights/AgentEvaluation.tsx:84 and insights/QualityLoop.tsx:145 `p50 / p95`
  - insights/EvaluationRecommendations.tsx:95 `?? "Unknown"`; :114 `evaluation #{id}`
  - insights/ContextPairedStudy.tsx:42 `?? "legacy"`
  - ProdErrors.tsx:387 `Run #`, :639 `<dt>Image</dt>`, :668 `error:`; prodErrors/ProductionOverview.tsx:848 and ProductionIncident.tsx:195 `Run #` (catalog already has `an.bh.run` with an id param)
  - analytics/shared.tsx:16-17 `fmt(..., "ms")` appends English units `min` / `s` in the Vietnamese UI (used by every analytics table).
  - Insights.tsx:1216-1217 `<span className="kbd">` commands (acceptable: code), `humanize(k)` for dynamic extras (Insights.tsx:933-944) produces untranslated labels from API keys.
- Problem: strings visible in the vi locale are English-only.
- Smallest fix: move to `t()` keys (e.g. reuse `an.bh.run`, add `an.p50p95`, `an.provider`); units via locale-aware formatter (`Intl.NumberFormat` with `unit`).
- Scope: shared for shared.tsx:16-17 (affects all analytics tables), otherwise local.

### UI-102 (G5-005) | item 7 | severity medium | Production incident detail

- prodErrors/ProductionIncident.tsx:88 vs prodErrors/ServiceDetails.tsx:68 and :44
- Problem: The incident back link is `<a className="ghost sm" href>`. styles.css only styles `button.ghost` and `.btn.ghost` (styles.css:265-272), so a bare `a.ghost` gets no button chrome; the same control on the sibling page is a `<button className="ghost sm">`. Result is an inconsistent, unstyled back link on the incident page. (ServiceDetails also uses a button to navigate where an anchor to `#${returnTo}` would do, §3.)
- Evidence:

```
<a className="ghost sm" href={`#${returnTo}`}>  // ProductionIncident.tsx:88
<button className="ghost sm" onClick={back}>    // ServiceDetails.tsx:68
```

- Smallest fix: `className="btn ghost sm"` on the anchor (DESIGN.md: `<a class="btn ghost">`); ideally both pages use the same element.
- Scope: local

### UI-103 (G5-006) | item 8 (§6, §3) | severity medium | Insights > Quality loop (legacy Failures tab)

- insights/QualityLoop.tsx:109, :138, :186 (`table.cost-table`), components/Cost.css:92-104
- Problem: Three tables (the providers one has 8 columns) are rendered directly in the card, not inside `.table-wrap`. `.cost-table td/th` is `white-space: nowrap`, so at 390 px the table overflows the card/page. Numeric columns are also left-aligned (`text-align: left`), against §3.
- Evidence:

```
<table className="cost-table"> <thead><tr><th>{t("ql.provider")}</th> ... 8 <th> ... // QualityLoop.tsx:138-147
.cost-table th,.cost-table td { text-align: left; padding: 6px 12px; white-space: nowrap; } // Cost.css:98
```

- Smallest fix: wrap each table in `<div className="table-wrap">` (and give numeric cells the existing `ins-num`/right alignment); ideally swap to `DataTable`.
- Scope: local (Cost.css is shared with Cost.tsx but the wrapper change is local)

### UI-104 (G5-007) | item 7 + 9 | severity medium | Production overview

- prodErrors/ProductionOverview.tsx:505-518, :640-653 (metric toggles), :694-715 (service series toggles), :288-303 (donut legend buttons); CSS analytics `.an-health-toggle` production-errors.css:186-218
- Problem: Hand-rolled segmented controls (`.an-health-toggle button.on`) duplicate `Segmented` from ui.tsx but omit `aria-pressed`; the series toggles show selected/hidden state only through colour/class (`on`/`muted`). The CSS re-implements pills with hard-coded `999px`/`5px 10px` instead of control tokens (§2). The donut legend "others" row is a real button whose handler is `undefined` (pressable no-op).
- Evidence:

```
<div className="an-health-toggle" role="group" aria-label={t("an.metric")}>
  <button className={barMetric === "events" ? "on" : ""} onClick={() => setBarMetric("events")}>
<button key={key} className={hidden ? "muted" : "on"} onClick={...}>   // no aria-pressed
onClick={() => (r.aggregate ? undefined : onSelect(r))}                // no-op button
```

- Smallest fix: metric toggles: `<Segmented options=[["events",...],["fingerprints",...]] .../>`. Series toggles: keep the markup, add `type="button" aria-pressed={!hidden}`. Legend: render the aggregate row as a non-button element.
- Scope: local

### UI-105 (G5-008) | item 5 | severity medium | Production Errors, Code scan, Insights evaluation

- Disabled primary actions with no visible reason (neither text nor `aria-describedby`):
  - ProdErrors.tsx:258 Scan disabled when `!chosen.length` (only `customError` is shown, ProdErrors.tsx:249-251)
  - ProdErrors.tsx:903-906 Scan now disabled with no connected source (the reason is in a separate status line at :930-943, not linked)
  - prodErrors/CodeScan.tsx:276 `disabled={!targets.length}` (select placeholders hint, but no text states why)
  - insights/ContextPairedStudy.tsx:49-50 disabled `!a || !b || a === b` (equal selection gives no reason)
  - insights/EvaluationRecommendations.tsx:77 `disabled={!category.trim()}`
  - insights/ProviderExperimentForm.tsx:174, :181 disabled when `mode !== "fixture"` / live without approval / no suite
  - prodErrors/bugHuntParts.tsx:647, prodErrors/IncidentWorkbench.tsx:210 disabled `!chosen.length` (a hint `an.bh.repositoriesHint` exists in the former, not linked)
- Problem: users get a dead button and must guess why. §12.5 requires visible text linked with `aria-describedby`; tooltips (e.g. `title=` on :401, :412) do not count.
- Evidence:

```
<button className="sm" disabled={busy || !chosen.length || !!customError} onClick={start}>   // ProdErrors.tsx:258
<button className="sm" disabled={!category.trim()} onClick={generate}>                       // Recommendations:77
```

- Smallest fix: render a `<small className="muted" id=...>` next to each button (existing `pe-warn`/`muted small` patterns) with the missing-input reason and add `aria-describedby`.
- Scope: local

### UI-106 (G5-009) | item 3 | severity medium | Incidents row, Settings tab, Insights evaluation

- Several brand-filled primary buttons in one area:
  - Expanded incident row (ProdErrors.tsx:491-696): `Investigate` (FixRef, :412, default primary), `Start bug hunt` (BugHunter.tsx:46-57, primary when no hunt), and IncidentWorkbench `Run runtime` (IncidentWorkbench.tsx:381-389, primary) can all show at once.
  - Settings tab: `Scan now` (ProdErrors.tsx:903), Scan panel `Scan` (:258), Schedule `Save` (:729) are all primary.
  - insights/EvaluationRecommendations.tsx:77 `Generate` and :137 `Save policy` both primary in one panel; insights/ProviderExperimentForm.tsx:76 `Publish suite` and :174 `Queue` both primary.
  - prodErrors/CodeScan.tsx:727-741: the open-finding actions are `Fix` (primary) / `Resolve` / `Dismiss` (both `ghost xs`) in one row, so the low-risk and discarding actions are not separated (ambiguous against §12.3: Dismiss asks for a reason in a dialog, but it is not styled `danger` or separated).
- Problem: no single dominant action per area; destructive-ish action adjacent to safe ones.
- Evidence:

```
<button className="sm" disabled={busy} onClick={onInvestigate}>            // FixRef primary
<Button size="sm" variant={huntId ? "secondary" : "primary"} ...>          // BugHunterInline
<Button size="sm" icon={<Activity .../>} loading={busy} ...>              // Workbench primary
```

- Smallest fix: keep one `primary` per area (e.g. Investigate primary, Start hunt and Run runtime `variant="secondary"`; Save `ghost` when not dirty; Generate stays primary, Save policy secondary).
- Scope: local

### UI-107 (G5-010) | item 6 | severity medium | Incident workbench

- prodErrors/IncidentWorkbench.tsx:278-300 (`fix`), :363-370 (`Button onClick={() => fix(c)}`)
- Problem: `fix` calls `api()` after a confirm dialog without `act()`, a busy state, or `disabled`/`loading` on the button, so after confirming, the button can be pressed again while the request is in flight. (The response has a `created` flag, which suggests the backend dedupes, so this is double-submit risk rather than certain duplication.)
- Evidence:

```
const r = await api<{ created: boolean; run_id: number }>(`/api/prod-errors/${fingerprint}/workbench/fix`, { cause_key: c.key, confirm: true });
<Button size="sm" variant="secondary" icon={<Wrench size={13} />} onClick={() => fix(c)}>
```

- Smallest fix: wrap the call in `act(...)`, or add `const [fixing,setFixing]` and pass `loading` to the Button (same pattern as `FixTaskButton`, bugHuntParts.tsx:181-216).
- Scope: local
- Other mutation buttons checked: ProdErrors (`link`, `ignore`, `investigate`, `Schedule` Save), CodeScan, Recommendations, ContextPairedStudy, ProviderExperimentForm, QualityLoop all use `act()` (which disables the clicked button, ui.tsx:787-811) and/or a busy flag.

### UI-108 (G5-011) | item 6 | severity low | Insights analytics dashboards

- insights/AnalyticsInsights.tsx:41-45 and :36; insights/AgentEvaluation.tsx:105-108
- Problem: Refresh buttons show no activity: `DashboardBody` does not read `refreshing` and passes no `loading`, unlike the production equivalent (prodErrors/ProductionErrorsPage.tsx:43-52 `loading={refreshing}`). A failed refresh also replaces the already loaded data with the ErrorBox (`if (error) return <ErrorBox/>` at :36), whereas production keeps data and shows the box above it.
- Evidence:

```
<Button variant="secondary" size="sm" onClick={reload} icon={<RefreshCw size={14} />}>   // AnalyticsInsights.tsx:41
<button className="sm ghost" onClick={response.reload}>  // AgentEvaluation.tsx:105 (no loading)
```

- Smallest fix: destructure `refreshing` and pass `loading={refreshing}`; use `Button variant="secondary" loading` in AgentEvaluation; change `if (error)` to `if (error && !data)` plus an inline ErrorBox like ProductionAnalytics.
- Scope: local

### UI-109 (G5-012) | item 1 | severity low | Production Errors, Insights

- prodErrors/ProductionErrorsPage.tsx:114 (`PageHeader` has no `actions`); :43-52 and insights/AnalyticsInsights.tsx:39-46 (Refresh in a content bar `.an-refresh`, analytics.css:233-239, alongside a timezone caption); ProdErrors.tsx:901-912 (`Scan now` parked in the Settings tab body, `.pe-scan-actions`, production-errors.css:483); insights/AgentEvaluation.tsx:101-109 (Refresh in `PageHeader actions`).
- Problem: Page-level Refresh lives in `PageHeader` on one Insights page and in an in-content bar on the others; the page's launch action (Scan now) is only reachable on the Settings tab, not from the Incidents tab where its result is shown (ambiguous against §12.1: Settings is arguably where scan configuration lives). Quote: "page-level context and settings belong in the page toolbar; a page's own primary actions go in `PageHeader` `actions`."
- Evidence:

```
<PageHeader icon={Siren} title={t("pe.title")} subtitle={t("an.productionWorkspace")} />
<div className="an-refresh"> <span className="muted small">{tz} · {bucket}</span> <Button ...>{t("an.refresh")}</Button>
```

- Smallest fix: move Refresh into `PageHeader actions` consistently (Production, Insights, Evaluation).
- Scope: local

### UI-110 (G5-013) | item 5 (§8) | severity medium | all analytics panels

- analytics/shared.tsx:35-39 (`Panel` hint), Insights.tsx:328-338 (`Metric title`)
- Problem: Panel definitions/semantics (e.g. `an.compareHint`, `data.semantics.event_count`, `an.errorShare`) are exposed only as the native `title` on a focusable `span` (no role). Native tooltips do not appear on keyboard focus or touch, so the text cannot be read by those users (§8: long text must not rely exclusively on hover).
- Evidence:

```
<span className="an-info" tabIndex={0} title={hint} aria-label={hint}><Info size={16} /></span>
```

- Smallest fix: render the hint as visible `muted small` text under the heading (or a `<details>` disclosure) using existing classes.
- Scope: shared (Usage, Performance, Workflows, Production panels)

### UI-111 (G5-014) | item 7 (§9) | severity medium | Production, Insights

- analytics/AnalyticsFilters.tsx:155-260, :265-324, :330-427 and analytics.css:9-125 (`.an-filter*`)
- Problem: Three filter forms are hand-built (`label > select` grids with own gap/typography) rather than `FilterToolbar`/`FilterField` (ui.tsx:401-425), which the Incidents list and Code scan on the same pages already use. Two visual systems for filters on one page (Incidents tab filters vs Overview filters).
- Evidence:

```
<form className="card an-filter" onSubmit={submit}><details open><summary>..</summary>
<div className="an-filter-grid"> <label>{t("an.timezone")} <select ...>
.an-filter-grid label { display: flex; flex-direction: column; gap: 6px; ... }   // analytics.css:26
```

- Smallest fix: use `FilterField` for each control and `FilterToolbar` for the grid; keep the form/Apply logic untouched.
- Scope: shared (Production overview/services, Usage, Performance, Workflows, Evaluation)

### UI-112 (G5-015) | item 2 + 9 | severity low | Production overview

- prodErrors/ProductionErrorsPage.tsx:128-146; analytics/AnalyticsFilters.tsx:183
- Problem: The 1h/6h/24h/7d/30d range shortcuts, which change the same `from/to` as the date inputs inside the filter form, are rendered as a separate row below the card, away from the date inputs; they apply instantly while the form needs Apply, and none shows an active state. Both `div.an-range-buttons` and `div.an-chips` carry `aria-label` but no role, so the name is ignored by AT.
- Evidence:

```
<div className="an-range-buttons" aria-label={t("an.customRange")}>   // no role="group"
<div className="an-chips" aria-label={t("an.activeFilters")}>          // no role
```

- Smallest fix: add `role="group"` to both; place the range buttons next to the date inputs inside the form's grid (or reuse `Segmented`).
- Scope: local

### UI-113 (G5-016) | item 9 | severity low | most files

- `<button>` without `type` (50 occurrences, none inside a `<form>` today, so no accidental submit now): ProdErrors.tsx (10: 255, 258, 401, 412, 429, 539, 680, 685, 729, 903), prodErrors/CodeScan.tsx (11), ProductionOverview.tsx (9), ServiceDetails.tsx (4), ProductionErrorsPage.tsx:137, analytics/shared.tsx:205,212, insights/AgentEvaluation.tsx:69,105, EvaluationEvidence.tsx:84,94, EvaluationRecommendations.tsx:77,137,161, ProviderExperimentForm.tsx:76,174,181,188, ContextPairedStudy.tsx:49, QualityLoop.tsx:79.
- Problem: §8/§12.9 require explicit button types.
- Evidence: `<button className="ghost xs" onClick={onOpen}>` (ProductionOverview.tsx:838)
- Smallest fix: switch to `Button` (defaults `type="button"`, ui.tsx:381) or add `type="button"`.
- Scope: local

### UI-114 (G5-017) | item 7 (§9) | severity low | Insights > Agent Evaluation

- insights/AgentEvaluation.tsx:111-124
- Problem: Hand-rolled `div.tabs` with `<a className="tab">` plus a non-link `span.tab.active` instead of `Tabs` (ui.tsx:559). The nav loses the Tabs button semantics used on the sibling pages, and the "health" entry is a legacy route link.
- Evidence:

```
<div className="tabs">{["health","usage","performance","workflows"].map((tab) => (<a key={tab} className="tab" href=...>
<span className="tab active">{title}</span>
```

- Smallest fix: use the same `Tabs` as AnalyticsInsights/ProductionErrorsPage (or `<nav aria-label>` with `aria-current="page"` on the active item).
- Scope: local

### UI-115 (G5-018) | item 7 | severity low | Insights > Agent Evaluation

- insights/EvaluationEvidence.tsx:82-103 vs analytics/shared.tsx:201-220
- Problem: A second, hand-rolled pager (`div.row` with two `ghost xs` buttons, a bare `page · total` span) duplicates `DataTable`'s `.an-pagination` (different size, no `muted` styling, no `type`).
- Evidence: `<button className="ghost xs" disabled={data.pagination.page <= 1} onClick={() => onPage(data.pagination.page - 1)}>`
- Smallest fix: reuse the `.an-pagination` markup (or pass `page/onPage/total` to `DataTable`).
- Scope: local

### UI-116 (G5-019) | item 7 (§1, §2, §8) | severity low | CSS across all assigned files

- Hard-coded colours: ProdErrors.css:113 `.pe-critical { color: #fff }`, :454 `.sp-step.is-done .sp-dot { color: #fff }`, :358 `color-mix(... #fff)`; chibi palette :301-304 (scoped illustration colours, acceptable by DESIGN.md "scene keeps its own palette"; flagged as ambiguous).
- Hard-coded px spacing instead of `--sp-*` (gap/padding/margin declarations with literal px): ProdErrors.css 25, Insights.css 16, bug-hunter.css 38, code-scan.css 9, incident-workbench.css 12, production-errors.css 43, analytics.css 15 (e.g. production-errors.css `.an-service-back-row { margin-bottom: 12px }`, `.an-service-heading { padding: 18px 0 }`, bug-hunter.css `padding: 12px`).
- Problem: §1 token scale and "use theme foreground tokens" (`--on-brand`/`--on-warning`) not followed.
- Smallest fix: replace `#fff` with `var(--on-brand)`; map 4/8/12/16/20/24 px to `--sp-1/2/3/4/5/6`.
- Scope: local

### UI-117 (G5-020) | item 7 (§10) | severity low | dead CSS

- prodErrors/production-errors.css:29-36 `.an-refreshing`; analytics/analytics.css:362-400 `.an-evidence*` and `.an-run-evidence*`
- Problem: Selectors with no usage anywhere in web/src (grep of all .tsx/.ts) are left over from earlier layouts; §10 asks to delete superseded rules.
- Evidence: `grep -rn "an-refreshing\|an-evidence\|an-run-evidence" web/src --include=*.tsx` returns nothing.
- Smallest fix: delete the three rule groups.
- Scope: local

### UI-118 (G5-021) | item 7 (§10) | severity low | cross-page CSS

- ProdErrors.css:243 `.spin` (unprefixed, global name) is consumed by ChatDelegations.tsx:97 and by prodErrors/ProductionIncident.tsx:94 / ServiceDetails.tsx:74 / bugHuntParts.tsx; also bare `.is-open .pe-chev` / `.is-done .bh-tl-dot` style state classes (ProdErrors.css:95-99, bug-hunter.css:152-201).
- Problem: A page-prefixed stylesheet provides a generic class used by another page; if ProdErrors.css is not loaded (Chat page) the spinner does not animate.
- Evidence: `.spin { animation: pe-spin 1s linear infinite; }`
- Smallest fix: use the `button-spinner`/`.spinner` that styles.css already owns (styles.css:1114) or move `.spin` to styles.css.
- Scope: shared

### UI-119 (G5-022) | item 7 (§1, §10) | severity low | Insights evaluation

- Inline px/layout styles: insights/AgentEvaluation.tsx:127 `style={{ marginBottom: 16 }}`; EvaluationRecommendations.tsx:108 `marginRight: 8`, :124 `marginTop: 12`; ProviderExperimentForm.tsx:173 `marginTop: 12`; ContextPairedStudy.tsx:76-80 `pre` with `maxHeight: 300` and overflow; Insights.tsx:840 (see G5-001).
- Problem: Spacing via inline pixel margins on children rather than gap on the owning container (§1); the JSON dump re-implements `JsonBlock`.
- Evidence: `<div className="row" style={{ marginTop: 12 }}>`
- Smallest fix: wrap in `.stack`/`.row` with token gap or an `.ins-`/`.an-` class; use `JsonBlock` for the evidence dump.
- Scope: local

### UI-120 (G5-023) | item 7 (§3) | severity low | Production overview, Workflows

- analytics/analytics.css:168-185 `.an-drill`; prodErrors/ProductionOverview.tsx:754, :789, :838, ServiceDetails.tsx:135, :167; insights/AgentEvaluation.tsx:69; ProviderExperimentForm.tsx:188
- Problem: `.an-drill` re-implements the shared `button.link-button` (transparent, no shadow, wrapping) with overrides (`box-shadow: none; min-height: 0`). Several buttons only change `location.hash` where §3 says to use an anchor when the destination is directly available (`openIncident`, `incidentLink`, `navigate("/insights/quality")`).
- Evidence: `<button className="link-button mono" onClick={() => openIncident(r.fingerprint)}>`
- Smallest fix: `className="link-button"` instead of `.an-drill`; use `<a href>` for pure navigation (a `.btn ghost xs` anchor for IncidentLinks).
- Scope: local

### UI-121 (G5-024) | item 11 | severity medium | verification coverage

- test/ui-quality.browser.ts:176-193 (routes list), 322, 415, 453, 459, 494, 505, 649-660
- Problem: The screenshot/geometry route list contains only `/prod-errors/overview`, `/insights/usage` and `/insights/evaluation`. Incidents, Services, Performance have targeted checks only; no coverage was found for `/prod-errors/code-scan`, `/prod-errors/settings`, `/prod-errors/incident/<fp>`, `/insights/workflows` (compact filter + drawer), or the legacy `/insights/quality|tools|failures|registry` pages (which contain the unwrapped tables of G5-006).
- Evidence: `["production", `/prod-errors/overview?${query}`], ["insights", `/insights/usage?${query}`], ["evaluation", "/insights/evaluation"]`
- Smallest fix: add these paths to `routes`.
- Scope: shared (test harness)

### UI-122 (G5-025) | item 4 | severity low | Production Errors, Insights

- catalog `pe.scanNow` = "Scan…" / "Quét…" and `pe.opt.scan` = "Scan" / "Quét" (i18n/catalog.ts:2122, 2127, 5642, 5647): two buttons with near-identical verb-only labels; neither states the outcome (what is scanned, that it reads Splunk/SigNoz) in the label.
- insights/AgentEvaluation.tsx:69-71 the cohort button's label is a 12-char hash prefix only. prodErrors/CodeScan.tsx:276 uses `cs.scan`: "Assess code" (fine).
- insights/WorkflowDashboard.tsx:297, :325 the approvals table labels the `dimension` column and the slow steps table labels `step_key` as "run" (`label: "run"`), while PerformanceDashboard.tsx uses "step" for the same field.
- Problem: vague or mismatched labels.
- Smallest fix: label the buttons by outcome ("Scan Splunk/SigNoz now" / "Start scan"), add the `an.step` label for `step_key`.
- Scope: local

### UI-123 (G5-026) | item 8 (§6) | severity low | Insights legacy, Evaluation

- Insights.tsx:355, :1172, :1220; insights/EvaluationTable.tsx:95 (`<div className="table-wrap">` without `tabIndex`, `role="region"`, `aria-label`)
- Problem: Scrolling table regions are not keyboard-focusable or named, unlike `DataTable` (analytics/shared.tsx:145). Keyboard users cannot scroll wide tables (`.ins-table { min-width: 560px }`).
- Evidence: `<div className="table-wrap"><table className="ins-table">`
- Smallest fix: add `tabIndex={0} role="region" aria-label={t("an.tableScroll")}`.
- Scope: local

### UI-124 (G5-027) | item 10 | severity low | Insights > Agent Evaluation

- insights/AgentEvaluation.tsx:143-160 (`["easy","medium","hard"]`, `["minimal","pack","tools","legacy"]` rendered as raw `<option>` text); analytics/AnalyticsFilters.tsx:140-141 and :235 (provider ids `claude`, `codex`...)
- Problem: Filter options show raw enum values; `easy/medium/hard` are not localised, while the sibling "all" option is.
- Evidence: `{["easy", "medium", "hard"].map((d) => (<option key={d}>{d}</option>))}`
- Smallest fix: `t(\`an.eval.difficulty.${d}\`)`-style keys (both locales); provider/model ids may stay raw (proper names).
- Scope: local

### UI-125 (G5-028) | item 9 | severity low | Code scan findings list

- prodErrors/CodeScan.tsx:532-558 (`div.cs-list role="table"`, `div.cs-row role="row"`), :533 (header `span`s are in `role="row"` with no `columnheader`), row contents are a `<button>` rather than `cell`s
- Problem: Incomplete ARIA table pattern (rows without cell/columnheader children) gives an inconsistent AT tree; the header row is not hidden either (ProdErrors.tsx:1121 uses `aria-hidden` for the equivalent header).
- Evidence: `<div className="cs-list" role="table"> <div className="cs-cols muted small" role="row"> <span>...`
- Smallest fix: drop the table/row roles (a list of accordion buttons) or add `role="columnheader"`/`role="cell"` wrappers.
- Scope: local (ambiguous: no rule in §12 names this explicitly; quoted for the reviewer's call)

### UI-126 (G5-029) | item 5 | severity low | empty states without next step

- prodErrors/ProductionErrorsPage.tsx:36 and prodErrors/ProductionIncident.tsx:82, ServiceDetails.tsx:38 `EmptyState title={t("an.empty")}` with no children/action; ProdErrors.tsx:1109 `pe.none` ("No errors") with `last` set renders `null` children; analytics DataTable empty uses `an.emptyHint` (good).
- Problem: "No data in this scope" gives no next step when the whole dashboard is empty (e.g. no scan yet).
- Smallest fix: pass a child hint/link (e.g. `an.emptyHint` as DataTable does, or a link to the Settings tab scan).
- Scope: local

## 4. Cross-cutting findings

One fix at the shared place, not N page fixes.

| Pattern                                                                                              | Pages                                                                                                                                                                        | Findings                                                       | Proposed shared fix                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `<button>` without `type` (and `ui.tsx` `Button` unused)                                      | 30+ files, all five groups                                                                                                                                                   | UI-004, UI-038, UI-071, UI-078, UI-113                         | Sweep adding `type="button"` (an ESLint `react/button-has-type` rule would hold the line); migrate to `Button` where a page already needs loading/disabled handling                 |
| Disabled controls with no visible reason, or tooltip-only                                            | WorkItems, Questions, Users, Chat, Runs, Report, RunView, StepInspector, Investigations, Benchmarks, Workflows, Knowledge, Repositories, Integrations, Production, Code scan | UI-005, UI-006, UI-030, UI-031, UI-057, UI-087, UI-105         | Small hint line next to the control with `aria-describedby`; consider a `Button` `reason` prop only if two pages share the wording                                                  |
| `act()` protects only the clicked button, not sibling or non-button controls                         | WorkflowEditor, Workflows, Knowledge, RepositoryAccess, Integrations (checkboxes, selects)                                                                                   | UI-051, UI-052, UI-054, UI-055, UI-080                         | Local `busy` state feeding `Button loading` / `disabled` on every control that starts the same request; document the limit of `act()` next to its definition in `ui.tsx`            |
| Clickable `tr`/card/link without keyboard support                                                    | Runs, Questions, Changes, Investigations, child cards, Insights failures                                                                                                     | UI-010, UI-033, UI-034, UI-098                                 | One keyboard-operable row/link pattern (real `<a href>` where a destination exists; otherwise a button inside the row)                                                              |
| Hard-coded copy and raw enums next to existing catalog keys                                          | 20+ files                                                                                                                                                                    | UI-007, UI-045, UI-063, UI-086, UI-100                         | Move the strings to the vi and en catalogs; a CI check for literal JSX text would prevent regressions                                                                               |
| Multiple primary (brand-filled) buttons per area; destructive buttons unseparated                    | Workflows, WorkflowEditor, Knowledge, Settings, Integrations, RunView, Benchmarks                                                                                            | UI-027, UI-029, UI-060, UI-081, UI-088                         | Keep one filled action; use `ghost`/`quiet` for the rest and a separator or `danger` for destructive actions                                                                        |
| Inline `style={{…}}` with literal px, hex colours and missing/invalid tokens                         | All five groups                                                                                                                                                              | UI-015, UI-016, UI-041, UI-068, UI-085, UI-089, UI-116, UI-119 | Move to page-prefixed classes using `--sp-*`/`--fs-*`; fix the invalid tokens (`--border`, `--st-warn`) in `DialogHost.css`, `Integrations.css`, `office.css` and `styles.css:1160` |
| Tables outside a focusable, named `.table-wrap`; global `table{display:block}` fallback applies (§6) | Runs, Questions, Users, OverviewTimesheet, Changes, AgentIsolation, RepositoryWorkspace, AutonomyInsights, Repositories                                                      | UI-023, UI-024, UI-084                                         | Use the existing named-region wrapper from `analytics/shared.tsx`                                                                                                                   |
| Inputs identified only by placeholder                                                                | Chat, Report, WorkItems, RunView, StepInspector, Investigations                                                                                                              | UI-009, UI-035                                                 | Add `aria-label`/`Field` label                                                                                                                                                      |
| Silent catches of background fetches                                                                 | App, Overview, ChatImportReview, WorkItems, RepositoryWorkspace                                                                                                              | UI-011                                                         | Show the cause in the existing `ErrorBox`/toast                                                                                                                                     |

## 5. Items that could not be verified

- **No dynamic pass.** `npm run smoke:ui-quality` and a headless browser need Chromium; the cached build (`chromium-1148`) exits with code 127 (`libnss3.so`, `libglib-2.0`, `libX11` and about 25 other libraries not found) and `sudo` is not available. No screenshots at 1440×900, 1024×768 or 390×844, no vi/en or light/dark comparison, no zoom stress, no keyboard or screen-reader run. All findings under checklist items 8 (responsive/scroll) and the sticky/overflow claims (UI-013, UI-022, UI-053, UI-064, UI-095, UI-103) are **inferred from CSS**, not measured.
- **Contrast** (§8, 4.5:1) was not computed; where a token is flagged (e.g. `#fff` on `--brand` in dark) the token values were read, not the rendered pixels.
- **Backend-driven enum values** may still miss a translation at runtime (`pe.reason.*`, `cs.kind.*`, `set.role.*`, `repo.ws.state.*`). Only values visible in code were checked; the script check covered every literal `t("…")`.
- **Reviewer-flagged ambiguities in the checklist**: (a) "Auto layout" canvas tool sitting in the same group as Validate/Save draft, and view-switch buttons in the Knowledge `PageHeader`: item 1 does not say where view switching belongs, so neither was counted; (b) whether Reject in `KnowledgeProposals.tsx:826` is destructive was not obvious from the code, so it was not flagged.
- Partly skimmed: `StepInspector.tsx` ~1260–2270, `Transcript.tsx` 1–230, `ProdErrors.css` 118–290 and 460–540. Whether `ReexecuteDialog` can leave `busy` true when `onSubmit` throws depends on the caller.
- Whether the `.tr-feed` transcript region is keyboard-scrollable depends on focusable children; untested.

## 6. Commands run

| Command                                                                                                                            | Outcome                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                                                                                    | pass (exit 0, Vite build in ~0.5 s)                                                                                                                         |
| `UI_QUALITY_PHASE=zz-audit-scratch CHROMIUM_BIN=~/.cache/ms-playwright/chromium-1148/chrome-linux/chrome npm run smoke:ui-quality` | **fail before any page loaded**: browser exited 127, `libnss3.so: cannot open shared object file`; `ldd` lists 27 missing libraries; `sudo -n true` refused |
| `node …/i18n-check.mjs` (scratch script comparing `t("…")` keys with `catalog.ts`, `analytics.ts`, `messages.ts`)                  | vi and en key sets match (3302 each); 2927 literal keys used; 2 unresolved (`an.in`, and a dynamic `status.`+value that is a prefix, not a missing key)     |
| 5 parallel read-only review agents (greps plus line-by-line reads)                                                                 | 126 findings, written to scratch notes outside the repo                                                                                                     |
| spot checks with `grep`/`sed` on high findings                                                                                     | all confirmed                                                                                                                                               |

Files created: `docs/frontend/ui-checklist-audit.md` (this report). Scratch notes and scripts live outside the repository, under the session scratchpad (`…/scratchpad/ui-audit/`); nothing in the repository needs deleting. No screenshots were produced.

## 7. Remediation status

Fixes were made after the audit, still without a browser run (typecheck, build, prettier, dialog tests and the i18n key script pass; `npm run smoke:ui-quality` could not run here).

**Fixed — all 9 high:** G1-001, G1-002 (Chat modals now use `Drawer`), G1-003, G2-007, G2-008, G3-001, G3-002, G3-003, G5-001.

**Fixed — medium:** G1-004 and the equivalents G2-012/G3-021/G4-001/G5-016 (324 buttons outside `<form>` got `type="button"`), G1-007/G2-019/G3-013/G4-009 (the visible English literals: Run #, PR preview, Validation, Welcome, Key, Audit, Revert, Preview/Animation, empty states, toasts, breadcrumbs; example placeholders, brand terms and enum codes left as is), G1-009/G2-009, G1-010 (Enter and Space, Changes rows focusable), G1-011 (RepositoryWorkspace error/loading only), G1-013, G3-014, G1-023/G4-007/G5-006, G2-001, G2-002, G2-003, G2-006, G2-010, G2-011, G3-004, G3-005, G3-006, G3-009, G3-011, G3-012, G3-020, G4-002, G4-003 (Background Git and the access matrix), G4-006, G4-015, G4-017 (provider error), G5-002, G5-003, G5-005, G5-007, G5-009 (secondary/ghost/danger styling), G5-010, G5-013 (hint shown as text), G1-014/G5-024 (8 smoke routes added, not run).

**Also fixed (disabled-reason pass):** G1-005, G1-006, G2-004, G2-005 (Investigations), G3-007, G3-008, G4-010, G5-008 (CodeScan, Workbench, ContextPairedStudy, Knowledge reviewer, Repositories, Workflows key, Workflow editor Run, Telegram connect, Provider handoff, Questions/Step inspector approve): visible hint text linked by `aria-describedby`.

**Also fixed (last pass):** G1-008 (Chat rows are real links with a sibling menu button), G1-012 (utility and "start work" actions grouped, with a visible label), G2-014 (the blanket Trace button rule now uses size tokens; its `.tx-search` still re-implements `SearchInput`), G4-004 (provider tabs and Save provider no longer primary, the two save bars no longer overlap, Ctrl+S no longer saves twice), G4-014 (`Field` gained a `group` mode used for the chip group and three Integrations fields), G5-014 (analytics filters use `FilterField`; the superseded `.an-filter-grid label` rule was removed), and the remaining disabled-reason hints (Benchmarks, Re-execute, Knowledge import, Proposals approve, ProdErrors scan, Integrations save buttons).

**Left as is on purpose:** the silent best-effort catches in App (badge counts), Overview (verification lookups) and ChatImportReview (status refresh): a failure there leaves the last known value on screen and no action the user could take; surfacing a toast per request would be noisier than the problem. Integrations "Find chats"/"prefs Save" and Bitbucket-style secondary buttons were not given hints.

**Verification limit:** none of these changes was exercised in a browser, so the visual effect of the CSS changes (Chat rows, save-bar offset, filters, Trace button tokens) needs the smoke run or a manual look.
