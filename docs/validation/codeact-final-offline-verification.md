# CodeAct — Final Offline (VPN-free) RCA and Workflow Verification

Branch `feat/codeact-offline-rca-verification` from `main` @ `5d449f7`, 2026-11-22. Private PostgreSQL test cluster,
real Workflow Engine, scheduler and Agent Harness, CodeAct in the real OS sandbox (bubblewrap + systemd scope), fixture
integrations only. **No network request to any company service; no VPN credentials were requested or used.**

**Real integrations (SigNoz, Splunk, Kubernetes, production database): NOT TESTED — VPN REQUIRED.** They are
unchanged and still available, only their real-world verification is deferred.

**LIVE PROVIDER EVALUATION: NOT RUN — BUDGET NOT AUTHORIZED.** Every result below comes from a simulated or scripted
deterministic agent. None of it shows a real model's reasoning quality.

## 1. CI

| Run | Commit | Result |
| --- | --- | --- |
| 44967325799 | `d5d1c07` (main) | failure: job `test (1/3)`, integration shard |
| 45007903843 | `5d449f7` (main, latest) | **success** (all jobs) |

The failing test was `server shutdown kills detached command process groups (no orphaned go test)`
(`test/engine.integration.ts`). **Classification: timing-dependent and not reproducible. No lifecycle defect was
found.** Evidence:

- **The orphan assertion cannot hold by mistake.** In the test environment `PLATFORM_TEST=1` selects the TypeScript
  supervision engine. The command runs `bash -lc` detached, as its own process group. `childGroups.killAll()` sends
  SIGKILL to that group. The supervisor resolves only on the child's `close`, which waits for every holder of its
  stdio, `sleep` included. `runCommand` resolves after that, and `await worker` returns after the step finishes. So
  "no orphaned process left" is checked after the whole tree has exited and been reaped.
- **Not reproduced locally**, in any of these settings (the rest of the file ran too):
  - like CI: `--test-concurrency=1 --test-shard=1/3`, clean `HOME`, `GIT_CONFIG_GLOBAL=/dev/null`;
  - with the OS sandbox made unavailable as on the runner (no user systemd);
  - with one verification slot;
  - pinned to 2 CPUs under load, 6 consecutive runs;
  - pass in every run.
- **Measured locally:** the command starts 225 ms after the run starts, against the test's 5 s start window.
- **Hypotheses examined and not confirmed:**
  - a leftover queued job claimed by `runOnce`: the queue was empty at test start (instrumented, then reverted);
  - test-PostgreSQL resolution delay: none for a temp cwd;
  - login-shell subshells making the bash count 2: 200 samples, always exactly 1.
- **Not done:** the job log needs a GitHub login (the public API returns 403), so it is unknown which of the test's
  two assertions failed. The test was not changed. No skip, timeout increase or weakened assertion was applied.

## 2. RCA correctness (P0 kept, two new defects fixed)

- **P0 suites still pass:**
  - T03 set and ordered grading: missing, extra and duplicate ids, natural vs lexicographic order, count consistency,
    empty sets.
  - Paginated and empty-intersection correlation through the Chat harness.
  - Evidence sufficiency.
- **New defect 1, found by the end-to-end run: a fabricated citation could vanish.** Claim normalization merges
  claims with the same text and keeps the stronger. A claim citing `codeact:999999:1` with the same text as a valid
  claim was replaced by it, and the verdict did not fail. At unit level the report even returned `passed`.
  - Fixes:
    - `normalizeClaims` never merges a contradicted claim.
    - `buildEvidenceReport` fails on any contradicted citation among the provenance-checked claims before any merge.
  - Tests:
    - `test/evidence-sufficiency.test.ts` "a fabricated citation fails even when …" (was `passed`, now `failed`).
    - "normalization never merges a contradicted citation" (mutation check: removing the fix turns it red).
- **New defect 2: CodeAct was disabled for evaluation workflow runs.** Tool calls of a workflow attempt arrive through
  the shared broker, outside the evaluation's async scope, so `execute_code` answered "CodeAct is disabled".
  - Fix: `PlatformToolEnv.codeact` records the evaluation scope when the worker builds the attempt's env, and the
    broker's dispatch runs in it.
  - Outside a scope it stays undefined, and the installation flag applies at call time exactly as before. A first
    version that always captured the flag broke 3 composition tests that enable CodeAct after building the env; it was
    corrected.

## 3. Three-arm RCA evaluation

- **Implementation:** `src/eval/rcaWorkflowArm.ts`.
- **Shared by all arms:**
  - incident symptoms, ground truth and grader (`gradeRca`);
  - read-only `rca.*` fixture tools;
  - no repositories (equal permissions);
  - the same deterministic policy: the incident's reference plan.
- **The arms:**
  - **A** Direct tools, through the Chat harness.
  - **B** CodeAct-enabled Chat.
  - **C** the `incident-investigation` template: discover → investigate (agent) → evidence report, run through the
    **real engine and scheduler**. The investigate step runs the Agent Harness with the Codex provider path: the fake
    `codex` CLI script mode drives the agent's tool calls through the real MCP bridge and broker, CodeAct runs in the
    OS sandbox, then provenance and the report run.
- **Arm C settings and grading:**
  - The report objectives are the fixtures' sources (trace and log; no code exists in these incidents).
  - Its answer status is the **platform's**: a CONFIRMED that the report did not verify counts as PROBABLE.
- **CLI for a live run:** `--suite rca --workflow-arm --live …`.

`node test/run-integration.ts test/rca-three-arm.integration.ts`: exit 0, 7/7, OS sandbox. Artifact:
[codeact-final-three-arm-fixture.json](codeact-final-three-arm-fixture.json).

