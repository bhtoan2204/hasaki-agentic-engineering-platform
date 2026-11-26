# Harness, Checkpoint and Replay Observability

## Requirements Document

### Summary

- **Request:** Show the execution harness lifecycle, checkpoints, recovery and DAG replay decisions in the existing Run View, Step Inspector, Trace Explorer and Insights screens. Add metrics for reuse, savings and latency. Do not add a separate dashboard.
- **Background:**
  - The unified lifecycle (`src/agent/harness`) writes a `harness_evidence` artifact on every attempt, with stage timings, guarantees, failure code, checkpoint source, tool calls and cost.
  - Checkpoints are durable (`workflow_checkpoints`, migrations 065/066) and replay is fingerprinted (`src/workflow/replay.ts`).
  - Very little of this is visible today. Decisions are not persisted, and checkpoints appear as raw JSON.
- **Expected outcome:**
  - An operator can see, for each run and step:
    - which harness stage ran and how long it took;
    - which checkpoints can be recovered, and from what;
    - what each DAG node will do or did on replay (reuse, resume, restore, re-execute, reconcile) and why;
    - how much work reuse avoided.
  - Insights aggregates the same data.

### Current State (verified)

- **Run View** (`web/src/pages/RunView.tsx:125`):
  - Layout: ReactFlow DAG plus a right pane with three modes: overview, `StepInspector` (`:666`) or `TraceExplorer` (`:660`).
  - Node pills live in `web/src/graph.tsx:225-300`, built from `StepNodeData` (`:144-158`).
  - `GET /api/runs/:id` (`runDetail` → `loadRunDetail`, `src/workflow/runRepository.ts:154`) already returns `checkpoints` and `artifacts` (with `data`), but the UI does not use them.
- **Step Inspector** (`web/src/pages/StepInspector.tsx:467`):
  - Tabs at `:544`.
  - Checkpoints are rendered as raw `JSON.stringify` inside a `<details>` (`:880-897`).
  - The history table shows `reused_from_attempt_id` (`:1032`).
  - `ReexecuteDialog` (`:1827`) already calls `GET /api/runs/:id/steps/:key/replay-preview` (`src/api/routes.ts:1056`, `previewReplay` `src/workflow/engine.ts:816`) and lists action, reason and the conditional flag (`:1949-1966`).
- **Replay vocabulary** `ReplayAction` (`src/workflow/replay.ts:16`): REUSE, RESUME, RESTORE, VERIFY_ONLY, REEXECUTE, FORCE_REEXECUTE, RECONCILE.
  - The plan (`planReplay` `:73`, `planContinuation` `:140`) is never stored.
  - The dispatch decision is made at `src/workflow/scheduler.ts:264-275`. A REUSE is recorded via `reused_from_attempt_id` plus a run event (`checkpoints.ts:252-260`). A miss is only logged.
- **Recoverable vs notes:**
  - Recoverable: `executor_returned` (`recordExecutorReturn`, `checkpoints.ts:197`) and the pauses `waiting_input`, `waiting_approval` and `provider_handoff` (`saveExecutionPause` `:175`), with an envelope validated by `validate` (`:287`).
  - Notes only: `progress`, `submit_result`, `skill_read`, `profile_*`.
  - Compatibility comes from the binding hash (generation, job, fencing, snapshot, context hash, input hash, provider) and the continuation dependency hash (`:359-381`). Before dispatch, the workspace fingerprint must match (`scheduler.ts:236-261`).
- **Where recovery decisions live today:**
  - `recoverInterrupted` SAFE_RETRY / REQUIRES_RECONCILIATION (`src/workflow/recovery.ts:53,63`)
  - the scheduler fingerprint mismatch path
  - engine retry with `pending_input.resume`
  - provider handoff (`engine.ts:~2560-3117`)
  - session resume `checkpointSource` (`src/agent/harness/stages/execute.ts:399-442`, persisted only in `harness_evidence`)

  They are spread across events, `pending_input`, checkpoint rows, `provider_handoffs` and `audit_log`.

- **Trace** (`src/workflow/trace.ts`):
  - `assembleTrace` (`:266`) builds run → step → attempt → tool → handoff from `loadTraceInput` (`:389`).
  - `traceLog` (`:95-148`) writes `workflow_events` with `kind='trace'`, and supports `span_id` and `parent_span_id`, which are unused so far.
  - Checkpoints, replay and harness stages are not in the trace.
  - Diagnosis rules live in `src/workflow/traceDiagnosis.ts`.
