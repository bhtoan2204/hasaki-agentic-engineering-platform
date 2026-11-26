# Shared results: progress

- [x] 1. Survey and plan (docs/shared-results/PLAN.md): approved (answers to the open questions were not recorded; step 2
      follows the plan's proposals)
- [x] 2. Schema + dedup key
- [x] 3. Lookup + single-flight
- [x] 4. Invalidation + retry + force re-run + provenance
- [x] 5. Access + scrub
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

## Step 4 (validity, retry, force re-run, provenance)

Done:

- `migrations/113_shared_analyses_provenance.sql` (additive): column `observed` (what was true at analysis time) and two
  indexes (`shared_analyses_subject` for marking a subject's older results, `shared_analyses_expiry` for the TTL sweep).
  Rollback: `docs/shared-results/rollback/113_shared_analyses_provenance.down.sql`; the 112 rollback now also removes 113's
  record, since 113 only extends 112's tables (tests cover both, and re-applying).
- `src/sharing/policy.ts` (pure): `isServable`, `validUntil`, `backoffMinutes`, `retryState`, `canStart`, `staleReason`. The
  `servable` and `mayStart` hooks of step 3 now default to these.
- `src/sharing/view.ts`: `describeAnalysis` (also exported as `sharedView`): the answer the API gives, ready for step 7.
- Config: `SHARED_RESULTS_MAX_ATTEMPTS` (3), `SHARED_RESULTS_RETRY_CAP_MINUTES` (60); the TTLs of step 2 are now used.
- Tests: `test/shared-policy.test.ts` (5), `test/shared-results-validity.integration.ts` (19), schema test (+2, 8 in all);
  the step 3 test (14) adjusted for the two behaviours below. The three files are stable over 3 consecutive runs.

### Rules as implemented

**Stale / valid / failed**

- A result is served only while `valid` and before `valid_until` (set at publish: RCA 24 h, bug hunt and assessment 30 d,
  configurable). A row past its end is not served even before anything marks it.
- `stale` is marked three ways, each with a reason: (1) the reconcile task marks valid rows past their end `ttl`;
  (2) when a request claims a new key for the **same subject** (same kind, repositories, error, focus), the older valid
  results of that subject become stale with `commit_changed:<repos>`, `definition_changed`, `rubric_changed`,
  `model_changed` or `contract_changed` (computed by comparing the two keys' readable parts; this runs in the background
  after a miss, never on the hit path); (3) nothing else: a different subject is never made stale.
- `failed` is never served and not cached forever: the count of failures in a row is carried into the next version of the
  key; the key may start again after `min(retry cap, 2^failures)` minutes (2, 4, 8, ... 60) and not at all after
  `MAX_ATTEMPTS` (3) except by a force re-run. During backoff a request gets `bypass` (it runs its own analysis outside sharing, as
  today). A failed latest version that follows a valid one holds the key too (the older valid is not served meanwhile).
- A run **canceled by a person is not a failure**: attempts stay, no backoff, the key is free at once.
  (A decision of mine: the plan says "failed: retry with backoff"; a cancel is not the analysis failing.)

**Force re-run: a new version, never an overwrite** (as decided in the plan, section 4.4)

- `force` claims version N+1 (trigger `force`, audit row `shared_analysis.force`). Version N stays `valid` and served while
  N+1 runs; when N+1 is published, **in the same statement** every older valid version of the key becomes `superseded`. A
  failed force leaves N in place.
- Single-flight is unchanged: a force beside a running analysis gets `wait` (no third run); five parallel forces start nothing.
- A member who may not read the existing valid result cannot force over it (`bypass`): that would supersede the result for
  everyone who may read it. Who may force is a step 5 decision (hook `canRead`); `force` itself is not yet authorized.
- The callers (code scans, RCA, bug hunt) now pass `force` into the shared path instead of skipping it, so a force with a flag
  on is a new version; with the flag off it is the previous behaviour.

**Production errors**: new occurrences never invalidate or re-run. The error group is updated by the scans as before;
`observed` stores the counters at publish; the answer carries `occurrences`: `at_analysis`, `now`, and
`new_since_analysis` (only when both are for the same scan day, otherwise null: per-window counts are not comparable).

**Provenance** (all from rows the run already has; nothing is measured again):

- At claim: who (`created_by`, name joined in the lookup query), trigger (manual / force / schedule), provider(s), model
  (incl. the configuration fingerprint), definition version, rubric hash, the key's readable parts.
- At publish: tokens in/out and cost from the run's attempt telemetry (null when no provider reported them, never an
  invented 0), run wall time, `valid_until`, `observed`.
- Reuse: `reuse_count`, `last_reused_at`, and a `shared_analysis_uses` row per use with `tokens_saved` (the original run's tokens)
  on a hit. **The hit path adds no query**: one SELECT answers it (the runner's name is joined into it); the use row and the
  counter are one statement run in the background after the answer (test: the answer returns while the row is locked
  by another session, and the total is exactly 2 statements).
- The answer (`describeAnalysis`): status, `freshness` (analysed_at, age_seconds, valid_until, expired, stale_reason),
  `run_by` {id, name}, `provenance`, `reuse`, `failure` {attempts, reason, retry_at, exhausted}, `occurrences`, `run_id`
  only for the member who started it, `result` only on a hit.

### Hooks (additions to the step 3 table)

`servable` and `mayStart` are now implemented (policy.ts) and remain overridable. `canRead` and `scrub`: see step 5;
`observe` (step 6; it now also receives `forced` and `expired`).

### Where the step touched step 3's behaviour

- **Not changed:** the claim, the unique-index single-flight, the settle task's guards.
- **Changed, and the tests of step 3 were adjusted:** (1) the use is recorded in the background, so a test reads the counter
  after `settleBackground()`; (2) a run that fails or times out now sets a backoff, so the next request is `bypass` until
  the backoff passes (the step 3 test that expected an immediate re-claim after a timeout now clears the backoff first).

### Decisions to confirm

1. **Marking stale by subject** needs the old key's readable parts; this is the only reason for the new index. A result is
   marked stale when someone _claims_ a newer key of its subject, not when the code merely moves. If nobody asks, the old
   result stays `valid` until its TTL (it is never served anyway, since its key no longer matches any request).
2. **Backoff and attempts count only the analysis's own failures** (run failed, nothing produced, timeout), not a cancel.
3. **A failed force does not make the key `bypass` forever**: it is a failed latest version, so the normal backoff applies
   after it.

### Not checked / remaining risks

- The cost and token sums are read from the run's attempts at publish. A run that publishes before its last attempt's
  telemetry is final would store slightly lower numbers (not observed; `settle` runs after the run is terminal).
- The TTL sweep marks at most 200 rows per tick; a large backlog clears over several ticks (rows past their end are not
  served meanwhile, so this is cosmetic).
- `occurrences.new_since_analysis` compares per-scan-window counters (the group's `today_count`), so it is only meaningful for
  the same day; the view says null otherwise.
- With a flag on, a bug hunt still resolves base commits (a fetch) while holding the per-owner advisory-lock connection
  (unchanged from step 3).
- The route-level behaviour of `force` with a flag on was exercised through the flows (`lookupOrStart`), not through HTTP.

## Step 5 (access, isolation, scrub)

Done:

- `src/sharing/access.ts`: `canReadShared(row, actor)`, the default `canRead` hook. It uses the platform's own access, with
  no new permission system:
  - the row's `key_parts.scope` must be this installation's id;
  - **code assessment, bug hunt**: the actor reads **every** repository in `scope_repos` now (`listAccessibleRepositories`:
    grants, shared level, Bitbucket/GitHub/GitLab verification). An empty or unknown repository list is denied;
  - **runtime RCA** (plan Q3, the proposal): the actor can search logs themselves, either a personal Splunk login
    (token or cookie), a usable personal SigNoz connection, or the shared Splunk token when `splunk.allowSharedToken` is
    on. New helpers `splunkConfiguredFor` and `signozConfiguredFor` read storage only and never call Splunk or SigNoz;
  - the creator gets no exception; any error denies (fail closed, logged with ids only).
- `src/sharing/scrub.ts`: `scrubResult`, the default `scrub` hook, `SCRUB_VERSION = 1`. Policy, in order:
  1. extra credential patterns;
  2. `redactPii` (which includes `redactSecrets`);
  3. a string that `looksSecret` still flags is replaced by `[redacted]`, as is any string under a field named like a
     credential (password, secret, api_key, \*token, authorization, cookie, dsn, connection_string, ...).
- Scrub runs **before the write**:
  - `settle` scrubs, then publishes. A scrub that throws fails the row (`scrub failed`, counted) and stores nothing.
  - `publish` records `key_parts.scrub_version`.
  - The free-text `focus` is scrubbed before `insertRunning` stores `key_parts`; the key hash is computed beforehand and
    is unchanged.
- `lookupOrStart`: `bypass` returns the row only when the caller may read it (otherwise `analysis: null`), so no version,
  key or runner name crosses an access boundary. This applies to every bypass, including a backoff.
- `waitForAnalysis(id, actor, opts)` takes the actor and re-checks access on the row it returns. A waiter who cannot read
  it, or who lost access while waiting, gets `{status: "denied", analysis: null}` and the observe event `denied`.

### Data paths into and out of the shared store

| Path                                     | Access                                                                                                         | Scrub                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| In: claim (`insertRunning`)              | The caller's own row. A valid or running row they cannot read gives `bypass`, never a new version              | `focus` scrubbed; other parts are hashes, commits, ids, config names       |
| In: publish (`settle` → `publish`)       | Reconcile task; no actor                                                                                       | **The result is scrubbed before the UPDATE**; `observed` holds counts only |
| In: fail / stale / expire / supersede    | Guarded by status; stale and supersede only within the same kind, key, scope and subject                       | Fixed reasons and repository names only                                    |
| In: use row (`recordUse`)                | Recorded only after a hit, wait, miss or forced that passed the check                                          | Ids and numbers                                                            |
| Out: hit                                 | `canRead` before returning                                                                                     | Stored scrubbed                                                            |
| Out: wait (the running row, runner name) | `canRead` before attaching; denied → `bypass` with `null`                                                      | No result while running                                                    |
| Out: `waitForAnalysis`                   | `canRead` again on the settled row                                                                             | Stored scrubbed                                                            |
| Out: bypass                              | Row only if `canRead`; otherwise `null`                                                                        | No result in the view                                                      |
| Out: force                               | Over a valid or running row the caller cannot read → `bypass`; the audit row only on `forced`                  | n/a                                                                        |
| Out: `describeAnalysis`                  | Called by the routes only for hit, wait, miss or forced; `run_id` only for the creator; `result` only on a hit | Stored scrubbed                                                            |
| Out: `observe` log line                  | Ids only (R1)                                                                                                  | n/a                                                                        |

No other code reads `shared_analyses` (no list or read-by-id endpoint until step 7).

### Isolation

- **Between installations:** the scope is in the key, and `canRead` also requires `key_parts.scope` = this installation's id.
  A row of another scope (a restored dump, a shared database by mistake) is served to no one, its creator included, and
  cannot be forced over. Stale and supersede only touch the same key or the same scope (`olderOfSubject` filters on scope).
- **Between projects of one installation:** by repository access. A member without every repository of the row gets
  `bypass` with no row, and runs their own analysis outside sharing; they never replace the readable result.

### Decision: access lost after a result was shared

- Access is **evaluated on every read and never stored** on the row or cached across users. Losing a grant takes effect at
  the next lookup or wait, bounded only by the platform's own caches: repository grants are invalidated on every committed
  write, and the Bitbucket check keeps its last result until its TTL, as elsewhere.
- The creator follows the same rule; a grant given back serves the result again.
- The row is **kept, not deleted or re-scoped**: others who still have access keep using it.
- What was already returned cannot be recalled; the use rows (who, when) remain for audit.
- A waiter who loses access while waiting gets `denied` when the analysis settles.
- A running analysis whose creator loses access is the run engine's business, as today (`enforceRunRepositoryAccess`).

### Scrub patterns (proposal: to confirm)

Plan 6.3 names the categories and "the patterns the platform already uses". `redactSecrets` and `redactPii` do not cover
private keys, several API key formats or national ids, so these are added in `scrub.ts` only; `integrations/redact.ts` is
unchanged, so other features are not affected:

- PEM private key blocks;
- AWS key ids (`AKIA`/`ASIA`);
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`);
- Slack tokens (`xox?-`);
- `sk-…` / `sk-ant-…` / `sk-proj-…` API keys;
- Google `AIza…` keys;
- Stripe `sk_/rk_live|test_` keys;
- a password-only URL (`redis://:pass@`);
- CCCD/CMND or national/citizen id followed by 9–12 digits (only with that label in front, since a bare 9–12 digit number is
  usually an order id).

Kept on purpose: request and trace ids, IPs, commit SHAs, order ids, numbers.

### Hooks (additions to the step 3 table)

`canRead` → `canReadShared`; `scrub` → `scrubResult`. Still overridable. The step 3 and 4 suites now set a creator-only
`canRead` explicitly, since they test lookup and validity, not access.

### Where the step touched steps 3 and 4

- The single-flight claim did not change.
- `bypass` may carry `null` where it used to carry the unreadable row.
- `waitForAnalysis` takes the actor, and has a new `denied` status.
- The hit path now runs the access check before answering. Repository access comes from the platform's caches (repository
  list and per-user grants). An RCA reads up to 3 credential rows. The use row and counter are still one background
  statement.

### Decisions to confirm

1. **RCA rule (Q3)** as proposed: log access means a personal Splunk or SigNoz connection, or the shared token when members
   may use it. The check looks only at whether a connection is stored; whether it is still valid is not checked (that would
   need a network call).
2. **Bug hunt follows the plan: repositories only.** If its report quotes log evidence (prior evidence from the workbench),
   it may need the RCA rule too.
3. **Admins have no bypass in lookup.** They get access like any member, which is the platform's rule for repositories. Plan
   6.1's "support access (?scope=all), audited" fits the read endpoint of step 7; nothing in this step reads by id.
4. **The scrub pattern list above.**

### Not checked / remaining risks

- Scrubbing is pattern-based: a secret with no recognisable shape and no credential-like field name (a random password in
  prose) passes. `looksSecret` only catches assignments of 12 or more characters.
- E-mails keep their domain and phone numbers keep their prefix and last 3 digits (the platform's existing masking).
- Snapshots stored before step 5 (flags were off by default, so none are expected) have no `scrub_version` and are not
  re-scrubbed; a re-scrub job is step 6 (backfill) if wanted.
- Who may **force** is still "anyone who may read". No role restriction was added.
