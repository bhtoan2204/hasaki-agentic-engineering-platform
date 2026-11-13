# Centralized AI Decision Engine

Gemini Flash recommends; the existing workflow infrastructure validates and executes. The feature is disabled by default for backward compatibility. Apply migration `057_ai_decisions.sql` through the normal migration runner before enabling it. No workflow definitions, historical attempt snapshots, coding-agent defaults, or approval policies are rewritten.

## Architecture audit and reuse

| Existing module                                                               | Finding and integration                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent/stepAgent.ts`, `agent/provider.ts`                                     | Provider/model/effort resolution and immutable attempt snapshots already exist. Retained as coding execution authority. Decision providers use the same provider type, not a new registry.                                                                                                                                     |
| `agent/antigravity/{capabilities,run,stream,policy}.ts`                       | Authenticated account CLI, catalog, streaming, cancellation and hooks already exist. Auxiliary completion inherited coding configuration and did not enforce decision output or tool isolation. Added explicit per-call model/effort, schema, scratch directory and session settings. Legacy completion behavior is preserved. |
| `agent/codex/run.ts`                                                          | Reused completion, catalog, subscription readiness and process cleanup. Decision-only mode validates its own model independently of coding defaults and denies tools through the existing fail-closed hooks.                                                                                                                   |
| `agent/handoff.ts`, `agent/telemetry.ts`                                      | Reused readiness for coding recommendations and the failure taxonomy. Decision fallback never invokes a coding handoff.                                                                                                                                                                                                        |
| `workflow/{engine,profiles,decomposition,replan,budgets}.ts`                  | Existing transactions, fencing, profile graph resolution, DAG checks, approval hashes, workspace ownership, retry budgets and feedback invalidation remain authoritative. No model is invoked while holding a workflow transaction/run lock.                                                                                   |
| `learning/providerPerformance.ts`                                             | Coding recommendation context reuses owner-scoped observational success/latency/token/cost coverage metrics. It does not invent missing prices or calibrated confidence.                                                                                                                                                       |
| `workflow/events.ts`, Run View, Step Inspector                                | Existing event infrastructure carries decision evidence. Run timeline has expandable details; Step Inspector lists its latest 100 decision events. Timeline data includes current downstream step status/attempt for correlation.                                                                                              |
| `agent/complete.ts`, reports, learning drafts, investigation and verification | Natural-language explanations/reports, knowledge extraction/drafting, coding/exploration/review and deterministic verification stay outside the engine. No compatible standalone production-triage decision call was found; triage remains an ordinary workflow agent operation.                                               |

New modules under `src/decision/`: `config.ts` validates policy; `schemas.ts` defines output/constraint validation; `engine.ts` manages recommendations, bounded inference and fallback; `providers.ts` adapts existing subscription transports; `index.ts` persists/cache-locks/audits; `recommendations.ts` constructs compact, constrained run advice. There is no additional scheduler, graph resolver, workflow executor or provider registry.

## Decision coverage

| Type                 | Invocation and safety boundary                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedback`           | Automatic migration of the existing feedback classifier when enabled. Medium for ordinary feedback, High when existing feedback cues indicate design/scope changes. Existing route broadening, graph anchors, affected downstream invalidation and completed-step preservation apply afterwards. Manual feedback modes skip classification. |
| `repository_ranking` | Automatic migration of the existing AI repository ranker. Only known candidate names, finite scores 0–10, no duplicates. Existing discovery decides whether AI ranking is necessary and retains deterministic ranking on failure.                                                                                                           |
| `test_recovery`      | Automatic migration of ambiguous developer test-answer interpretation. Existing exact-answer rules run first. Model interpretation cannot grant a baseline exception; explicit human confirmation remains necessary. Ordinary failure explanations remain outside the engine.                                                               |
| `provider_selection` | Shared validated recommendation type and owner-only run recommendation API. Requires explicit available permitted model/effort candidates. The run API preserves the effective step/run provider and model; it never expands a user's selection. Unconfigured account-default model names cannot be ranked safely and are rejected.         |
| `reasoning_effort`   | Shared validated recommendation type and run API. Only explicitly supported coding effort values may be recommended; a pinned user effort cannot be raised. Decision-model effort is configured independently.                                                                                                                              |
| `workflow_routing`   | Shared validated recommendation type and run API. Returns FAST/STANDARD/DEEP advice constrained by caller policy; the run API allows STANDARD/DEEP and preserves DEEP. Existing automatic profile classification and the graph resolver remain deterministic. Running graphs are never replaced by advice.                                  |
| `decomposition`      | Shared recommendation type and run API. Reuses `SubtaskSpec`, `DecompositionPlan`, existing DAG/repository/file-ownership validation, and default limits. The existing expansion API still requires exact-plan human approval and rechecks live limits, depth and graph state.                                                              |
| `recovery`           | Shared recommendation type and run API. Caller supplies deterministic allowed actions. The run API permits human/stop/replan advice only; it cannot authorize a retry or handoff without verified idempotency, failure classification and remaining budget. Existing automatic retry/recovery/handoff execution remains deterministic.      |

