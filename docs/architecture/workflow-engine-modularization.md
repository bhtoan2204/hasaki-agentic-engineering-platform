# Workflow engine modularization and reliability

Audit baseline: `origin/main` at `fe236e1` (2026-11-11). This is a behavior-preserving extraction, with no migrations or provider contract changes.

## Current call graph and ownership

```mermaid
flowchart TD
  API[HTTP workflow/run/question routes and Telegram actions] --> AUTH[requireRun / work-item ownership / action guards]
  AUTH --> ENGINE[workflow/engine.ts]
  ENGINE --> DEF[definitions + profiles + graph + branches]
  ENGINE --> CTX[context + execution policy versions]
  ENGINE --> SM[stateMachine]
  ENGINE --> DB[db/pool: withTx, deferred events, committed-write invalidation]
  SCHED[scheduler: claimJob / processJob / reaper timer] --> ENGINE
  SCHED --> ACCESS[execution scope + enforceRunRepositoryAccess]
  SCHED --> REG[executors/registry: makeContext + executor lookup]
  REG --> EXEC[builtin / agent executor / report executor]
  EXEC --> PROVIDER[agent/claude orchestration + provider runners]
  PROVIDER --> VERIFY[independent review + verification + scope + publish gates]
  ENGINE --> HANDOFF[agent/handoff: packages, workspace inspection, readiness]
  ENGINE --> EFFECTS[effects: durable terminal effects]
  EFFECTS --> REPORT[summary / outcomes / memory / learning]
```

`engine.ts` initially owns resolution, creation, lifecycle, re-execution, human decisions, attempts, budget gates, recovery, queries and handoff coordination (1,963 lines). `scheduler.ts` owns claiming, heartbeats, deadlines, executor dispatch and post-execution reconciliation. `stateMachine.ts` is the sole transition policy. `graph.ts` validates the persisted specification and provides pure dependency algorithms. Provider-specific session behavior remains in agent orchestration/runners.

### Lifecycle and transaction map

In the table, **T** means one `withTx` client, with events flushed before COMMIT and hooks executed after release. **R** means the run row is locked first. Read-only discovery before R does not acquire workflow row locks. These are actual paths, not a claim that every database write uses R.