- **Metrics:**
  - Verification evidence reuse is aggregated in `src/api/analytics/execution.ts:257-271` (`verification_evidence`), with no UI.
  - The context pack records `retrieval_cache.reused_from_pack` and `reread_count` (`src/context/pack.ts:928-944`).
  - Not recorded anywhere: replay hit rate, avoided invocations or tokens, checkpoint size, recovery latency. The workspace payload size is computed (`src/git/workspaceCheckpoint.ts:141,197`) but never stored.
- **UI primitives** (`web/src/ui.tsx`): `Badge`, `StatCard`, `JsonBlock`, `Tabs`, `Drawer`, `Segmented`, `EmptyState`, `Skeleton`. There are also the `rv-card`/`rv-mini` and `gn-pill` CSS classes, `Dialog`, and the Insights helpers `Panel`, `Metric`, `Table` and `Bars` (`web/src/pages/Insights.tsx:83-252`).
- **Tests:**
  - Playwright smokes serve the built `web/dist` with intercepted GET fixtures: `test/run-view.smoke.ts`, `test/trace-explorer.smoke.ts` (`npm run build`, then `npm run smoke:run-view` / `smoke:trace`).
  - Browser tests use a real database (`test/*.browser.ts`).
  - Replay integration: `test/replay.integration.ts`.

### User decisions (2026-11-18)

1. **Persistence:** a new `execution_decisions` table, added by a migration, written wherever a decision is made.
2. **Savings:** estimated from the source attempt's reported telemetry (tokens, cost, invocations) and labelled "estimated". When the source reported nothing, the value is unknown, not 0.
3. **Preview:** keep the Re-execute dialog and add per-decision badges and estimates. While the dialog is open, colour the Run View DAG nodes by their planned decision.

### Functional Requirements

- **FR-001 (mandatory) Decision log.**
  - Migration `067_execution_decisions.sql` creates `execution_decisions` with these columns:
    - `id`, `run_id`, `step_id`, `attempt_id` (nullable)
    - `generation`
    - `kind`: `replay` | `recovery` | `resume` | `restore` | `reconcile` | `verification_reuse` | `context_reuse` | `review_reuse`
    - `action`: one of the `ReplayAction` values, plus `SAFE_RETRY`, `REQUIRES_RECONCILIATION`, `HANDOFF`
    - `outcome`: `planned` | `applied` | `rejected` | `failed`
    - `reason` text, `source_attempt_id`
    - `latency_ms`, `checkpoint_bytes`
    - `saved_invocations`, `saved_tokens`, `saved_cost_usd`, all nullable
    - `details` jsonb, `created_at`

  Indexes: `(run_id, created_at)` and `(kind, created_at)`. There is a CHECK on `kind`, `action` and `outcome`, and retention follows the run (`ON DELETE CASCADE`).

- **FR-002 (mandatory) Recording.** A small repository/service, `src/workflow/decisions.ts`, records rows. It is best-effort outside transactions and transactional where the caller already holds the run lock, matching how `runEvents` works. Rows are written at:
  - Replay at dispatch (`scheduler.ts:264-275`): REUSE applied, or REEXECUTE with the miss reason.
  - Re-execute or retry (`engine.ts:738-930`): the `planReplay` decisions stored as `planned` rows for each step (`kind=replay`).
  - Recovery (`recovery.ts:53-164`): SAFE_RETRY / REQUIRES_RECONCILIATION, with `latency_ms` measured from lease expiry to the moment the decision is applied.
  - Workspace reconciliation mismatch (`scheduler.ts:236-261`): RECONCILE.
  - Provider handoff pause and resume: `HANDOFF`, with resume latency.
  - Session resume (`harness/stages/execute.ts`): RESUME applied, or rejected with fallback to rebuilt.
  - Workspace restore (`restoreMissingWorkspaces` call sites in the preflight and verify stages): RESTORE.
  - Verification evidence reuse (from `EvidenceStats` per verify round): `verification_reuse`.
  - Independent-review PASS reuse (`harness/stages/checkpoint.ts:96-115`): `review_reuse`.
  - `executor_returned` checkpoint (`recordExecutorReturn`): `checkpoint_bytes` from the encrypted workspace artifact length, plus the payload size reported by `executionWorkspace`.
