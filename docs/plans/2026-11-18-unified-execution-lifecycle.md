# Unified Agent Execution Lifecycle

## Requirements Document

### Summary

- **Request:** Gather the agent execution harness, which is currently spread over many places, into one explicit lifecycle that does not depend on the provider. Every supported provider (claude, codex, cursor, copilot, antigravity) must run under equivalent platform guarantees. Decisions that code can make move out of prompts and into the harness.
- **Background:** All the pieces already exist: execution contract, tool policy, scope guard, verification loop, budgets, context pack, provider adapters, checkpoints and implementation evidence. The problem is how they are arranged:
  - They are interleaved inside one function of about 1,900 lines, `agentExecutor.execute` (`src/agent/claude.ts:513-2432`).
  - Some checks run more than once:
    - authorization runs twice: `claude.ts:835` and again at about `:2294`;
    - output contract validation runs twice: `claude.ts:1745` and `:2417`;
    - `terminalCodingFailure` runs four times: `:1794`, `:2188`, `:2264`, `:2429`;
    - `assessMicroScope` runs three times.
  - There are three failure vocabularies:
    - `workflow/failures.ts` `FailureClass`, based on regex;
    - `agent/telemetry.ts` `FAILURE_CATEGORIES`;
    - `claude.ts:494` `TERMINAL_FAILURES`, which mixes both.
  - Guarantees are uneven across providers (matrix below).
- **Expected outcome:**
  - One ordered `runLifecycle()` that is the only path from a claimed attempt to an `ExecResult`.
  - One failure taxonomy.
  - Equal in-run controls (timeout, cancel, idle, tool-call and cost caps) for every provider.
  - Fail-closed preflight when a provider cannot meet the guarantees that the step's mode requires.
  - One harness evidence record per attempt.
  - New architecture fitness rules that lock the structure in place.

### Current State

- **Stack:** TypeScript (Node, `tsx`), PostgreSQL, modular monolith. Tests use `node:test` (`npm test`; `npm run test:integration` needs PostgreSQL). The architecture ratchet runs as `npm run arch:check` (`src/architecture/check.ts`, `architecture/baseline.json`) and also runs inside `npm test` through `test/architecture.test.ts`.
- **Call chain:**
  1. `scheduler.ts:153 processJob`
  2. `deferIfBranchBusy`
  3. `engine.ts:1590 beginAttempt` (claim transaction: access, lease or fencing, writer gate, provider health switch, `buildStepInput`, `validateContinuation`, `resolveContext`)
  4. `scheduler.ts:210 enforceRunRepositoryAccess`
  5. fingerprint reconcile and replay lookup (`scheduler.ts:236-271`)
  6. `getExecutor(type).execute`. Both `agent` and `coding_agent` map to `claudeExecutor` (`workflow/executors/index.ts:25`).
  7. `agentExecutor.execute`, whose `runTurn` (`claude.ts:1185-1460`) uses an if-chain to dispatch to the provider:
     - `cursorAgentTurn`
     - `codexAgentTurn`
     - `copilotAgentTurn`
     - `antigravityAgentTurn`
     - the Claude SDK `query()`
  8. back in the scheduler: workspace capture and the `recordExecutorReturn` checkpoint (`scheduler.ts:304-341`)
  9. `finishAttempt` → `applyResult` → `enforceBudget` (`engine.ts:2206`, `:1884`, `:2306`)
- **Where each stage lives today:**

  | Stage      | Where it runs                                                                                                                                                                                                    | Notes                                                                                        |
  | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
  | Preflight  | 7+ places across the scheduler, the engine claim, `claude.ts:521-754`, and every `*/run.ts` capability re-check                                                                                                  |                                                                                              |
  | Context    | `workflow/context.ts` (`buildStepInput`, `resolveContext`), `context/pack.ts ensureContextPack` (reused when the hash matches), `resumableSession`, `captureContextContinuity`                                   |                                                                                              |
  | Policy     | `toolPolicy.ts:997 decide()`, called through a separate adapter per provider: Claude hooks; codex/copilot/antigravity through the broker hook; cursor through `cli.json` plus a watcher that acts after the fact | `scopeGuard` runs after verification                                                         |
  | Budget     | `budgetPreflight` before the job is queued; `enforceBudget` after the attempt                                                                                                                                    | Nothing runs during the attempt except Claude `maxTurns` and the MICRO tool-call limit of 20 |
  | Checkpoint | Spread over the claim, the scheduler, `claude.ts` session resume and progress notes, and `checkpoints.ts`                                                                                                        |                                                                                              |
  | Verify     | `verify.ts:1063 verificationLoop` with `EvidenceCache`, plus the independent-review branch (`independentReview.ts`)                                                                                              |                                                                                              |
  | Repair     | Four loops: in-session verify repair (`max_repairs` ≤ 5), independent-review `reexecute` (≤ 10), testFailure auto-fix (≤ 5), engine retry (`max_attempts` ≤ 10)                                                  |                                                                                              |
  | Evidence   | `implementationEvidence.ts`, the `execution_contract` artifact, `output.implementation_evidence/scope_check/tested_heads`, `workflow_checkpoints` rows, `recordMetrics`                                          |                                                                                              |

