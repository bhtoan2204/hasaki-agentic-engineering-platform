# CodeAct D — Selection and Recovery Guidance

Branch `feat/codeact-diagnostics-eval-reliability`, 2026-11-22.

## Baseline and finding

- Chat `code.execute` said: "Use it when several lookups must be correlated; call a single tool directly with
  tools.call."
- Workflow `execute_code` said: "Use it when 3+ deterministic lookups would otherwise each need a turn; call single
  tools directly."

Neither mentioned result **size**. Yet the measured Direct failures (T03/T04/T05/T08/T09, fixture) come from a single
large result truncated at 6,000 chars, not from many lookups. Neither said what to do after a failure. The two
surfaces also disagreed: one used a count threshold, the other "several".

The pilot's non-adoption (1/2 eligible turns) is **not** treated as a defect: one sample cannot show whether the
choice was wrong.

## What changed

- `src/codeact/guidance.ts`: one `CODEACT_GUIDANCE` for both surfaces.
  - Prefer a direct call for one small, bounded lookup or a single piece of evidence.
  - Use a program when results would be large (filter or aggregate in code), when several read-only results must be
    correlated, or when direct calls would take several rounds.
  - On failure, read `failure`/`recovery`: retry once for a program or argument error, narrow after a size or budget
    failure, never retry an unavailable or unauthorized capability, and fall back to direct calls.
- Chat `code.execute`, workflow `execute_code` and the step prompt's capability line now use it. The fixed
  "3+ lookups" threshold is gone.
- Recovery advice arrives with every failure (`recovery.retry` and `hint`, Milestone A). It agrees with the guidance.
  Unavailable, startup, IPC and canceled failures always say `no`.
- Not done, by design:
  - No planner or router.
  - No forced or speculative execution.
  - No generated program without an agent's call.
  - No new tools; authorization and taint handling unchanged.

## Overhead

| Description | Before | After |
| --- | --- | --- |
| chat `code.execute` (native definition, incl. example) | 738 chars | 1095 chars |
| workflow `execute_code` | 738 chars | 1089 chars |

That is about +90 tokens by the chars/4 **estimate**, only where CodeAct is offered. A disabled CodeAct is still not
advertised.

## Verification

| Level | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `node --import ./test/env.ts --test test/codeact-guidance.test.ts` | 0 | 4/4: same guidance on both surfaces, no count threshold, recovery wording agrees with `recoveryAdvice`, size bound |
| 2 | `node test/run-integration.ts test/codeact-effect.integration.ts test/codeact-composition.integration.ts test/chat-agentic.integration.ts` | 0 | 27/27 |
| – | `npm test` | 0 | 1169/1169 |

Deterministic dataset checks with the simulated policy (C report, OS sandbox):
- T01 and T10 never use CodeAct (0/2 each).
- T03, T06 and T08 are solved with one program each.
- T09 reports the SigNoz outage explicitly.
- The T06 fault fixture recovers with exactly one further program (A).

These check the harness and the eligibility logic only. **Whether a model follows the guidance is NOT VERIFIED**:
that needs the live pilot.