- **FR-003 (mandatory) Savings estimate.** For applied REUSE, RESUME and review_reuse rows, `saved_*` comes from the source attempt's `execution_attempt_telemetry` (tokens, `reported_cost_usd`, `provider_invocations`). For verification reuse, `saved_ms` comes from `EvidenceStats`. Values stay null when the source reported none. The UI always labels them "estimated".
- **FR-004 (mandatory) Checkpoint API.**
  - `GET /api/runs/:id/steps/:key` and `GET /api/runs/:id` gain a derived `checkpoints[].recoverable` flag and `kind` (`recoverable` | `note`) based on `reason` and envelope presence.
  - They gain `compatibility`: `compatible` | `stale_generation` | `binding_mismatch` | `dependency_changed` | `workspace_changed` | `legacy` | `unknown`, computed with the existing `validate` / `validateContinuation` logic in read-only mode, never mutating.
  - Plus `latest_recoverable` per step, with its workspace (fingerprint, repos, artifact id and size), context (snapshot id, context hash) and verification (digest and last verification summary).
  - Envelope secrets and encrypted content are never returned.
- **FR-005 (mandatory) Step Inspector.** Replace the raw checkpoint `<details>` with a "Checkpoints" card in the overview tab, built from existing primitives:
  - a milestone list showing recoverable checkpoints as milestones and progress notes visually secondary, in a collapsible "notes" group;
  - a compatibility badge and the available recovery action (resume, restore, reconcile, re-execute), taken from `planContinuation`;
  - the latest recoverable checkpoint with workspace, context and verification evidence;
  - a "Harness" card with the stage timeline from `harness_evidence.stages` (stage, outcome, ms), guarantees, failure code and checkpoint source;
  - a decisions list for the step from `execution_decisions`.
- **FR-006 (mandatory) Run View.**
  - DAG nodes get an optional replay or recovery pill, using the latest applied decision of the current generation (`reused`, `resumed`, `restored`, `reconcile`, `re-executed`).
  - The overview pane gets a small "Execution reuse" `rv-card`: steps reused, resumed and restored, plus estimated avoided invocations and tokens for the run.
  - While the Re-execute dialog is open, nodes are coloured or badged by the preview decision (FR-008).
- **FR-007 (mandatory) Trace Explorer.**
  - `loadTraceInput` / `assembleTrace` add node types:
    - `stage` (from `harness_evidence.stages`, with cumulative offsets from attempt start);
    - `checkpoint` (recoverable rows only; notes as attributes);
    - `decision` (from `execution_decisions`).
  - The frontend `TraceNode` type, icons and i18n are updated.
  - New `traceDiagnosis` rules:
    - `recovery_loop`: the same step recovered N times in a generation;
    - `checkpoint_incompatible`: the latest recoverable checkpoint is incompatible while the step is waiting.
- **FR-008 (mandatory) Replay preview.**
  - The `replay-preview` response adds a per-step `estimate` (saved invocations and tokens from the reuse source) and a summary of counts per action.
  - The dialog groups steps by action, with badges and estimates.
  - `RunView` receives the preview through a shared state (lifted from the dialog) to colour nodes. No new endpoint.
- **FR-009 (mandatory) Insights.** In the existing harness/evaluation area (`HarnessEvaluation`, `Insights.tsx:853`, `metrics.ts:337`), using `execution_decisions` and the existing `verification_evidence` aggregate:
  - context reuse, verification reuse, provider resume and checkpoint restore rates;
  - replay latency (p50/p95 of applied replay rows), recovery latency (p50/p95);
  - avoided invocations and avoided tokens (estimated);
  - checkpoint size (p50/p95/max).

  No new page or tab.

- **FR-010 (mandatory) Progress vs checkpoint.** Every place that lists checkpoints (Step Inspector, the trace, the run timeline) labels `progress`, `submit_result`, `skill_read` and `profile_*` as notes, never as recoverable checkpoints.
- **FR-011 (optional) Run timeline.** `RunTimeline` shows decision rows (applied only) inline with events.

### Non-Functional Requirements