| Operation / public entry | Owner and calls | Reads / writes | Transaction, locks, recovery and authorization |
|---|---|---|---|
| Publish / resolve / preview | `definitions.create/publish`, `validateSpec`, `resolveRunGraph`, `previewRun` | definitions/versions, users, work_items, repositories/grants, prior runs/outcomes | Publishing locks definition; immutable versions and canonical hash avoid redundant publication. Resolution checks active owner, work-item owner agreement, private/shared definition and verified repository scope; profile and optional report resolved once. Cache key includes owner/version; transactional writes bypass cache. Preview is read-only apart from test-owner setup. |
| Create / initialize | `startRun` → resolve → ordered step inserts → `advance` | runs, steps, jobs, events, work item, policy-version records | T; new run inserted before R in advance. Graph, definition version, locale, provider, owner, repository scope and branch persisted. Optional PENDING/step mode retained. No worktree reset. |
| Graph progression / finalization | `advance` → run-if / approval gate / budget preflight / ensureJob / deriveRunStatus | runs, steps, jobs, events, telemetry, budgets, run effects | Caller supplies T; R; ordered step scan, fixed-point skipping, generation-bound approvals. Job key `step:id:gen:g:n:attempt_count` + conflict-ignore. PAUSED promotes but does not enqueue; CANCELED/PENDING return. Status validation and effects share T. |
| Claim | `scheduler.claimJob` → automatic handoff poll → UPDATE/subselect | jobs, steps, runs, platform_instances, handoffs | Single atomic statement; job `FOR UPDATE SKIP LOCKED`; token and claim count increment. Instance/session, availability, lane and paused-force filters; database affinity trigger remains authoritative. No run lock here. |
| Attempt begin | `beginAttempt` → input/context → snapshot → insert attempt | users, instance, run/job/step/attempt, context_snapshots, knowledge/policy context, handoff target link | T: R → live job → step → new attempt. Reject token/generation/state/owner/instance mismatch. Shared worktree reader/writer gate serializes consumers under R; local active jobs also checked. Attempt number is historical max+1; retry count is separate. |
| Execute | `scheduler.processJob` → enforce access → personal integrations → makeContext → executor | repository permissions, artifacts, questions, events, sessions, metrics, workspaces | Outside lifecycle T, under run owner's AsyncLocalStorage execution scope. Access revalidated before protected execution; provider tools enforce narrower restrictions. Heartbeat checks token, live lease and instance/session. Timeout aborts execution and yields retryable failure. |
| Complete | `finishAttempt` → `applyResult` or `persistProviderPause` → advance → budget | run/job/attempt/step, questions, checkpoints, events, effects, telemetry, handoffs | T: lookup attempt run ID → R → job → attempt → step → STOPPING handoff. Live lease checked with clock_timestamp; token, job identity, instance/session, current attempt and generation all checked. Already terminal is no-op; fenced still-current running attempt awaits reaper; invalidated result becomes STALE. All result writes, dependent enqueue and terminal effects atomic. |
| Human questions | `insertQuestions`, registry `ask`, `answerQuestions` | questions, attempts, checkpoints, steps, jobs/events | Executor ask persists immediately outside lifecycle T. Answer groups by run in ordered IDs, T per run: R → optional authorization guard → open questions. Older-attempt answers cannot schedule. Human step completes; agent resumes from latest checkpoint. Recovery requires explicit reconcile/stop answer; pending handoff blocks scheduling. Duplicate answer may return 400, never adds execution. |
| Approval / rejection | `approveStep/rejectStep` → repository selection / scope binding / applyResult or reexecute | steps, attempts, questions, events, checkpoints, jobs | T: R → guard → step; approvals tied to generation, proposal hash and risk acknowledgement. Duplicate approval conflicts (409) without adding execution. Rejection can invalidate configured upstream. Guards remain inside mutation transaction. |
| Retry / re-execute / feedback | `reexecuteStep/retryStep/sendFeedback` → `reexecuteTx` | steps, attempts, jobs, questions, knowledge versions, events | T: R; assigned worker checked. Target and transitive downstream generations increment; outputs/approvals reset; historical attempts marked invalidated, never deleted. Live jobs canceled/token bumped, local abort after commit. Upstream/unrelated results retained. Skills pinned before enqueue. Pending handoff cannot be bypassed. |
| Pause / resume / one-step | `pauseRun/resumeRun/startPendingRun/runStepNow` | runs, steps, jobs/events | T: R; resume only PAUSED, duplicate request conflicts (409), serialized advance prevents duplicate enqueue. Explicit instance adoption check never transfers ownership. Force job permits exactly chosen step while paused. Pause does not kill existing execution. |
| Cancel / stop / skip | `cancelRun/stopStep/skipStep` | runs, steps, attempts, jobs, questions, events/effects | T: R; cancel jobs bumps tokens before step changes; cancel marks running attempts CANCELED and dismisses open questions. Local abort only after commit. Waiting history retained. STOPPING handoffs may remain persisted but canceled run cannot resume. |
| Shutdown / expired lease | `releaseAttempt/reapExpiredLeases` → `recoverInterrupted` → advance | run/job/attempt/step, questions, checkpoints, agent_sessions, handoffs, events | T per run/job: R → job → attempt → step. Reaper rechecks expiry under lock; claimed-without-attempt requeues with incremented token. Safe control steps replay; unknown/side-effecting steps require reconciliation. Interrupted attempt retained, retry count refunded, latest checkpoint + resumable provider session copied, worktree untouched. STOPPING becomes BLOCKED without termination proof. |
| Provider pause / switch | `prepareProviderPause/requestProviderHandoff/resumeProviderHandoff/processAutomaticHandoff` | handoffs, artifacts, checkpoints, sessions/telemetry, audit_log, runs/steps/jobs/attempts/events | Build bounded/redacted package outside completion T after executor stops. STOPPING request committed before local abort. Completion rechecks racing request. Resume readiness checked outside T, then T: R → step → handoff; termination, generation/current attempt, workspace fingerprint, scope, approval, questions, policy/cost/tokens and instance checked. RESUMED duplicate is no-op; next begin links target attempt. Automatic poll uses handoff SKIP LOCKED + persisted next_check_at; restart preserves pending operation. |
| Session restore / verification | `agent/claude.ts` executor; native provider runners | agent_sessions, progress checkpoints, context, artifacts, tested/reviewed heads | Independent verifier always fresh; other resumes constrained by provider, workspace and upstream context. Invalid resume marks session nonresumable and rebuilds from persisted history/answers/progress. Coding verification/repair bounded; PR executor gates scope, clean tree, tested heads and independent PASS before Git/PR side effects. No provider calls moved into lifecycle transactions. |
| Final reporting / durable effects | `setRunStatus` → `enqueueRunEffects` → `dispatchRunEffects` | run effects, summary/outcome/memory/learning tables | Effect rows atomic with status; unique run/kind avoids duplicate enqueue. Dispatch leases rows, performs effects after claim, deletes on success, releases on failure; crash retries after lease. Notifications are best-effort after-commit background hooks, not durable effects. |
| Read API | `getRun/listRuns/runDetail/stepDetail/openQuestions/answeredQuestions` | runs, steps, versions, questions, attempts, artifacts, PRs, workspaces, checkpoints, sessions, snapshots, handoffs/metrics, instance health | Existing scope arguments/caller authorization retained. Parallel pool reads are a read model, not one consistent snapshot. `txThenRun` reads after commit; branches operation deliberately reads on its client. |

