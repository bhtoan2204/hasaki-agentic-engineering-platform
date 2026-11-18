# DAG replay and execution fingerprints

An explicit re-execution always opens a new generation for the target. The engine fences and invalidates its dependency closure under the run lock. Completed prerequisites and branches outside that closure retain their attempt IDs. A descendant may carry a historical attempt ID into the new generation as a candidate. Its previous output is cleared until normal dependency progression has produced fresh inputs.

The worker compares a candidate only after resolving inputs and revalidating access. Digests cover effective step and agent configuration, work item and run inputs, semantic upstream statuses and outputs, resolved knowledge and prompt plans, workspace evidence, policy and the execution contract. Upstream attempt IDs remain in the attempt and context snapshot for audit. The semantic digest compares outputs independently of those IDs. A reused output gets a new, lease-bound attempt with a link to its source, so later approvals and verification refer to current provenance.

Result reuse is deliberately limited to opt-in `agent` steps with `config.replay: "context_only"`. They need an explicit tool allowlist restricted to submission, no repositories or workspace, and no approvals, independent review, or delegation. Historical questions, artifacts, external tool observations, and outputs shaped as authorization or verification cannot supply a candidate. Legacy attempts without fingerprints execute normally.

## Planning and preview

The authorized read-only endpoint `GET /api/runs/:id/steps/:key/replay-preview` is displayed in the step re-execution dialog. Candidates are conditional until dispatch. The dialog can request `force: true` to execute the entire affected closure without result or verification reuse. An explicitly re-executed target is always forced. Budget, repository access, approval and publication gates still apply.

| Decision | Execution |
| --- | --- |
| `REUSE` | Preserve an unaffected step, or publish a matching descendant result as a new fenced attempt. |
| `RESUME` | Use the existing answer and provider-session continuation, with checkpoint validation. |
| `RESTORE` | A validated workspace artifact is available for operator restoration and reconciliation. See [Durable execution checkpoints](execution-checkpoints.md). |
| `VERIFY_ONLY` | A verification phase runs its configured tests when current evidence cannot be reused. It does not use an old coding or review verdict to bypass execution. |
| `REEXECUTE` | Execute after fresh dependency resolution and any required gates. |
| `FORCE_REEXECUTE` | Execute as requested even when a compatible prior result or test pass exists. |
| `RECONCILE` | Resolve an interruption, workspace mismatch or provider handoff before replaying affected steps. |

Standalone verification recognizes platform test commands, simple Go, Node and npm test invocations, and workflow-defined commands explicitly marked with `reuse_test_evidence: true`. Reuse requires evidence that tests ran. Passing evidence binds the clean workspace, baseline, test configuration, process environment and policy. Failed, skipped, waived or uncertain results do not become reusable. Publication and agent verification look up fully bound test evidence. The commit alone is insufficient.

## Benchmark

Run `node --import ./test/setup.ts test/replay.bench.ts`. The fixture uses local PostgreSQL and eight downstream analysis steps with a 20 ms scripted invocation and 500 synthetic tokens per call. It times seven replays of an unchanged control output following an initial run. These are fixture measurements, with no paid provider involved.

| Measurement | Baseline `b2bad02` | Incremental replay |
| --- | ---: | ---: |
| Median replay time | 670 ms | 476 ms |
| Agent invocations | 56 | 0 |
| Synthetic token count | 28,000 | 0 |
| Eligible downstream reuse | 0/56 | 56/56 |

## Decision log

`execution_decisions` (migration 067, `src/workflow/decisions.ts`) records every replay, recovery and reuse decision, `planned` or `applied`, with its reason, source attempt, latency and estimated savings:

- Re-execute stores the `planReplay` decision of each step as `planned`. Dispatch stores the REUSE, or the REEXECUTE miss, as `applied`.
- Recovery stores SAFE_RETRY / REQUIRES_RECONCILIATION, with latency measured from the expired lease.
- The harness stores:
  - session RESUME, `applied` or `rejected` with a rebuilt context;
  - RESTORE of missing worktrees;
  - verification, review and context reuse.
- Provider handoffs and workspace reconciliation are stored too.

Savings (avoided invocations, tokens, cost) are what the reused source attempt reported. They are labelled as estimates and stay unknown when the source reported nothing. Recording never changes the decision.

Where the decisions appear:
- **Run view:** each DAG node shows the latest applied decision of its current generation, and the overview has an "Execution reuse" card.
- **Re-execute dialog:** groups the preview by action with estimates. While the dialog is open, it colours the DAG nodes by their planned decision.
- **Trace Explorer:** decisions, harness stages and recoverable checkpoints are nodes. The `recovery_loop` and `checkpoint_incompatible` diagnosis rules use them.
- **Insights:** the harness section shows context, verification and replay reuse rates, the resume success rate, restores, replay and recovery latency (p50/p95; recoveries that waited for a human are excluded), estimated avoided work and checkpoint size.
