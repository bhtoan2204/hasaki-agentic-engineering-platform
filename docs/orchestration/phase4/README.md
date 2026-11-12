# Step-level agent orchestration

Agent and coding-agent nodes can select Claude, Codex, Cursor or Antigravity within one durable DAG run. Existing definitions without `config.agent` continue to inherit their stored run provider. No additional scheduler, execution queue, or dashboard is introduced.

## Configuration

```json
{
  "name": "Mixed provider implementation",
  "steps": [
    { "key": "research", "type": "agent", "config": { "agent": { "provider": "claude", "model": null } } },
    {
      "key": "implement", "type": "coding_agent", "depends_on": ["research"],
      "config": {
        "agent": {
          "provider": "codex",
          "model": null,
          "reasoning_effort": null,
          "execution_profile": "STANDARD",
          "timeout_ms": 2700000,
          "retry": { "max_attempts": 2, "backoff_seconds": 5 },
          "allowed_tools": null,
          "context_tokens": 24000,
          "verification": { "command": "go test ./...", "max_repairs": 2, "timeout_seconds": 600 }
        }
      }
    },
    { "key": "verification", "type": "agent", "depends_on": ["implement"], "config": { "independent": true, "agent": { "provider": "cursor" } } }
  ]
}
```

Omitted provider inherits the run default. Omitted profile inherits the run profile. `model: null` uses that provider's configured profile/role routing or account/SDK default; it does not forward legacy `config.model` or `config.codex_model`. Omitted model preserves legacy provider-specific routing. Codex never reads the Claude model field. A provider override resets the previous provider's explicit model and reasoning settings unless supplied again. Legacy model routing functions remain exported.

A step profile selects runtime/model routing; it does not transform the DAG. The existing run-level FAST optimization falls back to STANDARD if it would remove an explicitly configured agent boundary, preserving provider, tool and verification semantics. STANDARD/DEEP retain existing dependency behavior.

Resolution order:

1. Authorized persisted manual override on the step.
2. `config.agent` on the workflow step.
3. The stored run's `agent_provider` and profile.
4. `agent.defaultProvider` in platform configuration (defaults to Claude) for new runs without a default. Historical runs retain their existing stored Claude default.

Validation happens on workflow save/publication, run creation for inherited settings, and manual override. Unknown options are rejected. Actual Codex model/effort availability is checked against the installed CLI's account catalog before execution. Claude accepts SDK reasoning levels; Cursor rejects explicit reasoning effort. Cursor models require an installed CLI that advertises `--model`. Unsupported capabilities fail explicitly, without a provider fallback. Arbitrary model aliases are not advertised as available unless returned by the provider; provider-native defaults remain nullable.

## Attempts and telemetry

Migration `032_step_agent_orchestration.sql` adds `workflow_steps.agent_override` and immutable `agent_provider`, `agent_model`, and `effective_agent` columns on existing attempts. Routing is resolved under the existing run/job/step locks and inserted atomically before execution. A database trigger prevents subsequent changes to an attempt's routing snapshot. Non-agent attempts and historical rows keep NULL snapshots; no historical usage is invented or backfilled.

`agent_model` is the effective requested model, nullable when the provider/account chooses it. The model actually reported by the provider remains in existing session telemetry and `metrics.model`. These can differ. The canonical telemetry view prefers the attempt provider and effective profile, while retaining reported models, original per-session attribution, nullable usage/cost, and legacy fallbacks. Run detail, step detail and run metrics include the immutable settings. The inspector selects attribution from the selected historical attempt, never a future override.

Retry limits/backoff and execution timeout use the attempt snapshot. A timeout aborts the executor separately from the lease/cancellation controller, waits for provider termination, then records `EXECUTION_TIMEOUT` through normal failure handling. Missing final events do not create usage, cost, or quota errors. Existing recovery, fencing, ownership and reconciliation remain authoritative.

## Workspace coordination and context handoff

Provider session directories are isolated by step (`agent-<step_id>`); Codex and Cursor do not overwrite another branch's MCP configuration or prompt file. Existing run-local repository worktrees intentionally persist so implementation, verification and PR steps see the same changes.

At attempt creation, the existing run transaction acts as a durable reader/writer gate: read-only agent branches can run together; `coding_agent`, `command` and `git_pull_request` steps acquire exclusive access against other workspace consumers. Conflicting jobs are deferred for one second in the existing queue without creating or spending an attempt. This deliberately serializes coding branches even if they might touch different repositories. Cancellation also checks still-active local job handles until their executors have stopped. No parallel provider gets simultaneous mutable access to a run worktree. Existing repository locks continue to protect checkout setup.