| Incident | A Direct | B CodeAct | C workflow run | CodeAct execution | C verdict (missing) | C status | refs resolve |
| --- | --- | --- | --- | --- | --- | --- | --- |
| provider-timeout | ✔ | ✔ | 1 | 2 | incomplete (log) | PROBABLE | 1/1 |
| retry-amplification | ✔ | ✔ | 2 | 4 | **passed** | CONFIRMED | 2/2 |
| db-pool-saturation | ✔ | ✔ | 3 | 6 | incomplete (log) | PROBABLE | 1/1 |
| kafka-consumer-lag | ✔ | ✔ | 4 | 8 | incomplete (trace) | PROBABLE | 1/1 |
| idempotency-conflict | ✔ | ✔ | 5 | 10 | **passed** | CONFIRMED | 2/2 |
| missing-spans | ✔ | ✔ | 6 | 12 | **passed** | CONFIRMED | 2/2 |
| misleading-warnings | ✔ | ✔ | 7 | 14 | incomplete (log) | PROBABLE | 1/1 |
| partial-outage | ✔ | ✔ | 8 | 16 | incomplete (trace, SigNoz 503) | PROBABLE | 1/1 |

Arm C summary:
- 8/8 runs COMPLETED; 8/8 diagnoses correct.
- 0 false confirmations, 0 symptom-as-cause, 0 misleading signals taken, 0 unsafe actions.
- Missing sources reported 8/8.
- Verdicts: 3 passed, 5 incomplete.
- Mean latency 948 ms; mean 5 tool calls per run; 8 CodeAct executions, 0 failed; cost unknown (scripted agent).

**Interpretation.** The diagnoses are right in every arm because every arm runs the same reference plan; this checks
the paths and the grading, not reasoning. What arm C adds is the gate. When an investigation rests on a single source
(the reference plans of 5 incidents query only traces or only logs), the platform refuses to call it verified. That
is correct, not a defect.

### Offline end-to-end checks (same file)

| Check | Result |
| --- | --- |
| Scheduler, harness, tool dispatch, CodeAct composition, evidence persistence, provenance, sufficiency gate, report | all 8 runs COMPLETED with durable refs that resolve for the owner (`resolveCodeActEvidence`) |
| Checkpoint/replay | re-executing `report` from the persisted investigation gives identical `verification` and `confirmed_facts` |
| Cancellation | canceling during a nested `rca.slow` call: the run is CANCELED and its CodeAct execution ends `error` (canceled), never left running |
| Fabricated evidence | verdict **failed**; graded status not CONFIRMED |
| Incorrect causal conclusion (misleading pool warnings) | graded incorrect, `misleading_signal_taken` |
| Empty evidence + CONFIRMED | verdict not passed; graded status not CONFIRMED; incorrect |
| Unauthorized tool | `rca.mutate` refused both directly and inside a program; mutations = 0 |
| Partial outage | verdict incomplete with `missing_sources: ["trace"]`; never passed |

## 4. Other verification

| Command | Exit | Result |
| --- | --- | --- |
| `npm test` | 0 | 1200/1200 |
| `npx tsc --noEmit` (root, web), `npm run lint` | 0 | clean |
| `npm run arch:check` | 0 | 5 cycles / 6 violations (unchanged baseline) |
| `npm run test:integration` (first full run) | 1 | 956/962. The 3 new composition failures were fixed (see defect 2). The other 3 are the known pre-existing local failures (`evaluation.integration.ts` ×2, reproduced on `f666c65`; `repository-remotes`, from the host `~/.gitconfig`). |
| affected suites after the fix (composition, three-arm, evidence, incident, pairing, effect, rca-benchmark, diagnostics, sandbox, surfaces, chat, codex) | 0 | 35/35 + 83/83 |
| `npm run test:integration` (final full run, after the fixes) | 1 | **959/962, 0 skipped**. Only the 3 known pre-existing local failures remain; they pass on CI. |

## 5. Proposed live evaluation (needs an approved budget)

```
npm run eval:codeact -- --live --provider claude --model claude-sonnet-5-5 --effort medium \
  --suite rca --seeds 1,2 --workflow-arm --max-samples 56 --budget-usd 10 \
  --out docs/validation/codeact-rca-live-three-arm.json
```

- **Scope:** 20 incidents × (A, B) as pairs, plus 16 workflow runs (arm C), with pinned model and effort.
- **Estimate:** about $5–9 at pilot-2 prices. A workflow run costs more than a chat turn.
- **Stops automatically on:** the budget or sample limit (pairs first, then the workflow arm), an invalid pair
  (capability leak, model mismatch), or a sample that cannot run.
- **Acceptance:** model-matched, capability check valid, token and cost coverage complete.
- **Report:** per-arm RCA dimensions, false confirmations and verdicts. Claim no benefit beyond what repeats across
  incidents.

## 6. Final status

| Item | Status |
| --- | --- |
| Latest CI checked | `5d449f7` success. The `d5d1c07` failure is analyzed above (not reproducible, log not accessible). |
| CI on this branch | **NOT VERIFIED**: CI runs on pushes to `main` and on pull requests. No PR could be opened (`gh` not authenticated). |
| T03 and evidence-sufficiency regressions | pass |
| Three-arm RCA evaluation | implemented; fixture run 8 incidents × 3 arms |
| Offline end-to-end workflow, real OS sandbox, refs resolve, replay, cancellation | verified (§3) |
| Incorrect diagnoses rejected; no production mutation | verified (§3) |
| Real integrations | **NOT TESTED — VPN REQUIRED** |
| Live provider | **NOT RUN — BUDGET NOT AUTHORIZED** |