### Existing invariants and limitations

1. Atomic result application, graph advancement, attempt history and durable terminal effects use the same client. `q/one` and deferred events preserve rollback and cache invalidation semantics. No extraction may open a nested transaction or substitute the pool.
2. Run-level serialization is the primary lock-order invariant. Begin uses run → job → step; finish/release/reaper use run → job → attempt → step. Human operations use run → questions/step; handoff resume uses run → step → handoff. The old blanket comment run → job → step → attempt was inaccurate. Claim, heartbeat, automatic handoff poll and executor helpers have narrower standalone write contracts.
3. `assertStepTransition`, `assertRunTransition`, `deriveRunStatus` remain the only policies. Attempt/job/handoff statuses use existing dedicated SQL paths, not the step state machine.
4. Successful completion requires live job lease, token, identity, generation, current attempt, run instance and instance-session ownership. Cancellation/re-execution/reaping fence workers. Metrics have a live token predicate too. Executor logs/artifacts/questions/session writes are not all fenced; do not overstate the existing guarantee as universal side-effect fencing.
5. Idempotency means no duplicate execution, not identical HTTP responses: second run resume conflicts; second already-answered question submission can fail; approval also conflicts; completion/handoff have their own duplicate behavior.
6. Retry budgets and historical numbering differ intentionally. Recovery refunds consumed budget but retains historical attempts and partial telemetry. Safe recovery is an explicit allowlist; never broaden it while extracting.
7. Authorization is layered: routes enforce run/work-item access and CSRF; action guards recheck decisions in T; scheduler executes as owner; repository and provider tool restrictions remain at execution boundaries.
8. Persisted JSON shapes, schema defaults, immutable definition versions, session provider affinity, checkpoint references, unique keys and explicit legacy worker-assignment refusal are compatibility contracts.
9. Most Git/provider/network execution is outside lifecycle T. Existing exceptions must be retained and documented: graph resolution can verify repository permissions during creation; handoff resume inspects local Git under R; context preparation occurs during begin. Notifications lack durable replay; terminal effects have durable at-least-once delivery. This refactor does not redesign those contracts or claim exactly-once external effects.

## Maintainability problems and target boundaries

The engine mixes transaction primitives, graph progression, spending policy and crash reconciliation with public orchestration. Recovery's replay allowlist and checkpoint composition are hard to inspect independently. Budget queries distract from result application. The current state rules are already cohesive; splitting the entire engine by noun would create cycles (`applyResult` ↔ reexecute ↔ advance, and completion ↔ handoff persistence).

Use a small directional decomposition:

- `engine.ts`: compatibility exports and existing public lifecycle, human decisions, attempt completion and handoff orchestration. Keep tightly coupled result/re-execution/handoff paths together.
- `mutations.ts`: shared run lock, ordered step reads, validated run/step mutations, enqueue/cancel job primitives and shared EngineError/hook type. Helpers require caller's transaction; they never start one.
- `budgets.ts`: existing preflight and post-result budget gates; same queries/order/client; depends on mutations.
- `progression.ts`: fixed-point dependency progression, approval-gate scheduling and run derivation; depends on budgets and mutations.
- `recovery.ts`: safe replay policy, shutdown release and expired-lease reconciliation; owns its original transaction callbacks; depends on progression and mutations.

