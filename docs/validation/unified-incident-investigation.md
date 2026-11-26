# Unified Incident Investigation — validation

Working tree on `main` @ `11e3ac7` plus uncommitted changes, 2026-11-24.

- **Test environment:** deterministic fixtures, the private PostgreSQL test cluster, the real Workflow Engine and scheduler, and the real Agent Harness for the Bug Hunt (Codex provider path through the fake `codex` CLI).
- **Not used:** VPN, production SigNoz/Splunk, and paid LLM calls.
- **Runtime RCA steps were stubbed** (see §6). Token and cost figures for the runtime RCA are therefore synthetic. They prove call-count parity, not model-level savings.

## 1. What already existed (audit)

| Workflow | Persisted result | Link to the incident before this change |
| --- | --- | --- |
| `production-bug-hunt` | `bug_hunts` + `bug_hunt_findings`. Bug verification (`CONFIRMED/SUSPECTED/REJECTED/BLOCKED`) is a separate column from incident causality (`CONFIRMED/PROBABLE/NOT_SUPPORTED/UNKNOWN/NOT_APPLICABLE`). A DB check prevents causality `CONFIRMED` without bug `CONFIRMED`. | `bug_hunts.fingerprint`, per requester |
| `production-incident-investigation` (runtime RCA) | `investigation_report` step output: findings, plus `round` (RoundState: hypotheses with kind/status/refs/code location, outcome, deployed versions, impact, missing evidence) | none (free-text request) |
| `bug-investigation` (fix) | its own run, with `inputs.bug_hunt_id`/`bug_hunt_finding_id` (from a hunt), `inputs.investigation_run_id` (from a runtime RCA), or the incident's `work_item_id` | indirect |

Each workflow already had its own dedupe:
- `startBugHunt`: one active hunt per user, incident and scope.
- `createFixTask`: one fix per finding.
- `startFixFromInvestigation`: one active follow-up per runtime run.

Nothing joined these results, and nothing stopped a runtime fix and a hunt fix from being opened for the same cause.

## 2. Design (no new orchestrator)

- **Workspace.** `incident_investigations` holds one row per (fingerprint, owner); the owner is the access scope. `incident_investigation_runs` links runs (`runtime | bug_hunt | fix`) with `link_source`:
  - `workbench` when the run was started from the workbench;
  - otherwise it is discovered from the runs' own records (`bug_hunts`, `inputs.fingerprint`, `inputs.bug_hunt_id`, `inputs.investigation_run_id`, the incident work item).
  
  Only runs owned by the workspace owner are linked. On read, a run owned by someone else is excluded and reported (defense in depth).
- **Evidence by reference** (`src/incidents/unified.ts`). Evidence is never copied into the workspace. It is read from `bug_hunt_findings` and the runtime report's `round`, and keeps its reference (`bug_hunt:<hunt>:finding:<id>`, `run:<run>:hypothesis:<id>`, `run:<run>:finding:<n>`), source run, owner and commit.
- **Validity, checked on every read:**
  - **Ownership.**
  - **Repository access:** the owner can still read the repository the evidence cites.
  - **Freshness:** `git diff --quiet <evidence commit> <current base> -- <file>`. At most 40 checks per read; the base is cached per repository. Stale evidence is shown but cannot support `CONFIRMED`, and gets a "refresh" next action.
- **Deterministic reconciliation** (`src/incidents/reconcile.ts`), with zero model calls:
  - **Clustering.** Causes are clustered by code location: same repository and file, then same function or lines within 15 of each other. Without a location, statement token similarity (Jaccard ≥ 0.5) is used instead.
  - **Per-item causality level.**
    - Hunt causality maps to that level.
    - A runtime `causal_origin`/`direct_trigger` that is SUPPORTED gives `confirmed` only when it is a causal origin and the round outcome is CONFIRMED. Otherwise it gives `probable`.
    - DISPROVED or NOT_SUPPORTED counts as `against`.
  - **A cause takes the strongest single valid verdict.** Agreement between sources never raises the level (two PROBABLE stay PROBABLE).
  - **CONFLICTED** when:
    - one run supports a cause and another disproves it; or
    - two different causes are each confirmed.
  - **BLOCKED** when every source was blocked or failed and nothing usable exists. **UNKNOWN** otherwise.
  - **Bug verification ≠ causality.** A CONFIRMED defect with UNKNOWN causality is listed under "verified defects". It is not a root cause, and "runtime evidence that defect … caused this incident" is added to missing evidence.
  - **Not fixable:** a cause without a code location (provider, configuration or business) is `code_fixable: false`. So is a REJECTED defect.
