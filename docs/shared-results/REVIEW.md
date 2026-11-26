# Shared results: final review (step 8)

Scope: `git diff 77fa3e3..HEAD` (6 commits, 59 files, +7588/−67), read against docs/shared-results/PLAN.md (rules R1–R6)
and PROGRESS.md. **No code was changed.** Method:

- the author read the code;
- two independent read-only review agents covered (a) security and concurrency, and (b) keys, invalidation, flags and scope;
- every finding below was re-checked on the code before it was kept.

PROGRESS.md claims that are contradicted by the code are called out.

Severity:

- **Blocker (Chặn):** must be fixed before merge.
- **Should fix (Nên sửa):** fix soon, or accept explicitly.
- **Note (Ghi nhận):** known trade-offs and minor items.

## Blocker (Chặn)

### C1. RCA and bug hunt share results built from the starter's private evidence: a leak across permissions, and wrong merges

**Where.**

- The runtime RCA's input includes the starter's own bug-hunt digest:
  - `src/incidents/unified.ts:742` builds `d = digest(wb, "bug_hunt")`;
  - `:749` puts it in `request: describeGroup(g) + d.text`;
  - `:752` adds `prior_evidence: d.refs`.
- The digest (`unified.ts:682-710`) lists `repository:file:line` and up to 200 characters of each defect statement, taken
  from the actor's own runs.
- A workbench bug hunt gets the starter's RCA digest in the same way: `unified.ts:826,831`, then `src/bugHunt/service.ts:105-106`.
- Neither key contains this input:
  - `src/sharing/flows.ts:88` (`runtimeRcaKey`: scope, error, workflow, contract, rubric, model);
  - `flows.ts:117` (`bugHuntKey`).
- The RCA read check only asks whether the reader has a Splunk or SigNoz login (`src/sharing/access.ts:20-21`). An RCA row
  has `scope_repos = '{}'`.

**Reproduce.**

1. Member A can read the private repository X; member B cannot, but B has a Splunk login (or the shared token is allowed).
2. A runs a bug hunt on X for incident F, then a runtime RCA for F. The RCA prompt carries X's file locations and defect
   statements, and the RCA is published.
3. B opens F and starts a runtime RCA. B gets a hit and receives A's RCA, which may repeat X's locations and statements.

The reverse also holds: a workbench bug hunt carries A's log-based RCA hypotheses, and a member with repository access but
no log access receives them.

**Wrong merges.**

- An RCA started with prior evidence and one started without it have the same key.
- So do a hunt from `POST /bug-hunts` (no context) and one from the workbench (with the digest).

**Why it blocks.** It breaks the plan's read rule (6.1) and isolation goal. Step 5 flagged only "bug hunt may need the RCA
rule"; this concrete path was not seen.

**Not verified.** How much of the digest the model copies into the final report. The prompt receives it either way.

**Directions.**

- Either do not share a run started with prior evidence (skip sharing when `d.refs.length > 0`).
- Or put the evidence refs (hashed) into the key, add their repositories to `scope_repos`, and require log access for a
  hunt built on RCA hints.

### C2. A member's personal workflow definition is published under the shared definition's key

**Where.**

- The key resolves the **shared** definition: `src/sharing/context.ts:43` calls
  `definitions.version(definitionKey, …, db, null)`.
- The run resolves the **owner's** definition first: `src/workflow/engine/runCreation.ts:152` passes `ownerId`, and
  `src/workflow/definitionRepository.ts` `version()` orders by `d.owner_id NULLS LAST`.

**Reproduce.**

1. Member A has a personal copy of `codebase-assessment` with an edited prompt (or of the RCA or bug hunt workflow).
2. A runs it, and the result is published under the key computed from the shared definition.
3. Member B, on the standard workflow, gets a hit and is served the output of A's prompt as if it were the standard
   analysis.

This is a wrong merge, and also a way for one member to plant conclusions for others. The backfill already skips
`personal_definition` (`src/sharing/backfill.ts`), so the gap is specific to the live path.

**Direction.** Resolve the definition with the actor's `ownerId` in `analysisContext`. Then either put the definition
**id** (not only the version) into the key, or do not share runs of personal definitions.