No generic repository, service interface, second state machine or new dependency is needed. Existing engine imports remain valid by re-exporting moved public functions/classes. Scheduler may import recovery directly while preserving engine compatibility exports. Lower modules must not import engine. Preserve query count, lazy Telegram import, event batching, cache behavior and background effect dispatch. No performance improvement is claimed.

## Refactoring risks and compatibility constraints

Highest risks are changing SQL/lock ordering, breaking shared object mutation (`run.status`, step patch), moving hooks before commit, changing retry identity/history, resetting session/worktree state, exposing helpers as alternate authorization entry points, or introducing import cycles through effect/provider modules. Extraction must retain bodies and explicit Db/client arguments. Integration tests use disposable local PostgreSQL only, registered fake executors and local Git; no paid provider/integration validation. Exact function-body comparison supplements database fault tests. Older unassigned runs intentionally remain blocked pending explicit administrator assignment; this is preserved behavior, not a migration requirement.

## Verification

Validation results and concrete invariant test mapping are recorded below after implementation. Historical production snapshots are not available; compatibility testing can cover persisted current-schema rows with absent optional metadata and prior definition versions, but cannot prove every historical production payload resumable.

### Implemented dependency graph

```mermaid
flowchart TD
  scheduler --> engine
  scheduler --> recovery
  engine --> recovery
  engine --> progression
  engine --> budgets
  engine --> mutations
  recovery --> progression
  recovery --> mutations
  progression --> budgets
  progression --> mutations
  budgets --> mutations
  mutations --> stateMachine
  progression --> stateMachine
  mutations --> effects
  mutations --> events
```

The engine → recovery edge is a compatibility re-export. There is no import back into the engine from the extracted modules. The existing lazy Telegram import remains lazy. Completion, result handling, re-execution and handoff coordination stay together because they call one another within the same transaction.

### Maintainability evidence

| Measure | Before | After |
|---|---|---|
| Engine size | 1,963 lines | 1,649 lines (314 fewer, 16.0%) |
| Shared mutation ownership | Embedded in engine | `mutations.ts`, 98 lines |
| Budget policy / queries | Embedded in advance/result orchestration | `budgets.ts`, 100 lines |
| Dependency progression | Embedded in engine | `progression.ts`, 65 lines |
| Interruption policy / reconciliation | Embedded in engine | `recovery.ts`, 94 lines |
| Engine public named declarations | 46 | Same 46, including compatibility re-exports |
| Original engine function signatures/bodies | 55 | All 55 retained byte-for-byte, ignoring added `export` keyword; one owner each |
| Static runtime import cycles across src | 2 | Same 2; none includes an extracted module |
| State machines / migrations / new dependencies | One / zero added / zero added | Unchanged |

The five implementation files total 2,006 lines versus the original 1,963: explicit imports, exports and boundary documentation add 43 lines. This is an ownership improvement, not a total-code-size optimization. No duplicated business rule was removed and no existing dependency cycle was eliminated. The recovery allowlist remains single-owned; transition rules remain in the original state machine. Query count, batching, cache keys and retry delays were not optimized or changed; no performance gain is asserted.

### Regression evidence

`test/workflow-reliability.test.ts` adds nine local PostgreSQL integration tests:

- Eight concurrent claims yield one owner; expired claim before begin can be requeued and old token rejected.
- Lease expiry rejects completion even before the reaper; safe recovery retains historical numbering and refunds retry budget.
- Checkpoint trigger failure during completion rolls back all observed run/step/job/attempt/question/checkpoint/event/effect/handoff rows; retry applies once.
- A one-shot PostgreSQL SQLSTATE 08006 fault after successful step mutation causes rollback and one idempotent transient retry, with one attempt, dependent job and completion event.
- Checkpoint trigger failure during shutdown release rolls back STOPPING handoff, question and attempt mutations. Successful reconciliation preserves session/cwd/checkpoint, blocks handoff, retains answers and refunds budget.
- Concurrent run resume and approval preserve 409 duplicate behavior and one queued job; cancellation rejects late success.
- A held run-row lock creates an observed PostgreSQL lock wait during completion; the job remains lockable with NOWAIT until run serialization is released.
- Failure during deferred terminal-event flush rolls back successful attempt, derived run status and durable terminal effects before retry.
- A persisted run with absent optional policy metadata retains its pinned graph after definition publication and resumes with checkpoint/answer/history intact. This is a compatibility simulation, not a historical production fixture.