- **Performance:**
  - Decision writes are a single insert each, outside the claim critical path where possible.
  - Run detail adds at most one indexed query (decisions by run).
  - Compatibility evaluation is pure, using already-loaded rows plus the current step and attempt. No git calls on read: the workspace fingerprint check is reported from the last recorded reconcile decision, not recomputed.
- **Security:** never expose encrypted workspace content, the envelope `result` or secrets. Decision `details` are redacted with `redactSecrets`. Only the step and run owner or an admin can see them, under the existing access checks.
- **Compatibility:**
  - Old runs without decisions or evidence render as "no data", never as errors.
  - Legacy checkpoints (no envelope) show `legacy`.
- **Maintainability:** reuse `ui.tsx` primitives and existing CSS classes. Keep each new component under about 250 lines, and the decision vocabulary in one shared module mirrored by the web types.

### Technical Specifications

- **Shared vocabulary:** `src/workflow/decisions.ts` exports `DecisionKind`, `DecisionAction` (= `ReplayAction` ∪ the recovery actions) and `recordDecision(db, row)`. The web types live in `web/src/api.ts` or a small `web/src/decisions.ts`.
- **Compatibility evaluation:** factor the read-only parts of `validate` and `validateContinuation` (`src/workflow/checkpoints.ts:287-381`) into a pure `checkpointCompatibility(checkpoint, step, attempt)`. Never throw on read: map failures to a status.
- **Trace:** extend `TraceInput` with `stages`, `checkpoints` and `decisions`, loaded in `loadTraceInput` with bounded queries limited to the run. `assembleTrace` stays pure.
- **API impact:**
  - `runRepository.loadRunDetail` / `loadStepDetail` add decisions and a derived checkpoint view.
  - `previewReplay` adds estimates.
  - `metrics.ts` / `execution.ts` add aggregates.
- **Web impact:**
  - `graph.tsx`: a pill and a preview colour.
  - `RunView.tsx`: a reuse card and preview state.
  - `StepInspector.tsx`: Checkpoints and Harness cards, and dialog grouping.
  - `TraceExplorer.tsx`: node types.
  - `Insights.tsx`: metrics in the harness section.
  - i18n: vi and en.

### Constraints

- Reuse existing screens and components; no new dashboard, route or page.
- Behaviour of replay and recovery must not change; only recording is added. The replay and recovery integration suites must pass unchanged.
- Work on the current branch. Follow repo conventions. Commits in English with no AI attribution and no `func:`/`task:` footer for this repo.
- `web/dist` must be built before the smoke tests.

### Test Requirements

- **Unit:**
  - `checkpointCompatibility` for every status;
  - `assembleTrace` with `stages`, `checkpoints` and `decisions`;
  - the new diagnosis rules;
  - savings estimation (unknown vs 0);
  - the note vs recoverable classification.
- **Integration:**
  - `replay.integration.ts`: re-execute writes `planned` rows, and dispatch writes `applied` REUSE with a `source_attempt_id` and saved estimates (or a REEXECUTE miss).
  - Recovery (`workflow-reliability.integration.ts`): lease expiry writes a recovery decision with `latency_ms`.
  - A step resumes a session and gets a RESUME decision, or a rejected one with rebuild.
  - `executor_returned` records `checkpoint_bytes`.
  - API: `GET /api/runs/:id/steps/:key` returns `recoverable`, `compatibility` and `latest_recoverable`, with no secret fields.
- **UI regression:**
  - Extend `test/run-view.smoke.ts` with fixtures containing checkpoints (recoverable and notes), decisions and evidence. Assert the node pill, the reuse card, the Checkpoints card (milestones vs notes, compatibility badge, recovery action) and the Harness stage list.
  - Assert the preview overlay colours nodes while the dialog is open.
  - Extend `test/trace-explorer.smoke.ts` to assert stage, checkpoint and decision nodes and the new findings.
  - Add an Insights assertion to the existing analytics smoke (`smoke:analytics`).
- **Acceptance:**
  1. A re-executed run shows, without opening JSON, which steps were reused, resumed, restored or re-executed, with reasons.
  2. A waiting step shows its latest recoverable checkpoint, its compatibility and the recovery action.
  3. The trace shows harness stages with durations.
  4. Insights shows reuse rates, latencies, checkpoint size and estimated savings.
  5. All existing suites pass.

