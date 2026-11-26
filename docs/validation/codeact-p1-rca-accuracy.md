# CodeAct P1 — RCA Accuracy and Benchmark Correctness

Branch `fix/codeact-p0-grading-evidence-sufficiency` (after P0 `a28702f`), 2026-11-22. Fixture data, private
PostgreSQL cluster, real OS sandbox for the CLI run, simulated provider. **No live model ran in P1.**

## Benchmark defect found (independently of model output)

T03 does not test correlation: in the fixture the slow-gateway orders and the timeout-logged orders are the same 13,
so either source alone answers it (P0 report). Its reference is unchanged. Discriminating incidents were added instead.

## What was built (on the existing evaluation framework)

`src/eval/rcaIncidents.ts`: 10 scenarios × any seed, served by read-only fixture tools `rca.services`, `rca.traces`,
`rca.logs` and `rca.metrics`.
- The tools page with `limit`/`offset`, and an outage is an HTTP 503 error.
- Each incident has a documented `GroundTruth`:
  - root-cause service, operation and cause;
  - affected-order count;
  - the highest status the evidence supports;
  - unavailable sources;
  - the symptom service;
  - the deliberately misleading cause.

| Scenario | Symptom | Root cause (service / operation / cause) | Misleading signal |
| --- | --- | --- | --- |
| provider-timeout | refunds time out at gateway | payment-provider / provider.refund.http / provider_timeout | db-pool warnings on unaffected orders |
| misleading-warnings | same | same | db-pool **errors** on unaffected orders |
| missing-spans | same | same, provider spans absent (logs carry it) | db-pool warnings |
| partial-outage | same | same, SigNoz 503 → at most PROBABLE, must report `rca.traces` | db-pool warnings |
| retry-amplification | same | refund-worker / refund.retry / retry_amplification (retries precede provider latency) | provider slowness |
| db-pool-saturation | same | refund-worker / refund.db.acquire / db_pool_saturation | provider slow-response warnings |
| downstream-http | same | fraud-service / fraud.check / downstream_http_degradation | db-pool warnings |
| kafka-consumer-lag | refunds pending | refund-worker / consume.refund-events / consumer_lag | provider warnings |
| idempotency-conflict | refunds fail 409/5xx | order-api / refund.submit / idempotency_conflict (double submit) | db-pool warnings |
| event-ordering | ledger drift | ledger-service / ledger.apply / event_ordering | provider warnings |

How memorizing the answer is prevented:
- The same symptom has 6 different root causes.
- The seed changes the order ids, the affected count, latencies and which orders carry decoys.
- The question gives only the symptom and the tools; tests check that it never contains the answer's operation or
  cause.

The RCA grader (`gradeRca`) reports these dimensions separately:
- detection;
- correct service;
- correct operation;
- correct cause;
- fault localization;
- correlation (affected count);
- symptom-as-cause;
- misleading signal taken;
- **false confirmation**: CONFIRMED for a wrong diagnosis, or beyond what the evidence supports;
- uncertainty reported;
- missing sources reported;
- **unsafe next action**: raising a timeout, adding retries, changing log level or growing a pool for a different cause.

A diagnosis is correct only if every dimension holds. Each sample keeps its `rca` dimensions, per-field `grading`
diagnostics and the parsed `answer`.

Plumbing:
- `EffectTask.reference` (ground truth) and `EffectTask.grade` (task-specific grader).
- `runEvaluation({suite})`.
- `npm run eval:codeact -- --suite rca --seeds 1,2`.
- The report gains `rca_dimensions` per variant.

## Verification

| Level | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `node --import ./test/env.ts --test test/rca-grading.test.ts` | 0 | 7/7: deterministic per seed and varied across seeds; same symptom, ≥4 distinct causes; no answer leakage; every valid diagnosis passes; symptom-as-cause, misleading cause (also a false confirmation), wrong count and symptom fix rejected; outage caps CONFIRMED and must be reported; pool-size action only valid for pool saturation |
| 2 | `node test/run-integration.ts test/rca-benchmark.integration.ts` | 0 | 3/3: for **30 incidents** (3 seeds × 10) the reference plan, using only the tools, derives the ground truth; unknown incident is an error; paired Direct vs CodeAct through the Chat harness, 10/10 CodeAct, 0 false confirmations, raw diagnostics kept |
| 3 | `npm run eval:codeact -- --suite rca --seeds 1,2 --out docs/validation/codeact-p1-rca-fixture-sandbox.json` (OS sandbox) | 0 | 20 pairs, capability check valid |

### Deterministic comparison (simulated provider, OS sandbox, 20 pairs; NOT a model result)

| | Direct | CodeAct | Paired Δ (95% CI) |
| --- | --- | --- | --- |
| verified RCA correct | 19/20 | 20/20 | +0.05 [0.00, 0.15] |
| false confirmations | 0 | 0 | – |
| SDK calls | 2.90 | 2.00 | −0.90 [−1.15, −0.65] |
| top-level tool calls | 1.90 | 1.00 | −0.90 |
| prompt chars total | 16,309 | 8,888 | −7,422 [−9,092, −5,618] |
| latency ms | 89 | 149 | +60 [51, 70] (sandbox start) |

The one Direct miss was `INC-retry-amplification-2`: the retry-log result was cut at the chat's 6,000-char limit. The
simulated policy does not page, so it answered `null` everywhere. That counts as `detection: false`, with no false
confirmation. The simulated policy runs the reference plan, so these numbers describe the harness, not RCA skill.

## Gate

| Requirement | Status |
| --- | --- |
| Graders distinguish valid and invalid diagnoses | yes (unit tests and 30-incident consistency) |
| No false PASS on empty or insufficient evidence | yes (P0 evidence sufficiency, 14 tests) |
| Misleading incidents handled correctly | yes for the grader and reference: taking the decoy fails. **Model behavior NOT VERIFIED.** |
| CodeAct boundaries retained | yes: rca.* tools are read-only; existing authorization, composition and evidence suites pass |
| Reproducible accuracy and cost comparison | yes for the simulated provider. **Live: NOT RUN** (no authorized budget) |
| Regressions vs baseline reported | the simulated CodeAct effectiveness suite is unchanged (P0 run); `npm test` and integration below |

## Not done or not verified

- **Live RCA accuracy, model turns, tokens and cost: NOT RUN.** This needs an authorized budget. Proposed command
  (20 pairs, about $3–5 at pilot-2 prices; please approve a budget):
  `npm run eval:codeact -- --live --provider claude --model claude-sonnet-5-5 --effort medium --suite rca --seeds 1,2 --max-samples 40 --budget-usd 6 --out docs/validation/codeact-p1-rca-live.json`
- **Incident Investigation Workflow as a third arm: NOT IMPLEMENTED.** It needs the workflow engine to drive a real
  or scripted agent per incident. Its evidence gate was tested in P0 and by the M4 end-to-end tests.
- Code Intelligence/LSP, knowledge and memory are not part of these fixture incidents: they have no repositories.
