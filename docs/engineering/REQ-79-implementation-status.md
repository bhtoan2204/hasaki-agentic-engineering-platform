# REQ-79 implementation status

This is a partial security, test-isolation and component-measurement increment. It does **not** satisfy the full approved T0–T6 plan or the initiative's acceptance criteria.

## Implemented

- Raw artifact delivery reuses the existing authenticated route and `requireArtifact` access check in `src/http/app.ts`. A focused `artifactResponseHeaders` policy treats stored MIME as untrusted, permits only signature-matching PNG/JPEG/GIF/WebP inline, downloads other binary content as octet-stream, normalizes filenames, and sets no-store, nosniff and sandbox CSP headers. Text remains plain text. PDF inline preview is intentionally disabled.
- React Markdown extends the existing marked renderer through a private `Marked` instance in `web/src/markdown.ts`. Raw HTML remains escaped; explicit URL policy rejects executable, encoded and control-character schemes for links and images. Safe HTTP(S), relative references and mailto links remain usable.
- `test/setup.ts` starts and stops its own private PostgreSQL cluster over a temporary Unix socket. It ignores externally supplied database endpoints. Startup errors include server diagnostics and unused subprocess stdin is ignored.
- The opt-in external MySQL test in `test/project-databases.test.ts` is rewritten using the existing `setDatabaseDriver` seam. It retains SQL-literal preservation, row-cap propagation, masking, write-privilege warnings, rejection before driver invocation, and query-error behavior. Actual MySQL transaction enforcement and schema discovery against a server are no longer asserted by this test. Existing mock-based authorization and status tests remain.

## Reuse decisions

Extend the current route and renderer instead of replacing the HTTP or Markdown stack. Existing authorization remains the policy owner. The classic artifact modal in `public/app.js` escapes artifact content. Extend the existing test preload and database-driver injection seam rather than introducing another runner or database abstraction. Relevant locations: `src/http/app.ts:184`, `web/src/ui.tsx:71`, `public/app.js:1009`, `src/integrations/database.ts:431`, and `test/project-databases.test.ts:247`.

## Verification evidence and limits

- The supplied host log `/tmp/req79-host-tests.log` records 775 tests, 774 passes, zero failures, one existing MySQL skip, and 133091.60008 ms. This log covers the preserved eight-file increment **before** the external MySQL test rewrite. It is host evidence, not an in-sandbox test run, and provides no before/after performance comparison.
- In the coding sandbox, typecheck, frontend build and the five pure artifact/Markdown assertions passed. Targeted ESLint has no errors; existing any warnings remain. Full `npm test` fails at PostgreSQL startup because Unix socket binding returns `Operation not permitted`; all 80 files fail in preload before business assertions. No sandbox or authorization setting was changed.
- Repository-wide lint has a known baseline backlog, including generated frontend output. No lint rules were suppressed and no tests were skipped to obtain a pass.
- The final revision, including the MySQL rewrite, requires the platform's separate isolated verification process. The earlier host log must not be represented as verification of that later rewrite.
- The original security implementation is preserved from earlier attempts. Its test-first failure evidence was not re-established here; only current passing behavior was checked. The MySQL rewrite changes test isolation only and adds no production behavior.

## Remaining approved work

- T0 remaining: pool-wait separation and approved live-provider measurements. Each component sample now retrieves context for a disposable run, claims that queued job, heartbeats the lease and recovers the expired lease, in addition to the idle-claim and in-memory planning baselines. These fixtures are not end-to-end engineering-task performance.
- T1: full writer/consumer and access-control audit, revoked/support/cross-owner raw/metadata regressions, workspace traversal/symlink coverage, and browser execution tests. Current helper-level tests do not establish absence of stored XSS across the application.
- T2: complete. Idle claims issue one statement; handoff reconciliation shares in-flight scans; heartbeat combines lease extension and stopping-handoff checks into a single atomic SQL statement.
- T3: context profiling and measured reuse/accounting improvements across providers.
- T4: opt-in isolated coding workspaces, ownership enforcement, durable admission, deterministic integration/recovery and DAG UI progress. Existing serial admission remains in effect.
- T5: feedback characterization and conservative fingerprint-backed preservation.
- T6: impact-aware verification, representative paired benchmarks and the final initiative report.

