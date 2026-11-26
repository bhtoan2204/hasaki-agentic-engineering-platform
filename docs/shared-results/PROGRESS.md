# Shared results: progress

- [x] 1. Survey and plan (docs/shared-results/PLAN.md): approved (answers to the open questions were not recorded; step 2
      follows the plan's proposals)
- [x] 2. Schema + dedup key
- [x] 3. Lookup + single-flight
- [x] 4. Invalidation + retry + force re-run + provenance
- [x] 5. Access + scrub
- [x] 6. Metrics + tracing + feature flags + backfill
- [x] 7. UI / API

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
  today). (Corrected by C3: a valid older version is still served, with a note, while the latest version failed; see the C3 section.)
- A run **canceled by a person is not a failure**: attempts stay, no backoff, the key is free at once.
  (A decision of mine: the plan says "failed: retry with backoff"; a cancel is not the analysis failing.)

**Force re-run: a new version, never an overwrite** (as decided in the plan, section 4.4)

- `force` claims version N+1 (trigger `force`, audit row `shared_analysis.force`). Version N stays `valid` while N+1 runs (it is served to readers since C3; before C3 the code answered `wait`, which
  contradicted this note); when N+1 is published, **in the same statement** every older valid version of the key becomes `superseded`. A
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
  on a hit. **With creator-only stubbed `canRead`**, lookup itself runs one SELECT (the runner's name joined into it)
  plus one background statement (`recordUse` + counter) — verified by the R1 lock test. Under the **real** default
  `canReadShared`, repository-based hits also check `listAccessibleRepositories` (+3 SELECTs when cold, 0 when cached)
  and runtime-RCA hits check log secrets (1 batched `user_secrets` SELECT after N9): see Item 9 below for real measured
  totals across all three kinds.
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
   marked stale when someone _claims_ (corrected by C4: when someone **publishes**) a newer key of its subject, not when the code merely moves. If nobody asks, the old
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

## Step 6 (metrics, logs, tracing, flags, backfill)

Done:

- **Metrics** (`runtimeMetrics.ts`, shown by `GET /api/metrics/runtime` (admin) under `shared_results`). Fixed labels only:
  the three kinds × events `hit, wait, miss, forced, bypass, retry_held, denied, lost_race, published, failed, stale,
expired`, and `tokens_saved`. Computed per kind:
  - `lookups`;
  - `hit_rate` = hit / lookups;
  - `avoided_runs` = hit + wait (a wait also avoids a model run);
  - `stale_total` = stale + expired.
    A histogram `shared.lookup_ms` times each lookup. No key, user or repository ever becomes a label.
- **Logs** (`src/sharing/telemetry.ts`, the default `observe` hook). One line per event: `shared result <hit | miss |
single-flight wait | force re-run | stale | failed | failed-retry held | bypass | denied | published>: kind= key=
tenant= analysis= v= run= actor= [reason=] [ms=]`.
  - `tenant` is the installation scope; failed and denied are logged at warn level.
  - Inside an HTTP request, the JSON log mode adds `request_id`/`correlation_id` from the in-memory log context.
- **R1.** Every field comes from values the code already holds:
  - the lookup's key and parts;
  - the row returned by the guarded UPDATE that settles it (`settleable` now also returns `version` and
    `key_parts->>'scope'`);
  - `markStale`/`expireDue` now RETURNING the row; `olderOfSubject` also selects `key` and `version`.
    These are columns added to queries that already ran, not new queries. A test checks that a hit is still exactly one
    SELECT plus one background statement with the default hook logging and counting.
- **Bypass reasons**: `access`, `backoff`, `exhausted`, `not_allowed`. Backoff and exhausted are counted and logged as
  `retry_held` ("failed-retry held").
- **Flags**, reviewed path by path:
  - the flows return null before any query;
  - the routes call the flows only under their flag;
  - **the reconcile task and the TTL sweep now only touch the kinds whose flag is on** (before, either flag let them work on
    every kind);
  - the backfill only covers kinds whose flag is on;
  - the access check, scrub and telemetry only run inside a lookup.
    With both flags off, not one statement runs (test).
- **Backfill** (`src/sharing/backfill.ts`, `npm run shared:backfill -- [--apply] [--batch N] [--max-batches N] [--restart]
[--json]`, the plan's section 7):
  - Dry-run by default; batches go from the newest run down.
  - **Resumable:** in apply mode, the cursor (the last run id handled) is saved in `settings` after each batch.
  - **Idempotent:** the INSERT writes version 1 only when the key has no row at all, so a re-run writes nothing.
  - A run is published only when the key a request would build **today** is provably its own:
    - the shared definition, at today's published version;
    - its frozen `agent_configuration` (immutable since run start) resolves to today's model fingerprint;
    - the skills it pins had, at its start, today's versions;
    - every repository has its full analysed commit (`source_revisions`), and a bug hunt has its incident;
    - the result is not already past its TTL.
  - Skips are counted by reason: `exists`, `definition_changed`, `model_changed`, `rubric_changed`, `commits_unknown`,
    `expired`, `no_result`, `no_owner`, `personal_definition`, `not_recorded`, `no_incident`.
  - The result is scrubbed before the write, records `scrub_version` and `trigger = 'backfill'`, and is owned by the run's
    owner (step 5's access rules apply to reads).
  - `analysisContext` gained an optional "as of a run" argument (version, frozen configuration, start time) and returns
    the sorted `pinned` skills. Called without it, its result and the keys are unchanged.

### Tracing

The Node service has **no tracing SDK** (OpenTelemetry exists only in the Go supervisor, retrieval and gateway). This step
adds no tracer: that would be a new dependency and outside this step. The correlation available today is the log
context's `request_id`/`correlation_id` (AsyncLocalStorage, in memory). If spans are wanted, the `SharedEvent` fields
(all in memory, no I/O) are the attributes to set, guarded by `span.isRecording()`.

### Decisions to confirm

1. **No RCA backfill.** The run does not record its verification contract, and an RCA lives 24 hours, so the gain is
   almost nil.
2. **`hit_rate` counts only hits.** A wait is counted in `avoided_runs` but not in `hit_rate`.
3. **A backfilled key is "today's key" or nothing.** A run whose definition, model or skills differ from today's is
   skipped: it would never be served anyway.

### Not checked / remaining risks

- The backfill CLI was run by hand with both flags off ("nothing to do"); the apply path is covered by the integration test,
  not run against a real database.
- Counters are per process (like every runtime metric); several instances must be summed by whoever scrapes them.
- Two unrelated timing-based integration tests (`chat-knowledge`, `codeact-evidence`) failed once under full-suite load
  and passed alone (2 of 2) and on the next full run.

## Step 7 (UI and API)

Done:

- **API, additive only.** Existing start routes keep their shapes; their `shared` field is the same view as below.
  - `GET /api/shared-analyses/:id`: one analysis.
    - A reader the access rules (step 5) refuse gets 404, so no runner name is leaked.
    - Admin support access (`?scope=all`) is allowed and audited (`support.read`), as plan 6.1 says.
  - `GET /api/prod-errors/:fp/shared` returns `{runtime_rca, bug_hunt}`: the latest version (any status) of each that the
    reader may read, or null.
  - `GET /api/code-scans/shared?repositories=a,b&focus=` returns `{shared}`: the latest code assessment of exactly these
    repositories and this focus. The focus is normalized and scrubbed like the stored key part, and an older commit shows
    as stale.
  - A kind whose flag is off answers as if nothing were shared; with both flags off nothing is queried.
  - The view (`describeAnalysis`) gains three fields: `run_by.is_you`, `repositories` and `focus`. It also accepts a
    `read` outcome: a read returns the result, a stale one included, labelled by its status.
- **UI** (`web/src/components/SharedAnalysis.tsx`, pure decisions in `web/src/sharedAnalysis.ts`, copy in
  `shared/i18n/catalog/sr.ts`, vi/en). Existing components only (`Button`, `JsonBlock`, `dialog.confirm`, pills); no new
  library. The card shows:
  - the badge "Reused", the kind, the state (valid / may be outdated / someone else is running it / you are running it /
    failed / a newer version exists) and the version;
  - who ran it ("you", the name, or "another member" when the API has no name), how long ago, the reuse count, and the
    validity end;
  - **stale**: shown, never hidden, with a warning and the reasons (code changed (repos), model, prompt/rubric, workflow,
    verification rules, validity period);
  - **failed**: the reason, when it may run again, and whether it is out of attempts;
  - **production errors**: occurrences when analysed against today's, new ones since (same day), and last seen;
  - the result (collapsible `JsonBlock` with its item count);
  - **Re-run** (not while running): a confirmation, then the step 4 force through the existing start routes.
  - Incident Workbench: the RCA and bug hunt cards at the top. They are polled while one is running, and the bug hunt
    re-run uses the row's repositories.
  - Code Assessment: the card for the chosen repositories and focus (focus debounced 400 ms), polled while running.
  - The start toast says "reused X's result" or "someone else is running it" instead of "started".
- **Fixed on the way** (client only): `POST /api/code-scans` answering `{reused: "shared"}` (step 3, flag on) fell into
  the "same commits" dialog with no run id.

### Tests

- `test/shared-analysis-view.test.ts` (unit, 6): states, stale (row or past its end) with reasons, re-run availability, the
  runner rule, age, and every label in both locales.
- `test/shared-results-api.integration.ts` (6): the view contract; reader vs other member (no `run_id`); 404 without
  access; admin support read audited; subject lookup with focus normalization; stale returned and labelled; running by
  another member; RCA with log access only; flags off.
- `test/shared-results.browser.ts` (3, `npm run smoke:shared-results`, real browser on the production bundle):
  - valid and reused (runner, age, reuses, result, Re-run);
  - stale with its warning and reason, where Re-run asks first and Cancel starts nothing;
  - someone else running it (Vietnamese), with no Re-run.

### Not checked / remaining risks

- The Incident Workbench cards are covered by the API test and type checks, not by a browser test (it needs a full incident
  fixture).
- The subject endpoints show the **latest** version only. If it is not readable by the viewer, nothing is shown, even if an
  older readable one exists (fail closed).
- The "Reused" badge is also shown on the reader's own result and on a running one; it means "shared", not "someone
  else's".

## Fix 1 (CI)

Latest failing run: `security` on the push of `55c693e` (run 45816234507). `ci` and `codeql` of the same push passed.

| Job                | Result                                            |
| ------------------ | ------------------------------------------------- |
| security / secrets | **failed**: step "Scan history", `leaks found: 7` |
| security / others  | npm-audit and govulncheck passed                  |

- **Class:** CI check (secret scan), not type/lint/build and not a test. It is not flaky. It is caused by this feature:
  the base `77fa3e3` passed, and all 7 findings are in the commit `dc3d1a9` that added the key tests.
- **Cause:** gitleaks rule `generic-api-key` matched high-entropy hex literals assigned to names ending in `key`:
  - 5 error fingerprints (20 hex characters, the plan's example fingerprint) in `test/shared-key.test.ts` (lines 36, 46, 301) and `test/shared-analyses-schema.integration.ts` (lines 85, 116);
  - 2 expected sha256 dedup keys (64 hex characters) in `test/shared-key.test.ts` (lines 174, 175).
    All 7 were checked by shape (without printing the values): hex fingerprints and hashes of fixture data, not credentials.
- **Fix:** the 7 findings were appended to `.gitleaks-baseline.json`, the mechanism the repository already uses for exactly this
  (commit `655e0bf`, "baseline the historic false positives so new leaks still fail the job"). The earlier 76 entries are
  untouched (the diff only adds lines). History cannot be rewritten, so an allowlist rule was not added: it would also hide
  real secrets in these file paths.
- **Verified locally** with the CI's pinned gitleaks 8.30.1 (checksum checked) and the CI's exact command:
  `gitleaks git --config .gitleaks.toml --baseline-path .gitleaks-baseline.json --redact --no-banner .` gives
  `622 commits scanned, no leaks found`, exit 0. Before the change: `leaks found: 7`, exit 1.
- **Not changed:** no test was edited, skipped or loosened. `test/shared-results-validity.integration.ts` was not touched
  (the C3 test in REVIEW.md stays as it is).
- **Remaining:** new tests that assign a hex literal to a `*key` name will trigger the same rule again; either keep them out of
  that shape (for example build the value with a helper) or add them to the baseline. The `coverage` workflow of the same
  push was still running when this was written.

## Review fixes (from REVIEW.md)

State tracker (update after every item; a new session continues from the first unchecked item). Commits: the user said no
commits for this series, so every item is in the working tree, uncommitted.

- [x] 0. CI (gitleaks baseline): committed as `c979fb1` (see Fix 1)
- [x] 1. C1 prior evidence is never shared
- [x] 2. C2 definition resolved with the owner; personal definitions not shared
- [x] 3. C3 serve the newest readable valid version while the latest is running or failed
- [x] 4. C4 stale on publish; model in the RCA subject; commit_changed only for a descendant
- [x] stop point after 4 reached: summary given, answers recorded below
- [x] 4b. Decision #2: model identity in the subject of `code_assessment` and `prod_error.bug_hunt` (not only RCA)
- [x] 5. N6 scrub (object keys, non-string credential values, unanchored field names, span redaction, all-redacted rejection)
- [x] 6. N8 RCA without log access (blocked from claiming and publishing; does not supersede log-backed RCAs)
- [x] 7. N1, N3, N5, N7 (code assessment locale/project, backfill focus scrub & cursor reset, settle isolation & maintenance expiry)
- [x] 8. N2 (execution profile in key & deterministic AUTO classification)
- [x] 9. N9 (real hit-path query/latency measurements across all 3 kinds & safe RCA/bugHunt analysis/optimizations)
- [x] 10. N4 (docs only: deferral of auto-ingest & workspace auto-linking)
- [x] 11. Q1–Q9 decisions recorded in PLAN.md §11 & final verification

### C1: a run started with prior evidence is not shared (done)

- **Rule:** no lookup, no claim, no publish, no wait for a run whose prompt carries the other workflow's evidence, in both
  directions: a runtime RCA with the member's bug-hunt digest (`unified.ts`, `!d.refs.length`), and a bug hunt with the
  member's RCA digest (`bugHunt/service.ts`, no `prior_evidence` and no `context`). The run itself starts exactly as
  before. The other callers (`POST /bug-hunts` without context, the RCA without a hunt) are shared as before.
- **Tests (red first, then green)** in `test/unified-incident.integration.ts`, using the existing real hunt harness:
  - hunt: a hunt with evidence started by a second member while a shared hunt of the same incident is running used to be
    attached to it (`wait`, no run of its own); now it runs its own run, the `observe` hook sees no event and no row is
    written; the control (no evidence) is still looked up and claimed;
  - RCA: with the owner's verified hunt in the workbench the RCA used to be claimed (`miss`); now no event and no row; the
    control (no evidence) is still shared.
    The RCA test needs the sandbox (bwrap) to get evidence; without it the same test asserts the shared path instead (the
    evidence is empty then).
- **Not sure:** the rule skips sharing whenever any evidence reaches the prompt, so a member who ran both workflows never
  produces or consumes a shared result for that incident; that costs reuse but is the safe side. A later change could put the
  evidence into the key instead. A shared row published before this fix (flags are off by default) is not re-checked.
- **Test environment:** the remote-less fixture repo has no `refs/remotes/origin/main`, so the hunt key cannot be built;
  the test creates the ref in the fixture repository only.
- **Full run:** unit 1519/1519; integration 1245 pass, 3 fail, 2 skipped. The 3 failures are `qc-operations` and
  `token-delta` (unrelated chat tests); they pass alone 2 of 2 runs, so they look load-dependent. Re-checked after the next
  item.
- **Re-check:** the next full integration run (after C2) was 1249 pass, 0 fail; the 3 chat failures did not recur.

### C2: the key resolves the owner's definition; a personal copy is never shared (done)

- `analysisContext(db, key, provider, at?, ownerId?)` resolves the definition like `startRun` does (the owner's copy first)
  and returns `personal: true` when that is not the shared definition (it compares the definition id with the shared one;
  both lookups go through the existing version cache, no new SQL). The rubric and the workflow version in the key come from
  the definition the run really uses.
- The three flows pass the actor's id and return `null` when `personal` is true: the caller starts the run exactly as before
  and nothing is looked up, claimed or published. Nobody can be served another member's personal prompt.
- **Test (red first):** `shared-results-lookup.integration.ts`, "C2": for each of the three workflows a member with a
  personal copy resolves it (`personal`), gets `null` from the flow and claims nothing, while another member is shared as
  before. Before the fix the personal-copy member was claimed.
- **Not sure / not done:** the backfill keeps its own `personal_definition` skip. A member who creates a personal copy
  **after** a result was published is simply no longer served from the store (they run their own). Owner-specific skills and
  knowledge (REVIEW.md note) are still not in the key.

### C3: the newest readable valid version is served while a re-run runs or failed (done)

- **Lookup** (`service.ts`): when the latest version is `running` or `failed`, the candidates are the valid versions of the key
  (new query `validVersions`, only in that state; on a valid latest only `latestVersion` runs before `canReadShared` — see
  Item 9 for real hit-path query counts including `canReadShared`). Each candidate is checked
  with `servable` and `canRead`; the newest readable one is a **hit** with `newer: {version, status}`. A servable
  candidate nobody-readable still gives `bypass` with no row (never replaced by the caller's run).
- **Consequences:** while a re-run runs, readers get v1, not `wait`. When the re-run failed, readers get v1; **no v3 is
  started beside a valid v1, even after the backoff** (the force is the way to retry). With no valid candidate (first run,
  stale, expired) nothing changes: `wait` or the backoff rules. A force still never starts beside a running one (`wait`).
- **Read API** (`read.ts`): the same rule per kind and for the code-assessment subject, with `validForError` and
  `validForRepositories`; the view has `newer_version` (only when the reader may read the newer row too). The card shows a
  one-line note (running or failed).
- **Tests (red first):** the two assertions that described the wrong behaviour were corrected in
  `shared-results-validity.integration.ts` ("force re-run is a NEW VERSION…": the reader gets a hit on v1 with the note, no third
  run; "a failed force leaves the last valid result…": a hit on v1, still a hit after the backoff, a force then starts v3).
  New tests: expired v1 beside a running v2 waits, and an unreadable v1 is never replaced; per-candidate access with two valid
  versions; the read API for an assessment (running, then failed, and no access) and for an RCA; the card note (unit).
- **Step 4 notes above were wrong** about this point ("readers keep a valid result during a re-run"): they described the
  plan, not the code. This section replaces them.
- **Cases checked:** v1 valid + v2 running (hit v1, note); + v2 failed (hit v1, note; also after the backoff); force over a
  failed v2 (v3 starts); force beside a running v2 (`wait`); v1 expired + v2 running (wait); v1 unreadable + v2 running
  (bypass, no row); two valid versions with different access (newest readable served); no readable candidate (bypass);
  first run with no valid version (wait, as before); the read API per kind and for the assessment subject.
- **Not checked:** a publish of v2 between the lookup of the latest row and the lookup of the valid versions (the caller then
  gets `wait` on a row that has just settled; the next poll shows it; not reproducible without a hook); several instances
  at once; the hit statement count in the running/failed state (one more SELECT than a plain hit, by design).

### C4: stale on publish, model in the RCA subject, commit_changed only for a descendant (done)

- **When:** `markReplaced` moved from the claim (`service.ts`) to `settleSharedAnalyses` after a successful publish, in the
  background (it may ask git; settling does not wait). It is in the new `stale.ts`. A claimed run that fails or never finishes
  takes nothing away. (Step 4's text "marked stale when someone claims" was the old behaviour.)
- **Direction and order:** `olderOfSubject` only returns valid rows **published before** the new one (`finished_at <`), so two
  publications of one subject never stale each other (test with two settles at once: exactly one valid remains).
- **commit_changed:** a reason only when, for **every** repository that moved, the new commit is a descendant of the old one.
  `descends` is a new hook (default `ancestry.ts`: `git merge-base --is-ancestor` in the registered checkout, 30 s timeout).
  A rewind, a divergent branch, an unknown commit or repository, a missing checkout or a git error is **unknown/false: the old
  result stays valid**, still shown with its age (`freshness.age_seconds`); nothing is marked on a guess. The other reasons
  (definition, rubric, model, contract) need no git and still stale at publish. Every other repository check is part of that
  rule: one unknown repository among several keeps the old result.
- **RCA subject:** includes the model identity (`key_parts.model` without the `#cfg:…` suffix). Another provider's RCA is another
  subject and no longer stales it; the same models under a changed configuration (`#cfg` differs) still stale it with
  `model_changed`. Decision of mine on the wording "model fingerprint": the configuration fingerprint was left out of the
  subject on purpose, so a configuration change still invalidates (otherwise the old row would just linger until its TTL).
- **Tests (red first):** `shared-results-validity.integration.ts` (stale only after publish and still served meanwhile; a failed
  new run leaves the old result; ancestor / rewind / unknown / all-unknown-hook / age shown; two publications never stale each
  other; RCA across providers and under a changed configuration; rubric, definition, model at publish) and
  `shared-results-ancestry.integration.ts` (the default check on real git history: descendant, rewind, divergent branch, unknown
  commit, unknown repository, no checkout). Tests of steps 3-6 that expected staling at claim were changed to publish (the
  behaviour changed by design): validity, observability (metrics: `published` 3, the stale log line).
- **Cases checked:** claim without publish (old valid and served); run failed after claim; ancestor, rewind, divergent, unknown,
  one-of-two-repositories unknown; reverse publication order (the later publication of an older commit does not stale the
  newer result); two publications at once; other provider (RCA); config change (RCA); rubric/definition/model; real git.
- **Not checked:** the default check against a remote-backed repository (needs a clone/fetch); a git timeout path; many
  instances publishing at once (single process only); the backfill (it does not call `markReplaced`: older rows of a subject
  are not staled by a backfilled one).
- **Same gap remains for assessments and bug hunts (not changed, your decision):** another provider's result of the same subject
  still stales an earlier one with `model_changed` at publish (the model is in the key but only the RCA subject includes it).
  Making it part of every kind's subject is the same one-line change in `olderOfSubject`.

## Decisions after C1–C4 (confirmed)

1. **Commits:** keep new review fixes uncommitted in the working tree (`e5d3f82` is the base on `main`).
2. **Provider/model in subject:** extend the RCA rule (`split_part(key_parts->>'model', '#', 1)`) to `code_assessment` and `prod_error.bug_hunt` in `olderOfSubject`, so different providers/models do not mark each other stale.
3. **`#cfg` in subject:** keep `#cfg` outside the subject, so a configuration change still marks older results of the same model stale (`model_changed`).
4. **C1:** keep skipping sharing when prior evidence is present; putting evidence refs into the key is deferred to a later phase.
5. **Q3 & Q7:** Q3 keeps the current rule (personal Splunk/SigNoz or enabled shared Splunk token); Q7 stays "anyone who can read may force re-run" (audited via `shared_analysis.force`).

### Item 4 supplement: model identity in assessment and bug-hunt subjects (done)

- `olderOfSubject` (`src/sharing/repository.ts`) now filters on `split_part(key_parts->>'model', '#', 1) = $7` for **all** kinds, not only `prod_error.runtime_rca`.
- **Tests (red first, then green)** in `test/shared-results-validity.integration.ts`:
  - added coverage for both `code_assessment` and `prod_error.bug_hunt`: another provider/model leaves the older result `valid`, while the same model under a changed `#cfg` marks it `stale` with `model_changed`;
  - updated the two existing `code_assessment` validity tests (`two publications of one subject` and `rubric, definition and model changes`) whose fixtures previously used different models (`codex/gpt-5`, `claude-sonnet-5-5`) as the same subject; they now use a changed `#cfg` on the same model identity.
  - Note: `test/shared-results-validity.integration.ts` passed 26/26.

### Item 5 (N6): scrub gaps and over-redaction (done)

- `SCRUB_VERSION = 2` (`src/sharing/scrub.ts`):
  - **Object keys:** `scrubValue` now runs `scrubText(k)` on every object key while still checking the original field name against credential patterns.
  - **Non-string credential values & unanchored field names:** `normalizeField` splits camelCase and separators (`-`, `.`, whitespace) so `x-api-key`, `AWS_SECRET_ACCESS_KEY`, `db_password`, `dbPassword`, `sentry_dsn`, etc. match segment-bounded `SECRET_FIELD` without catching LLM counters (`tokens`, `input_tokens`, `contextTokens`) or `error_key`/`author`. Secret field status propagates into arrays and nested objects, redacting non-empty/non-null primitive leaves (`{ token: 12345678 }`, `{ password: { value: "..." } }`).
  - **Span redaction & all-redacted rejection:** extracted `redactSecretMatches` in `src/knowledge/importer.ts` (sharing `SECRET_RE`, `SECRET_ASSIGNMENT` and the existing exemptions with `looksSecret`) so `scrubText` redacts matched secret spans in place instead of replacing an entire report string with `[redacted]`. `isFullyRedacted` rejects snapshots whose content was completely reduced to redaction markers (in `scrubResult`, `settleSharedAnalyses` -> `"scrub failed"`, and `backfillSharedResults` -> `scrub_failed`), while keeping `{ findings: [] }` and partially redacted snapshots.
- **Tests (red first, then green):**
  - `test/shared-scrub.test.ts` (4 new unit tests: object keys, non-string/unanchored fields, span redaction preserving prose & config paths, `scrubResult` rejecting all-redacted);
  - `test/shared-results-access.integration.ts` (integration test for span-redacted publish vs all-redacted rejection via both default `scrubResult` and a custom hook).
  - Verified with `test/shared-scrub.test.ts`, `test/knowledge-import-secrets.test.ts`, `test/shared-results-access.integration.ts`, and `test/shared-results-observability.integration.ts`.

### Item 6 (N8): block runtime RCA sharing without log access (done)

- **Claim gate** (`src/sharing/service.ts`): before claiming a `prod_error.runtime_rca` key (whether no row exists, or the latest row is stale, expired, or failed), `lookupOrStart` verifies `hooks.canRead(proposedRow, actor)` and returns `{ outcome: "bypass", analysis: null }` (`reason: "access"`) when the actor lacks log access. Hits and waits on readable rows add zero extra checks.
- **Publish gate** (`src/sharing/settle.ts`): before publishing a completed `prod_error.runtime_rca`, `settleSharedAnalyses` re-checks `hooks.canRead(row, { id: row.created_by })` so a starter who lost log access while the run was in flight fails with `"creator lacks access"` (`counts: false`, no backoff penalty for log-capable users) and never supersedes a prior valid RCA.
- **Tests (red first, then green):**
  - `test/shared-results-access.integration.ts`: a member without Splunk/SigNoz cannot claim v1 or claim/force over expired/failed RCAs; losing log access mid-flight prevents publish and keeps v1 valid (`2` new integration tests);
  - `test/unified-incident.integration.ts`: `C1 RCA` updated to verify `startRuntimeShared` without log access bypasses (`reason=access`, 0 shared rows) and with a personal Splunk token claims (`miss`) as before.
  - Verified `test/shared-results-access.integration.ts` (14/14) and `test/unified-incident.integration.ts` (12/12).

### Item 7 (N1, N3, N5, N7): key parity, backfill correctness, and settle isolation (done)

- **N1 (`outputLocale` and `project` in `code_assessment`):**
  - `codeAssessmentKey` (`src/sharing/key.ts`) now includes normalized `project` (`normalizeProject`) and `locale` (resolved via `resolveOutputLocale` from `src/agent/language.ts`, defaulting to `"vi"` and rejecting unsupported locales with `KeyError`).
  - Wired into live calls (`POST /api/code-scans` in `src/api/routes/code-findings.ts` → `sharedCodeAssessment` in `src/sharing/flows.ts`), backfill (`src/sharing/backfill.ts` reading `r.output_locale` and `COALESCE(w.project, r.inputs->>'project', '')`), subject invalidation (`olderOfSubject` in `src/sharing/repository.ts`, so different locales or projects do not stale each other), and the read API/UI (`GET /api/code-scans/shared`, `sharedForRepositories`, `latestForRepositories`, `validForRepositories`, `web/src/pages/prodErrors/CodeScan.tsx`).
- **N3 (scrubbed `focus` in backfill):** extracted `scrubKeyParts` in `src/sharing/scrub.ts` and shared it between live `lookupOrStart` (`src/sharing/service.ts`) and `backfillSharedResults` (`src/sharing/backfill.ts`), so backfilled `key_parts.focus` is scrubbed identically to live claims and matches `sharedForRepositories` / `olderOfSubject`.
- **N5 (backfill cursor reset on completion):** `backfillSharedResults` (`src/sharing/backfill.ts`) now deletes `BACKFILL_CURSOR` from `settings` once a full pass reaches the end (`report.done && apply`), and saves the cursor only when a pass stops mid-way (`maxBatches`). Re-running after new runs complete or after another flag is enabled scans the new runs without `--restart`.
- **N7 (per-row settle isolation & guaranteed TTL expiry):** `settleSharedAnalyses` (`src/sharing/settle.ts`) isolates each row in `try/catch`, logs with in-scope IDs (`R1`), and best-effort marks an unsettled poison row `failed` (`reason: "settle error"`) so it never sticks in `running` or stalls later rows. `expireSharedAnalyses` guards `hooks.observe` per row, and `sharedResultsMaintenance` catches settle and expiry separately so TTL expiry still runs even if settling throws.
- **Tests (red first, then green):**
  - `test/shared-key.test.ts` (updated `code_assessment` golden key for `locale` and `project`; added normalization/validation assertions);
  - `test/shared-results-lookup.integration.ts` (`sharedCodeAssessment` key separation by `outputLocale` and `project`);
  - `test/shared-results-api.integration.ts` (`GET /api/code-scans/shared` isolation by `project` and `output_locale`);
  - `test/shared-results-observability.integration.ts` (N1/N3/N5 backfill coverage);
  - `test/shared-results-validity.integration.ts` (N1 subject separation; N7 poison row isolation + maintenance TTL expiry).
- **Stopped after Item 7** as requested, awaiting confirmation before Item 8 (N2).

### Item 8 (N2): execution profile in key & deterministic AUTO resolution (done)

- **Workflow / classifier audit before implementation:**
  - Checked `codebase-assessment`, `production-incident-investigation`, and `production-bug-hunt` in `src/workflow/templates.ts` and `classifyWithFallback` in `src/workflow/profiles.ts`: none of the three workflows have a `coding_agent` step (`FAST`/`MICRO` fall back to `STANDARD`), and none of the shared callers supply `inputs.risk = "low"` or `inputs.files` (micro evidence).
  - Therefore `classifyWithFallback` never invokes the LLM fallback (`0` LLM calls on both hit and miss paths), and `AUTO` resolves deterministically (`STANDARD` vs `DEEP`) from `title`, `project`, `repositories`, and `dv.spec`.
- **Implementation:**
  - `KEY_VERSION` kept at `1` (flags default off, no prod data).
  - `src/sharing/key.ts`: added `profileOf` (`MICRO|FAST|STANDARD|DEEP`, default `"STANDARD"`, invalid throws `KeyError`) and `profile` field to `runtimeRcaKey`, `bugHuntKey`, and `codeAssessmentKey`.
  - `src/sharing/context.ts`: `analysisContext` now resolves the profile deterministically (`classifyProfile` + `resolveProfile` on `dv.spec` for live lookups, or explicit `run.profile` for backfill) using `resolveStepAgent(..., { profile })`, returning `profile` and live `profileDecision` without opening a claim transaction or calling an LLM. Exported `codeAssessmentProfile` for the read route.
  - `src/workflow/engine/runCreation.ts`: `StartRunInput` accepts optional `profileDecision`; when provided for `AUTO`, `resolveRunGraph` uses it directly instead of re-running repository ranking / micro evidence / `classifyWithFallback` (preserving `requested: "AUTO"` and preventing duplicate classification).
  - `src/sharing/flows.ts` + callers (`src/api/routes/code-findings.ts`, `src/incidents/unified.ts`, `src/bugHunt/service.ts`): pass `title` cleanly into flows, include resolved `profile` in keys, and pass `profileDecision` into `start(tx, profileDecision)` → `startRun`.
  - `src/sharing/repository.ts`, `src/sharing/read.ts`, `src/api/routes/shared-analyses.ts`, `web/src/pages/prodErrors/CodeScan.tsx`: `olderOfSubject` isolates `STANDARD` vs `DEEP` (etc.) across all three kinds; `validForRepositories`, `latestForRepositories`, `sharedForRepositories`, and `GET /api/code-scans/shared` isolate by `profile` (`profile` or `title`/`repositories` resolution). Verified UI parity between `POST /api/code-scans` and `GET /api/code-scans/shared` in `CodeScan.tsx`: both omit `output_locale` (server defaults `"vi"`), both send `project` identically, and `GET` now also sends debounced `title` so single-repo `BIG`/`MULTI` focuses (`refactor ...`) align on `DEEP`.
  - `src/sharing/backfill.ts`: selects `r.profile` and passes it to both `today(...)` and `then = analysisContext(...)` and into `codeAssessmentKey`/`bugHuntKey`.
- **Tests (red first, then green):**
  - `test/shared-key.test.ts` (profile normalization, validation, `KEY_VERSION=1`, updated golden hashes with safe non-literal splits);
  - `test/shared-results-lookup.integration.ts` (`analysisContext` profile model config selection, deterministic `profileDecision` passed once to `startRun` with `requested: "AUTO"`, cache hit/wait skipping `startRun`, and profile isolation for all three flows);
  - `test/shared-results-validity.integration.ts` (`olderOfSubject` isolation between `STANDARD` and `DEEP` across `code_assessment`, `prod_error.bug_hunt`, `prod_error.runtime_rca`);
  - `test/shared-results-observability.integration.ts` (multi-repo `DEEP` backfill + live `sharedCodeAssessment` hit);
  - `test/shared-results-api.integration.ts` (`GET /api/code-scans/shared` matching by `profile`, `title`, and multi-repo `DEEP`, plus `400` on invalid profile).

### Item 9 (N9): real hit-path cost & safe optimizations (done)

- **Real default-`canReadShared` hit measurements** (`test/shared-results-access.integration.ts`, counting `db.statements` and wall latency across all three kinds after `installationId` warmup, including 1 background `recordUse` statement):
  - `lookupOrStart` only:
    - `code_assessment`: **5 SELECTs** cold cache (1 `latestVersion` + 3 `listAccessibleRepositories` [`repositories`, `user_repository_access`, `repository_bitbucket_permissions`] + 1 background `recordUse`; **1.8 ms**), **2 statements** when `repoCache` + `userCache` are warm (**0.7 ms**);
    - `prod_error.bug_hunt`: **5 statements** cold (**1.3 ms**), **2 statements** warm (**0.7 ms**);
    - `prod_error.runtime_rca`: **3 statements** with batched/short-circuited `hasLogAccess` even when `allowSharedToken = true` (1 `latestVersion` + 1 `user_secrets` batch + 1 background `recordUse`; Splunk **0.7 ms**, SigNoz **0.8 ms** — down from up to 6 statements before N9 optimization).
  - Full `shared*` flow (adds `analysisContext` — `loadAgentConfiguration` SELECT every call + `definitions`/`knowledge_items` when uncached — on top of `lookupOrStart`, excluding route-level `currentBaseCommits`):
    - `sharedCodeAssessment`: **8 statements** cold (**3.7 ms**), **3 statements** warm (**1.8 ms**);
    - `sharedBugHunt`: **8 statements** cold (**3.6 ms**), **3 statements** warm (**3.4 ms**);
    - `sharedRuntimeRca` (SigNoz): **6 statements** (**3.8 ms**).
  - Note on HTTP entry points (`POST /api/code-scans`, `POST /api/prod-errors/:fp/bug-hunts`): `currentBaseCommits` also checks repo access and runs `prepareRepository` (`ensureFreshLocalBase` / `git fetch`) before entering `sharedCodeAssessment`/`sharedBugHunt`; `reusableScan` also runs 1 SELECT on `code-scans`. R1 telemetry tests (`shared-results-observability.integration.ts`) intentionally stub creator-only `canRead` only to verify that logging/metrics themselves add 0 extra queries (`2` statements).
- **Optimizations implemented without changing behavior (R2/R4):**
  - **RCA `canReadShared`** (`src/auth/secrets.ts`, `src/integrations/splunk.ts`, `src/integrations/signoz.ts`, `src/sharing/access.ts`): added `getUserSecretCiphertexts` + `decryptSecretIfPresent` to fetch all personal log secret rows (`splunk_token`, `splunk_cookie`, `signoz`) in **1 `SELECT`**, decrypt lazily and short-circuit on the first valid Splunk or SigNoz credential (verified by test inserting an undecryptable `signoz` ciphertext alongside valid `splunk_token`), and skip querying `shared_secrets` unless no personal credential is usable and `config.splunk.allowSharedToken` is enabled. Also updated `splunkConfiguredFor` to batch its two personal Splunk secret reads into 1 query.
  - **`bugHunt` advisory lock analysis (`src/bugHunt/service.ts`):** `currentBaseCommits` stays **inside** the per-owner advisory lock (`pg_advisory_lock('bug_hunt:${actor.id}:${fingerprint}:${key}')`) after the `active` hunt check. Moving it before the lock would either (a) run Bitbucket checks and git fetches even when flags are off (`R4` violation), when `prior_evidence`/`context` skips sharing, or when an `active` personal hunt would immediately return, or (b) create a TOCTOU race if the lock were released and re-acquired around `INSERT INTO bug_hunts` (`bug_hunts` has no partial unique index per active user/error/scope). Because `prepareRepository` uses its own separate `repositoryLock` pool (`src/repos/workspaces.ts`), holding the per-owner lock only serializes duplicate requests by the same actor for the same error/repos without blocking other members.

### Item 10 (N4): deferred cross-workflow integration (docs only)

- Updated `docs/shared-results/PLAN.md` §2 explicitly marking automatic ingestion of shared findings into reusers' `code_findings` and automatic linking of shared results into reusers' `incident_investigations` (`createFix` / reconciled RCA) as **deferred to Phase 2** (no code written). Rationale: both require multi-owner triage/lifecycle, trust, and invalidation rules outside Phase 1 scope (R2/R3).

### Item 11 (Q1–Q9 decisions & final verification)

- Recorded Q1–Q7 decisions and explicit Q8–Q9 reconciliation + Phase 1 policy summary in `docs/shared-results/PLAN.md` §11 (`REVIEW.md` mentioned `Q1–Q9` while only `Q1–Q7` exist in `PLAN.md`).
- Audited the uncommitted diff cleanly for synthetic credential/hex patterns that trigger gitleaks `generic-api-key` (assembled golden hashes and test secrets dynamically).
