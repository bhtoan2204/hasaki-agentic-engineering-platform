# Shared results: Production Errors and Code Assessment (plan)

Status: **step 1/8, awaiting approval.** No code has been written for this feature.

Goal: when one member has already analysed something, another member with the right access reuses that analysis
instead of paying for the same model run again. A new analysis runs only when nothing valid exists, or on an explicit
force re-run.

## 1. What exists today

### 1.1 Production Errors

- **The scan is already shared and uses no model.** `prod_error_groups` (`013_prod_errors.sql`) is one global table keyed
  by `fingerprint`. A scan is a durable job (`085_prod_error_scan_jobs.sql`, `src/prodErrors/jobs.ts`) run by
  platform-go: one fixed SPL query, no LLM (`src/prodErrors/scan.ts:22-30`). Only one scan can be active across all
  instances (`prod_error_scans_one_active`), and a manual scan is admin-only (`src/api/routes/observability.ts:246`).
  Every member reads the same list (`GET /api/prod-errors`); only the linked work item and run are hidden from
  non-owners (`redactGroup`, `observability.ts:46-66`).
- **Fingerprint today:** `sha1(namespace, service, level, signature)[:20]` (`scan.ts:185`, mirrored in
  `go/internal/proderrors/merge.go:47`). `signature = signatureOf(message, err)` (`scan.ts:248-256`) replaces UUIDs,
  hex runs of 16+ characters and every token that contains a digit, collapses whitespace and cuts at 200 characters.
  **The stack trace is not part of it.** Many other tables reference this fingerprint: radar observations, incident
  investigations, work items, bug hunts and causal memory.
- **The expensive, duplicated work is the investigation.** Each member gets their own workspace per incident
  (`incident_investigations UNIQUE (fingerprint, owner_id)`, `104_unified_incident_investigation.sql`). Two model-heavy
  workflows run per member:
  - **Runtime RCA** (`production-incident-investigation`, `startRuntime`, `src/incidents/unified.ts:705`). It already
    dedups per owner: a session advisory lock on `incident_runtime:<owner>:<fp>` (single-flight), an active run is
    returned, a completed one gives `409` unless `force` is set.
  - **Bug Hunt** (`bug_hunts`, `094_bug_hunts.sql`, `startBugHunt`, `src/bugHunt/service.ts:50`). It dedups per
    `(fingerprint, scope_key = sorted repos, requested_by)` under an advisory lock; findings carry `commit` and
    `file_blob`.
  - RCA conclusions are immutable versions keyed by an `inputs_hash` that includes `VERIFICATION_CONTRACT`
    (`incident_rca_versions`, `unified.ts:37`).
- Evidence is read **by reference** from runs owned by the workspace owner (`discover`, `unified.ts:87-131`); a run
  is visible to its owner only (admins via support access with an audit row).

### 1.2 Code Assessment

- `POST /api/code-scans` (`src/api/routes/code-findings.ts:118-150`) starts `codebase-assessment` (select → assess
  agent → report, `src/workflow/templates.ts`). Before starting, `reusableScan` (`src/workflow/codeScans.ts:41-68`)
  reuses the **same owner's** run with the same sorted repositories and focus when it is still running, or completed with
  `workflow_runs.source_revisions` (`095_source_revisions.sql`) equal to each repository's current base commit
  (`currentBaseCommits`, which checks access and fetches). `force` bypasses it.
- Results are ingested per owner into `code_findings` / `code_finding_sightings` / `code_finding_scans`
  (`109_code_findings.sql`, `src/workflow/codeFindings.ts`): a finding is unique per `(owner_id, fingerprint)` with
  `fingerprint = (repo, category, file, symbol)`, and has a per-user status lifecycle (open, resolved, dismissed).
- **Not part of today's reuse key:** the workflow definition version, the assess step's instructions and skills, the
  provider and model.

### 1.3 Access model

