# Provider failover and portable continuation

Phase 5 extends existing runs, steps, durable jobs, attempt records, context packs and tool authorization. A provider failure can leave a step in `WAITING_INPUT` and its run in `WAITING` while a separate immutable attempt is prepared for another provider. Other independent branches retain their existing execution semantics. No new scheduler or dashboard is introduced.

## Recovery policy

Use `config.agent.fallback` on an agent/coding-agent step (`config.fallback` is also accepted):

```json
{
  "agent": {
    "provider": "claude",
    "fallback": {
      "mode": "manual",
      "providers": ["claude", "codex", "cursor", "antigravity"],
      "max_switches": 2,
      "allow_unknown_cost": false,
      "allow_budget_failure": false
    }
  }
}
```

- `manual` is the default. Saving a workflow or selecting a target never implicitly enables automatic failover.
- `disabled` preserves the existing failure/retry policy and rejects handoff requests.
- `automatic` must be explicit. The existing scheduler polls durable READY handoffs and rechecks one eligible record at a time, including after restart. Failed readiness checks are retried no more often than once per minute.
- Provider lists are ordered, unique and bounded. Switches across all attempts of a logical step are bounded by `max_switches` (default 2); automatic continuation never revisits a previously used provider. A user can explicitly resume the original provider after recovery without counting that as a provider switch.
- Optional `max_reported_cost_usd` and `max_reported_tokens` enforce reported totals. Incomplete coverage blocks automatic continuation when a corresponding limit is configured. A known subtotal is not a complete spend total.

The Phase 1 normalized taxonomy and structured provider codes determine eligibility. Provider diagnostics are distinguished from integration failures: a Bitbucket 401 is not evidence that the AI provider requires authentication.

| Category | Behavior |
|---|---|
| RATE_LIMIT | Existing bounded backoff first (at least three attempts); exhausted retries produce a reviewable handoff. |
| QUOTA_EXHAUSTED | Pause immediately; no pointless same-provider quota retry. |
| PROVIDER_UNAVAILABLE | Existing retry budget first, then pause. |
| AUTHENTICATION | Pause for manual recovery; never try unrelated credentials automatically. |
| CONTEXT_LIMIT | Manual recovery/context review. |
| EXECUTION_TIMEOUT | Existing retry budget first, then manual recovery. A timeout is never evidence of quota exhaustion. |
| UNKNOWN | Pause only with structured provider diagnostics or a reported failed provider session; never automatic failover. |
| TOOL_FAILURE / AGENT_ERROR / code or verification failure | Existing execution/retry behavior. No automatic failover eligibility. |

Only RATE_LIMIT, QUOTA_EXHAUSTED and PROVIDER_UNAVAILABLE are eligible for automatic failover. Even then, readiness, current repository permissions, tool/delegation capability, existing approval grants, assigned worker, instance fencing, switch budget, workspace fingerprint and conflicting attempts are rechecked before any new job is queued.

Readiness probes do not invoke a model: Codex uses existing version/flag/login/model-catalog checks; Cursor uses existing flag/login checks and model support; Claude uses the configured CLI (or `claude` on PATH) `auth status --json`. A provider can be logged in and still have no remaining quota. Remaining quota and billing availability remain **unknown** unless reported. Provider-specific model validation remains authoritative; no Claude model identifier or session is sent to another provider.

Automatic mode refuses unknown target/source costs unless `allow_unknown_cost: true` was explicitly authored in the workflow policy. Billing/credit/budget failures additionally require `allow_budget_failure: true`. Reported cost/token caps are never bypassed by those flags. Manual confirmation explicitly authorizes the selected provider and acknowledges unavailable cost/usage; it does not establish any billing estimate or convert a subscription into API billing. Fallback policy cannot be changed through a run-owner provider override.

## Durable pause and cancellation safety

Migration `033_provider_handoffs.sql` adds:

- `workflow_step_attempts.executor_stopped_at`, written by the scheduler only after `execute()` settles.
- `provider_handoffs`, unique per source attempt, with STOPPING / READY / BLOCKED / RESUMED states and a single target-attempt link.
- A partial unique artifact identity index for idempotent workspace evidence.
- `provider_handoff_metrics`, reusing existing canonical attempt telemetry.

A provider failure is persisted as a FAILED attempt. A manually canceled provider is persisted as CANCELED. Its step moves to WAITING_INPUT, its job lease is released and fenced, and a `provider_handoff` checkpoint is written in the same transaction. Git files are never reset, cleaned, stashed or discarded by this feature. Existing human approval gates remain mandatory. Existing human questions must be answered before continuation; answers do not themselves enqueue a handoff attempt.

For an in-progress manual switch, the first request writes STOPPING and requests cancellation through existing local abort handles. The executing worker also observes the durable request during heartbeat, covering requests served by another process on the same installation. It waits for the executor to terminate; a promise timeout is not treated as proof of termination. The source attempt continues to hold the existing workspace coordination gate until termination and inspection finish. An unresponsive provider remains STOPPING; it never gets a concurrent writer.

The assigned worker inspects Git with hooks/fsmonitor/external diff disabled and a 30-second overall deadline. It checks branch and root identity, HEAD, staged/unstaged diff hashes, conflicts, untracked-file hashes and bounded status/diff summaries. Symlinks escaping the worktree, conflicts or evidence too large to inspect safely block the handoff. Filesystem inspection is repeated under the run lock on resume. Any fingerprint change requires reinspection and a new preview acknowledgement.

A READY checkpoint survives restart entirely in PostgreSQL. STOPPING recovery without a durable termination marker becomes BLOCKED. Lease expiry alone is not termination proof. Reinspection can recover a blocked checkpoint only when executor termination has been confirmed; an operator must reconcile unconfirmed processes on the assigned installation. This deliberately blocks continuation when safety cannot be established.

## Portable handoff package

The redacted, bounded package retains task/workflow/step/attempt identities; task text; source context and pack references; requirements/rule references; repository identities, branches and heads; Git change summaries; decisions and pending work; commands/test observations; verification evidence; known failures; and source artifacts/checkpoints. Progress remains historical evidence, not a claim of verified completion.

Workspace details are stored as owner-scoped `provider_handoff` artifacts keyed by source attempt and fingerprint. Reinspection preserves prior artifact versions. Limits: 30 worktrees, 100 untracked files per worktree, 5 MiB untracked evidence and Git-command buffers per worktree, 4 MiB detailed workspace evidence, and 128,000 characters for the portable package. Oversized or unsafe state becomes BLOCKED rather than silently losing required evidence.

The receiving attempt gets a required handoff entry in its Phase 3 context pack. `platform.get_run_context` can retrieve the package and detailed workspace evidence with `handoff_offset`, `handoff_limit` (100–12,000 characters) and `handoff_workspace: true`; `handoff_source_pack: true` retrieves the source attempt’s immutable pack with the same pagination and owner/run binding; the result includes the next offset. Existing knowledge, code, symbol and step-output tools remain available under the same owner/attempt/repository policies. Provider-native resume requires the existing same-provider settings checks; cross-provider handoffs start fresh provider sessions and use portable context instead.

## Owner-scoped APIs and UI

All routes use existing authentication, CSRF, `requireRun`, assigned-worker checks and explicit audited admin `?scope=all` access.

```http
POST /api/runs/123/steps/implement/handoff
{"expected_attempt_id":456,"reason":"Switch provider after usage limit"}
```

The same request reinspects a READY/BLOCKED checkpoint when termination is confirmed. Reinspection is audited and pauses automatic continuation for manual review.

```http
POST /api/runs/123/steps/implement/handoff-resume
{
  "handoff_id":789,
  "expected_attempt_id":456,
  "checkpoint_fingerprint":"<64-character fingerprint from the preview>",
  "provider":"codex",
  "model":null,
  "confirm":true
}
```

