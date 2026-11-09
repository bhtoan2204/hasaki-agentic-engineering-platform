# Phase 1 validation

Validated on 2026-11-08, based on latest main `2504ee9` fetched from `https://github.com/bhtoan2204/hasaki-agentic-engineering-platform.git`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: backend and web TypeScript |
| `npm run build` | Passed: Vite production build |
| `npm test` with isolated local PostgreSQL | 396 passed, 0 failed, 0 skipped; 359.36 seconds |
| Targeted engine, telemetry, Codex and provider tests | 101 passed, 0 failed, including latest lifecycle clock changes |
| Provider validation after early resolved-model capture | 32 passed, 0 failed |
| Cursor collector regression and provider tests | 10 passed, 0 failed |
| Coverage/migration tests after final coverage changes | 4 passed, 0 failed |
| `git diff --check` | Passed |

The normal compose test port 55432 was unavailable. Validation used a new, isolated PostgreSQL 18.6 cluster under `/tmp/phase1-telemetry-pg` on loopback port 55433, with `TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform`. The existing test setup creates a separate temporary database per test file. No production database or provider account was used. The temporary cluster was stopped after validation.

The complete suite includes existing provider process fixtures, scheduler/engine recovery tests, RBAC tests, migration upgrades, Insights metric queries, verification, and container-isolated evaluation fixtures. New regression coverage includes partial/missing usage, explicit zero cost, optional cache/reasoning fields, repeated provider events, multiple model sessions, retries, stale-writer fencing, crash recovery, cancellation during execution and human waiting, interval union for overlapping tools, all normalized failure categories, redaction, shared Cursor collection, and audited admin metrics cache hits.

Migration 029 was applied through the normal migration runner in isolated databases; reapplying all migrations was a no-op. Historical migration files were not changed. Production rollout uses the existing application migration path. No dashboard, deployment, or remote repository write was performed.
