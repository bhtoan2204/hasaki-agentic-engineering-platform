# Agent Harness — Execution Efficiency, Context Continuity and Verification Reuse

Branch `feat/harness-efficiency` from `main` @ `8e6a917`, 2026-11-22. Deterministic fixtures, the private PostgreSQL
test cluster, the real Workflow Engine and Agent Harness (Codex provider path through the fake `codex` CLI). **No paid
provider run** (no budget authorized). No VPN-only integration was used. Simulated or scripted results here are **not**
evidence of model-level cost savings.

## 1. Baseline audit: confirmed defects vs hypotheses

| Area                                                          | Finding                                                                                                                                                                                                                                                                                                                                                                           | Status                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Verify-and-repair loop                                        | After every repair the whole verification ran again, even when the repair changed **nothing**. Failed evidence is (correctly) never reused, so identical source was re-tested in full, and only then did the "same signature twice" rule stop the loop.                                                                                                                           | **Confirmed** (baseline measured below). Fixed.                                                                      |
| Rejected submissions                                          | When `submit_result` was rejected by the output contract and the agent ended its turn, the harness reported "finished the turn without calling submit_result" (`INCOMPLETE_OUTPUT`). That is wrong and hides the reason. Observed in a real engine run (RCA workflow arm, `missing required field: hypotheses`), and encoded as expected behavior in `test/codex.integration.ts`. | **Confirmed.** Fixed (accuracy; no latency gain, see §3).                                                            |
| Verification evidence reuse                                   | The key binds workspace fingerprint (HEAD + uncommitted content, untracked files included), environment fingerprint, command and contract revision. Failed, stale or incomplete evidence is not reused (`verifyEvidence.ts`). Reuse is recorded in `execution_decisions` (`verification_reuse`).                                                                                  | Audited, correct. No change.                                                                                         |
| Independent review reuse                                      | The reuse key covers reviewer, test evidence, approved scope (including renewed-approval revision), review policy (rules version, step config, provider), and identical verified commits (`independentReview.ts`).                                                                                                                                                                | Audited, correct. No change.                                                                                         |
| Failure policy                                                | `AUTHENTICATION`, `QUOTA_EXHAUSTED`, `CONTEXT_LIMIT`, `NO_PROGRESS`, budget and security codes are never retried. Transient codes retry within `max_attempts`.                                                                                                                                                                                                                    | Audited. No pointless retries found. No change.                                                                      |
| Session loss during repair                                    | The repair continues in the same provider session. When it is gone, it rebuilds from durable state (pack + workspace + diagnostics). When context is under pressure, it compacts to a fresh session reconstructed from platform state, not from an LLM summary.                                                                                                                   | Audited. No change.                                                                                                  |
| Prompt and context reconstruction, duplicate upstream outputs | Context pack is reused when inputs match. Delta resume (delivery manifest). Upstream outputs are summarized under a token budget.                                                                                                                                                                                                                                                 | No measurable waste found in fixtures. **Hypothesis only**: real-provider measurements would be needed. Not changed. |

## 2. Change 1: a repair that changed nothing is not re-verified

- **What changed:**
  - `src/agent/verify.ts`: `sourceUnchangedSince(ws, failed)` compares every workspace's current `worktreeFingerprint`
    with the `tested_state` recorded by the failed round.
  - `verificationLoop` takes an `unchanged` hook. After a repair, if the source is identical, it stops with
    `outcome: no_progress, reason: unchanged_source` instead of running the verification again. Verification is
    deterministic in the source, so re-running cannot change the result.
  - **Fails closed:** a repo without a recorded tested state, a missing workspace or any error counts as "changed",
    so the tests run.
- `src/agent/harness/stages/verify.ts`:
  - Wires the hook.
  - Records an `execution_decisions` row (`recovery` / `STOP`, reason "repair N changed no source …").
  - Reports "made no progress (the repair changed no source; verification was not re-run)".
  - `metrics.verification.stop_reason = "unchanged_source"`.
- **Verification is not weakened:** the step still fails (a failure stays a failure); nothing passes without tests. Any
  change, including a new untracked file, is verified again.

### Tests

| Command                                                               | Result                                            |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `node test/run-integration.ts test/harness-efficiency.integration.ts` | 5/5 (real git worktrees, real `verifyWorkspaces`) |

The 5 cases:

- unchanged repair: **1** verification run, `no_progress` / `unchanged_source`;
- baseline without the hook: **2** runs;
- changed repair: re-verified (2 runs);
- untracked file counts as a change; unknown tested state and missing workspace fail closed;
- rejected-submission case (§3).