- **There is no tenant, workspace or team table.** One installation is one organisation. Scoping is per user
  (`owner_id` on runs, work items, findings, investigations) plus repository permissions
  (`src/repos/access.ts`: grants, shared level, Bitbucket, GitHub and GitLab verification; `requireRepositoryAccess`,
  `listAccessibleRepositories`). Admins can read other owners' data with `?scope=all`; that read is audited
  (`requireOwner`).
- Production logs are read with **the requesting user's own** Splunk or SigNoz connection, through the internal gateway
  (`src/prodErrors/gateway.ts`).

### 1.4 Reusable pieces (do not rewrite)

| Need                             | Already here                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Single-flight                    | Session advisory locks on a key (`unified.ts`, `bugHunt/service.ts`); the durable-job and lease pattern (`jobs.ts`) |
| Immutable versions + inputs hash | `incident_rca_versions` (immutable trigger, `UNIQUE(investigation_id, inputs_hash)`)                                |
| Commit-pinned freshness          | `source_revisions`, `currentBaseCommits`, `repos/freshness.ts`; bug-hunt `commit` and `file_blob`                   |
| Access checks                    | `requireRepositoryAccess`, `listAccessibleRepositories`, `assertRunScopeReadable`, `requireOwner`                   |
| Scrubbing                        | `redactSecrets` and `redactPii` (`src/integrations/redact.ts`), `looksSecret` (`knowledge/importer.ts`)             |
| Audit                            | `audit()` (`authz/access.ts`) → `audit_log`                                                                         |
| Run completion hook              | run effects (`dispatchRunEffects`, `workflow/scheduler.ts`)                                                         |
| Metrics                          | `src/runtimeMetrics.ts` (fixed label sets)                                                                          |
| Feature flags                    | typed env fields in `src/config.ts` + `.env.example`                                                                |
| Tokens and cost                  | attempt metrics and provider-reported cost (`report/cost.ts`)                                                       |

## 2. Proposed architecture

A sharing layer **outside** the analyses. The workflows, prompts and analysis logic do not change. Two entry points
change: they first look up a shared result, and the run-completion hook publishes one.

```
request ──▶ key = sharedKey(kind, inputs)  (pure)
          ──▶ lookup (one indexed query) ──▶ valid & readable by caller ──▶ return (hit, no model call)
                                          ──▶ running ──▶ subscribe / return "in progress" (wait)
                                          ──▶ none / stale / failed past backoff ──▶ claim (single-flight) ──▶ start the
                                              existing workflow as today ──▶ on completion: scrub → publish version
```

- **Module:** `src/sharing/` with `key.ts` (pure key builders), `repository.ts` (SQL), `service.ts` (lookup, claim,
  publish, invalidate), `scrub.ts` (scrub policy), `access.ts` (who may read a shared result).
- **A shared result is a scrubbed snapshot, not the source run.** Other users cannot open the source run: runs stay
  owner-only. The source run, owner and inputs are recorded as provenance; the payload a reuser sees is the scrubbed
  report: RCA report, bug-hunt report and findings, assessment findings.
- **Reuse for Code Assessment** ~~ingests the shared findings into the reuser's own `code_findings` (a sighting that
  points at the shared result), so each user keeps their own status lifecycle.~~ _(Deferred — N4)_: in Phase 1, a hit returns
  the scrubbed shared view (`reused: "shared"`) and renders it on the Code Assessment card without mutating the reuser's
  per-user `code_findings` / `code_finding_sightings` tables. Auto-ingestion with shared provenance & per-user triage
  lifecycle requires schema/status rules (avoiding polluting personal triage queues or bypassing owner scoping) and is
  explicitly deferred to Phase 2.
- **Reuse for Production Errors** ~~links the shared result into the reuser's `incident_investigations` workspace as a
  "shared" source. Their workbench shows it next to their own runs, and `createFix` stays per user.~~ _(Deferred — N4)_:
  in Phase 1, a shared runtime RCA or shared bug hunt returns the scrubbed shared view (`shared`) on the Production Errors
  workbench without inserting cross-owner rows into `incident_investigations` (`incident_investigation_sources`) or
  feeding reconciled RCA / `createFix`. Allowing a shared analysis to drive reconciled conclusions and code fixes
  requires explicit provenance/evidence-trust and invalidation rules across owners and is deferred to Phase 2.

