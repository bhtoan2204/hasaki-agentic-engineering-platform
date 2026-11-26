# CodeAct M2 — Effectiveness Evaluation (Direct Tools vs CodeAct)

Branch `feat/codeact-evidence-eval-composition` (M1 at `612ce3e`), 2026-11-22, WSL2 Linux 6.6.114.1, Node v22.23.5,
private PostgreSQL cluster (never the shared RDS).

## What exists

| Piece                                                                                                                  | File                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Dataset: 10 tasks over one deterministic fake incident window, reference solutions, eligibility, deterministic grading | `src/eval/codeactTasks.ts`           |
| Paired harness, simulated provider policy, metrics, summary (paired Δ + bootstrap 95% CI, Wilson success CI), Markdown | `src/eval/codeactEffect.ts`          |
| CLI (`npm run eval:codeact`), simulated by default; `--live` only with `--budget-usd` and `--max-samples`              | `src/cli/evalCodeAct.ts`             |
| CI test (simulated, plain process)                                                                                     | `test/codeact-effect.integration.ts` |

**Reuse.** Both variants run through the production Chat harness (routing, prompt building with the 6,000-char tool
result cap, `tools.call` dispatch and audit, the CodeAct surface, usage accounting with null-for-unknown via
`addUsage`), the Tool Registry (fixture tools are ordinary read-only integration tools), `wilson` from
`src/eval/scoring.ts`, and the provider runners from `src/agent/complete.ts`. The benchmark-case runner
(`src/eval/runner.ts`) grades code changes in worktrees and does not fit read-only investigations, so it is not used.

**Controlled variable.** `codeAct.enabled` only: it decides whether `code.execute` is disclosed (catalog / native
tool definitions) and callable. Same task text, provider, model, effort, mode (INVESTIGATE), tools, data, budgets.
A/B order alternates per repetition. Each sample is a fresh conversation.

**Eligibility** (adoption denominator): two or more deterministic read-only lookups whose results must be combined,
or one large result whose useful content is an aggregate. T01 (single lookup) and T10 (catalog listing) are not
eligible.

**Categories.** T01 single lookup; T02 independent lookups; T03 SigNoz/Splunk correlation; T04 slow operations across
services; T05 common failures; T06 refund timeout (with a misleading DB-pool signal, overlap 0); T07 cross-source
evidence; T08 large aggregation; T09 partial integration failure (SigNoz 503); T10 CodeAct unnecessary.

## Results

### Fixture benchmark + real OS sandbox — simulated provider (Level 3 for the harness; NOT a model result)

`npm run eval:codeact -- --repetitions 3 --out docs/validation/codeact-m2-fixture-sandbox.json` → exit 0.
60 samples, 30 pairs. Full report: [`codeact-m2-fixture-sandbox.json`](codeact-m2-fixture-sandbox.json).

|                               | Direct             | CodeAct            |
| ----------------------------- | ------------------ | ------------------ |
| completed turns               | 30/30              | 30/30              |
| verified correct (Wilson 95%) | 15/30 [0.33, 0.67] | 30/30 [0.89, 1.00] |
| unsupported conclusions       | 0                  | 0                  |

| metric (mean)                      | Direct         | CodeAct        | paired Δ (B−A) | bootstrap 95% CI |
| ---------------------------------- | -------------- | -------------- | -------------- | ---------------- |
| LLM completions per task           | 2.60           | 2.00           | −0.60          | [−0.83, −0.37]   |
| top-level tool calls               | 2.00           | 1.00           | −1.00          | [−1.47, −0.53]   |
| prompt chars, all completions      | 13,659         | 7,051          | −6,608         | [−8,227, −4,754] |
| largest prompt (context occupancy) | 7,193          | 3,771          | −3,422         | [−4,384, −2,449] |
| tool-result chars delivered        | 4,446          | 474            | −3,972         | [−5,084, −2,734] |
| end-to-end latency ms              | 86             | 136            | **+51**        | [+36, +64]       |
| input / output tokens, cost        | unknown (0/30) | unknown (0/30) | unknown        | –                |

Direct failures are T03/T04/T05/T08/T09: a needed result exceeded the chat's 6,000-char tool-result cap. The latency
increase is the OS-sandbox launch per execution (bubblewrap + cgroup scope) and is a real measured cost.

**What this does and does not show.** It shows the harness works end to end, the metrics are honest (provider
tokens/cost stay unknown, never zero), and how CodeAct changes what the platform sends to a model. It does **not**
show that a model would choose CodeAct, write correct programs, or save tokens: the simulated policy uses CodeAct for
every eligible task by construction and replays the same reference plan in both variants, never narrowing a query to
avoid truncation (so the Direct failures are an upper bound for a naive direct strategy).

### Live provider evaluation — NOT VERIFIED

Not run: it calls a real provider with this machine's credentials, and no spend was authorized for this task. The
bounded pilot is ready:

```
npm run eval:codeact -- --live --provider claude --budget-usd 1 --max-samples 8 --tasks T01-single-lookup,T03-trace-log-correlation,T06-refund-timeout,T08-large-aggregation --out docs/validation/codeact-m2-live-pilot.json
```

It stops before the next sample once known spend reaches the budget, or at the sample limit (bounding providers that
do not report cost).

### Real integration evaluation — NOT VERIFIED

No authorized read-only SigNoz/Splunk dataset was used; all data is fixture data.

## Verification

| Command                                                           | Exit | Result                             |
| ----------------------------------------------------------------- | ---- | ---------------------------------- |
| `node test/run-integration.ts test/codeact-effect.integration.ts` | 0    | 5/5                                |
| `npm run eval:codeact -- --repetitions 3 --out …` (OS sandbox)    | 0    | report above                       |
| `npm test`                                                        | 0    | 1128/1128                          |
| `tsc` root, `npm run lint`, `npm run arch:check`                  | 0    | 5 cycles / 6 violations (baseline) |

## Limitations

- Statistical uncertainty: CIs are percentile bootstrap over 30 pairs (10 tasks × 3); tasks are not independent
  samples of real workloads.
- Reasoning tokens, queue time and per-tool-category timings are not collected separately (unknown).
- CodeAct is not enabled anywhere by this milestone.
