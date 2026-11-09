# Phase 3 validation

Validated on **2026-11-08**, continuing from clean latest main **`061e964`** fetched from the requested repository.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, backend, tests and web |
| `npm run build` | Passed, production Vite build |
| Final full `npm test` | **423 passed, 0 failed, 0 skipped**, 268.18 seconds |
| Latest focused context/security integration tests | **13 passed, 0 failed** |
| Code-intelligence workflow + context regression checks | **18 passed, 0 failed** |
| Provider/knowledge compatibility checkpoint | **46 passed, 0 failed** |
| Context + Codex/Cursor compatibility checkpoint | **44 passed, 0 failed** |
| `git diff --check` | Passed |

The latest focused run includes the authorization-before-singleflight regression added during full-suite execution, as well as the final work-item fallback/visibility behavior. The full suite includes existing provider fixtures, actual shared-executor-to-Codex process tests, resumed worktree refresh, migrations, engine/scheduler recovery, RBAC, caching, analytics, evaluation and verification.

## Added integration coverage

`test/context-native.test.ts` validates:

1. Required context, owned knowledge versions, source provenance, explicit unavailable capabilities, token-estimate budget and immutable pack persistence/reuse.
2. Fail-closed budget exhaustion without silently shortening mandatory safety constraints.
3. Reexecution cannot pin another owner's private knowledge version.
4. Forged owner/run/step/mode/repository sets, wrong authenticated principal, expanded tool arguments, recursive workflow requests and stale generations are refused.
5. Knowledge visibility is rechecked; injected private content cannot enter returned results. Task memory without applicable trusted evidence is not invented.
6. A real PostgreSQL lock forces a bounded native read deadline; late completion produces no duplicate evidence record.
7. Clarification uses the workflow question store, is idempotent while open, blocks subsequent result mutation and is unavailable to read-only subagents.
8. Pack and unfinished-context data can be reconstructed from PostgreSQL alone; tools refuse a completed attempt.
9. Real Codex and Cursor stdio bridge processes advertise all twelve logical capabilities and retrieve the same owner-bound work item through an authenticated worker broker. Helpers receive no database environment. Claude-style direct shared dispatch returns the same resource.
10. Context/evidence inspection requires login, enforces owner isolation, and permits explicit audited admin support access only.
11. Provider child environments exclude database/platform/unrelated credentials while preserving only explicitly configured authentication for the selected provider; Codex does not inherit an API key.
12. Native symbol/definition/dependency calls reuse the existing real code index over a temporary Git repository; changed base files cause task-memory content to be withheld as `STALE`.
13. Context singleflight is authorized before reuse and cannot substitute one owner's pack for another identity.

Testing exposed and corrected two implementation regressions: regex redaction over encoded nested JSON could corrupt its syntax, and replacing the established validated snippet block broke existing code-intelligence workflow behavior. Structural redaction now preserves JSON; packs use `buildCodeContext` and retain the original untrusted snippet block, metrics, size cap and resume refresh. The unchanged code-intelligence workflow tests passed afterward.

## Reproduction

Tests use the repository's existing isolated PostgreSQL test setup. For the normal compose database:

```bash
npm run typecheck
npm run build
npm test
```

For an alternate isolated local admin endpoint:

```bash
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform npm test
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform \
  node --disable-warning=ExperimentalWarning --import ./test/setup.ts \
  --test --test-concurrency=1 test/context-native.test.ts
```

Validation used a temporary PostgreSQL 18.6 cluster on loopback port 55433. Each test file created a separate temporary database. Migration 031 was applied through the normal migration runner; existing upgrade/idempotence tests passed. The temporary cluster was stopped after validation. Repository compose defaults were not changed.

No paid model request, live Claude/Codex/Cursor account call, production scan, production lifecycle action, external notification, production migration, deployment, Git commit or remote push was performed. CLI transports are exercised with real local bridge processes and existing deterministic provider fixtures. Existing capability probes remain the runtime gate for installed CLI versions; no unsupported claim of live provider or context-quality improvement is made.
