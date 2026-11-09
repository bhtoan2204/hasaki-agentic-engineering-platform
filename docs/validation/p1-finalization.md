# P1 finalization — development validation

P1 is enabled and verified in the existing development environment. This report supersedes the earlier fixture-only validation for the checks below. No production deployment, remote push, or live paid AI execution was performed.

## Completion checklist and file evidence

| Requirement | Initial assessment | Final assessment | Evidence |
|---|---|---|---|
| Go / TypeScript / TSX / Proto / SQL parsing | PARTIAL: grammar-load failures were cached permanently | PASS | `src/codeIntelligence/parser.ts:78`; parser fixtures; retry/error test in `test/code-intelligence-failures.test.ts`; all five language variants indexed on real checkouts |
| Migration 026 / PostgreSQL compatibility | PASS | PASS | `migrations/026_code_intelligence.sql`; configured RDS migration checksum matched; migration runner returned no pending migrations; isolated migration tests passed |
| Immutable base snapshots / worktree overlays | NOT VERIFIED on real repositories | PASS | `src/codeIntelligence/store.ts` effective union and atomic publication; two real disposable worktrees on `oms-api` |
| Incremental cache / freshness | NOT VERIFIED outside fixtures | PASS | `src/codeIntelligence/indexer.ts`; `src/codeIntelligence/git.ts`; unchanged warm snapshots reused, live edits invalidate overlay and trigger fallback |
| Symbol / dependency search | PARTIAL: early path hits could hide later definitions | PASS | `src/codeIntelligence/search.ts:192`; candidate-safe relation lookup; regression test with early path distractors and later exact definition |
| Hybrid ranking affects selection | PARTIAL: earlier fake executor did not prove prompt integration | PASS | `src/workflow/executors/builtin.ts`; real scheduler→discovery output→selected repository tested; three actual repository scenarios below |
| Agent context reaches execution | NOT VERIFIED at provider boundary | PASS with CLI fixture; live model NOT VERIFIED | `src/agent/claude.ts:347`, `:348`, `:496`; `test/code-intelligence-workflow.test.ts` invokes the actual shared executor, provider hook, broker/MCP and Codex subprocess fixture, capturing final stdin |
| ripgrep fallback | PARTIAL: fresh index with no definition returned no source fallback | PASS | `src/codeIntelligence/search.ts:137`, `:350`; fresh-index literal search and missing-`rg` tests; startup warning in `src/startupValidation.ts` |
| Background execution / concurrency / recovery | PARTIAL: await-before-reservation race and timestamp precision risk | PASS | `src/codeIntelligence/indexer.ts:252`, `:258`, `:277`, `:311`; concurrency reserved before asynchronous ownership check, SQL timestamp watermark preserved exactly; expired-lease/cancellation tests |
| Disabled feature compatibility | NOT VERIFIED through actual provider executor | PASS | Real executor test completes with the feature off and no code-context block; dependency API also returns no indexed edges when disabled |
| UI/API integration | PARTIAL: no authenticated P1 API test | PASS API/build; interactive browser NOT VERIFIED | `test/authz.test.ts` authenticates admin/member, checks 401/403, status, reindex, cancel, disable; existing repository detail card builds successfully |
| Development startup / instance conflict | FAIL for reported startup attempt | PASS | `docs/validation/p1-server-smoke.json`: actual `src/server.ts` health 200, anonymous index-status 401, graceful exit 0 |

## Development configuration and migration state

The user explicitly confirmed that the configured AWS RDS `claude_task_platform` database is development and authorized P1 writes there. Its identity was queried from PostgreSQL before writes. Local test databases remained on the existing localhost PostgreSQL service; no infrastructure was added.

- Active configuration: ignored local `config.json`, `codeIntelligence.enabled: true`.
- Code default in `src/config.ts` and example in `config.example.json`: still `false`.
- `.env` database settings and credentials were not changed or copied into this report.
- Existing migration 026 was already applied. Its stored checksum matched the local file. `migrate()` returned `[]`; no migration history or existing data was rewritten.
- Development indexing runs completed and persisted published snapshots. Counts are reported below.