No context, parallel-execution, feedback, or wall-clock performance improvement is claimed for the security and measurement increments above. The T2 section records a later query-count change only. No push, deployment, server restart or migration against the application database was performed.

Applied skills: test-driven-development (including writing-good-tests), verification-before-completion, and commit. The task's explicit convention to omit an unavailable function code takes precedence over the commit skill's generic request to obtain one.

## Fresh verification on e5874c3

The resumed execution context permits test-owned PostgreSQL. `node test/local-postgres.test.ts` passes (1/1), superseding the earlier socket-bind limitation for this context. `npm run typecheck`, `npm run build`, and `node --test test/artifact-security.test.ts test/markdown-security.test.ts` pass (5/5 security assertions).

`npm test` exits 1: 775 tests, 774 passed, one failed, zero skipped, 129043.296402 ms. The rewritten MySQL business-flow test passes. The sole failure is `codex argv: per-invocation config, sandbox by mode, no bypass flags, resume by explicit id` at `test/codex.test.ts:452`: its assertion rejects an npm cache path containing `ctp-agent-tmp`. It also fails when selected alone. `npmCacheDir` derives its path from `config.dataDir` (`src/git/provider.ts:24`); this outer coding context uses temporary directories with that name. The test and Codex implementation are unchanged from `origin/main`; this is baseline-file evidence, not a separately executed baseline suite. No test or sandbox policy was weakened.

Targeted ESLint on all nine changed TypeScript/TSX files exits 0 with zero errors and 14 warnings. Repository-wide `npm run lint` exits 1 with 1847 errors and 1404 warnings, including generated output. These results do not establish a clean full-suite or lint gate. Logs for this attempt are `/tmp/req79-current-tests.log`, `/tmp/req79-current-lint.log`, and `/tmp/req79-codex-check.log`.

The coding process has no nonempty DATABASE_URL (checked as a boolean without reading credentials). Whether the separate mandatory verification launcher now omits that variable remains unverified. The previous launcher refusal below is historical evidence. The full approved initiative remains incomplete; this verification refresh adds no performance or feature implementation.

## Verification repair 1: launcher environment refusal

The mandatory platform check returned exit 2 with `refusing verification: DATABASE_URL is set`. This is the first guard in the fixed shell command (`src/workflow/templates.ts:43`), before candidate code or tests execute. In this coding process, a boolean-only environment probe confirmed that DATABASE_URL is absent; executing that exact guard succeeded. Supplying a harmless sentinel reproduced the reported exit 2 without accessing any database.

The existing isolated command environment already deletes DATABASE_URL (`src/platform/selfDevelopment.ts:239`). The observed refusal establishes that the external verification shell received a nonempty variable; it does not identify the exact launcher call path responsible. The safe remediation is for the platform operator to ensure the verification child process starts with DATABASE_URL omitted, using its existing isolated environment construction, and rerun the unchanged command with test-owned local infrastructure. Application/test code in this candidate cannot run before the shell guard or change its parent environment. Editing the fixed verification scripts, weakening the guard, changing the running checkout, or restarting/deploying the platform is outside this task's authorization. No such change was made. This infrastructure failure remains unresolved and no mandatory-verification pass is claimed.

## Independent review repair

