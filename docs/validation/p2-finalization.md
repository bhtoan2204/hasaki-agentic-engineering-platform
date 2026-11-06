# P2 implementation and validation

Validated on main based on `20cd7ba`, 2026-11-07 Asia/Bangkok. All changes remain uncommitted. No remote push, deployment, production checkout, production API, real PR or paid model invocation occurred. P2 database execution used **local** `platform_test` and `platform_bench`; migration 027 was not applied to the RDS development installation.

## Completion status

| Capability | Status and evidence |
| --- | --- |
| Existing architecture reused | Implemented: existing DAG integration steps, PostgreSQL job leases, checkpoints, approval/resume, metrics, artifacts, repository registry, P1 ranking/context and Insights. [Audit](../architecture/p2-evaluation.md). |
| Versioned executable dataset | Implemented/tested: 15 synthetic cases, pinned Git commits and source/harness/runtime hashes. `dataset.ts`, `fixtures.ts`, database immutability tests. |
| Objective validators and scores | Implemented/tested: actual TypeScript compilation and behavior tests, hidden regressions, SQL/proto structure, capability/path restrictions, mandatory gates and versioned configurable weights. |
| PostgreSQL persistence | Implemented/tested locally: migration 027 plus existing `eval_results`; no new queue or database service. Fresh migrations, idempotence and history protection pass regression tests. |
| Durable runner | Implemented/tested: bounded existing scheduler execution, retries, restart recovery, cancellation, concurrent A/B worktrees, expired worker publication fencing and cleanup. |
| Human checkpoints | Implemented/tested: approval, clarification before changes, answer/resume with original pinned context. CLI reference controls explicitly script answers. |
| Real executor integration | Tested with deterministic Codex process fixture through the actual executor. Plausible no-change output fails independent validation. **Live models NOT VERIFIED; live execution BLOCKED.** |
| Baseline/candidate and regression gates | Implemented/tested: persisted compatible configurations, paired repetitions, critical gates, insufficient-data verdicts and cost/latency warnings. |
| P1 OFF/ON evaluation | Implemented/tested: actual ranking, context retrieval, changed-worktree freshness and direct-search fallback. No global flag mutations across concurrent runs. |
| Dashboard | Implemented/browser verified: persisted local runs #5/#6, paired PASS plus latency warning, private case evidence and artifact/workflow links. [Screenshot](p2-dashboard.png). Zero browser errors. |
| Cost/provider usage | Unknown metrics remain null; fixture provider cost is zero. No live usage, token savings or provider cost accuracy claim. |
| Production readiness | NOT VERIFIED: production migration/configuration, portable runtime adapter and live spending controls remain outstanding. |

## Dataset and origins

Suite: **backend-v1@3**, hash `a27305539405a6b94802e8924f13ad80ce778e061fc02bc54554e40d7c57ba2f`. All cases are labeled `synthetic`. Existing CLI examples, workflow tests and P1 fixtures inspired coverage, but none had sufficient provenance to claim a real completed historical task. No customer data or credentials were copied.

| Case | Objective coverage |
| --- | --- |
| BENCH-001 | Refund remaining quantities and over-refund clamp |
| BENCH-002 | Legal order transitions; reject backwards/skipped transitions |
| BENCH-003 | API currency mapping without private-field exposure |
| BENCH-004 | Parameterized SQL keyset pagination |
| BENCH-005 | Proto currency field tag; preserve existing RPC/fields |
| BENCH-006 | Shared proto and payment client updated together |
| BENCH-007 | Payment idempotency across duplicate/distinct keys |
| BENCH-008 | Newer-only event versions; duplicates/out-of-order safety |
| BENCH-009 | Money rounding including zero/negative regression checks |
| BENCH-010 | Clarify historical refund policy before edits, approve/resume |
| BENCH-011 | One batch lookup; preserve order/duplicate customer mappings |
| BENCH-012 | Failed transfer cannot partially mutate balances |
| BENCH-013 | Declared transient failure, existing scheduler retry/recovery |
| BENCH-014 | Select the correct refund repository among similar fixtures |
| BENCH-015 | Changed worktree context excludes old source; safe fallback |

Pinned repositories:

| Synthetic repository | Base commit |
| --- | --- |
| fixture-payment-service | `5cda97a16016aba453b7f828de618944a8d05335` |
| fixture-alpha-service | `1220b1d8d77475e9c1901d0e44ee3e7c50f7a9b0` |
| fixture-shared-proto | `11780d1986b858c0fd12a8a01fede220f83bad69` |

Complete task descriptions, allowed paths, expected behavior, frozen configurations, validation checks and paired repetition results are in [the measured JSON report](p2-benchmark.json). PostgreSQL holds full evidence and existing workflow artifacts retain bounded diffs/context. Dataset revisions 1/2 from development remain preserved; version 3 records the final harness.

## Measured comparison

Command: `TMPDIR=/var/tmp EVAL_REPORT=/tmp/p2-verified-report.json npm run bench -- --suite=backend-v1 --repetitions=2`.

Both configurations use **scripted reference implementations**, 15 cases × 2 repetitions each. Baseline: P1 OFF/context none. Candidate: P1 ON/symbol retrieval. Local database evaluation IDs 5/6, workflow IDs 5/6; both COMPLETED. The full raw local report remains `/tmp/p2-verified-report.json`; the repository JSON retains compact auditable results. Neither configuration invoked a live agent.