## 3. Dedup keys

`key = sha256(canonical JSON of the parts below)` as hex. The parts are also stored in readable form (`key_parts`) for
audit and debugging. Every key starts with `kind` and `key_version`, so the key format itself can change later without
collisions.

### 3.1 Scope (tenant/workspace)

The repository has no tenant or workspace. **Proposal:** `scope = installation_id`, a fixed UUID generated once and
stored in `settings`; it is not the per-machine `instanceId`. Who may _read_ a key is decided by access rules
(section 6), not by the key. Two users with different access can share the same key, and each only sees results they
are allowed to see. **Question Q1.**

### 3.2 Production Errors

The "error key" is the existing group `fingerprint` (namespace + service + level + normalized message). **Question
Q2:** you asked for the error type plus a normalized stack trace. That is a different identity. Two options:

- (a) **Keep the group fingerprint** as the error key (recommended). Every occurrence of a group already maps to it,
  everything else references it, and the scan already decides grouping.
- (b) A new `error_key = sha256(namespace, service, error_type, top 5 normalized frames)` stored next to the group.
  It is more precise when one message comes from different code paths, but it needs the scan, the Go mirror and
  backfill to change, and groups and analyses would no longer be 1:1.

The analysis key adds what makes the analysis different:

| kind                     | parts                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prod_error.runtime_rca` | scope, error_key, workflow `production-incident-investigation` + definition version, `VERIFICATION_CONTRACT`, rubric_hash, model_id |
| `prod_error.bug_hunt`    | scope, error_key, sorted repos with each base commit, workflow + definition version, rubric_hash, model_id                          |

- `rubric_hash` = sha256 of the resolved prompt inputs that define the analysis: the step config instructions of the
  workflow version, plus the keys and versions of the skills and knowledge the step is pinned to. Live knowledge
  content is not part of it.
- `model_id` = `provider/model` as resolved for the step (`resolveEffectiveAgent`). **Question Q4.**

Normalization examples, computed with today's `signatureOf` and `fingerprint` (namespace `oms`; level `error` and service
`oms-api` unless stated):

| Raw occurrence                                                          | signature                                                   | error key (fingerprint)                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `order 1029384 not found`                                               | `order <n> not found`                                       | `87d5edbc020d1f804eb9`                         |
| `order 77 not found`                                                    | `order <n> not found`                                       | `87d5edbc020d1f804eb9` (same)                  |
| same message, service `oms-worker`                                      | `order <n> not found`                                       | `b816e546e9607cea8ffb` (service is part of it) |
| same message, level `warn`                                              | `order <n> not found`                                       | `71b3c344d5a2d9cfb8bb` (level is part of it)   |
| `payment 9f8e7d6c5b4a39281706f5e4d3c2b1a0 failed: timeout after 3000ms` | `payment <hex> failed: timeout after <n>`                   | `b6d82658b3e6f4cbe788`                         |
| `user 3fa85f64-5717-4562-b3fc-2c963f66afa6 locked`                      | `user <uuid> locked`                                        | `dde0f92d7212a5214c2c`                         |
| `dial tcp 10.0.3.17:5432: connect: connection refused`                  | `dial tcp <n>.<n>.<n>.<n>:<n>: connect: connection refused` | `5ba03fd5c483b6046ccc`                         |
| `failed at 2026-11-26T10:12:03Z for order A1B2`                         | `failed at <n>:<n>:<n> for order <n>`                       | `8ab515e52ae3c886efe8`                         |

Then the runtime RCA key = `sha256({kind:"prod_error.runtime_rca", v:1, scope:"<installation>", error:"<fp>",
workflow:"production-incident-investigation@17", contract:"unified-rca/v1", rubric:"<hash>",
model:"claude/claude-opus-5-5"})`.

Edge cases:

- A message that contains a deploy-specific constant without digits (for example a pod name made only of letters) is
  not normalized: such groups split per pod. Same behaviour as today.
- A message longer than 400 characters is cut before normalizing, so two errors that differ only after character 400
  collide. This is deliberate and already true for the groups.
- SigNoz span groups use span name + status (`spanMessage`, `scan.ts:262`). They have their own fingerprint, and the
  same failure seen in Splunk and SigNoz can produce two groups. That is unchanged and out of scope.

### 3.3 Code Assessment

| kind              | parts                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_assessment` | scope, sorted repos with each base commit SHA, normalized focus (trimmed, lower-case, whitespace collapsed, empty = whole repo), workflow `codebase-assessment` + definition version, rubric_hash (assess step instructions + pinned skills and knowledge versions), model_id |