- **RCA versions.** `incident_rca_versions` is immutable: a trigger rejects any UPDATE. A new version is written only when the inputs hash changes and at least one workflow has finished. The hash covers:
  - the verification contract;
  - the owner;
  - every item's ref, commit, verdicts, validity and freshness;
  - run states.
  
  Unrelated commits and permission changes that leave every item's validity unchanged mint no version (tested). The report records the base revisions it was checked against.
- **Fix tasks.** `incident_fix_tasks` has `UNIQUE(investigation_id, cause_key)`, and the reservation is inserted before any run is started. The task is routed to the existing flows:
  - `createFixTask` for a hunt finding (preferred when one exists);
  - otherwise `startFixFromInvestigation`.
  
  The fix needs `confirm: true`, and a cause that already has an active fix run reuses it.
- **Actions are user-initiated only.**
  - `POST /api/prod-errors/:fp/workbench/{runtime|bug-hunt|both|fix}`.
  - `GET /workbench` and `GET /workbench/rca/:version`. An admin may read another owner's workspace in support mode (`?scope=all&owner=`), and that read is audited.
  - An active run is returned rather than duplicated.
  - A completed run is never re-run implicitly: the API answers 409, and the UI asks before sending `force`.
  - A new run gets the other workflow's validated evidence as a bounded hint, never a transcript:
    - at most 8 lines, marked UNVERIFIED, with refs it can re-read;
    - only valid, fresh CONFIRMED/SUSPECTED findings or SUPPORTED hypotheses.
- **UI.** The Production Errors → Incidents accordion shows the **Unified RCA summary** first:
  - status, version, reasons, a causes table with supporting (+) and contradicting (−) evidence links, and "Create Fix Task" only on eligible causes (with a confirm dialog);
  - Run Runtime RCA / Run Bug Hunt / Run both;
  - Runtime and Bug Hunter cards with progress, outcome, per-run turns, tokens and cost, and run links;
  - contradictions, verified defects, runtime findings, impact, missing evidence, next actions, excluded evidence, related fix tasks, and per-incident totals including cost per verified RCA.
  - It polls every 5 s while a run is active. Phone width is covered.

## 3. Results