`GET /api/runs/:id/steps/:key` includes handoffs, checkpoint previews and history. `GET /api/runs/:id/steps/:key/handoff-providers` exposes readiness/model options without model calls. `GET /api/runs/:id/handoffs` exposes metrics for dashboards. Requests with stale attempt/generation/fingerprint, a replaced worker, revoked permissions, ungranted approvals, unanswered questions, canceled/paused runs, conflicting running attempts or exhausted switch budgets fail closed.

Concurrent confirmation is serialized under the existing run/step locks. The job idempotency key and unique target-attempt binding allow one effective continuation. Old fenced results cannot complete it. Generic retry/reexecute cannot bypass a pending handoff. `provider_handoff.request`, `.reinspect`, `.resume`, existing support audits and durable provider-handoff timeline events make the switch traceable. Automatic actions have an explicit system-origin flag and timeline event.

Workflow Studio exposes fallback mode/order/budget and explicit unknown-cost/budget permissions. Run View highlights paused provider steps; Step Inspector shows current provider, Switch Agent, availability, task/change/decision preview, a required confirmation checkbox, reinspection, history and attempt-level provider timeline. English and Vietnamese use existing locale and Hasaki components. Agent completion is shown separately from verification.

## Metrics and validation

`provider_handoff_metrics` includes original/target provider, reason/category, source and target attempts, prior/new attempt durations, handoff duration, retry count, continuation-attempt count, nullable reported token/cost totals with cost coverage, and the final reported verification result within the generation. Additional usage sums continuation retries until the next provider handoff. These usage totals are a subset of canonical run telemetry; do not add both views together as separate spend. Unknown cost remains NULL. The first target-attempt link remains stable; later retries retain their original attempt attribution.

Handoff duration runs from request/checkpoint creation to confirmed resume. An in-progress request overlaps the end of the source attempt; it must not be summed with source attempt wall duration as if disjoint. Provider execution and workflow wall latency retain Phase 1 semantics.

```sh
npm run typecheck
npm run build
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform npm test
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform \
 CHROMIUM_BIN=/path/to/chromium npm run smoke:handoff
```

`test/provider-handoff.test.ts` uses deterministic adapters and real durable jobs/transactions: Claude → Codex dirty-worktree continuation; running Codex → Cursor cancellation; retries/backoff; timeout ≠ quota; auth/unknown/context failures; restart recovery; duplicate resume and competing claims; stale completion; fingerprint reinspection; revoked repository access; unavailable/foreign workers; budget/coverage guards; existing approvals/questions; owner/admin RBAC and CSRF. The UI smoke uses fixture adapters through actual HTTP, authentication, workflow jobs and English/Vietnamese controls. No live paid provider calls are required.

Apply migrations and upgrade assigned workers before enabling Phase 5 workflows. Historical attempts without termination proof remain readable but require conservative reconciliation before a handoff; historical provider/model attribution is unchanged. No production migration or deployment is performed by the validation commands above.


### Recorded validation (2026-11-08)

- `npm run typecheck`: passed, backend, test sources and web.
- `npm run build`: passed.
- Full regression: **449 passed, 0 failed, 0 skipped**, three suites, approximately 295 seconds.
- Focused handoff suite: **13 passed**, including a switch request racing executor completion. That race produces a blocked checkpoint for explicit reinspection and retains the source output as unverified evidence. Ordinary step cancellation also retains termination proof. Restart continuation is exercised from a fresh Node process without source-worker handles or caches.
- Browser smoke: passed actual HTTP/login/CSRF, quota pause, readiness display, disabled-until-acknowledged confirmation, a Codex continuation in the same run, and English/Vietnamese handoff history. No uncaught page errors.
- `git diff --check`: passed.

All database checks used isolated local PostgreSQL. Readiness and execution adapters in the browser/handoff tests were deterministic fixtures. No live paid provider execution, production migration, or deployment was performed.

[Browser smoke results](screenshots/smoke-results.txt) · [English preview](screenshots/handoff-preview-en.png) · [Resume confirmation](screenshots/handoff-confirmation-en.png) · [Vietnamese history](screenshots/handoff-history-vi.png)