- **Provider parity gaps** (verified):

  | Guarantee                             | claude                     | codex                                       | cursor                                             | copilot                  | antigravity                 |
  | ------------------------------------- | -------------------------- | ------------------------------------------- | -------------------------------------------------- | ------------------------ | --------------------------- |
  | Tool policy enforced before execution | yes                        | yes (detects a tool that bypassed the hook) | **no**: watcher only, the tool has already started | yes, no bypass detection | yes, no bypass detection    |
  | Default wall-clock timeout            | **none**                   | yes                                         | yes (45 min)                                       | yes                      | yes                         |
  | Idle / no-progress kill               | none                       | none                                        | none                                               | none                     | none                        |
  | Budget during the run                 | `maxTurns`                 | none                                        | none                                               | none                     | none                        |
  | Structured failure classification     | `normalizeProviderFailure` | own classifier, no rate_limit               | **none**                                           | own classifier           | identical copy of copilot's |
  | Incomplete-output detection           | weak                       | yes                                         | yes                                                | **none**                 | **none**                    |
  | Network restriction                   | none                       | sandbox                                     | none                                               | `--sandbox` (optional)   | `--sandbox` (optional)      |
  - **Known bugs:**
    - A codex timeout is terminal, while copilot, antigravity and cursor timeouts are retried.
    - The `provider_error.code` map (`claude.ts:1716`) only knows codex's lowercase names.
  - **Duplication:**
    - `copilot/run.ts` and `antigravity/run.ts` differ by only about 38 lines.
    - The `submit_result` read-back SQL is repeated in four `run.ts` files.
    - `excludeFromGit` appears three times.
  - **Misplaced shared code:** the broker transport that every provider uses lives in `codex/broker.ts` and `codex/client.ts`. Other providers import it, which accounts for 8 of the 16 entries in `baseline.json`.

- **Rules that live only in prompts:**

  | Rule                                                     | Status                                                 |
  | -------------------------------------------------------- | ------------------------------------------------------ |
  | Do not edit CI or verify scripts (`verify.ts:1155`)      | not enforced                                           |
  | Call `submit_result` once per turn                       | not enforced; a second call inserts another checkpoint |
  | String `output_contract`s in `templates.ts`              | enums and nested shapes are prose only                 |
  | No local `git merge`                                     | not enforced                                           |
  | push, read-only, MICRO, secrets, primary-checkout writes | already enforced in `toolPolicy.ts`; no change         |

### User decisions (2026-11-18)

1. **Structure:** ordered, typed stage functions in a new `src/agent/harness/` module, called by one `runLifecycle()`. No middleware or plugin framework. Extract with behavior preserved first, then apply the fixes.
2. **Parity policy:** fail closed per mode.
   - Coding (write) steps refuse a provider that cannot meet write-mode guarantees.
   - Read-only steps may run degraded, and the degradation is recorded in evidence.
3. **In-run controls for every provider:**
   - default wall-clock timeout;
   - idle / no-progress kill;
   - tool-call budget, counted in the broker or hook;
   - mid-run cost check.
4. **Rules that move from prompt to code:**
   - protect CI and verify files;
   - `submit_result` once per turn;
   - typed output contracts;
   - deny local `git merge` and `git rebase` onto the parent branch.

### Functional Requirements

- **FR-001 (mandatory) Single lifecycle entry.** `src/agent/harness/lifecycle.ts` exports `runLifecycle(ctx: ExecutionContext): Promise<ExecResult>`. It runs these stages in a fixed order:
  1. `preflight`
  2. `resolveContext`
  3. `authorize`
  4. `checkBudget`
  5. `selectCheckpoint`
  6. `execute`
  7. `validateOutput`
  8. `verify`, with bounded repair that goes back to `execute`
  9. `finalize`

  `agent` and `coding_agent` register a harness executor that calls `runLifecycle`. `agentExecutor.execute` is removed. The Claude-SDK-specific turn code moves to the Claude provider adapter (FR-004).

