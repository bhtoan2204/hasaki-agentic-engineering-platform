# Execution Performance: Adaptive Profiles and Reuse

## Audit (measured on real runs, before this change)

Run #3 (`bug-investigation`, a one-field ZIP Code mapping fix) took **44.8 min** wall time, run #1 51.5 min.

| Source | Measured |
|---|---|
| 4 separate Claude sessions (analyze → root_cause → fix_proposal → implement) | **91 turns, ≈$3.46, ~574 s Claude time** |
| Duplicate exploration | 20 `Read`s of 12 files (4 files read by ≥2 steps), 30 `Grep`s |
| Growing prompts | user prompt 2k → 9k → 15k → 23k chars across the steps |
| Test step | 4 attempts × ~137 s, dominated by one integration test waiting ~130 s for an unreachable DB — re-paid on every run |
| Human waits | plan approval 222 s, repository confirmation 23 s |
| Discovery | always asked Claude to re-rank, even when the deterministic ranking was unambiguous |

Already available and reused: context budgets and knowledge disclosure, baseline comparison (in-memory cache only),
per-attempt metrics, session resume after questions.

## What changed

### Adaptive profiles (`src/workflow/profiles.ts`, `resolveRunGraph` in `src/workflow/engine.ts`)

`classifyProfile` uses deterministic signals only (no LLM call): explicitly selected or reused repositories, the
deterministic discovery result (single unambiguous repository), narrow-change terms (mapping/field/format/missing/
normalize…), bug terms, declared risk (`inputs.risk` / payload `risk`), multi-repository and large-change terms, and a
high-risk vocabulary (payment, refund, COD, settlement, invoice, migration, schema, transaction, outbox, auth, token,
PII, encryption, … in English and Vietnamese).

* FAST only when: one known repository **and** a narrow-change signal **and** a bug fix (or declared low risk) **and**
  no high-risk term. A short description is never enough.
* High-risk areas → STANDARD (never FAST automatically). Multi-repository, epics/refactors or declared high risk → DEEP.
* Anything uncertain → STANDARD ("safe default"), recorded with the reasons.
* Manual override (AUTO / FAST / STANDARD / DEEP) always wins; forcing FAST on a risky task records a warning.

`applyProfile` transforms the published spec into the run's graph (the definition is never mutated):

* **FAST**: analysis `agent` steps before the first `coding_agent` are folded into it (instructions merged in order,
  `merged_from` recorded); plan approvals are removed; `agent` review steps after coding are removed; dependants are
  rewired; discovery becomes deterministic; repository confirmation auto-approves when unambiguous. Tests, the PR
  approval gate and the Task Result Report remain. If a remaining step branches on a removed step (`run_if`/condition),
  FAST is refused and the run falls back to STANDARD with the reason.
* **DEEP**: full workflow, no auto-approvals, AI-assisted discovery.
* **STANDARD**: the published workflow.

The decision (`workflow_runs.profile`, `profile_decision`) and the graph changes (`graph.profile_changes`) are stored
with the run; `POST /api/runs/preview` returns exactly what `startRun` would create.

### Less redundant work

| Change | Where |
|---|---|
| Repositories confirmed in an earlier run of the same work item are reused (within the allowed set); discovery then skips ranking | `resolveRunGraph`, `repositoryDiscovery` |
| Discovery calls Claude only when the deterministic ranking is ambiguous | `executors/builtin.ts` |
| Code locations found upstream (current attempts' Read/Edit/Grep + `path:line` in outputs) are handed to the next agent; invalidated attempts are excluded | `collectFileRefs` in `context.ts`, prompt section, snapshot `prompt_plan.file_refs` |
| Prompt asks for targeted reads (path/glob Grep, offset/limit Read, parallel reads, no re-reads) | `stepPrompt.ts` |
| Task Result Report calls Claude only when a requirement can be judged from non-screenshot evidence | `report/executor.ts` (`config.reasoning: auto|always|never`) |
| Go baseline results persisted per (repository, base commit SHA, package); tests known to fail on the same base SHA are skipped via `GO_TEST_SKIP` (`go test -skip`) and reported as pre-existing; a new base commit invalidates automatically | `test_baselines` (migration 009), `executors/baseline.ts`, template test command |

Cross-step Claude session reuse is not added: steps differ in permissions (read-only vs coding) and workspaces, so
reusing a session across them would widen what an analysis turn could do. FAST gets the same effect safely by folding
the analysis into the coding session.

### Observability

`GET /api/metrics/runs/:id` adds per-attempt **queue**, **machine** and **human** time (PostgreSQL timestamps), Claude
session time (SDK), tool time (paired tool_use/tool_result events), command/test time, retries and the slowest step;
cost is labelled an SDK estimate. The run overview shows a latency bar per step; the Insights page compares profiles
(runs, average wall time, Claude steps/run, turns/run, estimated cost/run).

## Benchmarks

`npm run bench` (deterministic graph resolution) and `npm run bench -- --live` (real Claude, throwaway DB, Go fixture
repositories, human gates auto-approved, fake git provider). Scenarios: 1 one-field mapping fix, 2 small bug in a known
repository, 3 normal feature, 4 multi-repository change.

Profile resolution (deterministic run):

| Scenario | AUTO → | Steps | AI steps | STANDARD steps / AI steps |
|---|---|---|---|---|
| 1. One-field mapping fix | FAST | 5 | 1 | 9 / 4 |
| 2. Small bug, known repository | FAST | 5 | 1 | 9 / 4 |
| 3. Normal feature | STANDARD | 9 | 4 | 9 / 4 |
| 4. Multi-repository change | DEEP | 9 | 4 | 9 / 4 |

Live measurements (real Claude, `npm run bench -- --live --scenarios=1,2`, one run per cell; every run created a
worktree, committed a real fix, ran the tests (passed) and asked no question):

| Scenario | Profile | Claude sessions | Turns | Tool calls | Output tokens | Wall | Claude time | ≈ Cost (SDK estimate) |
|---|---|---|---|---|---|---|---|---|
| 1. One-field mapping fix | FAST (AUTO) | 1 | 8 | 7 | 2,585 | 28 s | 27 s | $0.17 |
| 1. One-field mapping fix | STANDARD | 4 | 30 | 26 | 9,354 | 98 s | 92 s | $0.65 |
| 2. Small bug, known repo | FAST (AUTO) | 1 | 9 | 8 | 2,513 | 31 s | 29 s | $0.17 |
| 2. Small bug, known repo | STANDARD | 4 | 22 | 18 | 9,046 | 95 s | 89 s | $0.62 |

For these two small tasks FAST used 1 Claude session instead of 4, 59–73 % fewer turns, ~72 % fewer output tokens and
was ~3× faster, with tests and the PR gate intact. Caveats: single runs (LLM variance), a tiny fixture repository
(real repositories need more exploration in both profiles), human gates auto-approved (real runs add human time).
Scenarios 3 and 4 resolve to STANDARD/DEEP, so FAST does not apply; they were not run live.

Not measured end to end: the `GO_TEST_SKIP` saving on real repositories (unit-tested; the ~130 s per run comes from
the run #3 audit), and the effect of the file-reference handoff on STANDARD runs (no A/B run).

## Remaining bottlenecks

* Human gates (plan approval, PR approval, report review) dominate wall time of real runs; FAST removes only the plan
  approval.
* STANDARD/DEEP still start one Claude session per AI step; context is handed over as summaries and file references,
  not as a shared session.
* Integration tests that need unreachable infrastructure are still paid once per new base commit (then cached).
* Claude cold start and prompt caching are outside the platform's control; cache-read tokens dominate token volume.