- Reproduced the percent-encoded relative filename regression with a failing Markdown test. The URL policy now checks decoded relative references for disguised schemes while emitting the original encoded URL. `report%20final.pdf`, `plot%20one.png` and encoded Unicode filenames remain usable; encoded and nested executable schemes remain rejected. All six pure artifact/Markdown assertions pass.
- Added `test/artifact-security.browser.ts`, extending the existing `handle`, authentication, `requireArtifact`, `startRun` and test-owned PostgreSQL flows. Real HTTP requests check exact hostile artifact bodies, download/plain-text MIME, disposition, no-store, nosniff and sandbox CSP. Metadata and raw routes reject anonymous/other-owner callers, require explicit admin support, audit support access and reject revoked sessions.
- The same test starts its own HTTP server and Chromium. A positive control first demonstrates execution of the hostile payload. Protected HTML/SVG/PDF and falsely labeled PNG binaries download; textual HTML appears literally in an iframe without executable elements or an execution message. Both HTTP/browser tests pass. Run with `CHROMIUM_BIN=<locally provisioned Chromium> node --import ./test/setup.ts --test test/artifact-security.browser.ts`. This browser file follows the existing explicit `.browser.ts` convention and is additional to `npm test`.
- This worker's cached Playwright binary cannot load `libnss3.so`. The already provisioned Nix Chromium at `/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium` runs successfully; no packages were installed. Test fixtures initially needed correction because replacing a document removes its event listeners; the final positive control and protected-route assertions pass together.
- Fresh `npm test`: 776 tests, 775 passed, one failed, zero skipped (131734.16934 ms). The only failure remains the unchanged Codex cache-path assertion at `test/codex.test.ts:452`. The new Markdown regression passes. Log: `/tmp/req79-repair-tests.log`. Typecheck, build, targeted ESLint for this repair and `git diff --check` pass. The separate platform gate remains authoritative for baseline-aware classification; this local full-suite result is not reported as green.

Applied receiving-code-review, test-driven-development (writing-good-tests), verification-before-completion and commit guidance. This repair fixes the two review findings for the preserved increment; it does not implement the remaining initiative scope listed above. No tests were deleted or rewritten for remote infrastructure in this repair; the earlier harness/MySQL changes remain documented above.

## Full Regression retest

The returned regression-step history (`run.step_history`, `regression_test`, artifact 837) contains only a tail with 769 passes, five failures and two skips. It has no individual failure names or diagnostic blocks. A fresh original-context run reproduced only the previously documented Codex argv assertion (775 passes, one failure). The five unnamed historical failures cannot be individually classified from that evidence.

Corrected the Codex test fixture: its negative assertion rejected every ancestor directory named `ctp-agent-tmp`, although the outer coding environment legitimately puts the shared configured cache beneath such a directory. It now supplies a named invocation scratch directory and rejects that exact directory and its children as cache targets. The existing exact `npmCacheDir()` argument assertion remains. Provider configuration and sandbox/authorization behavior are unchanged. The same file's pre-existing comma-expression loop was expanded into equivalent statements to satisfy lint without suppressing the rule.

Fresh verification after the assertion correction:

- Clean environment with the current HOME: `env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 TMPDIR=/tmp PLATFORM_SELF_TEST=1 npm test` exits 0: 776 passes, zero failures/skips, 162876.612096 ms. Log: `/tmp/req79-isolated-retest.log`.
- Private empty HOME plus launcher Git isolation: the same command with a test-only HOME, `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0` exits 0: 774 passes, zero failures, two existing evaluation-container skips, 97081.259758 ms. The skipped tests are `six provider plans use durable attempts and equivalent pinned fixtures with objective validation` and `A/B/C isolates pack/tool access and paired comparisons reject multiple changing factors`; their locally started validation container is unavailable under that HOME. The unskipped run above covers both. Log: `/tmp/req79-launcher-retest.log`.
- All 24 tests in `test/codex.test.ts` pass, including the broker stream parser and invocation assertions. Log: `/tmp/req79-codex-retest.log`.
- `npm run typecheck` passes. ESLint on `test/codex.test.ts` has zero errors and 18 existing warnings. `git diff --check` passes.