- **FR-002 (mandatory) Stage contract.**
  - Each stage is a plain async function `(state: LifecycleState) => Promise<StageOutcome>`. `StageOutcome` is either `continue` with an updated state, or `stop` with an `ExecResult` plus a `HarnessFailure`.
  - `LifecycleState` holds what is computed once and read later:
    - `effectiveAgent`, `policyContext`, `executionContract`, `contextPack`, `checkpoint`, `turnResult`, `submitted`, `verification`, `terminalOutcome`, `guarantees`, `evidence`.
  - Each value is computed **once**. The repeated authorization, contract, terminal-outcome and MICRO-scope calls become reads of the state.
  - The post-verification authorization becomes an explicit `revalidateContract` step inside `finalize`. It runs exactly once.
- **FR-003 (mandatory) Stage ownership boundary.**
  - These stay in `engine.ts` and `scheduler.ts` because they must run inside the claim transaction and lock order:
    - claim-transaction checks (owner, lease or fencing, writer gate, provider health switch, `buildStepInput`, `validateContinuation`, `resolveContext` snapshot, `enforceRunRepositoryAccess`, replay lookup);
    - `budgetPreflight` before queueing;
    - `enforceBudget` after the attempt.
  - The lifecycle doc names them as stage 0, "claim", and as "post-attempt accounting".
  - The harness owns everything from executor entry through to the returned `ExecResult`.
  - Workspace fingerprint reconciliation (`scheduler.ts:236-263`) moves into `selectCheckpoint`, which is inside the harness, so that all checkpoint selection lives in one place.
- **FR-004 (mandatory) Provider turn contract.**
  - Add a named `TurnResult` type to `src/agent/harness/turn.ts`. It replaces the inline `{isError, text, assistantTurns, failure?, submitted?}` shape.
  - Add an `AgentTurn = (req: TurnRequest) => Promise<TurnResult>` adapter for each provider. This is the existing `*AgentTurn` function plus a new `claude/` adapter that holds the SDK `query()` code.
  - `runLifecycle` selects the adapter through a lookup table, not the if-chain.
- **FR-005 (mandatory) Shared CLI turn runner.**
  - `src/agent/harness/cliTurn.ts` provides the parts the four CLI adapters share:
    - process-group spawn and kill tree (SIGTERM, then SIGKILL);
    - `AbortSignal` wiring;
    - wall-clock timeout;
    - idle watchdog;
    - `submit_result` checkpoint read-back;
    - workspace merge;
    - incomplete-output detection;
    - a structured `HarnessFailure` result.
  - Provider files keep only the argument building, stream parsing and auth specifics.
  - Combine `classifyCopilotError` and `classifyAntigravityError` into one classifier. Combine the three copies of `excludeFromGit` into one.
- **FR-006 (mandatory) One failure taxonomy.**
  - `src/agent/harness/failure.ts` defines `HarnessFailureCode`. It contains the existing `FAILURE_CATEGORIES`:
    - RATE_LIMIT, QUOTA_EXHAUSTED, AUTHENTICATION, PROVIDER_UNAVAILABLE, CONTEXT_LIMIT, EXECUTION_TIMEOUT, TOOL_FAILURE, AGENT_ERROR, CANCELED, UNKNOWN
  - It adds these codes:
    - `IDLE_TIMEOUT`, `NO_PROGRESS`, `BUDGET_EXHAUSTED`, `TOOL_BUDGET_EXHAUSTED`, `INCOMPLETE_OUTPUT`, `CONTRACT_INVALID`, `INVALID_EVIDENCE`, `POLICY_VIOLATION`, `UNSAFE_SIDE_EFFECT`, `GUARANTEE_UNMET`, `WORKSPACE`
  - One table maps each code to `{retryable, failureClass (workflow/failures.ts), stepAction}`. That table replaces:
    - `TERMINAL_FAILURES` (`claude.ts:494`);
    - the `provider_error.code` map (`claude.ts:1716`);
    - each provider's ad-hoc failure strings.
  - `ExecResult.failed.details.failure_code` carries the code. `classifyFailure` (`failures.ts`) uses the structured code first and falls back to the regex only for older results without a code.
