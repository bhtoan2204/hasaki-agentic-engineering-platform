# Phase 6: provider evaluation and evidence-based defaults

This extends the existing benchmark suites, case runs, durable workflow executor, isolated fixture repositories, deterministic validator, telemetry, Insights, authentication and support-access audit. It does not add a second evaluation engine. Migration `034_provider_evaluation.sql` adds immutable phase bindings, recommendation snapshots and optimization decisions, owner-scoped policies, an aggregate source view and existing-cache invalidation triggers.

## Execution and limits

The Insights **Agent Evaluation / Đánh giá tác tử** section supports Claude, Codex, Cursor, Antigravity, Claude → Codex, Codex → Claude, Claude → Antigravity and Claude → Codex → Cursor. Models and supported reasoning settings are validated per provider. One phase implements; two phases implement then verify; three phases research, implement then verify. The existing isolated validator, not a phase's self-reported success, determines the result. Phase execution budgets share the case time budget. Recovery failover is disabled inside controlled benchmark phases.

**Live evaluation remains blocked on this installation.** The existing execution safety guard requires a verified connector enforcing hard token/cost budgets and outbound API isolation. This implementation preserves that guard. Choosing live or dry-run produces an explicit blocked result, without launching a paid provider. Fixture controls exercise the real durable DAG, configured provider attribution, context adapters, portable artifacts and deterministic validation; they do not measure Claude, Codex, Cursor or Antigravity proficiency, model quality or real handoff effectiveness. No live comparison or paid benchmark was performed for this delivery.

Example request configuration (use the existing evaluation creation endpoint and suite ID):

```json
{
  "mode": "fixture",
  "adapter": "provider_fixture",
  "provider": "fixture",
  "provider_sequence": [
    { "provider": "claude", "model": null },
    { "provider": "codex", "model": null },
    { "provider": "cursor", "model": null }
  ],
  "context_variant": "tools",
  "repetitions": 2,
  "context_tokens": 24000,
  "case_limit": 15,
  "max_case_seconds": 30,
  "max_tokens": 10000,
  "max_cost_usd": 0
}
```

Replace `provider_sequence` with any single provider or the supported two-phase plans. Null models use provider defaults; configured and observed model attribution are separate. No provider model identifiers or sessions are translated into another provider's format. The UI can queue all three context variants with otherwise identical settings.

Cases retain pinned base commits, fixtures, acceptance criteria, permissions and budgets. A constraints hash freezes task/cohort, tools, prompt, budget and accessible context inventory. Changing relevant knowledge inventory blocks execution rather than silently changing the experiment. Context plan inputs are restricted to the current case, avoiding leakage of reference solutions from other cases in a serial run. Reference patches are fixture-only artifacts applied in an isolated pinned checkout. Clarification still uses the existing approval mechanism before writes.

The built-in suite is version **4**, reflecting the new harness hash. Historical suite versions and results remain readable. Existing legacy configurations and their idempotency hash remain compatible. A pending old evaluation whose harness no longer matches is blocked; it is not silently regraded under new code.

## Context experiment

- **A / minimal:** task prompt without platform context packs or agent-initiated retrieval.
- **B / pack:** task plus the existing bounded context pack; trusted preparation retrieval is permitted, agent-initiated retrieval is denied.
- **C / tools:** task plus pack and permitted platform context tools.

Authorization, safety constraints and required control/clarification operations apply in every arm. Explicit tool allowlists also constrain C. Context size, preparation time and retrieval/tool activity are recorded where available; fixture token/cost usage stays unknown.

The existing paired comparison endpoint now reports context effectiveness. Context comparisons reject simultaneous provider/model changes. Pairs match task and repetition. Conclusions require completed genuine live results, complete matched sets, at least ten distinct tasks and at least two repetitions. Two-sided exact sign tests use a 0.025 threshold for each of quality and latency. Latency benefit requires at least ten tasks verified successful in both arms and no task-level quality regressions. Faster failures cannot establish benefit. Fixture comparisons always say `HARNESS_CONTROL_ONLY`. Conclusions are conditional on the frozen cohort; absence of detected benefit does not prove equivalence. Retrieval accuracy remains unknown without labeled relevance evidence.

## Analytics and quality evidence

