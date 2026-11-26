# Agent execution lifecycle

Every `agent` and `coding_agent` attempt runs through one lifecycle, whatever the provider (Claude, Codex, Cursor,
Copilot, Antigravity). `src/agent/harness/executor.ts` is the registered executor. It calls `runLifecycle`
(`src/agent/harness/lifecycle.ts`), which runs nine stage functions in a fixed order. A stage either lets the next one
run or stops the attempt with its `ExecResult`. `finalize` always returns one.

Values a stage computes once (provider, policy, guarantees, context pack, resumable session, turn result, submitted
output, verification rounds) live in `LifecycleState` (`src/agent/harness/state.ts`). Later stages read them instead of
recomputing them. There is no middleware chain: the stages are plain functions in `src/agent/harness/stages/`.

## Ownership

| Phase           | Owner                                      | What it covers                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim (stage 0) | `engine.ts` `beginAttempt`, `scheduler.ts` | Lease and fencing, owner and writer gates, provider health switch, input and context snapshot, repository access, replay lookup, workspace fingerprint reconciliation, run-level `budgetPreflight` before the job is queued. These run inside the claim transaction and its lock order (see [workflow engine modularization](workflow-engine-modularization.md)). |
| Attempt         | `src/agent/harness`                        | The nine stages below, from executor entry to the returned `ExecResult`.                                                                                                                                                                                                                                                                                          |
| Accounting      | `engine.ts` `finishAttempt`                | Applies the result through `stateMachine.ts`, classifies failures, charges spend with `enforceBudget`.                                                                                                                                                                                                                                                            |

The harness never imports the engine, scheduler or mutation modules. It returns a result and the engine applies it.

## Stages

| Stage        | Responsibility                                                                                                                                                                                               | Reuses                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `preflight`  | Configuration recovery, assigned skills, repository checkouts and workspace conflicts, provider guarantees (fail closed), provider capability, self-repository isolation, workspace restore, MICRO admission | `git/provider.ts`, `providerCapabilities.ts`, provider `capabilities` |
| `context`    | Tool policy context (worktrees, protected paths, network), routing, metrics, context pack (reused when inputs match)                                                                                         | `toolPolicy.ts`, `context/pack.ts`                                    |
| `authorize`  | Mandatory execution contract for implementation steps                                                                                                                                                        | `executionContract.ts`                                                |
| `budget`     | Tool-call budget for the attempt, remaining run or work-item spend                                                                                                                                           | `report/cost.ts`                                                      |
| `checkpoint` | Implementation baseline, resumable provider session, prior verdict reuse or incremental re-review                                                                                                            | `implementationEvidence.ts`, `independentReview.ts`                   |
| `execute`    | Prompt assembly and the provider turn (resume first, rebuild from durable state when the session is gone)                                                                                                    | `stepPrompt.ts`, `harness/turn.ts`                                    |
| `output`     | Submitted output against the step's output contract, coding outcome normalization, investigation evidence                                                                                                    | `contract.ts`, `evidence.ts`                                          |
| `verify`     | Independent verdict gates, or the bounded verify-and-repair loop                                                                                                                                             | `verify.ts`, `verifyEvidence.ts`                                      |
| `finalize`   | Approved-scope integrity, implementation evidence, contract re-authorization, final contract validation                                                                                                      | `scopeGuard.ts`, `executionContract.ts`                               |

After the lifecycle ends, with a result or an exception, the executor writes one `harness_evidence` artifact: stage
trace and timings, outcome and failure code, guarantees, tool calls used, reported cost and how it was enforced, verify
rounds, checkpoint source, context pack size and the execution contract revision.