- **FR-007 (mandatory) Explicit handling for each failure mode:**

  | Condition          | Detection                                                                                                                                                                                      | Outcome                                                                                                                                                        |
  | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Timeout            | wall-clock timer per turn and per attempt; default for every provider (Claude included)                                                                                                        | `EXECUTION_TIMEOUT`; retryable once, then stop. Progress is checkpointed.                                                                                      |
  | Cancellation       | `ctx.signal`                                                                                                                                                                                   | kill the process tree or abort the SDK; `CANCELED`; never retried                                                                                              |
  | Idle               | no stream event and no hook call for `idle_timeout_ms`                                                                                                                                         | `IDLE_TIMEOUT`, retryable                                                                                                                                      |
  | No progress        | verify signature repeats (existing `verify.ts:1096`), or `ToolLoopDetector`, which is now recorded for **all** providers through the broker hook path                                          | `NO_PROGRESS`, which needs a human                                                                                                                             |
  | Budget exhausted   | tool-call cap, or projected or live cost above the remaining budget                                                                                                                            | turn aborted, checkpoint saved, run **paused** with a `budget` event (matches the existing soft-pause behavior); `BUDGET_EXHAUSTED` or `TOOL_BUDGET_EXHAUSTED` |
  | Provider failure   | adapter classifier                                                                                                                                                                             | the mapped code from FR-006                                                                                                                                    |
  | Incomplete output  | no terminal result event, or exit 0 without `submit_result`, for every provider including copilot, antigravity and Claude                                                                      | `INCOMPLETE_OUTPUT`, retryable with session resume                                                                                                             |
  | Invalid output     | `validateOutputContract` against the typed schema                                                                                                                                              | `CONTRACT_INVALID`; the existing in-turn retry stays; final failure is non-retryable                                                                           |
  | Invalid evidence   | implementation evidence missing or forged, tested-state fingerprint drift, `verifyEvidence` rejection                                                                                          | `INVALID_EVIDENCE`, non-retryable, needs a human                                                                                                               |
  | Unsafe side effect | a tool that bypassed the hook (`broker.hookCalls` / `allowedTools` for codex, copilot, antigravity; cursor watcher), a denied network or git operation attempted, a write outside the worktree | kill the turn; `UNSAFE_SIDE_EFFECT` or `POLICY_VIOLATION`; not retryable                                                                                       |

- **FR-008 (mandatory) Guarantee matrix and fail-closed preflight.**
  - `providerCapabilities.ts` gains a static `GUARANTEES[provider]` set:
    - `pre_tool_policy`, `hook_bypass_detection`, `network_isolation`, `write_sandbox`, `live_cost`, `incomplete_detection`, `resume`
  - `preflight` computes the guarantees the step needs from its mode:
    - **write/coding:** `pre_tool_policy`, `hook_bypass_detection`, `write_sandbox`, `network_isolation`;
    - **read-only:** `pre_tool_policy` is preferred, and degraded runs are allowed.
  - A write step that is missing a required guarantee fails with `GUARANTEE_UNMET` before any tool runs.
  - A degraded read-only run records `guarantees.degraded[]` in evidence.
  - Concrete changes:
    - **copilot/antigravity:** `--sandbox` is mandatory for write steps. `options.sandbox:false` is refused.
    - **copilot/antigravity:** add hook-bypass detection by reusing broker `hookCalls` / `allowedTools`, as `codex/run.ts:557` does.
    - **Claude, write mode:** `WebFetch`/`WebSearch` are denied in `decide()` unless the step config grants `network: true`.
    - **cursor:** write steps require a hook path (`.cursor/hooks.json` → broker) where the installed CLI supports it (see Outstanding Issues). Otherwise preflight refuses cursor for write steps.
- **FR-009 (mandatory) In-run controls.**
  - `StepAgentConfig` gains `idle_timeout_ms` and `max_tool_calls`, next to the existing `timeout_ms` and `max_turns`.
  - Defaults are settled by the plan and live in `config.ts`:

    | Setting           | Default                                     | MICRO cap                 |
    | ----------------- | ------------------------------------------- | ------------------------- |
    | `timeout_ms`      | 45 min (same as the current cursor default) | existing 10-min cap stays |
    | `idle_timeout_ms` | 10 min                                      | 3 min                     |
    | `max_tool_calls`  | 400                                         | existing 20 stays         |

  - Tool calls are counted in one place, `decide()`. It is reached through the Claude hook and through the broker for every hook-based provider. Cursor's watcher counts too.
  - **Cost:**
    - Where usage streams live (Claude SDK per-message usage), cumulative cost is computed with `report/cost.ts` pricing and compared to the remaining run or work-item budget during the turn.
    - Providers that report usage only at the end (codex `turn.completed`, copilot or antigravity terminal `result.usage`) cannot be checked mid-run. For them, `checkBudget` refuses to start when `remaining < projected` (reusing the `budgetPreflight` estimator), and the tool-call cap acts as the in-run proxy.
    - Evidence records `cost_enforcement: "live" | "preflight_only"`.
