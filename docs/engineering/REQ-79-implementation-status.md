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