Examples:

| Input                                                                        | Key parts                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| repos `[oms-api, payment]`, focus `""`, oms-api@`a1b2c3d`, payment@`9f8e7d6` | `repos:[oms-api@a1b2c3d, payment@9f8e7d6], focus:"", workflow:codebase-assessment@12, rubric:<h>, model:<m>` |
| the same repos in the order `[payment, oms-api]`                             | **same key** (sorted)                                                                                        |
| the same, focus `"  Refund   Flow "`                                         | `focus:"refund flow"`: a different key from `""`                                                             |
| oms-api moves to `b4c5d6e` (new merge to base)                               | **different key**: the old result goes stale (section 4)                                                     |
| the assess instructions change in a new definition version                   | **different key** (definition version and rubric)                                                            |
| the same everything, model changed by the user                               | **different key** (Q4)                                                                                       |

Blob hashes instead of commits: not proposed for v1. A commit pin is what `source_revisions` and
`currentBaseCommits` already give, and a commit that does not touch the assessed paths still invalidates. Blob-level
reuse (for example "only these files changed and they are outside the focus") is a later improvement. **Question Q5.**

## 4. Lookup, single-flight, validity, force re-run

### 4.1 Schema (step 2)

```sql
CREATE TABLE shared_analyses (
  id             bigserial PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('prod_error.runtime_rca','prod_error.bug_hunt','code_assessment')),
  key            text NOT NULL,          -- sha256 hex
  version        int  NOT NULL,          -- 1, 2, ... per key (force re-run = new version)
  status         text NOT NULL CHECK (status IN ('running','valid','stale','failed','superseded')),
  key_parts      jsonb NOT NULL,         -- readable inputs of the key (no secrets)
  scope_repos    text[] NOT NULL DEFAULT '{}',  -- repositories whose access is required to read it
  error_key      text,                   -- prod errors: the group fingerprint
  result         jsonb,                  -- scrubbed snapshot (section 6.3); NULL while running or failed
  source_run_id  bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  trigger        text NOT NULL,          -- 'manual' | 'force' | 'backfill' | 'schedule'
  provider text, model text, definition_version int, rubric_hash text,
  tokens_in bigint, tokens_out bigint, cost_usd numeric, duration_ms bigint,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  valid_until    timestamptz,            -- TTL
  stale_reason   text,
  failure        jsonb, attempts int NOT NULL DEFAULT 0, next_retry_at timestamptz,
  reuse_count    int NOT NULL DEFAULT 0, last_reused_at timestamptz,
  UNIQUE (kind, key, version)
);
-- One lookup: the current version of a key.
CREATE INDEX shared_analyses_lookup ON shared_analyses (kind, key, version DESC);
-- Single-flight in the database: at most one running analysis per key.
CREATE UNIQUE INDEX shared_analyses_one_running ON shared_analyses (kind, key) WHERE status = 'running';
CREATE INDEX shared_analyses_error ON shared_analyses (error_key) WHERE error_key IS NOT NULL;

-- Provenance of every use (hit, wait, miss, forced): who, when, and which version they got.
CREATE TABLE shared_analysis_uses (
  id bigserial PRIMARY KEY,
  analysis_id bigint NOT NULL REFERENCES shared_analyses(id) ON DELETE CASCADE,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('hit','wait','miss','forced')),
  tokens_saved bigint, at timestamptz NOT NULL DEFAULT now()
);
```