The reported instance conflict was the existing duplicate-instance guard, not a migration failure. The observed row had a stale heartbeat and no active server process; normal lease acquisition subsequently succeeded. The instance ID and ownership protections were preserved. `src/instances.ts:29` now reports a retry countdown instead of leaving a recently restarted user without timing guidance. Validation released its lease; the actual development-server smoke test then started and stopped cleanly. The server is not intentionally left running by this task; start the enabled installation with `npm run serve` (or `npm start` to rebuild first).

## Real registered repositories

Only registered, readable local checkouts were indexed. Business source in primary checkouts was compared before/after and remained unchanged. Two detached, disposable worktrees were created through Git, associated with owner-scoped disposable workflow records, and removed in `finally`. Their workflow runs were canceled; any remaining queued indexing requests from the validation runs were canceled with fencing. No real coding jobs were executed during the server smoke: the queue was checked first and was empty.

| Repository | Indexed files | Languages | Symbols | Relations | Initial indexing duration |
|---|---:|---|---:|---:|---:|
| oms-api | 523 | go (514), proto (7), sql (2) | 6192 | 37023 | 6.359 s |
| oms-frontend | 608 | tsx (334), typescript (274) | 1740 | 18120 | 4.742 s |
| oms-background | 591 | go (588), proto (3) | 6719 | 44557 | 8.293 s |

Real checks passed: known function/type lookup, syntax relationship retrieval, modified untracked probe replacement, renamed-file location replacement, deleted-symbol removal, stale fallback, unchanged base snapshot, two concurrent isolated worktrees, and feature disable. Probe files contained only synthetic Go declarations. Detailed evidence and run/snapshot metadata are in `p1-real-repositories-initial.json` and `p1-real-repositories.json`.

## Actual workflow proof

`test/code-intelligence-workflow.test.ts` does not replace the shared agent executor. It registers `claudeExecutor` for analysis and coding, the real discovery executor, and executes the durable scheduler using the existing Codex CLI fixture. It proves:

1. Metadata-only ranking initially ties and chooses repository A; indexed symbol evidence selects repository Z through the real discovery output and workflow state transition.
2. The final Codex subprocess stdin contains the retrieved worktree source block, commit, correct path and `:2-2` line range.
3. Repeated evidence does not duplicate source-range provenance, and retrieval respects the configured character/token estimate budget.
4. After an agent question pauses execution, a worktree edit invalidates the old overlay. The resumed *same thread* receives the new source (`return 2`) in its new code-context block, not the stale source (`return 1`).
5. Disabling P1 preserves workflow completion and removes the context block.
6. Missing ripgrep, missing definitions, invalid syntax, oversized source, permissions, parser load failure/recovery and concurrency are covered by additional tests.

Live Claude/Codex reasoning quality, paid-provider usage and real tokenizer counts remain **NOT VERIFIED**. The fixture's synthetic token counters are not treated as live measurements. No claim of token savings is made.

## Representative development RDS measurements

Each real scenario uses the same three candidate repositories. Names below are actual indexed symbols; the expected source repository was verified by exact definitions in its snapshot. Timings are single observations including development RDS/Git validation overhead, not latency percentiles or production guarantees.

| Symbol | Expected repository | Metadata top | Hybrid top | Metadata time | Hybrid time |
|---|---|---|---|---:|---:|
| `app.NewAuthHandlerMap` | oms-api | oms-api | oms-api | 0.11 ms | 925.90 ms |
| `useGetMe` | oms-frontend | oms-api | oms-frontend | 0.32 ms | 1019.76 ms |
| `http.handleErr` | oms-background | oms-api | oms-background | 0.12 ms | 1105.89 ms |

In these three scenarios metadata selected the expected source in 1/3 cases and hybrid ranking in 3/3. This is a small, symbol-navigation sample, not general task-selection accuracy. Hybrid retrieval adds database/Git work and is slower than metadata-only ranking.

| Repository | Validated symbol lookup | Retrieved context | Context retrieval | Unchanged warm reindex |
|---|---:|---:|---:|---:|
| oms-api | 243.73 ms | 1643 characters | 795.35 ms | 90.52 ms |
| oms-frontend | 271.89 ms | 4169 characters | 4424.38 ms | 108.39 ms |
| oms-background | 294.45 ms | 671 characters | 1580.28 ms | 121.54 ms |