The dashboard uses PostgreSQL aggregates and paginated case details, with date range/timezone, provider, model, category, difficulty, context and cohort filters plus the existing shared dimensions. Date ranges are half-open `[from,to)`; local dates use the selected timezone. Model filters match configured or observed models. Observed model sets remain separate comparison groups. Links lead to workflow runs and existing verification artifacts.

Scorecards show objective success, acceptance and requirement coverage, build evidence, security gates, retries/interventions, median/p95 completion time, active/queue/human/tool time, reported tokens/caches/reasoning/cost and coverage. Completion time includes phases and validation; active provider time is separate. SQL/protocol fixtures have no compiler build result, so build success stays unknown. Invalid/unnecessary changes and semantic correctness are not fabricated where validators cannot establish them. Existing validators provide fixture-specific acceptance/security evidence, not a general security audit.

Missing cost is never rendered as $0. Cost per verified success requires complete reported-cost coverage. Partial case totals are identified with both case and fully covered attempt counts. Input/output coverage is independent; cache and reasoning counts remain nullable. Estimated values must retain their source labels; unreported subscription/CLI usage is not API billing. Planned sequence transitions and recovery handoffs are separate metrics. Fixture transitions establish wiring only.

Production observations are displayed separately and excluded from recommendations. Only explicit verification signals count as verified outcomes. Benchmark-only filters do not invent labels for production runs. Historical production comparisons remain observational and may reflect task selection, permissions, user behavior and provider changes.

## Recommendations and optional future defaults

A recommendation snapshot is immutable, owner-scoped and versioned (`controlled-evidence-v1`), with filters, evidence IDs, cohort/evidence hashes and a 30-day expiry. Fixture and blocked outcomes never qualify. Eligible controlled-live evidence must contain complete, graded case outcomes from completed evaluations.

Each candidate needs at least 30 trials, ten distinct tasks, two completed evaluations and two repetitions, with at least two comparable provider/model routes in the same category, cohort and context arm. A task counts as stably successful only if all its observed repetitions passed hard gates. Wilson intervals use distinct tasks rather than inflating independence with repetitions; a recommendation requires the winner's lower bound to exceed every competitor's upper bound. Ambiguous or mixed cohorts yield **Insufficient evidence**. Current provider readiness and required tool permissions are checked; unavailable candidates are explicitly unavailable. Cost availability is Known, Partial or Unknown independently of quality confidence. High confidence additionally requires 30 distinct tasks and three evaluations; the current small built-in suite cannot establish that threshold. Most category subsets will not meet even the minimum sample threshold.

Optimization is **disabled by default** and requires explicit owner opt-in against a current supported snapshot. Only single-provider recommendations can influence defaults; mixed routes remain advisory. Policies match an explicit future run `task_category` and agent step type. Explicit run provider or step provider/model settings take precedence. Expired evidence, unavailable providers, incompatible permissions or unknown cost without explicit consent skip application and persist the reason. Provider readiness uses the actual execution profile. Applied/skipped decisions retain recommendation, evidence and policy provenance. Running workflows, business rules and approval requirements are never modified.

## APIs and access

- `GET /api/agent-evaluation`: aggregate scorecards, context/difficulty/failure distributions, production observations and paginated evidence.
- `POST /api/agent-recommendations`: create an owner evidence snapshot; `GET` lists the owner's snapshots; `GET /api/agent-recommendations/:id` retrieves evidence.
- `GET/POST /api/agent-optimization`: inspect/create/update owner opt-in policies.
- Existing evaluation and paired-comparison endpoints remain the execution/drill-down entrypoints.

Default reads and all writes are owner-scoped. Team analytics and cross-owner snapshot reads require the existing explicit support scope and audited authorization before cache use. A generic administrator role alone does not grant silent team access. Workflows/artifacts preserve their existing access checks. Reads reuse bounded caching and aggregate queries; detailed tables do not load all raw events into browser memory.

## Validation evidence

Validation uses deterministic fake adapters and isolated PostgreSQL/Docker fixtures, without paid provider calls. The new integration tests cover all six plans, repeated runs, A/B/C controls, inventory drift, frozen cohorts, unknown cost/tokens, attribution, policy provenance/precedence, readiness, objective verification denominators, timezone boundaries, RBAC/audited support scope, pagination and conservative evidence thresholds. Existing failover/orchestration/telemetry tests remain part of full regression.