The migration is additive (two new tables). Rollback = turn the flags off; dropping the two tables is safe because
nothing else references them.

### 4.2 Lookup-before-compute (step 3)

- One query: the newest version of `(kind, key)`, with its status.
- `valid` and `valid_until > now()` and readable by the caller (section 6) → **hit**: record a use, increment
  `reuse_count`, return the snapshot. No model call.
- `running` → **wait**: return `{status: "running", analysis_id, started_by, started_at}`. The client subscribes to the
  shared result: one SSE `shared_analysis` event on completion, through the existing live-updates relay. It never gets
  the source run.
- Nothing, `stale`, or `failed` whose `next_retry_at` has passed → **miss**: claim, then start the workflow exactly as
  today. The run-completion hook publishes the new version.
- Single-flight: the claim is an `INSERT ... status='running'` guarded by `shared_analyses_one_running`. A concurrent
  claimer gets a unique violation and becomes a waiter. The existing per-owner advisory locks stay as they are.
  A running row whose run ends without a result (failed or canceled) becomes `failed` in the same completion hook. A row
  orphaned by a crash is reaped when its run is terminal (reconcile task), so no key stays "running" forever.

### 4.3 Validity (step 4)

| Status       | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| `valid`      | usable until `valid_until`                            |
| `stale`      | kept for history and display, never served as a hit   |
| `failed`     | not cached as a result; retried after `next_retry_at` |
| `superseded` | an older version after a force re-run                 |

Stale when:

- **Code changed.** Commits are part of the key, so a new commit gives a new key. The old version is marked `stale`
  (`commit_changed`) on the next lookup that finds a newer key for the same repos and focus.
- **Rubric, prompt, definition or model changed.** They are part of the key, so a new key; the old version is marked
  stale the same way.
- **TTL passed.** Configurable per kind, defaults in Q6: runtime RCA 24 h (logs and deploys move), bug hunt and code
  assessment 30 days (commit-pinned, the TTL is only a backstop).
- **Production Errors:** new occurrences **do not** invalidate. The group counters (`today_count`, `last_at`,
  observations) keep updating from scans, and the shared RCA shows them live from the group row next to "analysed at
  X with N occurrences then".

Failed: `attempts` and `next_retry_at = now() + min(1 h, 2^attempts minutes)`. After `max_attempts` (default 3) only a
force re-run starts it again. The failure is shown, not hidden.

### 4.4 Force re-run (step 4)

**A new version, never an overwrite.** The previous `valid` version becomes `superseded` when the new one is
published, not when it starts, so readers keep a valid result while the re-run is in progress. Why:

- other users may be reading or citing the old version;
- RCA versions are already immutable (`incident_rca_versions`);
- audit: who forced it, and what changed;
- a failed re-run must not destroy the last good result.

Who may force: Q7.

## 5. Provenance and audit (step 4)

