# Production cleanup validation

Baseline: latest fetched `main`, commit `b6e6ccc700475c7b7ba78da0177b9e0e5f3c67f8`, on a clean checkout. Work is isolated on `chore/production-cleanup`. The requested GitHub repository and the origin under its former name resolve to that same main commit.

## Scope and evidence

Inspected repository identity/provisioning and all repository path consumers; workflow engine, state machine, scheduler, contexts, retries, questions and event persistence; Claude/Codex/Cursor execution and auxiliary completions; Tree-sitter indexing/search; evaluation fixture/materialization/isolation/validation; knowledge/task memory; database transactions, migrations and cache invalidation; React routing, API/live hooks, repository forms, styles and localization.

Compiler unused-declaration diagnostics, repository-wide identifier searches, import graph reachability (including tests and CLI roots), dynamic entrypoint searches and runtime regression tests informed removals. Static reachability alone was not used to delete modules. Every declared runtime dependency has an import, stylesheet, executable or grammar-asset consumer. No dependency was removed.

## Finding classifications

| Classification | Finding and action |
| --- | --- |
| SAFE_TO_REMOVE | Compiler-proven unused imports/locals in agent prompts, APIs, code intelligence, evaluation, Git/repository code and tests: removed; assertions remain. |
| SAFE_TO_REMOVE | Unreferenced private frontend `supportViewOn`, obsolete Vietnamese-only `STATUS_LABELS`, unused `Mono` component, and unused `EvaluationConfiguration` type: removed after call-site searches. Localized status rendering remains in i18n. |
| SAFE_TO_REMOVE | `repo.dir` and `repo.remote` have no static or finite dynamic-key consumers: removed in both languages. Actual legacy-layout labels remain. |
| SAFE_TO_REMOVE | `hasakiWork.chromiumPath` has no reader: removed from the type/defaults. Older JSON configurations remain accepted and ignored; explicit local-browser configuration is unchanged. |
| REFACTOR_REQUIRED | Identical legacy SSH-origin conversion in Git, checkout validation and explicit migration: one helper in `repos/remote.ts`; strict HTTPS registration is unchanged. |
| REFACTOR_REQUIRED | Duplicate Bitbucket reference parsing and repeated credential reads: one private reference parser and one credential resolution per REST operation. No cross-operation credential cache; rotation takes effect on the next call. |
| REFACTOR_REQUIRED | Repeated repository/workspace reads: combined assignment/owner/scope query, direct per-repository workspace lookup, joined recovery lookup and single-query agent-directory resolution. All post-provisioning permission/fencing checks remain. |
| REFACTOR_REQUIRED | Repeated fetch/connection argument construction: shared locally within provisioning; locking, validation before/after fetch, interrupted clone handling and authentication remain unchanged. |
| REFACTOR_REQUIRED | Auxiliary completions imported the large agent orchestrator for metrics, creating a runtime import cycle: moved pure metrics to `agent/metrics.ts`; established `claude.ts` exports remain available. |
| REFACTOR_REQUIRED | Answer persistence made one UPDATE per question: one batch UPDATE per locked run, in the same transaction, followed by unchanged step/resume logic. |
| REFACTOR_REQUIRED | Independent verifier upstream filtering deleted/reassigned properties unnecessarily: directly use the existing filtering function's result. |
| REFACTOR_REQUIRED | Repository list fetched index status only rendered on detail pages: make that request conditional on detail navigation; remove the one-use legacy label wrapper. |
| REFACTOR_REQUIRED | Test bootstrap forcibly dropped a fixed database: create unique local test databases without dropping/reusing existing databases. |
| COMPATIBILITY_REQUIRED | Legacy repository paths, overrides, configured-source discovery, explicit migration, fixture storage and worktree/session recovery remain required by live data. Retained. |
| COMPATIBILITY_REQUIRED | Workflow versions, DAG transitions, executor registry, Git provider seam, checkpoint/recovery policies, idempotency, audit/event contracts, RBAC and instance/job fencing have live or runtime call sites. Retained. |
| COMPATIBILITY_REQUIRED | Codex `hook.ts` is launched by a configured filename; browser ambient `env.d.ts` is compiler-loaded. Neither is dead despite lacking a normal import edge. |
| COMPATIBILITY_REQUIRED | Provider-specific stream parsers, cancellation/process groups, credentials, approvals and sandbox differences cannot be unified safely as a cleanup. Retained. |
| UNCERTAIN | Dynamic CSS classes, dynamic translation families, infrequent configuration, unmeasured index usage and historical operational documents are not proven unused. Retained. |

Both TypeScript configurations now enforce `noUnusedLocals` and `noUnusedParameters` to prevent recurrence.

## Live compatibility assessment (read-only)

Two inspections used explicit PostgreSQL READ ONLY transactions and returned aggregates only:

- 26 repository rows; all 26 have NULL `repository_url`; no local/benchmark provider rows in this live registry.
- 2 nonterminal runs have legacy repositories in their allowed scope.
- 16 persisted execution-workspace records reference legacy repositories; none belongs to a nonterminal run at inspection time.

These are blockers to removing legacy resolution/discovery/migration support. Administrators must review and configure existing canonical URLs and account for historical/resumable runs first. Cleanup does not run the migration CLI or rewrite any repository record. Historical SQL migrations and historical validation reports remain immutable. No production credentials or user files were changed/deleted.

A read-only EXPLAIN of the joined workspace lookup returned a nested loop with sequential scans on this small live dataset. This is not evidence that indexes are unused; no index or schema changes were made.

## Before and after: verified operation counts