| Suite | Command | Result |
| --- | --- | --- |
| Reconciliation unit tests | `node --import ./test/env.ts --test test/incident-reconcile.test.ts` | 10/10 |
| Full unit suite | `npm test` | 1270/1270 |
| Unified integration (engine + harness + PG) | `node test/run-integration.ts test/unified-incident.integration.ts` | 10/10 |
| Full integration suite | `npm run test:integration` | 1043/1046; the 3 failures are the pre-existing baseline (identical on untouched `main`): evaluation.integration.ts ×2 (platform-go not running), repository-remotes.integration.ts ×1 (global git `insteadOf`) |
| Browser (production bundle, mocked API) | `npm run smoke:incident-workbench` (needs `CHROMIUM_BIN` on this host; the Playwright Chromium lacks `libnss3`) | en @1280 px, vi @390 px PASS |
| Existing incident list browser test | `npm run smoke:prod-errors-tabs` | PASS (workbench tolerates the mock's `[]`) |
| Typecheck / lint | `npm run typecheck`, `npm run lint` | clean |

Integration scenarios (`test/unified-incident.integration.ts`):

1. **Bug hunt first.** Real hunt. Linked; evidence by reference with its commit. Reading or reconciling makes no agent call. Refresh creates no new version.
2. **Then runtime.** Two concurrent clicks start one run. The hunt's validated findings arrive as a bounded unverified hint, and their refs are recorded in `inputs.prior_evidence`. Result:
   - one deduplicated cause with both sources, `CONFIRMED`, version 2;
   - impact and missing evidence are carried over;
   - per-incident telemetry is filled in;
   - an UPDATE on a version is rejected (immutable), and history is readable.
3. **No implicit re-run.** Starting a completed runtime or hunt returns 409. Replaying the report step keeps the same RCA version, and only that deterministic step ran.
4. **Duplicate fix prevention.**
   - Unconfirmed requests are rejected, and so are other users' requests.
   - Two concurrent confirmed requests create one task. It is routed through the verified finding, and a single `incident_fix_tasks` row exists.
5. **Freshness.**
   - An unrelated commit leaves the evidence fresh and mints no version.
   - Touching the cited file marks it stale, adds a refresh action, and mints exactly one new version.
6. **Authorization.**
   - Each owner has a separate workspace. Another user gets 404 on the RCA version and in support mode.
   - An admin in support mode can read it, and the read is audited.
   - A forged link to another user's run is excluded ("run owned by another user") and never confirms anything.
7. **Runtime first, then a contradicting hunt** (second user's workspace).
   - The runtime run DISPROVES the location, and the next action suggests (does not start) a hunt.
   - The verified hunt then makes the RCA `CONFLICTED`, with refs from both sides.
   - The first user's RCA is unaffected.
8. **Parallel runs and partial failure.**
   - "Run both" starts both; a repeat returns the same active runs.
   - No version is written while nothing has finished.
   - The hunt is canceled and the runtime completes. The RCA stays `PROBABLE` from runtime alone.
   - The provider cause (no code location) is not fixable, and the API refuses a fix.
9. **Efficiency.** A runtime RCA started from the workbench makes exactly as many agent calls as a standalone run.
10. **Discovery.** A hunt started from the existing Bug Hunter UI is linked (`link_source: bug_hunts`) and is not visible to another user.

The sandbox (`bwrap`) was available, so the hunt took the CONFIRMED-verification path. Without it, the same tests take the BLOCKED branch and assert that nothing is reported as verified.

## 4. Benchmark: standalone vs unified (offline)

| Measure | Standalone runtime RCA | Unified, no prior evidence | Unified, with bug-hunt digest |
| --- | --- | --- | --- |
| Agent calls (provider attempts) | 3 | 3 | 3 |
| Tokens (stubbed telemetry) | 3000 in / 600 out | 3000 in / 600 out | 3000 in / 600 out |
| Request size | — | 1333 chars | 1703 chars (+370 chars, ≈ 100 tokens, bounded to 8 lines) |
| Reconciliation | — | 0 LLM calls, 15.1 ms avg per workbench read (PG + git) | same |

- **Single-workflow investigations incur no extra LLM call.** Linking, reconciliation and versioning are SQL plus git only.
- **The only added model input is the optional digest**, about 100 tokens, and only when the other workflow already has validated evidence.
- **Tokens are equal by construction here** (the runtime agents are stubbed). Real-model token effects of the digest are not measured. Doing so would need an authorized paid run.
- **Cost per verified RCA** = the incident's reported cost ÷ the number of CONFIRMED RCA versions. The workbench shows it, but it is only meaningful with real provider telemetry.

Remaining efficiency levers already enforced:
- no automatic start of either workflow;
- no implicit re-run of a completed one;
- active-run dedupe;
- RCA cached by inputs hash.

## 5. Known limits

- `startFixFromInvestigation` allows one active follow-up per runtime run. If a runtime RCA has two distinct code causes and no hunt finding, the second cause's "Create Fix Task" returns the existing follow-up. It is recorded under that cause rather than opening a second fix from the same run.
- Runtime evidence freshness uses the deployed commit the round resolved, when there is one. Without it, runtime hypotheses are not freshness-checked; only bug hunt findings always carry a commit.
- Runtime runs started before this change carry no `inputs.fingerprint`, so they are not auto-discovered.
- Bug hunt evidence reuse across hunts stays as before (`reused_from` on findings). The investigate stage of a re-run hunt is not skipped. Instead, a completed hunt is never re-run without explicit confirmation.

## 6. What was real vs stubbed

| Component | Real / stubbed |
| --- | --- |
| PostgreSQL schema (migration 104), Workflow Engine, scheduler, run lifecycle, cancel, reexecute | real |
| Production Bug Hunt (all stages, Agent Harness, MCP bridge, sandboxed reproduction) | real; agents scripted through the fake `codex` CLI |
| Runtime RCA agent steps and Splunk/SigNoz-backed integration steps | stubbed per step; the report step returns a scripted RoundState |
| Fix routing (`createFixTask`, `startFixFromInvestigation`, `bug-investigation` start) | real; fix runs canceled immediately in tests |
| Telemetry aggregation (`execution_attempt_telemetry`) | real view; runtime token and cost numbers recorded by the stub |
| Browser test | production bundle; API mocked |