- **FR-010 (mandatory) Rules moved from prompts into code:**
  - **CI and verify files.** `decide()` denies Edit, Write and Bash writes to:
    - `.github/**`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, `.circleci/**`;
    - every repo-relative file path named as a token in the step's fixed `verify.command`.

    The step config can opt out with `allow_ci_edits: true`, for steps that are meant to change CI.

  - **submit_result once per turn.**
    - `submitResult` refuses a second valid submission in the same turn ("already submitted").
    - Each verify-repair resume and each session-resume turn opens a new submission window, because repair rounds legitimately submit again (`verify.ts:1156`).
    - A submission that fails validation does not use up the window.
  - **Typed output contracts.**
    - Every string `output_contract` in `src/workflow/templates.ts` is converted to an `output_schema` (JSON Schema validated with zod, the path `IMPLEMENT` already uses). Enums such as `PASS|FAIL|BLOCKED` are encoded in the schema.
    - The string-contract code path stays for stored or user definitions (backward compatibility).
    - The prompt renders the contract from the schema, so the prompt and the validator cannot diverge.
  - **git merge/rebase.** `ALWAYS_DENIED` gains local `git merge` and `git rebase` (also `pull --rebase` and `pull` with merge) inside worktrees.
  - **Prompt text.** Prompt lines whose rule is now enforced become short informational notes. The harness is the source of truth. No enforced rule depends on prompt text.
- **FR-011 (mandatory) Bounded repair, unified accounting.**
  - The four repair loops keep their existing caps and semantics.
  - The lifecycle records one `repairs` ledger per attempt: kind, round, signature, outcome.
  - In-session verify repair keeps `max_repairs` ≤ 5 and the stop on a repeated signature.
  - Every repair round counts against `max_tool_calls` and the attempt timeout. It does not get a fresh budget.
- **FR-012 (mandatory) Evidence persistence and finalization.**
  - `finalize` writes one `harness_evidence` artifact per attempt with:
    - the stage timings and outcomes;
    - guarantees required, provided and degraded;
    - failure code;
    - tool-call count;
    - cost and `cost_enforcement`;
    - the repairs ledger;
    - checkpoint source (fresh, resume or replay);
    - `context_pack` reuse flag;
    - execution contract revision.
  - It uses the existing artifact mechanism (`ctx.artifact`) and `recordMetrics`. No new table, unless a field must be queryable, in which case it goes in a migration and the plan is updated first.
  - The existing outputs keep their shape: `implementation_evidence`, `scope_check`, `tested_heads`, `execution_contract`.
- **FR-013 (mandatory) Broker relocation.** Move `codex/broker.ts` and `codex/client.ts` to `src/agent/broker/{server,client}.ts`. They are the provider-neutral enforcement transport. Update the imports. Run `npm run arch:baseline` to remove the 8 `no-provider-internals` entries that no longer apply.
- **FR-014 (mandatory) Architecture fitness rules.** Add to `src/architecture/check.ts`:
  - `no-provider-cross-import`: a file under `src/agent/<p>/` must not import from `src/agent/<q>/` for any `q ≠ p`. The broker is no longer under a provider directory.
  - `harness-single-entry`: only `src/workflow/executors/index.ts` and `src/agent/harness/**` may import `src/agent/harness/lifecycle.ts`.
  - `harness-no-workflow-core`: `src/agent/harness/**` must not import `src/workflow/engine.ts`, `scheduler.ts` or `mutations.ts`. The harness returns an `ExecResult` and the engine applies it.
  - Add `"claude"` handling to `PROVIDERS` once `src/agent/claude/` exists, so that `no-provider-from-core` covers it. The existing baseline entries `src/workflow/executors/index.ts -> src/agent/claude.ts` become `-> harness`, and the old entries go stale.
  - Add a unit test (not an arch rule) asserting that `GUARANTEES` and the failure-code table are total over `AgentProvider` and `HarnessFailureCode`.
