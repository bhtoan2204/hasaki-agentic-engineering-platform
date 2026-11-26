# CodeAct C — Reliable Paired A/B Evaluation

Branch `feat/codeact-diagnostics-eval-reliability`, 2026-11-22. Private PostgreSQL cluster, real OS sandbox,
simulated or scripted providers (no paid call).

## Root causes (confirmed in source)

| Problem | Why | Evidence |
| --- | --- | --- |
| Pilot stopped with an incomplete pair (T08 Direct without T08 CodeAct) | Budget and sample checks ran **before every sample**, not every pair. Once a sample pushed known spend past the budget, the next sample, the second half of the pair, was refused. | `runEvaluation` (before): checks inside the per-variant loop; pilot `stopped: "budget 1 USD reached (known spend 1.0242)"` after 7 samples. |
| Variants could contaminate each other and other conversations | `runSample` set the process-global `config.codeAct.enabled` and the global chat provider seam (`setChatProviders`). Any concurrent sample, or an ordinary conversation in the same process, saw the other variant's capability and runner. | `codeactEffect.ts` (before) `config.codeAct.enabled = variant === "codeact"`. The new isolation test fails on the old code: the flag flips while samples run. |
| Availability, adoption and usage outcomes were mixed | The report had one paired Δ table and an adoption count. Nothing separated "CodeAct available" from "CodeAct used", and nothing marked usage outcomes as agent-selected. | Pilot T03: the CodeAct-enabled sample was correct without running CodeAct. |

## What changed

- `src/codeact/scope.ts`: `withCodeActScope(enabled, fn)` and `codeActEnabled()`, based on AsyncLocalStorage.
  - Every reader of the switch now goes through it: `codeActAvailability`, the chat tool list, workflow context tools,
    the step prompt and the MCP bridge env.
  - Outside a scope the installation default applies, so CodeAct stays off by default.
  - Only evaluation code opens a scope. The sandbox, broker and authorization are unchanged.
- `src/chat/runtime.ts`: `withChatProviders(p, fn)` sets the runner for turns started inside `fn`. `runTurn` uses the
  scoped providers, then the global seam.
- `src/eval/codeactEffect.ts`:
  - `runSample` runs its post inside both scopes and mutates nothing process-wide.
  - `runEvaluation` schedules by pair:
    - A pair starts only if both samples fit `maxSamples` and the remaining budget covers the estimated pair cost
      (2 × mean known cost per sample).
    - The first pair runs on an unknown estimate.
    - An admitted pair is completed, and any overshoot is reported.
    - A sample that cannot run leaves an incomplete pair (kept, with its cost) and stops the evaluation.
    - An invalid pair (capability leak, or variants on different provider-reported models or efforts) stops the
      evaluation before more spend.
  - Returns `pairs` and `budget` (`limit_usd`, `known_spend_usd`, `overshoot_usd`, `unknown_cost_samples`,
    `enforcement: best-effort`).
  - `summarize` adds:
    - `intention_to_treat` (A): paired Δ over complete pairs, including verified correctness.
    - `adoption.adoption_rate_ci95` (B, Wilson).
    - `usage_outcomes` (C, labeled observational).
    - `capability_check`: Direct must never be offered `code.execute` and CodeAct always must; otherwise the Markdown
      prints "INVALID comparison".
    - `incomplete_pairs` with their cost, `spend`, and a note when there are fewer than 10 complete pairs.
- `src/eval/codeactTasks.ts`: `eval.traces` and `eval.logs` accept bounded `limit`/`offset` (`total`, `next_offset`),
  for both variants alike. Unpaged responses are unchanged, so the reference answers do not move. No question carries
  a plan or hint.
- `src/cli/evalCodeAct.ts`:
  - `--live` now requires `--model`, so both variants are pinned, and `--max-samples ≥ 2`.
  - Adds `--effort`.
  - The report includes `budget` and `pair_schedule`.

## Verification

| Level | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `node --import ./test/env.ts --test test/codeact-effect-report.test.ts` | 0 | 6/6: ITT/adoption/observational separation, capability leak → invalid, model checks |
| 2 | `node test/run-integration.ts test/codeact-pairing.integration.ts` | 0 | 5/5: 4 concurrent samples plus an ordinary conversation, no leak and global flag never flips; pair not started when the estimate exceeds the remainder; first pair overshoot reported; allowance needs 2; incomplete pair kept and costed |
| 2 | `node test/run-integration.ts test/codeact-effect.integration.ts` | 0 | 10/10 (paging fairness test added) |
| 2 | chat, codex, CodeAct and incident suites (11 files) | 0 | 100/100 |
| 3 | `npm run eval:codeact -- --repetitions 2 --out docs/validation/codeact-c-fixture-sandbox.json` (OS sandbox, simulated) | 0 | 20 complete pairs, `capability_check.valid`, no incomplete pair |
| – | `npm test` | 0 | 1165/1165 |

### Overhead: same fixture run at `main` (`56824d6`, temporary worktree) vs this branch

| | base Direct | new Direct | base CodeAct | new CodeAct |
| --- | --- | --- | --- | --- |
| verified correct | 10/20 | 10/20 | 20/20 | 20/20 |
| tool-result chars (mean) | 4445.8 | 4445.8 | 719.5 | 735.0 |
| prompt chars total (mean) | 13658.6 | 13658.6 | 7279.8 | 7293.7 |
| latency ms (mean) | 92.6 | 89.8 | 141.0 | 142.9 |

The +15.5 chars per CodeAct answer is the new `execution_id` field. The latency differences are within run-to-run
noise. These are **fixture and simulated-provider numbers**, not model results.

## Limitations

- The budget is best-effort: there is no provider hard cap. An admitted pair can overshoot, and the overshoot is
  reported.
- The scope follows the async context. Work started outside it, such as the stale-turn recovery poller, sees the
  installation default. That is the safe direction (off).
- Paging lets a capable direct strategy avoid truncation. The simulated policy still does not page, so its Direct
  failures remain an upper bound for a naive strategy.