No tests were removed or newly skipped. The Codex assertion correction is a test-fixture repair, not a remote-infrastructure rewrite; the earlier PostgreSQL/MySQL isolation changes remain listed above. No production code changed in this retest increment. These fresh passes supersede earlier local suite failures for the current candidate; they do not establish the cause of all five unnamed historical failures or completion of the broader REQ-79 plan.

## T0 measurement repair

Historical version-1 evidence follows. The version-2 report and current evidence in the final section supersede it; timings across fixture versions are not comparable.

The measurement omission is addressed with `platform-performance-v1` in the existing benchmark CLI. Reuse decision: extend `src/cli/bench.ts` rather than add a second command framework; call the existing `claimJob` (`src/workflow/scheduler.ts:58`), `planKnowledge` (`src/context/plan.ts:65`), `renderContextPack` (`src/context/pack.ts:867`), `estimateTokens` and `noteToolUse` (`src/agent/metrics.ts:90`). Reuse the versioned evaluation's `sha256` utility. The existing `backend-v1` evaluation remains unchanged, including its live-provider restrictions. Its task-quality comparisons and this narrowly scoped component baseline answer different questions.

Run from the worktree with installed dependencies and local PostgreSQL binaries on PATH:

```sh
node --import ./test/setup.ts src/cli/bench.ts --suite=platform-performance-v1 --baseline-ref=origin/main --repetitions=5 --output=docs/engineering/REQ-79-performance-baseline.json
```

The CLI refuses to run without the test-owned preload's database name, flag and private Unix socket. It exports only committed source/migration/package files from the pinned Git revision into a temporary directory inside the authorized worktree, then removes it. No primary checkout is executed or modified. Both source subjects use the candidate's installed dependencies, one process, one disposable database and serial execution. There are three warm-ups, five alternating paired warm repetitions per size, plus explicitly labeled first-use samples. These are component workload sizes, not completed engineering tasks or independent cold-process runs.

The committed JSON report compares baseline `68d360020081864e39c42055eee0df50086a3511` with candidate `4058f8cbb896ff2bc1ab0fc60bd92ba890568389`. It records fixture/harness/preload/lockfile hashes, both source trees and measured-module hashes, Node v22.23.2, PostgreSQL 18.6, OS/CPU information, raw samples and paired median/p95 distributions. Every pair has matching output hashes. The five measured production modules are byte-identical between subjects: this is an unchanged-code control, and timing variation demonstrates why no speedup is claimed.

| Fixture | Knowledge items / context entries / idle claims | Baseline warm median / p95 (ms) | Candidate warm median / p95 (ms) | SQL calls, both subjects |
| --- | --- | --- | --- | --- |
| small | 10 / 8 / 2 | 4.026 / 4.413 | 3.966 / 4.969 | 4 |
| medium | 100 / 80 / 8 | 14.854 / 17.052 | 16.178 / 19.547 | 16 |
| large | 1000 / 800 / 32 | 63.412 / 70.081 | 61.036 / 67.525 | 64 |

The measured idle claim path makes two SQL calls per claim in both revisions. This is concrete baseline evidence for investigating claim/handoff overhead, not justification to remove reconciliation without recovery tests. Each sample also calls `resolveContext` on a disposable run, claims that queued job, extends the lease with `heartbeat`, then expires it and runs `reapExpiredLeases`. Numeric phase timings cover knowledge planning, context rendering, serialization, token estimation, tool accounting, idle claiming, context retrieval and the active scheduler path. Query counts/failures and elapsed time contain no SQL, parameters or prompts. Query time includes pool acquisition. Context retrieval and lease recovery use transactions, so those client queries are in their phase timings and are not all present in `pool_query_calls`. Separate pool wait is unavailable. Token estimates refer to the serialized fixture payload, not actual provider usage. Provider latency, input/output/cache tokens and cost remain null. Repeated-read counts come from synthetic tool events through the existing metrics implementation. Cancellations and live providers remain outside this component baseline. The candidate revision is recorded only when `git status` is clean, aside from the harness snapshot directory, and every measured module on disk matches that commit. Uncommitted candidate behavior is refused instead of being labeled HEAD.

