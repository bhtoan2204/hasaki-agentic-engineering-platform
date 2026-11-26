# CodeAct A — Failure Diagnostics and Recovery Accounting

Branch `feat/codeact-diagnostics-eval-reliability` (from `main` @ `56824d6`), 2026-11-22, WSL2 Linux 6.6.114.1,
Node v22, private PostgreSQL cluster (never the shared RDS), real bubblewrap + systemd-run sandbox.

## Baseline (live pilot `codeact-m2-live-pilot.json`)

T06 CodeAct sample: `codeact_executions: 2`, `codeact_failed: 1`, `repairs: 0`, 10 top-level tool calls, correct.
The report carried no category, phase or tool for the failure.

## Root causes (confirmed in source)

| Problem | Why | Evidence |
| --- | --- | --- |
| `repairs` is always 0 for a failed program | The eval counted a repair only when the **chat** tool call's status was not `ok`. A failed program is returned as data (`ok: false` inside the answer) from a successful `code.execute` chat call, so the outer status is `ok`. | `src/eval/codeactEffect.ts` (before): `calls.findIndex(c => c.tool === "code.execute" && c.status !== "ok")`; `src/chat/tools.ts` `code.execute.run` throws only for `unsupported`. Pilot: `codeact_failed: 1`, 8 calls after it, `repairs: 0`. |
| A failure is not diagnosable | The executor kept only a coarse `Category` (8 values). A syntax error, an uncaught runtime error and an uncaught nested-tool failure were all `internal`. There was no phase, no nested tool, and no execution id in the answer. | `src/codeact/execute.ts` (before): `m.t === "fail"` → `fail("internal", …)`; `runner.mjs` sent one undifferentiated `fail`. |

## T06 investigation — cause NOT determinable

The pilot ran through `npm run eval:codeact`, which preloads `test/setup.ts`. That creates a per-process database
`platform_test_<uuid>` and **drops it on `beforeExit`** (`test/setup.ts:197`). The only remains of that run are
`/tmp/ctp-test-ucrpz8/data` (empty `sandbox/`, empty `completion-sessions/`; `persistSession` is off in evaluation).
No `code_executions` or `code_execution_calls` row, program hash, nested-call status or stderr survives. The report
JSON has only counters.

What is missing, and what future runs keep:

| Needed | Before | Now |
| --- | --- | --- |
| Failure category and phase | – | `code_executions.diagnostics.failure` and the eval sample's `codeact_failures[]` |
| Nested tool involved | – | `failure.last_nested_failure {seq, tool, category}` and `diagnostics.nested_failures[]` |
| What the agent did next | – | `sample.recovery` (episodes: `recovered` / `recovery_failed` / `fallback_direct` / `abandoned` / `unknown`) |
| Execution ↔ chat call link | order only | `execution_id` in the answer, so `chat_tool_calls.result->>'execution_id'` |

Candidate causes consistent with the task are an uncaught nested failure (refund-worker traces return 503 in the
fixture) or invalid nested arguments. **Neither is confirmed.** The regression fixture below reproduces the first one
deterministically. It is a fixture, not a reconstruction of the pilot.

## What changed

- `src/codeact/runner.mjs`: sends `{t:"started"}` after the program compiles, and `fail` carries
  `phase: compile | run | result`. The parent reads only these known values; the runner stays untrusted.
- `src/codeact/execute.ts`:
  - `FailureCategory` and `FailurePhase`, with `CodeActResult.failure` and `CallRecord.failure`.
  - Distinguished: invalid program, sandbox unavailable, sandbox startup failure, syntax error, runtime error, process
    terminated, execution timeout, cancellation, resource budget, IPC protocol error, output too large.
  - Nested: unknown tool, unauthorized tool, invalid arguments, nested timeout, tool output too large, invocation
    failure.
  - An unknown tool's name is program text, so it is dropped (`tool: null`).
  - `recoveryAdvice(failure)` says retry only what a corrected program can fix, and never retry unavailable,
    unauthorized or canceled.
  - The coarse `category` is unchanged.
- `migrations/093_code_execution_diagnostics.sql`: `code_executions.diagnostics JSONB`, nullable and additive.
- `src/codeact/surfaces.ts`:
  - Persists the sanitized diagnosis: categories, phases, sequence numbers, catalog tool names, persistence-failure
    count.
  - Returns `execution_id`, `failure` and `recovery` to the agent.
  - Rows reconciled after a dead worker get `{failure:{category:"interrupted"}}`.
- `src/eval/codeactRecovery.ts`: `classifyRecovery`, which classifies from the observed sequence and timing. Overlaps
  and follow-ups with no visible intent are `unknown`.
- `src/eval/codeactEffect.ts`: per-sample `codeact_failures`, `nested_failures` and `recovery`. The report shows
  `failure_categories`, recovery counts and `failed_but_correct_turns`. `repairs` is removed.
- Security: no new tool, no authorization change. Diagnostics hold no program text, arguments, payloads or error
  messages; this is asserted with a secret-bearing error and a program marker.

## Verification

| Level | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `node --test test/codeact-diagnostics.test.ts test/codeact-recovery.test.ts test/codeact.test.ts` | 0 | 26/26 |
| 2 | `node test/run-integration.ts test/codeact-diagnostics.integration.ts` | 0 | 5/5 |
| 2 | `node test/run-integration.ts test/codeact-effect.integration.ts` | 0 | 7/7 (2 new regression tests) |
| 2 | evidence, composition, surfaces, incident-investigation suites | 0 | 34/34, 16/16 (unchanged) |
| 3 | `node test/run-integration.ts test/codeact-sandbox.integration.ts` (real bubblewrap + cgroup) | 0 | 7/7 |

Representative records (private test cluster, sanitized):

```
DIAG-FAILED {"execution_id":1,"diagnostics":{"failure":{"phase":"program_run","category":"program_runtime_error","last_nested_failure":{"seq":2,"tool":"diag.traces","category":"tool_invocation_failed"}},"nested_failures":[{"seq":2,"tool":"diag.traces","category":"tool_invocation_failed"}],"persistence_failures":0}}
DIAG-RECOVERED {"execution_id":2,"diagnostics":{"nested_failures":[{"seq":2,"tool":"diag.traces","category":"tool_invocation_failed"}],"persistence_failures":0}}
FAULT-RECOVERED {"codeact_failures":[{"execution_id":9,"category":"program_runtime_error","phase":"program_run","nested_tool":"eval.traces","nested_category":"tool_invocation_failed"}],"recovery":{"execution_failures":1,"recovery_attempts":1,"recovered":1,…,"episodes":[{"execution_ids":[9,10],"categories":["program_runtime_error"],"attempts":1,"outcome":"recovered"}]},"correct":true}
SANDBOX-DIAG {"syntax":{"category":"program_syntax_error","phase":"program_compile"},"nested":{"category":"program_runtime_error","phase":"program_run","last_nested_failure":{"seq":1,"tool":"echo","category":"tool_invocation_failed"}},"memory":{"category":"process_terminated","phase":"program_run"}}
```

## Limitations

- `last_nested_failure` is the most recent failed nested call before a runtime failure. The program may have failed
  for another reason, so it is reported as context, not as the cause.
- A runner killed by the heap limit is `process_terminated`. The kernel's exact reason (OOM, CPU limit) is not read.
- Workflow surface: the parent `agent_context_tool_calls` row records the answer, so the link is `execution_id` inside
  it. There is no separate column.
