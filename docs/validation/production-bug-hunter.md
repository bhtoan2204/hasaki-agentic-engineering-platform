# Production Bug Hunter

Branch `feat/production-bug-hunter` from `main` @ `9491a74`, 2026-11-22.

Everything here ran offline:

- the private PostgreSQL test cluster;
- the real Workflow Engine, scheduler and Agent Harness;
- the Codex provider path, through the fake `codex` CLI driving the real MCP bridge and broker;
- the real bubblewrap verification sandbox;
- a seeded Go repository.

Status of the external pieces:

- **Live provider evaluation: NOT RUN.** No budget was authorized.
- **No VPN and no SigNoz, Splunk or production access.** The hunt uses persisted incident evidence only.
- Every result below comes from deterministic scripted agents. These results show that the infrastructure behaves as designed. They are **not** evidence of a real model's ability to find bugs.

## 1. Architecture: reuse, no new runtime

A hunt is an ordinary `production-bug-hunt` workflow run.

- It is owned by the requesting user and limited to that user's repository permissions and provider settings.
- It passes through the existing run gates and budgets.
- A `bug_hunts` row links it to the incident.
- The scanner and the incident's existing work-item link are untouched.

```
context ─┬─ scope ─┐
         └─────────┴─ investigate (existing INCIDENT_INVESTIGATE agent) → evidence (existing evidence_report)
                                   → hunt (agent) → triage → verify (agent, independent; run_if) → reproduce → report
```

| Step                       | Kind                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                     | Reuses                                                                                             |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `context`                  | integration `bug_hunt_context`         | Loads the incident's persisted evidence: signature, error, stack frames, caller, request/trace id, time window and production image. Also loads up to 10 related incidents of the same service and previous hunts. Records the investigated revision of each selected repository, and whether it matches the commit production ran. Missing evidence is listed, never invented.                  | `getIncidentDetail`, `imageInfo`, run checkout authorization (same as harness preflight)           |
| `scope`                    | integration `bug_hunt_scope`           | Maps stack frames and the caller onto the repository at that revision, and finds the functions that emit the incident's error text. Adds callers from **LSP** `incoming_calls`, falling back to **Code Intelligence** `findReferences`, then to a bounded word search labelled as syntax candidates. Bounded to 6 functions, 10 callers and 12 files. Records which tools were used, or why not. | `navigate` (LSP), `findReferences`, `git show`/`git ls-tree` at the revision                       |
| `investigate` + `evidence` | agent + integration                    | The existing incident-investigation agent and its evidence report, unchanged.                                                                                                                                                                                                                                                                                                                    | `INCIDENT_INVESTIGATE`, `evidence_report`                                                          |
| `hunt`                     | agent (analysis, read-only)            | Bug Hunter. Produces candidates with repository, commit, file, function, lines, category, hypothesis, trigger, expected/actual, evidence, reproduction strategy, confidence and uncertainty. Budget: `max_tool_calls 80`, `timeout_ms 20 min`, `context_tokens 24k`.                                                                                                                             | Agent Harness, existing tool policy                                                                |
| `triage`                   | integration `bug_hunt_triage`          | See "Triage" below.                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                  |
| `verify`                   | agent (analysis), `withhold: ["hunt"]` | The independent verifier. See "Independent verifier" below.                                                                                                                                                                                                                                                                                                                                      | Agent Harness; independent-verification filtering of read tools                                    |
| `reproduce`                | integration `bug_hunt_reproduce`       | See "Reproduction" below.                                                                                                                                                                                                                                                                                                                                                                        | `runVerificationCommand` slot and sandbox, plus `--unshare-net`                                    |
| `report`                   | integration `bug_hunt_report`          | Applies the verdict rules (`src/bugHunt/logic.ts`). Persists the findings and the report.                                                                                                                                                                                                                                                                                                        | `execution_attempt_telemetry` and `agent_context_tool_calls` for cost and tokens (no new pipeline) |

**Triage.** It:

- drops malformed candidates;
- rejects platform-contradicted ones: repository outside the hunt, a stale commit, a missing file, a line past the end of the file, a function not declared in the file;
- deduplicates by repository, file, function and category;
- reuses an earlier verdict (CONFIRMED or REJECTED) only when the file blob is byte-identical and the requester is the same;
- defers candidates below 0.5 confidence;
- sends at most 3 candidates to the verifier.

When nothing is left to verify, the verifier step is **skipped**, so it costs nothing.

**Independent verifier.** It receives only the platform-built claims (`triage.to_verify`), the scope and the incident evidence.

- The hunter's output, history and artifacts are withheld. `read_step_output`, `run.step_history` and `read_artifact` all refuse them.
- For each claim it returns a verdict, an execution path, code excerpts, alternative explanations, a separate `incident_link` judgment, and an optional new Go test file.