| Operation | Before | After | Evidence |
| --- | --- | --- | --- |
| Personal-secret reads for new/update PR operation | 6 (operation + two request resolvers) | 2 | Query-spy regression; both requests use the same owner and next operation sees rotation. |
| Personal-secret reads for PR listing | 4 | 2 | Query-spy regression. |
| Questions answered in one run | N UPDATE statements | 1 UPDATE | Two-question regression checks one statement, trimmed answers, answerer/timestamps, one completed attempt and duplicate-answer rejection. |
| Worker assignment + latest session directory | 2 SELECT statements | 1 SELECT | Query-spy regression restores a recorded legacy session directory. |
| Assignment + saved repository workspace | 2 SELECT statements | 1 joined SELECT | Existing isolation/remote mismatch/legacy resume tests exercise the joined lookup. |
| Initial workspace owner/scope checks | 2 SELECT statements | 1 SELECT | Same fields read together; separate checks after provisioning retained. |
| Index-status requests while on repository list/create drawer | 1 on mount | 0 | Real Chromium browser smoke; requests resume on detail navigation. |

These are query/request-count improvements, not measured production latency or throughput claims. No cache, queue or concurrency infrastructure was added. Cache invalidation generations, transaction write tracking, cross-process notifications and deferred event persistence are unchanged.

## Validation

- Baseline typecheck and build: passed.
- Baseline application test suite: 385 passed, 0 failed, using a private non-destructive bootstrap with the same test command/options and original application code. The old `npm test` bootstrap would DROP the existing fixed `platform_test` database and was not executed against it.
- Stage 1: 54 agent/Codex/localization/repository tests passed.
- Stage 2: 100 engine/repository/instance/cache tests passed.
- Stage 3: 25 repository/code-intelligence workflow tests passed.
- Final `npm run typecheck`: passed with both unused-code checks enabled.
- Final `npm run build`: passed.
- Chromium repository UI smoke: passed, including URL normalization/registration, missing-credential behavior, instance-local status, controls and detail-only index-status requests. Theme, responsive styles and Vietnamese/English catalogs remain in place.
- Final `npm test`: **387 passed, 0 failed, 0 skipped** (293.5 seconds).
- `git diff --check`: passed.

The normal test bootstrap now creates `platform_test_<uuid>` on local PostgreSQL; it refuses remote PostgreSQL and never drops/resets an existing database. Fresh test databases are retained for inspection. No existing test was removed. Tests require no real Bitbucket token or paid agent call.

## Remaining technical debt and intentional deferrals

- High priority operational blocker: review/apply the existing repository migration for the 26 legacy registry rows before retiring compatibility; preserve ownership and historical workspace recovery.
- Medium priority: provider-specific environment, cancellation and sandbox contracts remain distinct. Further consolidation needs provider-specific failure/security fixtures rather than a generic runner rewrite.
- Medium priority: larger UI/engine files and pinned-knowledge version queries remain candidates for focused follow-up work. Their persisted behavior, authorization and version semantics need dedicated evidence before broad changes.
- Deferred for lack of evidence: index deletion, cache strategy changes, dynamic CSS/translation removal, historical migration/document removal and unused-dependency claims.
- Test artifact retention: uniquely created test databases intentionally remain for inspection under the no-reset/no-data-deletion constraint; local test database lifecycle cleanup is a separate explicit operation.
- Live Bitbucket, paid agent execution and native Windows/macOS smoke tests were not performed. Existing synthetic provider and evaluation fixtures remain the regression evidence. Shared OS accounts still do not provide OS security separation.

## Change statistics and exact files

- Runtime source (`src/` and frontend code): +125 / -151 lines; **26 fewer lines** overall, including the extracted metrics module.
- Regression tests and safe test infrastructure: +79 / -16 lines. No test cases removed; two added, with existing session/browser assertions extended.
- Whole patch including documentation/configuration: +366 / -173 lines across 45 files.
- Dependencies removed: **0** (all have demonstrated consumers). Modules removed: **0**; one pure metrics module added to remove orchestration coupling. Duplicate SSH translators consolidated from three implementations to one; duplicate Bitbucket reference parsers from two to one.

- `README.md`
- `docs/architecture/agent-architecture.md`
- `docs/architecture/repositories.md`
- `docs/validation/production-cleanup.md`
- `src/agent/claude.ts`
- `src/agent/codex/run.ts`
- `src/agent/complete.ts`
- `src/agent/metrics.ts`
- `src/agent/stepPrompt.ts`
- `src/api/routes.ts`
- `src/bitbucket.ts`
- `src/codeIntelligence/search.ts`
- `src/config.ts`
- `src/eval/fixtures.ts`
- `src/eval/runner.ts`
- `src/eval/service.ts`
- `src/eval/validator.ts`
- `src/git.ts`
- `src/git/changes.ts`
- `src/git/provider.ts`
- `src/prompt.ts`
- `src/repos/legacy.ts`
- `src/repos/paths.ts`
- `src/repos/remote.ts`
- `src/repos/service.ts`
- `src/repos/workspaces.ts`
- `src/workflow/context.ts`
- `src/workflow/engine.ts`
- `src/workflow/executors/builtin.ts`
- `test/auth-ui.browser.ts`
- `test/code-intelligence.bench.ts`
- `test/code-intelligence.test.ts`
- `test/codex.test.ts`
- `test/engine.test.ts`
- `test/evaluation.test.ts`
- `test/repositories.browser.ts`
- `test/repository-remotes.test.ts`
- `test/setup.ts`
- `tsconfig.json`
- `web/src/DESIGN.md`
- `web/src/api.ts`
- `web/src/i18n/catalog.ts`
- `web/src/pages/Integrations.tsx`
- `web/src/pages/Repositories.tsx`
- `web/tsconfig.json`