Every agent receives the Phase 3 bounded, owner-scoped structured pack, including upstream outputs, decisions, worktree evidence and verification requirements where available. Nested context budget and verification settings are applied before context snapshot creation. Packs and continuation evidence persist in PostgreSQL. Provider-native session resume requires the same step, provider, directory, pinned settings and upstream snapshot. Provider changes therefore rebuild from portable context; they never import a foreign session ID. Legacy session directories without pinned settings are rebuilt into isolated directories from durable context.

## Tools and authorization

`allowed_tools: null` or omitted retains baseline permissions. An empty array excludes optional tools. Native names use the existing policy vocabulary (`Read`, `Grep`, `Glob`, `Bash`, `Write`, etc.); Codex hooks map shell/patch/image tools to that vocabulary. Platform tools use `platform.search_code`, `platform.get_symbol`, etc. Integrations use `integration:<name>`. Allowlisting intersects baseline read/write restrictions; it cannot grant access to primary checkouts or other owners' repositories.

Completion, clarification and progress controls remain available. Dispatcher metadata tools remain usable, while the dispatched target is checked again, including aliases through `call_tool`. The dispatcher reloads permissions from the bound immutable attempt rather than trusting CLI arguments. Trusted server context preparation retains its existing read-only retrieval capabilities; agent-initiated retrieval is restricted by the allowlist. Tool auditing and lease/owner/worker validation are reused. Cursor rejects a custom native allowlist because its current adapter cannot enforce it before every native tool executes; its existing baseline policy still applies. Existing restrictions on non-Claude delegation remain.

The UI and API allow a manual override only for pending/retryable agent steps (`PENDING`, `READY`, `RETRYING`, `FAILED`, `CANCELED`, `WAITING_INPUT`) on a non-canceled run. Running and completed steps cannot be changed. Completed history remains immutable. Reexecution of a finished step uses the existing separate authorized operation.

```http
POST /api/runs/123/steps/implement/agent
Content-Type: application/json
X-CSRF-Token: ...

{"agent":{"provider":"codex","model":null,"execution_profile":"STANDARD"}}
```

`{"agent":null}` clears the override. Saving does not start/retry a step; existing run/retry/continue controls do that. `requireRun` enforces owner isolation. Admin access to another owner's run requires explicit `?scope=all` and existing `support.access` auditing. Every successful override also writes `step.agent_override` with actor, previous/new settings and effective resolution in the same transaction. Manual overrides cannot change trusted verification commands or broaden a workflow-authored tool allowlist. Neither tool arguments nor pending input can set this authority.

## Rollout

Apply the additive migration through the existing migration runner and upgrade assigned workers before publishing mixed-provider definitions. Older worker binaries do not understand `config.agent`. Existing Claude-only definitions and historical telemetry remain readable during the upgrade. The coordination query uses the existing `(run_id, id)` attempt index; no new index is needed.

## Validation

Run with an isolated local PostgreSQL:

```sh
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform npm test
npm run typecheck
npm run build
TEST_DATABASE_ADMIN_URL=postgres://platform@127.0.0.1:55433/platform \
  CHROMIUM_BIN=/path/to/chromium \
  node --disable-warning=ExperimentalWarning --import ./test/setup.ts test/step-agent.smoke.ts
```

`test/step-agent.test.ts` covers precedence, model isolation, three-provider DAGs, parallel readers/exclusive writers, retries, recovery/provider switches, cancellation, pinned timeouts, immutable historical attribution, tool restrictions, owner/admin RBAC, and FAST boundary preservation. The Codex adapter test uses the real CLI protocol with the repository's deterministic fake binary, hooks and MCP broker; it makes no live model call. Existing regression tests exercise provider adapters and Phase 3 context bridges.

Screenshots and browser results are in [screenshots](screenshots/smoke-results.txt). They use synthetic data and the actual application, with saved Studio configuration and a pending override in English/Vietnamese. Live paid provider execution is not part of the automated smoke.

### Recorded validation (2026-11-08)

- Latest main inspected at `1bee276` before implementation.
- `npm run typecheck`: passed (backend and web).
- `npm run build`: passed.
- `npm test`: **436 passed, 0 failed, 0 skipped** across 3 suites, approximately 283 seconds.
- Focused orchestration and instance checks: **27 passed**, including 12 orchestration scenarios.
- `npm run smoke:orchestration`: passed; saved provider/model configuration, audited pending override, English/Vietnamese rendering, three-provider DAG labels, and no uncaught browser errors.
- `git diff --check`: passed.

These checks used isolated local PostgreSQL databases. No production database migration or live paid provider execution was performed.