### C3. A force re-run, and a failed re-run, hide the last good result: this contradicts plan §4.4

**Where.** `lookupOrStart` reads only the highest version (`src/sharing/service.ts:114` calls `latestVersion`, in
`src/sharing/repository.ts:93`). The read API does the same (`latestForError` `repository.ts:250`,
`latestForRepositories` `:267`).

**What the plan says (§4.4):** "readers keep a valid result while the re-run is in progress", and "a failed re-run must not
destroy the last good result".

**Reproduce.**

1. v1 is valid. A member forces, and v2 is running.
2. Every other caller gets `wait`, not v1, for the whole run (tens of minutes).
3. If v2 fails, callers get `bypass` during the backoff, and each starts their own **unshared, paid** run.
4. After the backoff, the next caller starts v3, although v1 is still `valid`.

**Docs and tests are wrong too.** PROGRESS.md (step 4) and the test name at
`test/shared-results-validity.integration.ts:350` ("the old one stays valid and served until the new one is published")
say the opposite of what the test asserts (`:369` expects `"wait"`).

**Direction.** When the latest version is running or failed, serve the newest _valid and servable_ version, readable by
the caller, as a hit (with a "re-run in progress / failed" note). Fix the test name and PROGRESS.md.

### C4. Marking stale "by subject" invalidates good results: across providers, at claim time, and regardless of commit order

**Where.**

- `markReplaced` runs right after a claim, not after publish (`src/sharing/service.ts:173-174`).
- It marks every valid row of the same subject under another key stale (`olderOfSubject`,
  `src/sharing/repository.ts:376`).
- The subject does not include the provider/model. For an RCA it is just the error key.

**Reproduce.**

1. **Providers fight each other.** A's RCA for F was run with codex and is valid. B starts the same RCA with claude, which
   is another key. A's row becomes `stale: model_changed` although nothing about it changed. The next codex user misses and
   pays again, and two providers in use keep invalidating each other.
2. **Nothing left after a failure.** A new commit is claimed, the old result is marked stale at once, and the new run
   fails: nothing is valid for that subject.
3. **Direction is ignored.** Two members whose base refs differ for a moment around a push (commit X, then Y) claim in
   order Y, then X. The X claim marks the **newer** Y result stale with `commit_changed`.

**Why it blocks.** It defeats invalidation (topic 4), which must mark only what is really outdated, and it adds the cost
the feature exists to save.

**Direction.**

- Mark stale on **publish**, not on claim.
- Make the subject include the model fingerprint (or skip `model_changed` when only the provider choice differs).
- For commits, mark stale only when the new commit is a descendant (or when its run started later).

## Should fix (Nên sửa)

### N1. The code assessment key ignores the output locale and the project

**Where.** The run gets `outputLocale` and `project` (`src/api/routes/code-findings.ts:148,152`), but
`codeAssessmentKey` (`src/sharing/key.ts:228`) has neither.

- The locale goes into the prompt's language policy.
- The project goes into the context resolution (project knowledge) and into the profile classification.

**Reproduce.** A runs it in `vi`. B, using `en`, gets A's Vietnamese report as a hit.

**Same gap for backfilled rows.**

### N2. The execution profile (AUTO) is not in the key

**Where.**

- `analysisContext` resolves the step agents with `profile: null` (`src/sharing/context.ts:83`).
- `startRun` classifies the run with `classifyWithFallback` (`runCreation.ts:231`), from the title, project and
  provider, possibly with an LLM call. The profile (FAST/STANDARD/DEEP) can change the models and the steps.

**Reproduce.** Two requests whose titles differ are classified FAST and DEEP. They have the same key, so the FAST result is
served to the DEEP request.

**How often it happens: not verified.** The backfill also ignores `run.profile`.

### N3. The backfill stores the focus unscrubbed

**Where.** `src/sharing/backfill.ts:209` writes `{...key.parts, scrub_version}`. The live path scrubs `focus` first
(`scrubParts` in `service.ts`).

**Effects.**

- A focus containing an e-mail or a token is stored and returned in the view (`view.ts`, field `focus`).
- Such a row is never found by `latestForRepositories` or `olderOfSubject`, which compare against the scrubbed text.