**Reproduction.** Runs at most 3 times per hunt.

- The verifier's test is validated: it must be a new `*_test.go` file in the package directory, define the named test, and stay under 20 KB. No free-form shell is accepted.
- The revision is exported with `git archive` (no `.git` directory) under the data directory.
- One focused test runs: `go test -run '^Name$'`. It goes through the verification slot, inside bubblewrap with `--unshare-net`, with `GOPROXY=off` and `-mod=readonly`, and a 120 s limit.
- The output is stored as an artifact and the export is deleted.
- Without bubblewrap the reproduction is **not run** and the outcome is `blocked`.

**Verdict rules.** A candidate's bug status is decided as follows:

| Condition                                                                                                                   | `bug_verification_status`                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The verifier says CONFIRMED and the platform's reproduction failed on the named test                                        | **CONFIRMED**                                                |
| The reproduction passed                                                                                                     | SUSPECTED                                                    |
| The reproduction was `blocked`, timed out or was canceled                                                                   | BLOCKED                                                      |
| The reproduction was invalid                                                                                                | SUSPECTED                                                    |
| No reproduction was proposed, and every cited excerpt is present at the cited lines of the revision, with an execution path | CONFIRMED                                                    |
| No reproduction was proposed, otherwise                                                                                     | SUSPECTED                                                    |
| The verifier said SUSPECTED, REJECTED or BLOCKED                                                                            | stays as the verifier said; a reproduction never upgrades it |

`incident_causality_status` is a separate verdict:

| Status         | When                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CONFIRMED**  | The bug is CONFIRMED, **and** the location is an incident stack frame or caller (or emits the incident's error text), **and** that code is identical to the production commit, **and** the verifier judged the link SUPPORTED. |
| PROBABLE       | The location is linked to the incident but one of those conditions is missing. This includes a callee of a failing frame.                                                                                                      |
| NOT_SUPPORTED  | No link between the location and the incident evidence.                                                                                                                                                                        |
| UNKNOWN        | There is no incident evidence to link to.                                                                                                                                                                                      |
| NOT_APPLICABLE | The bug was rejected.                                                                                                                                                                                                          |

The database enforces the invariants with `CHECK` constraints in `migrations/094_bug_hunts.sql`:

- a CONFIRMED bug names its verification step or the finding it reuses;
- a CONFIRMED cause requires a CONFIRMED bug.

**Hunt status.** It is derived from the run, so there is no second state machine: queued, running, verifying, completed, partial, failed, canceled.

A hunt is `partial` when:

- any finding is BLOCKED;
- the verifier did not complete although claims existed; or
- a reproduction was blocked or timed out.

When the run fails before the report, the hunter's raw candidates are shown, labelled as unverified hypotheses.

**API.**

- `GET`/`POST /api/prod-errors/:fp/bug-hunts`
- `GET /api/bug-hunts/:id`
- `POST /api/bug-hunts/:id/findings/:fid/fix-task`

Cancel uses the existing `POST /api/runs/:id/cancel`. The POST routes require an idempotency key.

**Repeated hunts and concurrent requests.**

- Hunts are traceable and never overwritten: each has its own run, revisions, report and finding rows.
- Concurrent starts by the same user, for the same incident and repositories, return the one active hunt. A session advisory lock plus a check enforces this.

**Fix task.** It creates a work item and starts the existing `bug-investigation` workflow. That workflow keeps its own human approval before any fix. The fix task is idempotent per finding, and only CONFIRMED or SUSPECTED findings are accepted.

**UI.** A **Bug Hunter** panel on the incident page (`web/src/pages/prodErrors/BugHunter.tsx`), built from existing `Panel`, `Button`, `AgentProviderField` and toasts, with no browser-native dialogs. It provides:

- repository selection, up to 3 readable repositories;
- provider selection;
- the history of hunts;
- stages from workflow state;
- findings grouped Confirmed / Suspected / Blocked / Rejected, each with its two verdicts, basis, reproduction (command and log link), alternatives, missing proof and evidence;
- coverage and execution (tools, sources unavailable, tokens, cost, cost per confirmed bug);
- cancel and "Create fix task".

While a hunt is active the panel says **"Refreshes every 5 s (not real-time)"**, because it polls.

## 2. Tests

| Command                                                                                                                                                                                                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit -p .` and `-p web`, `npm run lint`                                                                                                                                                                                                                      | clean                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run arch:check`                                                                                                                                                                                                                                                      | 5 cycles / 6 violations (unchanged baseline). The first version joined an existing cycle through a builtin ↔ steps import; it was fixed by registering the actions at startup (`registerIntegrationAction`).                                                                                                                                                                                                                          |
| `npm test`                                                                                                                                                                                                                                                                | 1208/1208, including `test/bug-hunt-logic.test.ts` (8 tests: verdict and causality rules, fail-closed parsing, frames, dedupe, reproduction validation and classification, excerpts, status)                                                                                                                                                                                                                                          |
| `node test/run-integration.ts test/production-bug-hunter.integration.ts`                                                                                                                                                                                                  | 9/9 (see the coverage table below)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Affected suites: bug hunter, codeact-evidence, codex, context-native, engine, harness-efficiency, harness, idempotency, incident-investigation, intake, prod-errors-go, prodErrors, rca-benchmark, rca-three-arm, splunk-investigation, step-agent, verification-evidence | 272/272                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run build && CHROMIUM_BIN=<nix chromium> npm run smoke:bug-hunter` (real browser, production bundle, real hunt)                                                                                                                                                      | 1/1                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run test:integration` (full)                                                                                                                                                                                                                                         | **974/977**, 0 skipped. The 3 failures are the known pre-existing local ones (`evaluation.integration.ts` ×2; `repository-remotes`, from the host `~/.gitconfig`). Two earlier full runs failed for environmental reasons: `/tmp` (7.8 GB tmpfs) was full of leftover test roots, so the linker failed with `no space left on device` and PostgreSQL went into recovery. After the leftovers were removed, the suite passed as above. |

How the required tests (spec §10) are covered:

| #    | Requirement                                      | Where                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Incident → workflow creation                     | integration test 3 (`startBugHunt` → run plus `bug_hunts` row)                                                                                                                                                           |
| 2    | Repository scope and authorization               | test 2: no repository, more than 3, an unregistered or inaccessible repository, an unknown incident. Test 3: another user cannot list or read the hunt.                                                                  |
| 3    | Code Intelligence / LSP discovery                | test 3: scope from the stack frame at the revision, with tool use recorded. Here LSP and Code Intelligence are disabled, so the recorded reason and the labelled text fallback are what is shown.                        |
| 4, 5 | Hunter; independent verification                 | test 3: the verifier's `read_step_output("hunt")` is refused (`summary: withheld`). Benchmark: `verifier_saw_hunter_output` is never true.                                                                               |
| 6    | Reproduction evidence                            | test 3: `reproduced`, and the artifact shows `--- FAIL: TestBugHuntApplyDiscount`                                                                                                                                        |
| 7, 9 | Confirmed vs suspected; false-positive rejection | benchmark `correct-code-suspected`: the credulous verifier says CONFIRMED, the platform's test passes, so the finding is SUSPECTED and nothing is confirmed. Test 7: deferred and over-budget candidates stay SUSPECTED. |
| 8    | Causality separation                             | test 3: bug CONFIRMED, cause CONFIRMED. Benchmark `misleading-stacktrace`: the `Fill` bug is CONFIRMED, its cause PROBABLE (a callee, not the crashing frame), and the crashing frame `Format` stays SUSPECTED.          |
| 10   | Durable results and linking                      | test 3: the finding row has its verification step id, hunter attempt id and commit                                                                                                                                       |
| 11   | Cancellation and replay                          | test 6: cancel gives `canceled` with no findings. Test 4: re-executing `report` gives identical rows.                                                                                                                    |
| 12   | Concurrent deduplication                         | test 3: two parallel starts return one hunt                                                                                                                                                                              |
| 13   | Stale evidence invalidation                      | test 8: a stale commit, a missing file and an invented function are rejected, and the verifier is skipped. Reuse requires a byte-identical blob (benchmark `recurring-incident`).                                        |
| 14   | Budget enforcement                               | test 1: per-agent tool and time budgets in the template. Test 7: at most 3 verifications, a low-confidence threshold, duplicates merged. Run and work-item cost budgets are the existing preflight.                      |
| 15   | UI progress and results                          | `test/bug-hunter.browser.ts`                                                                                                                                                                                             |
| 16   | Read-only original repository                    | test 3: HEAD unchanged, clean `git status`, no test file, no extra worktree. The template has no coding, command or PR step.                                                                                             |

## 3. Evidence example (integration run, hunt of `misleading-stacktrace`)

Finding `C2`:

- **Location:** `orders/loader.go:10-15`, function `Fill`, category `nil_handling`, commit = investigated revision.
- **Bug verdict:** CONFIRMED.
- **Basis:** "independent verifier CONFIRMED and the platform's isolated reproduction test failed as claimed".
- **Reproduction:** `go test -count=1 -buildvcs=false -run '^TestBugHuntFillGuest$' ./orders`, outcome `reproduced`, log artifact `#4`.
- **Incident cause:** PROBABLE.
- **Causality basis:** "the function is called from a function on the incident's stack (not itself a failing frame)".

Finding `C1`, `Format` at `orders/render.go:6-8`:

- **Bug verdict:** SUSPECTED ("plausible from the code; no valid focused test").
- **Missing proof:** "a failing focused test on the investigated revision".

Screenshots from a real browser on a real hunt (`incident-bug-hunter-{results,start,queued}.png`) were captured during validation and are no longer committed to git.

## 4. Offline benchmark: A (incident-investigation) vs B (bug hunt + independent verifier)

**Setup.**

- One Go module with 10 scenarios (`src/eval/bugHuntFixtures.ts`): real bug, misleading stack trace, correct code falsely suspected, retry amplification, race condition (deterministic interleaving), idempotency, nil edge case, transaction consistency, missing cancellation, and a recurring incident.
- Every scenario has a ground truth.
- Both arms use the same incidents, the same repository and the same revision, through the real engine.
- Artifact: [production-bug-hunter-benchmark.json](production-bug-hunter-benchmark.json).
- Command: `BUG_HUNT_BENCHMARK_OUT=1 node test/run-integration.ts test/production-bug-hunter.integration.ts`.

**Scripted policies, the same in both arms.**

- A's investigator uses the stack-top heuristic: the top in-repository frame is the cause.
- B's hunter also proposes plausible false candidates.
- B's verifier is credulous: it says CONFIRMED whenever it can write a test.

**Grading.**

- A "reported bug" is A's named root-cause location, or one of B's CONFIRMED findings.
- Attribution is the location the arm names as the cause.

| Metric                                   | A investigation                                                      | B bug hunt                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Runs completed                           | 9/9                                                                  | 10/10                                                                        |
| True / false positives / false negatives | 7 / **2** / 1                                                        | 9 / **0** / 0                                                                |
| Precision / recall                       | 0.78 / 0.88                                                          | 1.00 / 1.00                                                                  |
| Reproduction success                     | —                                                                    | 8/9 attempted (the 9th is correct code: its test passed, so no confirmation) |
| Root-cause attribution accuracy          | 0.78                                                                 | 1.00                                                                         |
| Mean platform tool calls per run         | 6                                                                    | 19.2 (recurring hunt: 12; the verifier was skipped by reuse)                 |
| Mean latency                             | 0.62 s                                                               | 2.3 s                                                                        |
| Tokens / cost                            | fixture usage from the fake CLI, **not model tokens** / not reported | same                                                                         |

Where they differ:

- In `misleading-stacktrace`, A blames the crashing frame `Format`. B confirms the defect in `Fill` and attributes it as PROBABLE.
- In `correct-code-suspected`, A names `Parse` as the cause, which is a false positive. B confirms nothing.

**What this shows:** confirmation is gated by platform proof, causality is kept separate, and reuse and dedupe work. A credulous verifier cannot turn correct code into a confirmed bug.

**What it does not show:** a real model's bug-finding accuracy, or real costs. The scripted hunter is handed plausible candidates.

## 5. Cost, limitations and risks

**Cost.**

- A hunt adds 2 agent turns (hunter and verifier) to an investigation; when no candidate qualifies or reuse applies, it adds 1.
- The verifier runs only when triage leaves a candidate. Reproductions are capped at 3.
- Cost per confirmed bug comes from existing telemetry when the provider reports it. Codex reports no cost, so it shows "not reported".
- **No live run was made.** Real token and cost numbers need an approved budget.

**Reproduction.**

- Go only.
- It needs bubblewrap with user namespaces on the worker. Otherwise findings that need a test end BLOCKED and the hunt is partial (tested by branching in test 3). The GitHub runner has no bubblewrap installed, so CI exercises that path.
- It needs the module's dependencies in the local module cache, because downloads are disabled. Otherwise the outcome is `blocked`.

**Code-evidence confirmation.** When the verifier proposes no test, CONFIRMED rests on excerpts that are present in the code plus a stated execution path. This is weaker than a failing test, and the basis says so.

**Scope discovery.**

- Stack frames are parsed for Go-style traces.
- The callee-on-path check is textual.
- LSP and Code Intelligence were disabled in these tests, so their use is recorded as unavailable and the bounded text fallback is shown labelled as syntax candidates.

**Revision.** The agents read the checkout's revision. When it differs from production's commit, the gap is reported, and causality cannot be CONFIRMED unless the file is byte-identical between the two commits.

**Independence.** Platform read tools withhold the hunter's output. A provider's own native session files are outside the platform's tool policy; isolation mode governs them.

## 6. CI and delivery

- **Commit:** on branch `feat/production-bug-hunter`, pushed.
- **CI on this branch: NOT VERIFIED.** CI runs on pushes to `main` and on pull requests. No PR could be opened, because `gh` is not authenticated on this machine.
- **Live provider evaluation: NOT RUN — BUDGET NOT AUTHORIZED.**
- **Environment note:** test runs leave `ctp-test-*` roots and per-process `ctp-verification-cache-*` Go build caches in `/tmp`. Both existed before this change; bug-hunt reproductions reuse the same cache mechanism. On a small tmpfs they eventually fill it.
