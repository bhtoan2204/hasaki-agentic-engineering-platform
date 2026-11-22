# CodeAct E — Verification Summary and Next Live Pilot

Branch `feat/codeact-diagnostics-eval-reliability` from `main` @ `56824d6`.

| Milestone | Commit | Evidence |
| --- | --- | --- |
| A Failure diagnostics and recovery accounting | `6a6c4a5` | [codeact-a-failure-diagnostics.md](codeact-a-failure-diagnostics.md) |
| B Provider, model, turn and token accounting | `4349f92` | [codeact-b-provider-accounting.md](codeact-b-provider-accounting.md) |
| C Pair-aware evaluation and isolation | `f4d2c5c` | [codeact-c-paired-evaluation.md](codeact-c-paired-evaluation.md), [codeact-c-fixture-sandbox.json](codeact-c-fixture-sandbox.json) |
| D Selection and recovery guidance | `f20b721` | [codeact-d-selection-guidance.md](codeact-d-selection-guidance.md) |

**LIVE PROVIDER: NOT RUN — awaiting budget authorization.** The previous $1 pilot does not authorize another run.
Every result on this branch is a unit, integration or runtime (OS sandbox) result with fixture data and a simulated or
scripted provider. None shows how a real model behaves.

## Proposed live pilot (requires explicit approval of the budget)

```
npm run eval:codeact -- --live --provider claude --model claude-sonnet-5-5 --effort medium \
  --tasks T01-single-lookup,T03-trace-log-correlation,T06-refund-timeout,T08-large-aggregation,T09-partial-failure,T10-codeact-unnecessary \
  --repetitions 2 --max-samples 24 --budget-usd 5 \
  --out docs/validation/codeact-live-pilot-2.json
```

- **Model.** Pinned `claude-sonnet-5-5`, the same for both variants (the CLI refuses `--live` without `--model`).
  The previous pilot used the account default, and its model is unknown. Sonnet costs less per pair. Pin
  `claude-opus-5-5` instead if the question is about the production chat model.
- **Tasks.** 6 tasks:
  - T01 and T10 check for unnecessary use.
  - T03 and T08 check correlation and aggregation.
  - T06 checks failure and recovery.
  - T09 checks partial integration failure.
- **Size.** 6 tasks × 2 repetitions = 12 pairs, 24 samples. The previous pilot cost about $0.11–0.17 per sample with
  an unknown model. The estimate is about $2–4.
- **Budget.** $5 is the requested limit. It is best-effort: a pair starts only if the estimated pair cost fits the
  remainder, an admitted pair is completed, and overshoot is reported.
- **Acceptance (the report is usable).**
  - `capability_check.valid`.
  - `model_check.status = matched`.
  - No incomplete pair, or each one listed with its cost.
  - Token and cost coverage is 24/24 known.
  - Every failed execution has a non-`unknown` category.
- **Interpretation.** 12 pairs remain descriptive.
  - Report intention-to-treat Δ for correctness, cost, latency, input tokens including cache, and model turns, plus
    task-level outcomes.
  - Report adoption on eligible tasks (T03, T06, T08, T09) and unnecessary use on T01/T10.
  - Usage outcomes are observational.
  - Claim no benefit unless it repeats across tasks and repetitions. No significance claim at this size.
- **Stop conditions.**
  - Budget or sample limit (automatic).
  - A sample that cannot run (automatic, pair kept as incomplete).
  - An invalid pair (capability leak) or a model mismatch, which make the comparison meaningless.