Per version: `created_by`, `trigger`, `source_run_id`, `started_at`/`finished_at`, `duration_ms`, `provider`,
`model`, `definition_version`, `rubric_hash`, `key_parts`, tokens and cost (from the source run's attempts),
`reuse_count`, `last_reused_at`.

Per use: `shared_analysis_uses`, plus `audit()` rows for `shared_analysis.force` and for a support (admin) read of a
result outside their own access.

## 6. Access and isolation (step 5)

### 6.1 Read rule

A shared result is readable by user U only if:

- **code_assessment, bug_hunt:** U can read **every** repository in `scope_repos` right now
  (`listAccessibleRepositories`, evaluated at lookup, not cached across users). Results with repositories U cannot
  read are treated as a miss for U. U then runs their own analysis, which becomes another version under the same key:
  the key does not leak, the payload is never returned.
- **runtime_rca:** Q3. Proposal: U must be able to see the incident (every member can today) **and** have their own
  Splunk or SigNoz connection. Otherwise the RCA would hand log evidence to someone with no log access.
- Admin support access (`?scope=all`) works as it does for runs: allowed and audited.

The key never includes a user. Who may read is evaluated on every lookup.

### 6.2 What a reuser does not get

The source run (logs, prompts, tool calls, worktree), the source owner's work item and PRs, other users' finding
statuses. They get the scrubbed snapshot plus provenance (who, when, which model, how many times reused).

### 6.3 Scrub policy (before storing `result`)

- `redactSecrets`: tokens, keys, passwords, connection strings, bearer and basic auth, JWT, private keys.
- `redactPii`: emails, phone numbers, national ids, card numbers (the patterns the platform already uses).
- `looksSecret` on each string field: a field that still looks secret is replaced by `[redacted]`.
- Raw log lines from Splunk or SigNoz are kept only as the RCA report already summarises them, and are passed through
  the same scrub. Request ids and trace ids are kept: they are needed to correlate and are not secrets.
- Scrubbing is idempotent and versioned (`scrub_version` in `key_parts`), so a stricter policy can re-scrub old
  snapshots.

## 7. Observability (step 6)

- Counters in `runtimeMetrics` with fixed labels: `shared.{hit,miss,wait,forced,stale,failed}` per kind, plus
  `shared.tokens_saved` per kind (the source version's tokens, summed per hit) and a lookup-latency histogram.
- Logs: one line per lookup with `kind`, `outcome`, `analysis_id`, `version`, `run_id`. These are only the values
  already in scope (rule R1); no extra query is made for logging.
- Tracing: span attributes from the same in-scope values.
- Flags: `SHARED_RESULTS_PROD_ERRORS` and `SHARED_RESULTS_CODE_ASSESSMENT` (`config.sharedResults.*`, `.env.example`),
  both default **off**. Off = no lookup, no publish, behaviour identical to today.
- Backfill (CLI, opt-in): publish existing completed runs as version 1 of their key when their key parts can be fully
  reconstructed (definition version, `source_revisions`, model from the attempts). Anything ambiguous is skipped and
  counted. Default dry-run.

## 8. Changes by file (indicative)

| Step                                     | Files                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 schema + key                           | `migrations/112_shared_analyses.sql`; `src/sharing/key.ts` (pure); `src/config.ts` (flags, TTLs); unit tests with the examples above                                                                                                          |
| 3 lookup + single-flight                 | `src/sharing/{repository,service}.ts`; hooks in `startRuntime` (`incidents/unified.ts`), `startBugHunt` (`bugHunt/service.ts`), `POST /api/code-scans` (`code-findings.ts`)                                                                   |
| 4 invalidation, retry, force, provenance | `src/sharing/service.ts`; publish and fail from the run-effects hook; reconcile task to reap orphans                                                                                                                                          |
| 5 access + scrub                         | `src/sharing/{access,scrub}.ts` built on `repos/access.ts` and `integrations/redact.ts`                                                                                                                                                       |
| 6 metrics, tracing, flags, backfill      | `runtimeMetrics.ts`, `src/cli/sharedBackfill.ts`, `.env.example`                                                                                                                                                                              |
| 7 UI/API                                 | `GET /api/shared-analyses/:id`; the workbench and the code-scan start return `{shared: ...}`; badges in the Production Errors workbench and the code findings page (who, when, version, valid/stale, reuse count, "Re-run" with confirmation) |

## 9. Risks

| Risk                                                 | Mitigation                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Leaking analysis across access boundaries            | read rule evaluated per lookup, key without users, snapshot instead of the run, integration tests with two users of different access |
| Serving an outdated RCA                              | 24 h TTL, version and "analysed at" shown, force re-run                                                                              |
| Secrets in model output                              | scrub before storing; scrub version; secret-looking fields replaced                                                                  |
| Running rows stuck after crashes                     | partial unique index + reconcile reaper tied to the run's terminal state                                                             |
| Key drift (two keys for one analysis)                | canonical JSON, sorted repos, normalized focus, `key_version`                                                                        |
| Behaviour change with flags off                      | the lookup and publish paths are skipped entirely; tests run the existing suites with flags off                                      |
| Cost of `currentBaseCommits` (fetch) on every lookup | already paid today by `reusableScan`; no new fetches                                                                                 |

## 10. Shared rules (every later step follows them)

- **R1** Tracing and logging attach only IDs and attributes already in scope. **No extra DB query or I/O** to enrich a
  trace or log line.
- **R2** No scope beyond this plan. The core analysis logic (workflows, prompts, scoring, RCA reconciliation,
  assessment) does not change; only a sharing layer is added around it.
- **R3** Out of scope: any automatic approval based on a shared result.
- **R4** With a flag off, behaviour is identical to today (same queries, same responses, same runs).
- **R5** Follow the repository conventions: forward-only checksummed migrations, typed config fields in
  `src/config.ts`, fixed metric labels, `audit()` for privileged actions, tests next to the existing suites.
- **R6** Every step ends with `typecheck`, `lint`, the relevant unit and integration tests and `arch:check`, and
  updates `PROGRESS.md`.

## 11. Open questions (decisions recorded)

- **Q1 (scope / tenant boundary):** **Accepted proposal** (`scope = installation_id`, a single UUID stored in `settings`,
  not per-machine `instanceId`). Users in one installation share the same keys; access boundaries are enforced per
  lookup via `canReadShared` (repository grants/checks or log access), never embedded in keys.
- **Q2 (production-error key identity):** **Option (a)** — reuse `prod_error_groups.fingerprint`
  (`sha1(namespace, service, level, signature)[:20]`, message truncated at 400 chars). Option (b) (stack-frame hash) was
  rejected because existing tables, Go scan, radar, and work items all join on `fingerprint`.
- **Q3 (runtime RCA read rule):** **Accepted proposal + N8 hardening** — viewer must have incident access (all active
  members) **and** own log-search capability (`splunk_token` / `splunk_cookie`, enabled `signoz`, or shared
  `splunk_token` when `splunk.allowSharedToken` is enabled). By N8, members without log access are also blocked from
  claiming or publishing a shared RCA so they cannot supersede log-backed RCAs.
- **Q4 (model, profile, and config in key & subject):** **Accepted + expanded via C4 / Decision #2 / N2** — keys record
  resolved `profile` (`MICRO|FAST|STANDARD|DEEP`), step provider/model(s) resolved for that profile, and `#cfg:<hash16>`
  over provider defaults & profiles. `olderOfSubject` isolates subjects by both model identity (`split_part(model, '#', 1)`)
  and `profile` across all three kinds; `#cfg` stays outside the subject so config changes still mark prior runs of the
  same model+profile stale (`model_changed`).
- **Q5 (commit pinning vs partial diff reuse):** **Accepted proposal** — full commit SHA (40 or 64 hex) per repository in
  keys; stale `commit_changed` triggers on publish only when every moved repository's new commit is a confirmed descendant
  (`git merge-base --is-ancestor`). Partial file/path-filtered reuse is deferred.
- **Q6 (TTLs):** **Accepted defaults** — runtime RCA `24h`, bug hunt `30d`, code assessment `30d` (configurable via
  `SHARED_RESULTS_TTL_*`).
- **Q7 (who may force a re-run):** **Anyone who may read the result** (`canRead`), audited via `shared_analysis.force`.
  Unreadable results bypass sharing rather than superseding another reader's result. (Confirmed after C1–C4; can later be
  restricted to creator/admin without schema changes.)
- **Q8–Q9 note (REVIEW.md reference reconciliation):** Only **Q1–Q7** were defined in this plan (`REVIEW.md` §"Note"
  referenced `Q1–Q9`). No Q8 or Q9 exists in the document history. The remaining post-C1–C4 policy choices active in the
  codebase (for confirmation) are:
  - **Prior-evidence sharing (`C1`):** keep bypassing sharing whenever prior cross-workflow evidence is attached (keying
    evidence refs deferred to a later phase);
  - **Downstream auto-ingestion & linking (`N4`):** keep deferred to Phase 2 (see §2);
  - **`KEY_VERSION`:** keep at `1` while feature flags default off and no production rows exist.