The last five types are advisory APIs, not newly enabled automatic workflow transitions. This intentionally keeps the existing deterministic decisions intact; only the three compatible existing AI decision calls are automatically migrated. Reports, ordinary text generation and coding agents do not route through the engine.

Authenticated owner request:

```http
POST /api/runs/:id/decisions/recommend
Content-Type: application/json

{"type":"decomposition","stepKey":"plan","question":"Would independent repository work benefit from subtasks?"}
```

`stepKey` must belong to the run. It is required for provider/effort/recovery recommendations. The result has `advisoryOnly: true`. Apply changes only through the existing approval, expansion, reexecution, profile creation or handoff APIs. This endpoint does not accept caller-supplied permissions, model catalogs, readiness or retry budgets.

## Configuration and authentication

`config.example.json` contains the complete default block:

```json
{
  "decisionEngine": {
    "enabled": false,
    "primary": { "provider": "antigravity", "model": "gemini-flash", "effort": "medium" },
    "highComplexityEffort": "high",
    "overrides": {},
    "fallback": {
      "enabled": true,
      "providers": ["codex", "claude"],
      "models": {},
      "maxSwitches": 2
    },
    "timeoutMs": 60000,
    "rateLimitRetries": 1,
    "cache": true,
    "observability": true,
    "maxInputChars": 24000
  }
}
```

Enable after worker authentication and catalog validation. `primary.model: "gemini-flash"` is a platform selection alias, never sent to the CLI: it selects the numerically latest account-catalog Flash variant for the requested effort. An unsuffixed family such as `gemini-<catalog-version>-flash` pins a family while allowing Medium/High variants. An exact suffixed slug must agree with the requested effort. Configure per-type targets under `overrides` with provider/model/optional effort. An explicit per-type effort wins over complexity escalation.

For example, `overrides.feedback` may name the unsuffixed Flash family published by your account and set `effort: "high"`. Do not copy illustrative model/version identifiers without checking `agy models`.

The installed worker CLI audited here was `agy 1.5.8`. The adapter requires the existing streaming/capability flags plus `--settings`, `--json-schema` and `--disable-slash-commands`. Sign in using the CLI's Google Account flow as the worker user. The existing OAuth-file readiness indication must be present. No credential is read or copied by the engine. Executable configuration and worker authentication are reused; coding model/effort defaults are not.