### Outstanding Issues

1. **Decision history for old runs.** No backfill is planned; only new runs record decisions. The UI shows "no decision data" for older runs.
2. **Checkpoint size of pause checkpoints.** Pause checkpoints have no workspace artifact. Their size is the envelope `octet_length`, which is the only available measure.
3. **Recovery latency for manual recoveries** (a human answers a reconciliation question) measures time to the human decision, not system latency. Report it separately as "awaiting human" or exclude it from p95. Planned default: exclude rows whose `details.human = true`.

## Task Breakdown

### Dependency graph

```
P1 migration + decisions.ts ──> P2 recording at decision points ──> P3 API (checkpoint view, decisions, preview estimates)
                                                                     ├─> P4 Step Inspector + Run View + preview overlay
                                                                     ├─> P5 Trace (stages/checkpoints/decisions + diagnosis)
                                                                     └─> P6 Insights aggregates + UI
P4, P5, P6 ──> P7 smoke/UI regression + docs
```

### Phases

- **P1:** `migrations/067_execution_decisions.sql`, `src/workflow/decisions.ts` (vocabulary, `recordDecision`, savings estimator), and unit tests.
- **P2:** record decisions in:
  - `scheduler.ts` (replay hit or miss, reconcile mismatch)
  - `engine.ts` (planned replay on re-execute or retry, handoff pause and resume)
  - `recovery.ts` (SAFE_RETRY / REQUIRES_RECONCILIATION with latency)
  - `checkpoints.ts` (`checkpoint_bytes` on executor return)
  - harness stages: execute (resume), preflight and verify (restore), checkpoint (review reuse), verify (verification reuse)

  Integration tests go in `replay.integration.ts`, `workflow-reliability.integration.ts` and a step-agent resume test.

- **P3:**
  - `checkpointCompatibility` (pure, in `checkpoints.ts`);
  - `runRepository.ts` (decisions plus the derived checkpoint view and `latest_recoverable`);
  - `previewReplay` estimates and summary;
  - API tests.
- **P4:**
  - `StepInspector.tsx`: Checkpoints card, Harness card, decision list, dialog grouping and estimates;
  - `RunView.tsx`: Execution reuse card, preview state passed to the canvas;
  - `graph.tsx`: decision pill and preview colour;
  - i18n.
- **P5:**
  - `trace.ts` (TraceInput, node types, `loadTraceInput`);
  - `traceDiagnosis.ts` (`recovery_loop`, `checkpoint_incompatible`);
  - `TraceExplorer.tsx` (types, icons, details);
  - i18n;
  - `test/trace.test.ts`.
- **P6:**
  - `metrics.ts` `harnessEvaluation` (or `execution.ts`) aggregates from `execution_decisions` plus `verification_evidence`;
  - the `Insights.tsx` harness section;
  - an analytics test.
- **P7:**
  - extend `test/run-view.smoke.ts`, `test/trace-explorer.smoke.ts` and the analytics smoke;
  - update `docs/architecture/execution-lifecycle.md`, `execution-checkpoints.md` and `dag-replay.md` with the decision log and the UI.

### Execute handoff

- **Decisions:**
  - table, not events;
  - savings estimated from the source attempt and labelled "estimated";
  - the preview colours the DAG while the dialog is open;
  - no new page;
  - replay and recovery behaviour unchanged.
- **References:**
  - `src/workflow/replay.ts:16-175`
  - `src/workflow/checkpoints.ts:27-398`
  - `src/workflow/recovery.ts:19-243`
  - `src/workflow/scheduler.ts:236-330`
  - `src/workflow/trace.ts:95-420`
  - `src/agent/harness/evidence.ts`
  - `web/src/pages/StepInspector.tsx:544,880,1827`
  - `web/src/graph.tsx:144-300`
  - `web/src/pages/RunView.tsx:187-240,598-842`
  - `web/src/pages/Insights.tsx:853`
  - `src/api/metrics.ts:337`
  - `src/api/analytics/execution.ts:257`
- **Constraints:**
  - Build `web/dist` before the smokes.
  - Never return encrypted workspace content or the envelope `result`.
  - Old runs render "no data".
  - Keep the integration suites green at the end of P2, P3 and P7.