Browser smoke exercises the actual HTTP application and VI/EN UI: fixture labels and unknown cost, insufficient-evidence snapshots, server pagination, Vietnamese three-provider configuration and no uncaught page errors.

- [English screenshot](screenshots/agent-evaluation-en.png)
- [Vietnamese screenshot](screenshots/agent-evaluation-vi.png)
- [Browser smoke results](screenshots/smoke-results.txt)

Typecheck and production build pass. Final regression results are recorded below after completion. Migration has been exercised in isolated test databases; no production migration or deployment was performed.

Final validation on the fetched main baseline `2cd4dc1`:

| Check                                     | Result                                               |
| ----------------------------------------- | ---------------------------------------------------- |
| `npm run typecheck`                       | Pass: server and web                                 |
| `npm run build`                           | Pass                                                 |
| `npm test`                                | **460 passed, 0 failed, 0 skipped**; 423.45 seconds  |
| New provider evaluation integration tests | **11 passed** within the full suite                  |
| `npm run smoke:provider-evaluation`       | **5 browser checks passed**, EN/VI screenshots above |
| `git diff --check`                        | Pass                                                 |

The final full run used a fresh local PostgreSQL instance and test temporary directory on disk. Earlier interrupted runs encountered changing harness hashes during development and exhausted `/tmp` database storage; those runs were superseded by the clean, frozen-harness full run. Synthetic positive recommendation fixtures test SQL/statistical behavior only; they are not empirical provider evidence.

## Controlled live Ponytail connector

`knowledge-ponytail-v1` is defined from a registered-repository snapshot with an absolute `local_path` per row. The platform repository and synthetic benchmark repositories are excluded. Six pinned exploratory tasks cover Go bugfix/feature, TypeScript feature, refactor, review and regression work. All eligible repositories participate in the task cohort. Baseline/pilot configurations hold the provider fixed, use two repetitions, and cover Claude, Codex, Cursor and Antigravity.

The shared agent executor supplies the live path. `evaluation.liveEnabled` defaults off. Prerequisites require explicit administrator paid approval, local provider executables, PostgreSQL `initdb`/`pg_ctl`, bubblewrap and attested incremental usage support. `evaluation.liveUsageProviders` excludes Cursor until its installed stream protocol has been checked against mocked incremental-usage fixtures; add it only after that compatibility check. Unknown usage blocks acceptance. Token/cost limits accumulate across case phases and sessions. Unreported costs use `evaluation.estimatedUsdPerMillion` (default $30 per million tokens), frozen into each evaluation configuration; Antigravity does not report actual spend. These estimates are not invoice totals.

Each live phase uses a secret-scrubbed archive of its pinned commit, never the original checkout or Git history. Provider sandboxes stay enabled. Verification retains the normal verification and test-weakening gates, with a scrubbed environment and network-isolated bubblewrap. A new socket-only PostgreSQL cluster is created and destroyed per phase; platform database credentials never enter the provider environment. A phase that fails without being aborted removes its case workspace at once, and a finished case removes it after storing its result. Nothing is swept automatically: live leftovers after a timeout, cancel, lease loss or crash stay under `<dataDir>/evaluation-work/<evaluation>/<case>/live` and are cleaned with `npm run eval:cleanup` (a dry-run listing of runs, statuses, running postmasters and sizes), then `npm run eval:cleanup -- --yes` for COMPLETED or CANCELED runs, or `--case <case_run_id> --yes` for one case regardless of status. `--yes` skips a case whose worker may still be active (one extra lease after cancel); `--case` proceeds with a warning. A database whose postmaster cannot be stopped, or whose liveness cannot be verified, is kept and reported. FAILED runs are never removed by `--yes` because they can be retried. No run pushes or opens a PR. A shared `budget_group` serializes accounting across the eight A/B arms so suite spend cannot reset between providers. Defaults are 1800 seconds, 3M tokens, $10 per case and $300 per suite; local administrator limits remain authoritative.

The code path is `npm run bench -- --suite=knowledge-ponytail-v1 --registry-file=/absolute/repositories.json --live --paid-approval --admin`. Without `--live`, it records blocked dry-run controls. This implementation session did not execute that command or call any provider. Reports are written to `docs/evaluation/<date>-ponytail-ab.md`; missing verification/coverage measurements keep acceptance inconclusive, and any quality regression fails regardless of LOC/token gain. n=2 supports descriptive comparisons only.