`test/codex.test.ts` and its existing fake CLI add a missing-session case: native resume fails, the old session is marked nonresumable, fresh execution receives the stored answer, the run completes, and the completed upstream step is not repeated. No production provider implementation changed.

The initial six reliability cases passed on the unmodified baseline before extraction. Stage checks: mutation/effects 9/9; budget/completion 8/8; progression/profile/re-execution 20/20; final focused reliability/handoff/instances/Codex 61/61. An intermediate recovery run overlapped dependency installation and failed to load packages; it was discarded and rerun after installation. Initial typecheck identified stale installed dependencies (`mysql2` missing); lockfile-preserving `npm ci --no-audit --no-fund` resolved it. Initial smoke launch failed because cached Chromium lacked libnss3; the installed Nix Chromium succeeded. Generated smoke screenshots were restored so no unrelated UI artifacts enter this change.

### Genuine follow-ups

1. Evaluate fencing for executor `ask`, artifact and session persistence separately. Existing helpers can write after an attempt loses authority even though successful completion and metrics are fenced. Tightening these predicates is a behavior change requiring dedicated late-writer tests; it is intentionally excluded here.
2. Add sanitized historical persisted-run fixtures when available. Current-schema compatibility simulation, pinned-definition tests and explicit legacy-instance refusal do not prove compatibility with every historical JSON payload.

### Persistence ownership outside lifecycle transactions

The lifecycle table above must not be mistaken for exclusive ownership of every write. The audit also inspected these existing persistence boundaries; none moved in this change:

| Table(s) | Other writers / contract |
|---|---|
| `workflow_runs` | Repository-scope enforcement narrows/refreshes allowed scope before protected execution; summary/outcome services enrich completed records. No alternate run-status policy introduced. |
| `workflow_step_attempts` | Scheduler records `executor_stopped_at` after execution with attempt token; registry stores session ID and fenced metrics; progress/provider tooling stores evidence/telemetry under existing execution checks. |
| `workflow_jobs` | Claim and heartbeat are standalone fenced UPDATEs; database instance-affinity trigger guards claim ownership. |
| `workflow_questions` | Registry `ask` persists immediately so provider interruption cannot discard questions. Later answer/resolution paths remain run-serialized and current-attempt-aware. |
| `workflow_events` | Executor transcripts are standalone best-effort retry writes; lifecycle events are deferred on the transaction client and flush before COMMIT. |
| `workflow_checkpoints` | Tool/progress writers persist during execution; result/recovery/handoff checkpoints use their original lifecycle transaction. |
| `context_snapshots` | `context.resolveContext` inserts immutable attempt context and knowledge/prompt-plan snapshots on the begin client. |
| `workflow_artifacts` | Registry artifacts and report evidence upload/delete are standalone writes under existing caller authorization; `agent/handoff` upserts workspace evidence by attempt/name/fingerprint before transactional confirmation. |
| `agent_sessions` | Registry records provider-specific sessions; failed native resume marks the matching provider/session nonresumable. Recovery reads latest resumable session without changing it. |
| `execution_workspaces`, `pull_requests` | Git/workspace provider and built-in PR executor persist local workspace / published PR results outside lifecycle T; provider contracts, branch selection and reconciliation rules remain unchanged. |
| `execution_attempt_telemetry`, handoff metrics | Existing telemetry persistence/projections retain partial and stale-attempt usage. Budget queries use reported costs without pretending to impose a provider hard cap. |
| `workflow_run_effects` | Status transition enqueues in caller T; dispatcher claims, releases and deletes outside that T, providing durable at-least-once processing. |

Existing standalone writer exceptions motivate the narrow scope of the refactor: consolidating them into a new persistence service would change locking, latency, error handling and authorization behavior rather than merely clarify ownership.

### Reproduce validation

