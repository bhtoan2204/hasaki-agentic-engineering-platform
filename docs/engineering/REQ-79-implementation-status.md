# REQ-79 implementation status

This is a partial security and test-isolation increment. It does **not** satisfy the full approved T0–T6 plan or the initiative's acceptance criteria.

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

- T0: instrumentation and reproducible paired small/medium/large baselines, including query counts and provider/cache metrics.
- T1: full writer/consumer and access-control audit, revoked/support/cross-owner raw/metadata regressions, workspace traversal/symlink coverage, and browser execution tests. Current helper-level tests do not establish absence of stored XSS across the application.
- T2: scheduler profiling and measurement-justified query reductions with fencing, recovery and cancellation regressions.
- T3: context profiling and measured reuse/accounting improvements across providers.
- T4: opt-in isolated coding workspaces, ownership enforcement, durable admission, deterministic integration/recovery and DAG UI progress. Existing serial admission remains in effect.
- T5: feedback characterization and conservative fingerprint-backed preservation.
- T6: impact-aware verification, representative paired benchmarks and the final initiative report.

No scheduler, context, parallel-execution, feedback or performance improvement is claimed. No push, deployment, server restart or migration against the application database was performed.

Applied skills: test-driven-development (including writing-good-tests), verification-before-completion, and commit. The task's explicit convention to omit an unavailable function code takes precedence over the commit skill's generic request to obtain one.

## Fresh verification on e5874c3

The resumed execution context permits test-owned PostgreSQL. `node test/local-postgres.test.ts` passes (1/1), superseding the earlier socket-bind limitation for this context. `npm run typecheck`, `npm run build`, and `node --test test/artifact-security.test.ts test/markdown-security.test.ts` pass (5/5 security assertions).

`npm test` exits 1: 775 tests, 774 passed, one failed, zero skipped, 129043.296402 ms. The rewritten MySQL business-flow test passes. The sole failure is `codex argv: per-invocation config, sandbox by mode, no bypass flags, resume by explicit id` at `test/codex.test.ts:452`: its assertion rejects an npm cache path containing `ctp-agent-tmp`. It also fails when selected alone. `npmCacheDir` derives its path from `config.dataDir` (`src/git/provider.ts:24`); this outer coding context uses temporary directories with that name. The test and Codex implementation are unchanged from `origin/main`; this is baseline-file evidence, not a separately executed baseline suite. No test or sandbox policy was weakened.

Targeted ESLint on all nine changed TypeScript/TSX files exits 0 with zero errors and 14 warnings. Repository-wide `npm run lint` exits 1 with 1847 errors and 1404 warnings, including generated output. These results do not establish a clean full-suite or lint gate. Logs for this attempt are `/tmp/req79-current-tests.log`, `/tmp/req79-current-lint.log`, and `/tmp/req79-codex-check.log`.

The coding process has no nonempty DATABASE_URL (checked as a boolean without reading credentials). Whether the separate mandatory verification launcher now omits that variable remains unverified. The previous launcher refusal below is historical evidence. The full approved initiative remains incomplete; this verification refresh adds no performance or feature implementation.

## Verification repair 1: launcher environment refusal

The mandatory platform check returned exit 2 with `refusing verification: DATABASE_URL is set`. This is the first guard in the fixed shell command (`src/workflow/templates.ts:43`), before candidate code or tests execute. In this coding process, a boolean-only environment probe confirmed that DATABASE_URL is absent; executing that exact guard succeeded. Supplying a harmless sentinel reproduced the reported exit 2 without accessing any database.

The existing isolated command environment already deletes DATABASE_URL (`src/platform/selfDevelopment.ts:239`). The observed refusal establishes that the external verification shell received a nonempty variable; it does not identify the exact launcher call path responsible. The safe remediation is for the platform operator to ensure the verification child process starts with DATABASE_URL omitted, using its existing isolated environment construction, and rerun the unchanged command with test-owned local infrastructure. Application/test code in this candidate cannot run before the shell guard or change its parent environment. Editing the fixed verification scripts, weakening the guard, changing the running checkout, or restarting/deploying the platform is outside this task's authorization. No such change was made. This infrastructure failure remains unresolved and no mandatory-verification pass is claimed.