| Metric | P1 OFF | P1 ON |
| --- | ---: | ---: |
| Success / graded executions | 28/30 | 30/30 |
| Hard-gate pass rate | 93.3% | 100% |
| Wilson 95% success interval | 78.7–98.2% | 88.6–100% |
| Mean / median score | 95.67 / 100 | 100 / 100 |
| Score sample SD | 16.49 | 0 |
| Median duration | 1,449 ms | 2,342 ms |
| p95 duration | 2,019 ms | 3,486 ms |
| Duration sample SD | 389 ms | 626 ms |
| Repository accuracy | 93.3% | 100% |
| Average retrieved context | 0 characters | 260.6 characters |
| Median first correct file | 41 ms | 685 ms |
| Retry rate | 6.7% | 6.7% |
| Scripted human intervention rate | 6.7% | 6.7% |
| Regression rate | 0% | 0% |
| Provider cost per success | $0, no model invoked | $0, no model invoked |
| Actual input/output/cached tokens | Unknown | Unknown |

The configured quality verdict is **PASS**, with **“Latency regression exceeds configured ratio”**. BENCH-014 fails in both baseline repetitions and passes with P1; the remaining reference controls pass in both configurations. P1 adds indexing/search overhead in these tiny fixtures. These correlated scripted samples validate framework behavior; they do not establish model superiority, live completion improvement, statistical significance, token savings, or real workload speedups. Infrastructure cost is not included in the zero provider cost.

## Verification

- Full regression: **364 passed, 0 failed, 0 skipped**, 210.75 seconds. Includes ten P2 tests, migration checks, authorization, workflow, agent and P1 regression coverage. Log: `/tmp/p2-regression-final.log`.
- `npm run typecheck`: passed. `npm run build`: passed. Build log: `/tmp/p2-build-verified.log`.
- Real local benchmark DAG: 60 graded case executions, persisted results and comparison, as above.
- Headless Chromium through actual authenticated HTTP/API/UI handlers: PASS, runs/details/comparison/warning/evidence rendered, zero page errors. Only the synthetic local benchmark owner's password was reset for this check. Temporary HTTP listener/browser were closed.
- Formatting checks for the new modules and `git diff --check`: passed. No tests were skipped to obtain a green result.
- Final CLI-only compatibility check initially exposed the legacy benchmark's missing work-item owner. After supplying a synthetic owner, `npm run bench -- --scenarios=1 --profiles=FAST` passed (five graph steps, one agent step, no agent invoked), its unique scratch database was dropped, and typecheck/diff checks passed again. The earlier failed smoke test's scratch database was also removed. The full 364-test run preceded this CLI-only repair; the repaired path was verified by this direct invocation.
- Actual live-model/token measurement, real SQL execution plans, protoc compilation, production deployment and RDS migration 027: **NOT VERIFIED**.

## Configuration and migration

Production default remains `evaluation.enabled=false`. Enable via the local `PLATFORM_CONFIG`, not shared workflow settings. Local benchmark CLI uses `/var/tmp/hasaki-p2-benchmark/config.json` when `TMPDIR=/var/tmp`; it has `evaluation.enabled=true`, global P1 disabled and per-evaluation ON/OFF overrides. Run startup on that isolated installation only; do not start another process with a live instance identity.

Migration [027_benchmark_framework.sql](../../migrations/027_benchmark_framework.sql) creates five relational tables and extends `eval_results` with case/owner/gate/score/failure columns. Immutable version/configuration triggers and indexed foreign keys preserve existing data. It follows the existing forward-only migration framework. Local application and repeated startup succeeded. No RDS database was migrated for P2.

## Remaining limits

- Paid live-agent execution is deliberately BLOCKED, even after approval, until a connector enforces hard total spend/token and external-side-effect limits. The existing executor path is tested with a process fixture only. Model/provider quality comparisons remain unverified.
- Sandbox portability is limited to the verified Linux/Nix/Podman-compatible adapter and a preinstalled image; unavailable controls BLOCK rather than execute on the host.
- SQL/proto validation is structural; query-plan performance, database transaction isolation and full generated-code/protoc compilation need additional validators.
- The code-quality dimension is a syntax/security/path proxy; correctness and coverage share assertions. No subjective maintainability score is claimed.
- Dataset contains no verified real-derived tickets. More difficult, independently curated private cases and more repetitions are needed for agent decisions.
- A crash during nested evaluation/workflow creation can leave a non-runnable orphan PENDING workflow needing administrative cleanup. Published results and newer attempts remain fenced.
- Completed worktrees are cleaned; datasets and bounded audit artifacts are intentionally retained. Automated long-term artifact retention is not added.

## Files and working tree

All files below are uncommitted; no unrelated pre-existing edits were present at the audit baseline.

Added: `migrations/027_benchmark_framework.sql`; `src/cli/evaluate.ts`; `src/eval/{dataset,fixtures,isolation,runner,scope,scoring,service,validator}.ts`; `test/evaluation.test.ts`; `web/src/pages/EvaluationBenchmarks.tsx`; `docs/architecture/p2-evaluation.md`; `docs/validation/{p2-finalization.md,p2-benchmark.json,p2-dashboard.png}`.

Modified: `README.md`; `config.example.json`; `src/agent/{claude,toolRegistry}.ts`; `src/agent/codex/run.ts`; `src/api/routes.ts`; `src/auth/execution.ts`; `src/cli/bench.ts`; `src/codeIntelligence/{indexer,search}.ts`; `src/config.ts`; `src/git/provider.ts`; `src/knowledge/{learning,memory}.ts`; `src/notify.ts`; `src/repos/{paths,service}.ts`; `src/server.ts`; `src/workflow/engine.ts`; `src/workflow/executors/builtin.ts`; `test/authz.test.ts`; `web/src/pages/Insights.tsx`.