- **FR-015 (optional) Lifecycle doc.**
  - Add `docs/architecture/execution-lifecycle.md` with the stage table, ownership boundary (FR-003), failure table and guarantee matrix.
  - Link it from `agent-architecture.md` and `workflow-engine-modularization.md`.
  - Add the new rules to `architecture-governance.md`.

### Non-Functional Requirements

- **Behavior preservation:**
  - Phase 2 (extraction) must not change any observable output, artifact, event or state transition. The existing integration suites are the oracle.
  - Behavior changes arrive only in later phases and each one has its own test.
- **Security:**
  - Fail closed: a missing guarantee, a broker error, a tool that bypassed the hook, or a classifier exception all lead to denial or stop, never to allow.
  - No secret values in evidence or logs. Reuse `context/redact.ts` and `integrations/redact.ts`.
- **Performance:**
  - The lifecycle adds no extra DB round-trips per attempt, apart from the single evidence artifact write.
  - The idle and timeout timers are per-process timers.
  - The mid-run cost computation is O(1) per message.
- **Maintainability:**
  - `claude.ts` shrinks to the Claude adapter. The goal is no file in `src/agent/harness/` over about 400 lines.
  - The large `no-circular` baseline cycle must not grow. Shrinking it is welcome but not required.
- **Compatibility:**
  - Existing step configs, stored workflow definitions and string `output_contract`s keep working.
  - The new config fields are optional and have defaults.

### Technical Specifications

- **Reuse, do not duplicate:**
  - `verify.ts verificationLoop` and `verifyEvidence.ts` remain the only verification engine.
  - `toolPolicy.ts decide()` remains the only policy decision point.
  - `executionContract.ts` and `contract.ts` remain the only contract validators.
  - `budgets.ts` and `report/cost.ts` stay the budget and pricing source.
  - `checkpoints.ts` and `git/workspaceCheckpoint.ts` stay the checkpoint store.
  - `context/pack.ts` stays the context builder.
  - The harness **orchestrates**. It does not re-implement any of these.
- **Not added:** a middleware chain, plugin registry, event bus, or a second provider interface beyond `AgentTurn`.
- **Planned layout:**
  ```
  src/agent/harness/
    lifecycle.ts     runLifecycle + LifecycleState + stage order
    stages/preflight.ts, context.ts, authorize.ts, budget.ts, checkpoint.ts,
           execute.ts, output.ts, verify.ts, finalize.ts
    turn.ts          TurnRequest / TurnResult / AgentTurn + adapter table
    cliTurn.ts       shared CLI process runner (spawn/kill/timeout/idle/abort/read-back)
    failure.ts       HarnessFailureCode + mapping table
    evidence.ts      HarnessEvidence builder
  src/agent/broker/server.ts, client.ts   (moved from codex/)
  src/agent/claude/turn.ts                (SDK query() adapter, extracted from claude.ts)
  ```
- **Impact scope:**
  - `src/agent/claude.ts` (split up)
  - `src/agent/{codex,cursor,copilot,antigravity}/{run,stream,policy,hook,bridge}.ts`
  - `toolPolicy.ts`, `platformTools.ts` (`submitResult`)
  - `stepAgent.ts` (new config fields), `providerCapabilities.ts`, `telemetry.ts`
  - `workflow/failures.ts`, `workflow/executors/index.ts`, `workflow/scheduler.ts` (reconcile move), `workflow/templates.ts` (schemas)
  - `src/architecture/check.ts`, `architecture/baseline.json`
  - docs
- **Web UI:** if `providerCapabilities.ts` drives UI controls, the new `idle_timeout_ms` and `max_tool_calls` fields appear in step-agent settings (`web/src/StepAgentFields.tsx`). Only the minimal field addition.

### Constraints

- Keep the modular monolith and the existing lock order (run → job → attempt → step). `stateMachine.ts` stays the only transition policy.
- Do not move claim-transaction logic out of `engine.ts`.
- Work on the current branch. No branch creation. Commits are in English and carry no func/task footer for this repo.
- Minimal diff inside each phase. No drive-by reformatting.
- Live provider CLIs may not be available in CI. Provider behavior is tested with the existing fake-CLI and stream fixtures.

### Test Requirements