The step inspector shows this evidence as a "Harness lifecycle" card. Trace Explorer shows the stages as `stage` nodes under the attempt, with cumulative offsets from its start. Replay, recovery and reuse decisions are recorded separately in `execution_decisions` (see [DAG replay](dag-replay.md#decision-log)).

## Provider turns

`TURN_ADAPTERS` (`src/agent/harness/turn.ts`) maps each provider to one function that returns a `TurnResult`. The CLI
providers share `src/agent/harness/cliTurn.ts`:

- `superviseTurn` stops a turn once, for cancellation, the wall-clock limit or idle, and reports `CANCELED`,
  `EXECUTION_TIMEOUT` or `IDLE_TIMEOUT`. Activity is a provider stream event, a hook call or a platform tool request;
  a running shell command is silent, so the idle limit stays above the longest tool timeout. The Claude SDK turn uses
  the same watchdog and its PreToolUse hook counts as activity.
- `turnLimits`: step `timeout_ms` / `idle_timeout_ms`, then the provider config, then `agent.turnTimeoutMs` (45 min) and
  `agent.idleTimeoutMs` (30 min; MICRO at most 3 min).
- `readSubmitted` (only what the current turn submitted) and `adoptRunWorkspaces` replace per-provider copies.

Policy enforcement goes through `toolPolicy.ts` `decide()` for every provider: in process for Claude, through the
broker (`src/agent/broker`) for the hook-based CLIs. `decide()` also counts the attempt's allowed native tool calls
against its budget and feeds the loop detector. The broker counts `PreToolUse` hook calls separately from telemetry
hooks: a native tool that appears before any `PreToolUse` call stops the turn.

## Guarantees

`GUARANTEES` in `src/agent/providerCapabilities.ts` declares what each adapter enforces. `preflight` fails closed:

| Guarantee                                                             | Claude | Codex | Copilot | Antigravity | Cursor |
| --------------------------------------------------------------------- | ------ | ----- | ------- | ----------- | ------ |
| `pre_tool_policy` (every native tool decided before it runs)          | yes    | yes   | yes     | yes         | no     |
| `hook_bypass_detection` (a tool that skipped the hook stops the turn) | yes    | yes   | yes     | yes         | no     |
| `write_sandbox` (OS-level write confinement)                          | no     | yes   | yes     | yes         | no     |
| `network_isolation`                                                   | no     | yes   | no      | no          | no     |
| `reported_cost` (cost known when a turn ends)                         | yes    | no    | no      | no          | no     |
| `incomplete_detection`                                                | yes    | yes   | yes     | yes         | yes    |
| `resume`                                                              | yes    | yes   | yes     | yes         | yes    |

- Implementation steps need `pre_tool_policy` and `hook_bypass_detection`, plus `write_sandbox` where the provider has
  one. A step that turns the sandbox off is refused. Today Cursor cannot run implementation steps: the installed CLI
  has no pre-execution hook, and its watcher can only stop a tool after it started.
- Read-only steps run without missing preferred guarantees and the attempt log and evidence record them.
- Web tools are denied while a step can write, unless the step sets `config.network: true`.

## Failures

`src/agent/harness/failure.ts` holds the single failure table. Each code maps to engine retry, in-attempt rebuild, the
engine recovery class and the `provider_error.code` read by provider handoff. Results carry `details.failure_code`, and
`classifyFailure` uses its class before the error-text rules.

| Condition                                                                | Code                                                 | Handling                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Cancellation                                                             | `CANCELED`                                           | Process tree killed; never retried                                          |
| Wall-clock limit                                                         | `EXECUTION_TIMEOUT`                                  | Retried within `max_attempts` for every provider                            |
| No stream activity                                                       | `IDLE_TIMEOUT`                                       | Retried within `max_attempts`                                               |
| Same failure twice in verification, or a tool loop                       | `NO_PROGRESS` / loop denial                          | Stops for a human                                                           |
| Remaining spend reached before another turn (`costBudget.action: pause`) | `BUDGET_EXHAUSTED`                                   | Step waits for the developer; a `budget` event marks the scope acknowledged |
| Tool-call budget used up without a result                                | `TOOL_BUDGET_EXHAUSTED`                              | Fails, not retried                                                          |
| Provider error                                                           | `RATE_LIMIT`, `QUOTA_EXHAUSTED`, `AUTHENTICATION`, … | Per the table                                                               |
| No result, reply or submission                                           | `INCOMPLETE_OUTPUT`                                  | Retried with session resume                                                 |
| Output contract mismatch                                                 | `CONTRACT_INVALID`                                   | Retried inside the attempt; the final check is not retried                  |
| Missing or stale implementation or verification evidence                 | `INVALID_EVIDENCE`                                   | Fails, not retried                                                          |
| Tool ran without the platform hook                                       | `UNSAFE_SIDE_EFFECT`                                 | Turn killed, not retried                                                    |
| Provider cannot guard the step                                           | `GUARANTEE_UNMET`                                    | Fails before any turn                                                       |

Cost is only reported when a turn ends (and only by Claude), so spend is checked between turns of an attempt, not in
the middle of one. The tool-call budget (`max_tool_calls`, default 400) is the in-turn limit for every provider.

## Rules enforced in code, not prompts

- Edits and shell writes to CI configuration (`.github/`, `.gitlab-ci.yml`, …) and to script paths named in the fixed
  verification command are denied unless the step sets `config.allow_ci_edits`. Because a shell can write in ways no
  command check sees, `finalize` also fails the step (`POLICY_VIOLATION`) when such a file changed since the step's
  implementation baseline. Runner manifests (`package.json`, `Makefile`) are not protected.
- `git merge`, `rebase` and `pull` are denied; `push`, history rewrites and branch changes already were.
- `submit_result` records one output per turn; a repair turn opens a new one.
- String output contracts are validated field by field, including enums, nested shapes, `number[]` and nullable unions.