### N4. Two behaviours the plan promises are not implemented

Plan §2 promises them; PROGRESS.md does not record that they are missing:

- "Reuse for Code Assessment ingests the shared findings into the reuser's own `code_findings`". A hit only returns the
  view, so the reuser's Findings list stays empty.
- "Reuse for Production Errors links the shared result into the reuser's `incident_investigations` workspace". A shared
  hunt is explicitly not linked (`unified.ts` `huntOrShared`), so it never reaches the reuser's reconciled RCA or
  `createFix`.

### N5. A finished backfill never picks up newer runs

**Where.** After a complete pass, the saved cursor is the **smallest** run id handled (`src/sharing/backfill.ts:134`), and
the scan keeps `r.id < cursor` (`:116`).

**Effects.**

- Running it again, after new runs or after a flag is turned on, scans nothing unless `--restart` is given.
- The CLI says "Safe to run again" (`src/cli/sharedBackfill.ts:8`), which is true for idempotency but misleading for
  coverage.
- The rollback of 112 keeps the cursor setting, so after re-applying 112 the backfill skips everything.

**Direction.** Store `{high, low}` marks, or clear the cursor when a pass completes.

### N6. Scrub gaps, and one risk of over-redaction

**Where.** `src/sharing/scrub.ts:36-50`.

**Gaps.**

- Object **keys** are never scrubbed (an e-mail or token used as a map key is kept).
- The credential-field rule applies only to **string** values: `{token: 12345678}` and `{password: {value: "…"}}` pass it.
- The field-name regex is anchored, so `x-api-key`, `AWS_SECRET_ACCESS_KEY` and `db_password` do not match it. They
  rely on the text patterns alone.
- Numbers are never scrubbed (a phone number stored as a JSON number).
- A national id without a label in front is not caught. This was chosen on purpose, to keep order ids.

**Over-redaction.** A single `looksSecret` match replaces the **whole string**. If a report is one markdown string, the
published result is `"[redacted]"`, and it is served as a valid hit for up to 24 hours (RCA) or 30 days (assessment and
bug hunt).

**Not verified.** The real shapes of the outputs. **Direction.** Redact the matched span, and fail the publish instead of
publishing an all-redacted result.

### N7. One row that throws stops the reconcile task for every row after it

**Where.** `settleSharedAnalyses` has no per-row error isolation (`src/sharing/settle.ts:106-141`), and
`sharedResultsMaintenance` (`:182`) runs expiry only if settling succeeded.

**Effect.** A persistent error on one row repeats on every tick. It could come from `snapshotOf`, `factsOf` or
`publish`, for example a jsonb rejection. The rows after it, ordered by id with LIMIT 50, are then never settled: their
keys stay `running`, and every caller gets `wait` until the 360-minute timeout.

**Not reproduced.** No realistic poison row was found.

### N8. A member without log access can produce the shared RCA, which then supersedes for everyone

**Where.** Starting an RCA does not require log access. The run uses the starter's own (absent) Splunk or SigNoz
credentials. When the latest version is not servable, the claim path does not check `canRead`
(`src/sharing/service.ts:146-158`).

**Effects.**

- An RCA with no log evidence becomes the shared version (and supersedes the previous one) for every reader with log
  access.
- Its creator cannot read it.

**Not verified.** How much an RCA degrades without logs.

### N9. Cost on the hit path is higher than PROGRESS.md states, and the test does not measure the real path

**What happens on every request with a flag on, hit included.**

- Before the lookup, `analysisContext` makes about 3 queries: the definition, the agent configuration and the skill
  versions.
- The code assessment and the bug hunt resolve base commits with `currentBaseCommits`, which **fetches git**. The bug hunt
  does it while holding its per-owner advisory lock (`src/bugHunt/service.ts:124`).
- `canRead` for an RCA reads and decrypts up to 4 secrets in sequence.

**The test.** The "hit = 1 SELECT + 1 background statement" checks override `canRead` with a creator-only stub
(`test/shared-results-validity.integration.ts:54`, `test/shared-results-observability.integration.ts:60`), so the default
access check is never counted.

**Logging is fine (R1).** It adds no query; this was verified.

