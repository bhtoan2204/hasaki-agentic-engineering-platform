# Shared results: progress

- [x] 1. Survey and plan (docs/shared-results/PLAN.md): approved (answers to the open questions were not recorded; step 2
      follows the plan's proposals)
- [x] 2. Schema + dedup key
- [ ] 3. Lookup + single-flight
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