Verification: all three new measurement tests pass (including an observed failing even-sample median assertion before correction); `npm run typecheck`, build and changed-file ESLint pass (zero lint errors, nine existing warnings in the legacy benchmark CLI). Final full suite: 779 passed, zero failed/skipped, 142672.52008 ms; log `/tmp/req79-performance-final-tests.log`. The benchmark command passes with 18 matched pairs. No remote-infrastructure tests were added, rewritten or deleted in this measurement repair. Earlier PostgreSQL/MySQL isolation changes remain documented above. The additional report/documentation commit changes no executable code.

## Representative persisted context retrieval repair

The review finding was reproduced: the earlier probe retrieved zero fixture knowledge. The strengthened regression failed with `0 !== 10` before the probe changed. The probe now extends the existing `buildStepInput` and `resolveContext` flows rather than constructing an empty input. Every sample persists owner-private knowledge and versions with repository/project/workflow scopes, assigned skills and knowledge, local repository registry entries and read grants, completed ancestor outputs and answered questions. An extra explicitly requested repository-scoped item has no read grant and must be excluded. No hosted remote, provider request or business repository is involved.

Fixture version 2 varies every relevant input dimension:

| Size | Retrieved fixture knowledge | Accessible repositories | Persisted upstream outputs | Persisted answers |
| --- | --- | --- | --- | --- |
| small | 10 | 2 | 8 | 2 |
| medium | 100 | 8 | 80 | 8 |
| large | 1000 | 32 | 800 | 32 |

Each measurement asserts these retrieved dimensions and hidden-item exclusion. A normalized content/upstream digest participates in baseline/candidate output equality, excluding random fixture identifiers. Setup and cleanup use the existing `q` write notifications for knowledge/repository cache invalidation. The test checks all three sizes and verifies disposable owner/run cleanup. Fixtures are removed after every sample. New owners deliberately exercise candidate retrieval for each sample; warm repetitions describe warmed process/database resources, not reuse of the same owner's cached context.

Fresh report: `docs/engineering/REQ-79-performance-baseline.json`, baseline `7cf114566c6020286c6b2b0eecd630ca4c4d1cb8`, candidate `8f711659bddf8b76ea472a4027937fb695d015b7`. The local origin/main ref advanced since the historical report; the command pins and records the actual revision it uses. All 18 pairs have matching outputs, including five warm repetitions per size. Warm wall-time medians (baseline/candidate ms) are small 22.584/24.454, medium 45.052/47.541 and large 391.687/390.985. These are component fixture observations, not a speedup claim. Persistence/cleanup is included in wall time; `context_retrieval_ms` covers input construction and resolution inside the transaction. Transaction client SQL is not fully counted by the pool-query observer, as the report states. Separate pool wait and live-provider metrics remain unavailable.

The harness hash now includes `performanceProbe.ts` as well as the CLI and measurement helpers. Benchmark source commit: `8f71165`. Verification on the current implementation: five targeted tests pass; typecheck, build, changed-file ESLint and diff whitespace checks pass. Full suite: 781 passed, zero failed/skipped, 153272.066135 ms (`/tmp/req79-representative-tests.log`). The paired benchmark command above succeeds. The only rewritten test in this repair is the existing scheduler/context probe test, replacing the empty retrieval assertion with exact size, visibility and cleanup checks. It continues to use test-owned local PostgreSQL; no remote-infrastructure test was added or removed. This report/documentation update changes no executable code. Broader REQ-79 acceptance remains incomplete.

## T2 handoff reconciliation