- **Characterization, before Phase 2:**
  - Extend `test/harness.integration.ts` and `test/step-agent.integration.ts`.
  - Snapshot `ExecResult`, artifacts and events for each step type: coding, read-only, MICRO, independent review, investigation, resume, waiting_input, reexecute.
  - Run them with a fake turn adapter.
- **Unit tests:**
  - stage ordering and short-circuit on `stop`;
  - failure table totality and the mapping for each code (including the timeout parity bug);
  - `GUARANTEES` totality and the fail-closed preflight matrix (provider × mode);
  - `cliTurn` timeout, idle, abort and incomplete-output detection, using a fake child process;
  - `submitResult` once per turn, with a new window after a repair resume;
  - CI and verify file deny (with and without `allow_ci_edits`);
  - git merge and rebase deny;
  - typed template schemas reject enum violations;
  - tool-call cap;
  - live cost abort, which leads to a pause and not a failure.
- **Integration tests:**
  - all existing `test:integration` suites pass unchanged after Phase 2;
  - a new `harness-lifecycle.integration.ts` covers budget pause mid-run, idle kill → retry, hook bypass → `UNSAFE_SIDE_EFFECT`, `GUARANTEE_UNMET` for a write step on a degraded provider, and evidence artifact contents.
- **Architecture:** `test/architecture.test.ts` gets a synthetic-graph unit test for each new rule. `npm run arch:check` passes with a smaller baseline.
- **Acceptance criteria:**
  1. `agentExecutor.execute` no longer exists, and `runLifecycle` is the only executor path for `agent` and `coding_agent`.
  2. Each validator (authorization, output contract, terminal outcome, MICRO scope) is called once per attempt in the lifecycle. Verify by grepping the call sites.
  3. All 5 providers return a `TurnResult` with structured `failure` codes. A timeout gets the same retry decision whichever provider produced it.
  4. A write step on a provider that lacks a required guarantee fails before any tool runs.
  5. `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration` and `npm run arch:check` all pass.

### Outstanding Issues

1. **Cursor hooks.** Does the installed cursor-agent CLI support `.cursor/hooks.json` (beforeShellExecution, beforeReadFile, and similar) well enough to route policy through the broker? Phase 5 must check the CLI version and its docs.
   - If yes: wire it the same way as copilot.
   - If no: cursor is refused for write steps. This is a user-visible behavior change and must go in the release notes.
2. **Protected verify files.** Should `package.json` count as a protected verify file when the verify command is `npm test`? Planned default: **no**, because agents legitimately edit dependencies. Only path tokens and CI directories are protected. Revisit if abuse is seen.
3. **Mid-run cost for codex, copilot and antigravity** is not possible with the current CLIs, which report usage only at the end. The plan uses preflight-only enforcement plus the tool-call proxy. Confirm this is acceptable, or decide to add a per-provider cost-per-tool-call estimate later.
4. **Existing runs.** In-flight runs with `pending.resume` checkpoints written by the old executor must resume under the new lifecycle. The checkpoint shape is unchanged, but Phase 2 should include one resume test that uses an old-shaped checkpoint.

## Task Breakdown

### Dependency graph

```
P0 characterization ─┐
P1 failure taxonomy ─┼─> P2 lifecycle extraction ─> P4 parity/fail-closed ─> P5 in-run controls
P1b broker move ─────┘            │                                          │
                                  └─> P3 shared CLI turn runner ─────────────┘
P6 prompt→code (needs P2 for submit window; templates part independent)
P7 evidence/finalize (needs P2, P4, P5) ─> P8 fitness rules + docs
```

### Phases

**P0: Characterization tests**

- Files: `test/harness.integration.ts`, `test/step-agent.integration.ts`, a new fake turn adapter fixture under `test/fixtures/`.
- Freeze the current `ExecResult`, artifacts and events for each step type listed in Test Requirements.

**P1: Failure taxonomy**

- Files:
  - `src/agent/harness/failure.ts` (new)
  - `src/agent/telemetry.ts`
  - `src/workflow/failures.ts`
  - `src/agent/claude.ts` (`TERMINAL_FAILURES` and the `provider_error` map → table)
  - `codex/stream.ts` (add rate_limit), `copilot/stream.ts` and `antigravity/stream.ts` (single classifier)
  - `cursor/run.ts` (set `failure`)
- Fixes the timeout parity bug.

**P1b: Broker relocation**

- Files: `src/agent/broker/{server,client}.ts` (moved), importers in all provider dirs, `architecture/baseline.json` (regenerated).