Before P1, these workflows had no code-intelligence source block. The measured character counts above are added bounded source context, not a comparison against a hypothetical whole-repository prompt. Approximate token budgeting uses the existing four-characters-per-token convention. Full before/after live prompts and billing are NOT VERIFIED. Initial and warm indexing measurements are kept separate so cached runs are not presented as initial indexing performance.

## Final quality gate

- Typecheck: PASS (backend and frontend).
- Production Vite build: PASS.
- Full regression suite: 353 passed, 0 failed, 0 skipped.
- Separate focused P1 plus migration run: 27 passed, 0 failed, 0 skipped.
- Real repository integration: PASS on development RDS; two concurrent disposable worktrees cleaned up.
- Actual server startup/shutdown: PASS; health 200, protected API 401 anonymously, exit 0.
- Prettier check on new feature modules, developer CLI and new focused tests: PASS.
- `git diff --check`: PASS.

An intermediate run failed because a new error-class constructor used TypeScript parameter properties unsupported by Node 22 strip-only mode. This was fixed with an explicit field assignment; the complete suite was rerun successfully. No tests were skipped or weakened. Tests use `TMPDIR=/var/tmp` in this environment to preserve the pre-existing instance-identity guard against Git-controlled temporary directories.

## Remaining limits

- Candidate relationships are syntax evidence, not compiler/LSP resolution; SQL remains the bundled grammar's supported subset.
- Retrieval is bounded and can truncate supporting results. Production-scale load, broad task-selection accuracy and live AI/token/billing behavior are not verified.
- Historical base snapshots and unused parse artifacts still lack automatic GC; completed-run overlays retain the implemented retention policy.
- Interactive browser rendering was not exercised; authenticated API behavior, the existing UI component integration and the production build were verified.
- The smoke test confirms development startup, not production deployment readiness. Production defaults remain off. Nothing was deployed or pushed.

## Files and working tree

Files changed specifically in this finalization: `config.json` (ignored, local enablement), `src/instances.ts`, `src/startupValidation.ts`, `src/codeIntelligence/{parser,indexer,search}.ts`, `test/authz.test.ts`, `test/code-intelligence-{workflow,failures}.test.ts`, `src/cli/validate-code-intelligence.ts`, `package.json`, `README.md`, and the evidence files in `docs/validation/`.

The pre-existing P1 changes remain uncommitted/untracked on `main`; they were not discarded or committed. No remote changes were pushed. Complete current file inventory (tracked modifications plus new files):

- `README.md`
- `config.example.json`
- `docs/architecture/code-intelligence-benchmark.json`
- `docs/architecture/code-intelligence.md`
- `docs/validation/p1-finalization.md`
- `docs/validation/p1-real-repositories-initial.json`
- `docs/validation/p1-real-repositories.json`
- `docs/validation/p1-server-smoke.json`
- `migrations/026_code_intelligence.sql`
- `package-lock.json`
- `package.json`
- `src/agent/claude.ts`
- `src/agent/toolRegistry.ts`
- `src/api/routes.ts`
- `src/cli/validate-code-intelligence.ts`
- `src/codeIntelligence/git.ts`
- `src/codeIntelligence/indexer.ts`
- `src/codeIntelligence/parser.ts`
- `src/codeIntelligence/search.ts`
- `src/codeIntelligence/store.ts`
- `src/config.ts`
- `src/git/provider.ts`
- `src/instances.ts`
- `src/server.ts`
- `src/startupValidation.ts`
- `src/workflow/executors/builtin.ts`
- `src/workflow/scheduler.ts`
- `test/authz.test.ts`
- `test/code-intelligence-failures.test.ts`
- `test/code-intelligence-parser.test.ts`
- `test/code-intelligence-workflow.test.ts`
- `test/code-intelligence.bench.ts`
- `test/code-intelligence.test.ts`
- `web/src/pages/Repositories.tsx`

`config.json` is intentionally absent from Git status because it is ignored. Re-run development validation with `npm run validate:code-intelligence -- claude_task_platform`; the command verifies database identity before writes and cleans up its disposable worktrees.