**End to end:** `test/execution-contract-runtime.integration.ts` "a repair that changes nothing stops the verify loop
…". It runs the real FAST graph: approval, coding agent through the harness, fake Codex writing a failing value, `go
test -json`, then a repair turn that changes nothing. The step FAILS with the new message, the decision is recorded, and
the verification metrics show `rounds 1, repairs 1, stop_reason unchanged_source`.

### Measured delta (same end-to-end scenario, 2 runs each; baseline = the hook removed)

|           | rounds | verification ms | coding step ms | provider turns                           |
| --------- | ------ | --------------- | -------------- | ---------------------------------------- |
| baseline  | 2, 2   | 4335, 4210      | 8880, 8899     | unchanged (the repair turn runs in both) |
| optimized | 1, 1   | 3760, 3913      | 7601, 8549     | unchanged                                |

The saving is one complete verification run per no-op repair. The fixture's `go test` of one function is cheap (about
0.4 s here, with a warm build cache); with a real suite it is the suite's whole duration. Provider cost is unchanged:
the repair turn itself still happens.

## 3. Change 2: a rejected submission is reported as what it is

- **What changed:**
  - `src/agent/platformTools.ts` `submit_result`: a contract rejection writes a `workflow_checkpoints` row
    (`reason: submit_rejected`, only the validation errors, **not** the rejected output).
  - `src/agent/harness/stages/output.ts`: when nothing valid was submitted and the attempt's latest submission was
    rejected, the result is `CONTRACT_INVALID` with the errors ("… its submit_result was rejected by the step's
    output contract: missing required field: hypotheses"), not `INCOMPLETE_OUTPUT`.
  - This covers every provider, since all of them submit through the same platform tool.
- **Effect:** the diagnosis and recovery category are correct (`contract_invalid` instead of a transient
  "incomplete" error), and the reason is visible to operators and to the resumed session.
- **No latency gain:** the engine still retries within `max_attempts`, with the same 5 s delay (measured: recovery
  decision `RESUME`, `delay_s: 5`). It is a correctness and observability fix, not a performance one.
- **Tests:**
  - `test/harness-efficiency.integration.ts` (real engine + harness + fake Codex): `CONTRACT_INVALID` with the reason;
    durable `submit_rejected` checkpoint without the output.
  - `test/codex.integration.ts` now expects the accurate message for its `bad-contract` case. The old assertion
    encoded the defect. The `no-submit` case still reports "without calling submit_result", and invalid outputs are
    still never recorded as `submit_result`.

## 4. Cross-provider semantics

Both changes sit on shared paths:

- the verification loop belongs to the harness `verify` stage, whatever the provider;
- `submit_result` is the shared platform tool, in process for Claude and through the broker or bridge for the CLIs.

The Codex, Antigravity, step-agent, execution-contract, harness, incident and RCA workflow suites pass (§5). No provider
guarantee or policy changed. `GUARANTEES` and fail-closed preflight are untouched.

## 5. Verification

| Command                                                                                                                                                                        | Exit                               | Result                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit -p .`, `npm run lint`, `npm run arch:check`                                                                                                                  | 0                                  | clean; 5 cycles / 6 violations (baseline)                                                                                                                                                                |
| `npm test`                                                                                                                                                                     | 0                                  | 1200/1200                                                                                                                                                                                                |
| affected integration suites (harness-efficiency, harness, execution-contract-runtime, codex, antigravity, step-agent, incident-investigation, rca-three-arm, codeact-evidence) | 0 after the codex assertion update | 141/141                                                                                                                                                                                                  |
| `npm run test:integration`                                                                                                                                                     | 1                                  | 965/968, 0 skipped. The 3 failures are the known pre-existing local ones (`evaluation.integration.ts` ×2, reproduced on `f666c65`; `repository-remotes`, from the host `~/.gitconfig`). They pass on CI. |

## 6. Not done and limitations

- **Benchmarks of the remaining scenario types are not new measurements.** Covered by existing deterministic suites,
  with no new deltas claimed:
  - one-file and multi-file implementation: execution-contract-runtime;
  - failed test then repair: engine and harness;
  - infrastructure verification failure (`outcome: error`, not repaired): harness;
  - session interruption and rebuild: harness and codex `resume-missing`;
  - compaction: compaction tests;
  - unchanged re-execution with verification reuse: verify-evidence tests;
  - incremental review and source-revision invalidation: engine independent-verification tests;
  - unauthorized modification: policy and scope-guard tests.
- **No model-level savings are claimed.** Measuring provider turns, tokens and cost per scenario needs a paid run with
  an approved budget.
- **Context continuity:** no confirmed defect was found, so nothing was changed there. An LLM summary still never
  replaces checkpoint evidence (compaction rebuilds from platform state).

## 7. Delivery

- **Commits:** on branch `feat/harness-efficiency`.
- **CI on this branch: NOT VERIFIED.** CI runs on pushes to `main` and on pull requests, and no PR could be opened
  (`gh` not authenticated).
- **Live provider: NOT RUN — BUDGET NOT AUTHORIZED.**