Thinking mapping is conservative: the adapter requires catalog-published `-medium`/`-high` variants, selects that exact variant and omits `--effort` to avoid conflicting selectors. It does **not** trust the legacy catalog's blanket list of supported efforts, invent token budgets, or assume an unsuffixed model supports every effort. If the catalog cannot prove support, the request fails as unsupported. CLI flags alone do not prove model-specific support. See Google's [effort reference](https://antigravity.google/docs/cli/commands/effort).

Decision sessions use a temporary workspace, a deny-all PreToolUse hook with no broker authority, permission denials, strict permissions and no workspace escape. Session settings force account mode (`modelProvider: ""`) and disable credit overflow (`useG1Credits: false`). API-key environment variables are filtered by existing environment policy. See Google's [settings schema](https://antigravity.google/schemas/v1/settings.json) for the account/credit/permission controls. The normal coding-agent permission policy is unchanged.

For Codex fallback, fill `fallback.models.codex` with an explicit catalog slug supporting the requested effort and log in with a ChatGPT subscription. API-key login is rejected. For Claude fallback, fill `fallback.models.claude` with an explicit supported model and use verified subscription OAuth (`auth status --json`); API-key/cloud-provider routes are disabled. This adapter uses the installed SDK's Medium/High support; unsupported model/effort errors are terminal. No Claude model catalog is available through the existing adapter, so operators must configure a supported model. Empty fallback model IDs are deliberately not guessed. Cursor is represented by the existing provider type but rejected for decision execution because its adapter cannot enforce explicit reasoning effort.

## Fallback and deterministic safety

Only QUOTA_EXHAUSTED, RATE_LIMIT and PROVIDER_UNAVAILABLE allow switching. Rate limiting first uses the configured bounded retry count, with short bounded backoff. Provider order is configured, duplicates are removed, and `maxSwitches` is capped at three. One total timeout covers readiness, retries and inference. No fallback follows authentication/permission failure, unsupported capabilities, invalid JSON/schema, business-rule rejection, unknown failure or timeout. Generic CLI startup errors are not treated as proof of provider unavailability.

A switch changes only the decision transport. It never modifies a run's coding provider, step override, session or attempt snapshot. If eligible providers are exhausted, `DecisionUnavailable` is thrown. There is no generic AI-generated recovery action. Existing feedback cues and repository ranking remain the explicitly defined deterministic fallbacks at their existing call sites. Ambiguous test answers remain a human clarification flow. The advisory endpoint returns an error and performs no execution.

Recovery recommendations are not permissions: a recommendation to retry a non-idempotent side effect cannot authorize that retry. Budget/permission/approval/workspace/fencing checks remain in the existing execution path. Subscription quota still applies; the engine cannot promise a provider-level hard spending or token cap. It does not introduce API billing or purchase extra credits.

## Persistence and observability

A canonical SHA-256 fingerprint includes redacted input/context, decision type/schema version, scope/run/step generation or graph state, constraints, complexity and complete engine policy. Attempt ID is excluded so equivalent retries reuse decisions. Different runs are isolated. Changed state or policy invalidates reuse. Successful decisions, compact redacted context and selected model/effort are durable in `ai_decisions`. Retention follows run deletion.

PostgreSQL session advisory locks serialize equivalent requests across processes; they do not hold a workflow transaction open. The same connection handles cache persistence and events, avoiding pool deadlock. Lock waits honor the request deadline. Process death releases the session lock. Cache-off requests still persist evidence, but skip reuse. Confidence is always null because these providers do not supply calibrated confidence.

Events carry type, fingerprint, provider/model/effort, latency, actual available token usage (otherwise null), fallback attempts and classifications, validation outcome and concise rationale. Validation errors are terminal and audited. `observability: false` suppresses successful/cache-hit events, not mandatory failure evidence or durable results. The run timeline correlates the current downstream step status/attempt; there is no causal attribution metric claiming that the recommendation caused an outcome. Existing execution telemetry remains the source of actual execution outcomes.

## Verification

Normal tests use mocks and isolated test databases, with no paid inference:

```sh
node --disable-warning=ExperimentalWarning --import ./test/env.ts --test test/decision-engine.test.ts
node --disable-warning=ExperimentalWarning --import ./test/setup.ts --test --test-concurrency=4 test/decision-engine.integration.ts test/antigravity.integration.ts test/codex.integration.ts test/engine.integration.ts test/authz.integration.ts
npm run typecheck
npm run build
npm run bench:decisions
```

The optional live smoke is deliberately separate and consumes worker subscription quota:

```sh
DECISION_LIVE_SMOKE=1 npm run smoke:decisions
```

The smoke verifies an actual account-catalog Medium Flash variant and structured output. It does not use paid API keys, create a workflow, or mutate repositories. It was not run during implementation.

Measured mock benchmark (200 requests, simulated 2ms inference, in-memory persistence):

| Path                             |   Median |      p95 |     Total | Provider calls |
| -------------------------------- | -------: | -------: | --------: | -------------: |
| Previous completion + JSON parse | 2.222 ms | 2.648 ms | 450.90 ms |            200 |
| Engine, cold distinct inputs     | 2.706 ms | 4.086 ms | 596.76 ms |            200 |
| Engine, equivalent cached inputs | 0.192 ms | 0.351 ms |  44.92 ms |              0 |

Cold median overhead was approximately 0.48ms. These measurements exclude CLI startup, account service latency and PostgreSQL; they are not a live provider latency claim.

## Operational limitations

- This is a compatible incremental migration. Profile classification and coding selection remain deterministic; decomposition/recovery/provider/effort APIs are recommendations, not automatic actions. User provider/model/effort pins are preserved even when performance metrics favor another option.
- No real Google inference or live fallback was exercised. Confirm the worker account publishes the needed variants using the optional smoke before rollout. Unsupported catalogs fail closed rather than silently dropping effort.
- Antigravity is still an agent CLI, with startup overhead and CLI-managed global customizations/session persistence. The scratch workspace, deny hooks and strict session policy limit its authority; it is not represented as a native lightweight inference API. CLI upgrades need the mocked regressions and optional live smoke. Saved CLI conversations are not reused by decisions.
- Catalog readiness may spend time on metadata probes; a deadline stops the decision but older readiness helpers may finish their bounded metadata subprocess after cancellation. They cannot start inference after the deadline because completion adapters recheck cancellation before spawning it.
- A crash after remote inference but before durable persistence can require repeating inference. There is no provider-side idempotency guarantee. Likewise audit delivery can fail after persistence; replay uses the persisted result and can emit its cache-hit event.
- Claude requires an explicit configured supported model, and Cursor decision inference is unavailable. A misconfigured/unsupported fallback is terminal; the engine does not silently skip a capability or authentication rejection to seek a different billing route.
- Decision token totals remain independent evidence in events/metrics, rather than being reported as coding-session usage. No provider price or confidence is fabricated.
- The full unit suite encountered two environment failures in `postgres-binaries.test.ts`: its login harness resets PATH to `/usr/bin:/bin:<node-store-bin>`, where this Nix installation has no `npm`. Both reported `npm: command not found`; unrelated platform code was left unchanged. Focused feature tests and the workflow/provider/auth integration suite passed. See the implementation handoff for final counts.