**P2: Lifecycle extraction (behavior-preserving)**

- Files:
  - `src/agent/harness/{lifecycle,turn}.ts`
  - `stages/*.ts`
  - `src/agent/claude/turn.ts`
  - `src/agent/claude.ts` (shrinks)
  - `src/workflow/executors/index.ts`
  - `src/workflow/scheduler.ts` (fingerprint reconcile → `stages/checkpoint.ts`)
- Remove the repeated validator calls in favor of `LifecycleState`. The P0 suite must pass unchanged.

**P3: Shared CLI turn runner**

- Files: `src/agent/harness/cliTurn.ts`, `codex|cursor|copilot|antigravity/run.ts`, and a single `excludeFromGit`.
- Adds the idle watchdog and incomplete-output detection for copilot and antigravity.
- Adds an incomplete-output check to the Claude adapter.

**P4: Guarantee matrix and fail-closed preflight**

- Files:
  - `providerCapabilities.ts` (`GUARANTEES`)
  - `stages/preflight.ts`
  - `copilot|antigravity/run.ts` (mandatory sandbox for write; hook-bypass detection)
  - `toolPolicy.ts` (network deny in write mode)
  - `cursor/*` (hooks or refusal, per Outstanding Issue 1)

**P5: In-run controls**

- Files:
  - `stepAgent.ts` (`idle_timeout_ms`, `max_tool_calls`)
  - `config.ts` (defaults)
  - `toolPolicy.ts decide()` (tool-call counter; `ToolLoopDetector.record` for every provider)
  - `stages/budget.ts` (preflight remaining vs projected)
  - `src/agent/claude/turn.ts` (live cost)
  - `stages/execute.ts` (abort → pause with a `budget` event)
  - `web/src/StepAgentFields.tsx` (two fields)

**P6: Rules moved from prompts to code**

- Files:
  - `toolPolicy.ts` (CI and verify file deny, git merge and rebase deny)
  - `platformTools.ts` (submit window)
  - `stages/execute.ts` and `stages/verify.ts` (open a new window for each turn and repair)
  - `src/workflow/templates.ts` (string contracts → `output_schema`)
  - `stepPrompt.ts` (render the contract from the schema; trim enforced prose)

**P7: Evidence and finalization**

- Files: `stages/finalize.ts`, `src/agent/harness/evidence.ts`.
- Write the `harness_evidence` artifact and the repairs ledger. `revalidateContract` runs once. `INVALID_EVIDENCE` is wired in.

**P8: Fitness rules and docs**

- Files:
  - `src/architecture/check.ts` (3 rules, claude in `PROVIDERS`)
  - `test/architecture.test.ts`
  - `architecture/baseline.json`
  - `docs/architecture/{execution-lifecycle,architecture-governance,agent-architecture}.md`

### Execute handoff

- **Decisions:** see "User decisions". Defaults settled by the plan:

  | Setting                  | Value                                                 |
  | ------------------------ | ----------------------------------------------------- |
  | `timeout_ms`             | 45 min                                                |
  | `idle_timeout_ms`        | 10 min (MICRO 3 min)                                  |
  | `max_tool_calls`         | 400 (MICRO 20)                                        |
  | Budget exhausted mid-run | pause, not fail                                       |
  | `submit_result`          | once per turn, a new window per repair or resume turn |
  | `package.json`           | not protected                                         |

- **Order:** P0 → P1/P1b → P2 → P3 → P4 → P5 → P6 → P7 → P8. Commit each phase separately, and make sure each commit passes `npm run typecheck && npm test && npm run arch:check`. Run `npm run test:integration` at the end of P2, P5 and P8.
- **References:**
  - `docs/architecture/agent-architecture.md:137-170` (harness loop)
  - `docs/architecture/workflow-engine-modularization.md` (lifecycle and transaction map, lock order)
  - `docs/architecture/execution-checkpoints.md`
  - `docs/architecture/architecture-governance.md`
  - `codex/run.ts:557` (hook-bypass pattern to copy)
  - `verify.ts:1063-1100` (repair loop)
  - `workflow/budgets.ts:16` (estimator to reuse)
- **Constraints:**
  - Never weaken an existing deny rule.
  - Do not add a second verification engine, policy decision point or provider interface.
  - If P2 changes any characterization snapshot, stop and report instead of updating the snapshot.
  - If the cursor hooks check (Outstanding Issue 1) is inconclusive, implement the refusal path and flag it.
