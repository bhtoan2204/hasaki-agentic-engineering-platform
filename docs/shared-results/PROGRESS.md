# Shared results: progress

- [x] 1. Survey and plan (docs/shared-results/PLAN.md): approved (answers to the open questions were not recorded; step 2
      follows the plan's proposals)
- [x] 2. Schema + dedup key
- [x] 3. Lookup + single-flight
- [ ] 4. Invalidation + retry + force re-run + provenance
- [ ] 5. Access + scrub
- [ ] 6. Metrics + tracing + feature flags + backfill
- [ ] 7. UI / API

## Step 2 (schema and key)

Done:

- `migrations/112_shared_analyses.sql`: `shared_analyses` (+ lookup, one-running, error-key and running-run indexes),
  `shared_analysis_uses`, and the `shared_results.installation_id` setting (the key scope, created once).
  Additive; nothing existing changes. Rollback: `docs/shared-results/rollback/112_shared_analyses.down.sql` (run by hand;
  drops both tables, keeps the installation id, deletes the migration record so the migrator applies 112 again).
- `src/sharing/key.ts` (pure): `runtimeRcaKey`, `bugHuntKey`, `codeAssessmentKey`, `rubricHash`, `modelOf`,
  `normalizeFocus`, `reposOf`, `errorKeyOf`, `canonicalJson`. `src/sharing/scope.ts`: `installationId()`.
- Flags declared in `config.sharedResults` (`SHARED_RESULTS_PROD_ERRORS`, `SHARED_RESULTS_CODE_ASSESSMENT`, both default
  off) and the TTLs (`SHARED_RESULTS_TTL_*`, 24 h / 30 d / 30 d). **Not read by any code path yet.** `.env.example` documents them.
- Tests: `test/shared-key.test.ts` (17: every example of the plan with the real `signatureOf`/`fingerprint`, pinned golden
  keys, same error on another deploy, partial code change, rubric/prompt/model/definition change, scope isolation),
  `test/config-env.test.ts` (flags default off, per-kind, TTL validation), `test/shared-analyses-schema.integration.ts`
  (7: constraints, single-flight index, index-probe lookup, uses, rollback and re-apply).

Not done (later steps): lookup/store, single-flight use, validity and retry, force re-run, access and scrub, metrics,
UI/API. The analysis flows are untouched.

Where the implementation is stricter than, or adds to, the plan (none contradicts it):

- Commits in keys must be **full SHAs** (40 or 64 hex). The plan's examples abbreviate them (`a1b2c3d`) for readability; an
  abbreviation could not match the full SHA `source_revisions` stores.
- `normalizeFocus` also applies Unicode NFC, so composed and decomposed Vietnamese give the same key (the plan lists
  trim, whitespace and lower-case).
- The model must be the resolved model id; `default`/`auto` and empty are refused (a key with a placeholder would merge
  different models).
- Extra integrity checks in the migration: key is 64 hex, error key is 20 hex, a production-error kind needs an error
  key and a code assessment must not have one, `valid`/`stale`/`superseded` rows must carry a result, counters are non-negative.
- `rubricHash` normalizes only line endings and trailing whitespace; inner whitespace counts as content.

Remaining risks:

- **Rubric inputs are not wired yet.** What exactly feeds `rubricHash` (step instructions of the resolved definition
  version, pinned skills and knowledge versions) and `modelOf` (the step's resolved provider and model) must be read from
  the real run configuration in step 3; if a flow resolves them late, the key must be computed after that point.
- **A broader focus match than today.** Today `reusableScan` compares the focus text exactly (case-sensitive); the key
  lower-cases it. Two focus texts that differ only by case will now share a result.
- The error key is the existing group fingerprint (plan question Q2, option a). The message is cut at 400 characters
  before normalizing, so errors that differ only after it share a key (unchanged behaviour).
- Migration 112 will be applied to the real database the next time the server starts; it is additive and idempotent.
- `installationId()` caches the id per process; restoring a database from another installation would change the scope
  (old results then simply never match).

## Step 3 (lookup-before-compute and single-flight)

Done:

- `src/sharing/service.ts`: `lookupOrStart` (hit / wait / miss / bypass) and `waitForAnalysis`.
- `src/sharing/repository.ts` (SQL), `src/sharing/types.ts` (kinds), `src/sharing/hooks.ts` (hook points),
  `src/sharing/context.ts` (definition version, rubric and model of a key, read before any run exists),
  `src/sharing/flows.ts` (the three analyses), `src/sharing/settle.ts` (reconcile task: publish or fail).
- Wired behind the flags. With a flag off every path is the previous one: the flows return `null` before any query, and the
  reconcile task returns at once.
  - Code Assessment: `POST /api/code-scans`, after the existing per-owner `reusableScan`. Base commits are now resolved
    at most once per request (memoized), whether the per-owner check, the shared key or both need them.
  - Runtime RCA: `startRuntimeShared` (the API's entry point), inside the existing per-owner advisory lock and after the
    existing "already completed → 409" check.
  - Bug Hunt: `startBugHuntShared` and the workbench's `startHuntShared`, inside the existing per-owner lock, after the
    active-hunt check. The commits for the key are resolved only when the flag is on.
  - `startRuntime`, `startHunt` and `startBugHunt` keep their old signatures and never share (benchmarks, tests).
- Config: `SHARED_RESULTS_RUNNING_TIMEOUT_MINUTES` (360) and `SHARED_RESULTS_WAIT_TIMEOUT_MS` (30 000).
- Tests: `test/shared-results-lookup.integration.ts` (14, stable over 3 consecutive runs).

### Why this mechanism

- **Single-flight = the partial unique index `shared_analyses_one_running` + "claim and start the run in ONE
  transaction".** `startRun` already accepts the caller's transaction, so the claim row and the run commit or roll back
  together:
  - no in-process lock, which would not work across instances;
  - no advisory lock held across a model run;
  - no separate queue: the workflow engine already is one, with leases, recovery and fencing.

  A concurrent claimer blocks on the unique index until the first transaction ends, then gets `23505` and looks again
  (now a waiter). Up to 3 attempts.

- **Crash handling relies on the engine's own run lifecycle**, not a second lease. A claim always points at a run, and
  the reconcile task (`registerReconcileTask("shared_results")`, every tick, on every instance) settles claims whose run
  is `COMPLETED` (publish the snapshot, or fail when there is no output), `FAILED` or `CANCELED` (fail), gone (fail),
  or older than the running timeout (fail; a late result is ignored). Each row is settled by a guarded `UPDATE ... WHERE
status = 'running'`, so exactly one instance publishes it and sends `NOTIFY shared_analysis`.
- **Waiters** are not blocked inside the HTTP request: the API answers `wait` with the analysis id at once.
  `waitForAnalysis` (for callers that want to block, and for step 7's API) is woken by the notification through the shared
  LISTEN connection, with a poll as the backstop, and returns `timeout` at its deadline.

### Hook points for later steps (`src/sharing/hooks.ts`, `setSharingHooks`)

| Hook                    | Called                                                                | Default now                         | Step                                |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| `servable(row, now)`    | a valid row is found                                                  | `status = 'valid'`                  | 4: TTL and stale                    |
| `mayStart(latest, now)` | before claiming (nothing usable)                                      | always                              | 4: failed backoff (`next_retry_at`) |
| `canRead(row, actor)`   | before serving a hit or a wait                                        | **creator only**                    | 5: repository and namespace access  |
| `scrub(kind, result)`   | before a snapshot is stored                                           | identity                            | 5: scrub policy                     |
| `observe(event)`        | every outcome (hit, wait, miss, bypass, lost_race, published, failed) | one log line with in-scope ids (R1) | 6: metrics and tracing              |

Force re-run (step 4) plugs in at the callers, which already skip the lookup on `force`. It will then claim a new
version instead of bypassing sharing.

### Decisions to confirm (differences from the plan)

- **A valid or running result the caller may not read gives `bypass`**: the caller runs its own analysis outside sharing,
  as today. The plan (6.1) said the caller's run "becomes another version under the same key". That would supersede a
  result for everyone allowed to read it, and two members with different access would keep replacing each other's.
- **Until step 5, `canRead` serves a result only to the member who created it.** With the flags on, nothing crosses
  members yet. This is deliberate, so that no access decision is made before step 5.
- **The model part of a key** = every agent step's `provider/model` as `resolveStepAgent` gives it, plus a fingerprint of
  those providers' configuration (defaults and all profiles). Why: the run's execution profile (AUTO) is decided inside
  `startRun`, so before the run it is not known which profile's model will be used. Every model change, for any profile,
  gives a new key (more keys, never fewer).
- **The rubric** = the instructions, output contracts and schemas of the workflow version's agent steps, plus the
  skills those steps name at their current shared version.

### Concurrency scenarios

Checked (tests):

- 12 parallel requests, one key: exactly one `startRun`, 11 waits, all on the same analysis.
- A second "instance" (separate pool and connection) holding a claim while this one looks up: no second run.
- The run fails to start inside the claim transaction: neither claim nor run is kept; the next request claims.
- The run is canceled or fails after the commit: the claim is failed, a waiter is woken by `NOTIFY` (not by its 60 s
  poll), and the key is free again (version 2).
- A run completes: published, the next lookup is a hit, no second run; uses and `reuse_count` recorded.
- A run completes without the analysis output: failed, never published empty.
- A run stuck past the running timeout: failed, key freed; its late completion is not published.
- A waiter reaches its timeout: returns `timeout` with the running row.
- Three settle passes at once (three instances): each row published exactly once.
- Hooks: `canRead` false gives `bypass` and never supersedes; `servable` false re-runs as a new version; `mayStart` false
  gives `bypass`.
- Flags off: the flows return `null` and the reconcile task does nothing; the existing integration suites pass unchanged
  (unified incident, bug hunter, code findings, all 1203).

Not checked (reasoned only, or not reproducible in tests):

- A real process kill between the claim's `COMMIT` and the HTTP answer. It is equivalent to the "run ends" cases above,
  since the run's own lease recovery takes over, but it was not killed for real.
- A lost `NOTIFY` during a LISTEN reconnect: covered by the poll backstop (`pollMs`, default 2 s), but no test drops a
  notification.
- Three lost races in a row (`MAX_CLAIM_ATTEMPTS`): the caller then gets the `23505` error. Not provoked.
- Settling by timeout and by run completion at the same moment: both are guarded by `status = 'running'`, so one wins.
  Not provoked as a race.
- The HTTP routes with a flag on (code scans need fetched repositories, RCA and hunts need provider runs). The flows are
  tested directly; the routes are tested with the flags off (existing suites).

### Remaining risks

- **Bug Hunt with the flag on resolves the base commits (a fetch) while holding the per-owner advisory-lock connection.**
  Today that connection is held during `startRun` too; the hold is now longer.
- **Duplicate cost until step 5.** Two members asking for the same analysis at once with the flag on still run twice:
  the second gets `bypass`, because access is not decided yet.
- **Runtime RCA inputs include the requester's own prior evidence digest**, but the key does not (plan section 3.2). A
  shared RCA was computed with the creator's digest.