## Note (Ghi nhận)

- **A timeout breaks single-flight.** A row running longer than 360 minutes is failed, but its run keeps going; after the
  backoff, a second run of the key starts beside it. This is documented, and nothing cancels the first run.
- **The claim transaction holds the key during `startRun`** (`service.ts:147-158`), which includes repository preparation
  and the profile classifier (up to a 5-second LLM call). Concurrent requests for the key block for that time. A 23505
  raised by `startRun` itself would be mistaken for a lost race and retried, up to 3 times.
- **`waitForAnalysis` is used only by tests.** The API answers `wait` at once and the UI polls the read API, which checks
  access. So the NOTIFY wake-up claimed in PROGRESS.md does not run in production.
- **The read API shows only the newest version per subject.** If the reader cannot read that one, nothing is shown, even
  when an older readable version exists (fail closed).
- **Anyone who can read a result can force it.** It is audited (`shared_analysis.force`); plan question Q7 (who may force)
  was never answered.
- **R4, strictly read.** With the flags off, the server behaves as before: the flows return `null` before any query (this
  was verified for the code-scan, runtime, hunt and both routes). The web client, however, always makes two new GET
  requests (`web/src/pages/prodErrors/IncidentWorkbench.tsx:248`, `web/src/pages/prodErrors/CodeScan.tsx:199`). They
  answer `null` or 404 without touching the database, but they are new requests.
- **The key is very strict on configuration.** The `#cfg` fingerprint covers the defaults and profiles of every provider
  involved, so any configuration change drops every hit. This is intended ("never fewer keys").
- **Owner-specific knowledge and skills are not in the key** (only shared skills and their versions are), so their effect
  on a run is not reflected. It overlaps with C2.
- **Tracing.** There is no tracing SDK in the Node service; logs and metrics do no I/O (R1 holds). The plan's "span
  attributes" item is unimplemented, as PROGRESS.md says.
- **Migrations.**
  - 112 and 113 are additive, and their rollback scripts are tested.
  - The backfill is idempotent (`NOT EXISTS` + `ON CONFLICT DO NOTHING`); see N5 for its coverage.
- **Scope (R2, R3).** No change to the workflows, prompts, scoring or RCA reconciliation; the `startRun` inputs are
  unchanged. Nothing auto-approves. Changes outside `src/sharing`:
  - small helpers in `integrations/splunk.ts` and `integrations/signoz.ts`;
  - an export in `report/cost.ts`;
  - `runtimeMetrics.ts`;
  - a client-only fix in `CodeScan.tsx` for `{reused: "shared"}`.
- **Plan questions Q1–Q9 were never answered or recorded** (PLAN.md §11). Several findings above (C1, Q3; the force rights,
  Q7) depend on them.

## Untested high-risk areas

- **C1 (cross-permission leak):** no test runs an RCA or hunt started with prior evidence and then reads it as a member
  without the repository or without log access.
- **C2:** no test covers a personal workflow definition.
- **C3:** the test asserts the behaviour that contradicts the plan (`wait` during a force).
- **C4:** no test covers a provider change, or a failed run after claim-time staling.
- **N9:** the cost of the default `canRead` on the hit path is not counted.
- **The HTTP start routes with a flag on** (`POST /api/code-scans`, `/workbench/*`, `/bug-hunts`) are not exercised end to
  end with hit, wait and force. They need a git fetch, so only the flows and the read API are covered.
- **N7:** no test has a row that fails to settle.
- **Multiple instances** are simulated with `Promise.all` in one process, not with separate processes or connections
  crashing mid-claim.
- **The Incident Workbench card** has no browser test; only the Code Assessment page has one.

## Not verified

- Whether the RCA and hunt reports actually repeat the prior-evidence locations and statements (C1). The prompts contain
  them.
- How often AUTO picks a profile other than STANDARD (N2).
- The real shapes of the RCA, hunt and assessment outputs, which decide how bad the over-redaction is (N6).
- A crash between the claim's COMMIT and the run being picked up (`afterCommit`). This was reasoned through, not
  exercised.
- Whether the RCA workflow reads repositories itself, in which case it would also need the repository read rule.
- Runtime behaviour under real load or real multiple instances.