The version-2 baseline measured two pool statements per direct `claimJob` call. The extra statement was `processAutomaticHandoff` scanning for a due row before every claim, including idle claims that find nothing. Eight idle claims failed the new count at `16 !== 8` before the scan was removed from `claimJob`. After the change those eight claims issue eight statements.

`claimJob` now only claims. `reconcileAutomaticHandoff` performs the existing one-row `SKIP LOCKED` scan. Concurrent callers share the scan already in flight: two overlapping calls issue one statement, and the next call after that scan settles issues another. Nothing about the handoff row is cached. `runOnce` and `drain` call that reconciliation before claiming, so manual and test execution still resumes a due automatic handoff and then claims the continuation. Each scheduler lane does the same before its claim, and the existing lease reaper triggers it as well, so a due handoff is still visited while every worker is inside a job. A single idle lane therefore still does one scan plus one claim per poll. Lanes that poll together share the scan instead of repeating it. The historical JSON report is the before measurement and was not regenerated. No wall-clock speedup is claimed.

Fresh checks on this increment: `npm run typecheck` passes. ESLint on the changed TypeScript files reports zero errors and the pre-existing `any` warnings. `npm test` exits 0: 786 passed, zero failed, zero skipped, 117110.338125 ms. The new tests use the test-owned PostgreSQL preload. No remote-infrastructure test was added, rewritten, or deleted. Heartbeat query shape, fencing, and recovery semantics are unchanged. T3–T6 and the remainder of T2 above are still open.

## T2 heartbeat query optimization & detached process termination test fix

The heartbeat lease renewal previously issued two sequential queries per tick: one `UPDATE workflow_jobs` to extend the lease and a second `SELECT id FROM provider_handoffs WHERE source_attempt_id=$1 AND status='STOPPING'` to check if a handoff was requested.

`heartbeat` in `src/workflow/engine.ts` now accepts an optional `attemptId` and evaluates stopping status in the same atomic `UPDATE` statement: `($6::int IS NULL OR NOT EXISTS (SELECT 1 FROM provider_handoffs h WHERE h.source_attempt_id = $6 AND h.status = 'STOPPING'))`. If a handoff is stopping, the lease is not renewed and `heartbeat` returns `false`, triggering `ac.abort()` in `src/workflow/scheduler.ts` without an extra database round-trip.

In `test/codex.test.ts`, the process termination check was corrected to inspect `/proc/${pid}/stat` state. When a detached child process is killed with `SIGKILL` in a Linux container where init does not immediately reap reparented children, the process enters state `Z` (Zombie/terminated). `kill(pid, 0)` in Linux continues to find zombie descriptors until reaped; checking the process state confirms the process has terminated.

Verification on this increment:
- `npm run typecheck` passes (tsc . & tsc web).
- ESLint on modified files reports zero errors.
- Targeted tests `test/scheduler-efficiency.test.ts` (3/3), `test/codex.test.ts` (24/24), `test/provider-handoff.test.ts` (16/16), and `test/workflow-reliability.test.ts` (9/9) pass.
- Full test suite `npm test`: 785 passed, zero failed, two skipped (135703.85 ms).

## Verification repair: test build cache and home directory isolation

When targeted verification executes tests for `src/workflow/engine.ts`, `test/engine.test.ts` runs integration tests using real `go test` and `git` commands against a temporary repository. In restricted test runner environments where `$HOME` points to an unwritable or nonexistent directory, `go test` failed before package compilation with `failed to initialize build cache: mkdir /...: read-only file system`, which caused baseline comparison in `src/workflow/executors/builtin.ts` to report no parseable failures (`(exit 1, no go test failure to compare)`).

`test/setup.ts` now isolates `$HOME`, `$GOCACHE`, and `$GOPATH` to dedicated subdirectories inside the test's temporary root (`root`), ensuring that tool cache initialization succeeds independently of host/runner filesystem restrictions.

Targeted verification command (144 tests) passes with 0 failures under restricted `HOME=/nonexistent`.