Provision a disposable **local** PostgreSQL instance on port 55439 (or another unused local port). `test/setup.ts` refuses remote hosts and creates a unique database per file. The validation run used PostgreSQL 17 Alpine without a persistent volume. Export this only to the test process; do not set the application's production DATABASE_URL:

```bash
export TEST_DATABASE_ADMIN_URL=postgres://platform:platform@localhost:55439/platform
npm run typecheck
node --disable-warning=ExperimentalWarning --import ./test/setup.ts --test --test-concurrency=1 test/workflow-reliability.test.ts test/provider-handoff.test.ts test/instances.test.ts test/codex.test.ts
npm test
npm run build
CHROMIUM_BIN=/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium npm run smoke:handoff
CHROMIUM_BIN=/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium npm run smoke:orchestration
git diff --check
```

`CHROMIUM_BIN` is specific to this environment; use an installed compatible Chromium elsewhere. The paid/live smoke command (`smoke:codex`) was intentionally not run. Source-level comparison also verified the 55 function bodies, all 46 facade declarations and unchanged static import-cycle components against baseline commit `fe236e1`.

### Final results

| Check | Result |
|---|---|
| `npm run typecheck` | PASS (backend and web) |
| Final focused reliability / provider-handoff / instances / Codex test command above | PASS: 61 tests, zero failures or skips |
| `npm test` | PASS: 663 tests, 662 passed, zero failures, one optional real MySQL test skipped (`TEST_MYSQL_HOST` absent); 480.6 seconds |
| `npm run build` | PASS |
| `npm run smoke:handoff` with installed Chromium | PASS: English/Vietnamese durable pause, explicit confirmation, continuation and provider history; no uncaught browser errors |
| `npm run smoke:orchestration` with installed Chromium | PASS: mixed-provider draft controls, owner override, inspector and locales; no uncaught browser errors |
| `git diff --check` | PASS |
| Source signature/body and public declaration comparison | PASS: all 55 functions / 46 public declarations preserved |
| Static import SCC comparison | PASS: same two existing cycle components; no new cycle |

| Invariant | Direct test evidence | Result |
|---|---|---|
| I1 Transaction atomicity | New checkpoint, transient completion and deferred-event SQL fault tests; recovery/handoff rollback snapshots; existing pool rollback/hooks tests | PASS |
| I2 Lock ordering | Observed run-lock barrier with job NOWAIT; concurrent claim and decision tests; unchanged SQL order in all 55 function bodies | PASS for changed paths; not an exhaustive proof of all interleavings |
| I3 State machine integrity | Original transition tables/assertions unchanged; full pure/engine tests exercise illegal transitions, derived states, approval gates and invalidation | PASS |
| I4 Fencing | Expired lease before reaper, zombie result, generation invalidation, cancellation, actual multi-process instance/session replacement and stale telemetry tests | PASS |
| I5 Idempotency | Eight competing claims, duplicate completion/release/resume/approval, dependent enqueue after transient retry; existing duplicate handoff confirmation tests | PASS (existing duplicate conflicts preserved) |
| I6 Authorization | `repository-access.test.ts` queued execution after revocation and retry; `authz.test.ts`; handoff endpoint ownership/CSRF/audited admin tests; step tool restrictions | PASS |
| I7 External side-effect ordering | Transaction bodies unchanged; pool afterCommit tests; effects persistence/dispatch tests; local Git publish/verification gates; browser smokes use fixtures | PASS for tested paths; no live production integration invoked |
| I8 Persisted compatibility | Pinned-definition tests; persisted optional-metadata/checkpoint/answer case; same-thread resume and missing-session rebuild; handoff restart; legacy assignment refusal | PASS for tested shapes |
| Retry, interruption and resume | New rollback/budget/history tests; engine shutdown/DB-drop/human-answer tests; instance crash tests and provider session fallback | PASS |
| Provider handoff | Full handoff tests include restart, STOPPING interruption, cancellation race, duplicate resume, permissions, budgets, workspace drift and retained human questions; browser handoff smoke | PASS |
| Actual historical production payload corpus | No historical database snapshot/fixtures supplied | NOT VERIFIED |

All regression databases were unique databases in the disposable local PostgreSQL container. No production infrastructure, paid AI models or production integrations were used. The disposable container was removed after validation. The branch is based on fetched main `fe236e1`; no push or deployment was performed.
