# Workflow-to-workflow delegation

A step of a running workflow can ask the platform to run **other workflows** when it finds independent work that needs
its own execution, verification or deliverable. Doing the work inside the current workflow remains the default.

## How it works

**Opt-in per step.** A step may delegate only when its config allows it:

```json
{ "key": "plan", "type": "agent",
  "config": { "child_workflows": { "workflows": ["bug-investigation"], "modes": ["propose", "blocking"],
                                   "max_children": 3, "budget_usd": 5 } } }
```

**Declarative request.** The agent adds this to its `submit_result` output:

```
child_workflows: [{ workflow, title, request, reason, mode?, repositories? }]
```

No tool starts a run. The platform validates each request in the transaction that completes the step, records one row
per request in `workflow_delegations` (migration 107), and starts the children on the scheduler's reconcile tick (or
right after the commit).

**Modes:**
- `propose`: the child is created PENDING; a human starts it (existing start action).
- `blocking`: the step waits (`WAITING_INPUT`, no question) and completes with
  `output.child_workflows.results`. A child that does not complete fails the step; re-execute or skip it as usual.
- `parallel`: the parent continues; the parent **run** completes only after the child (it shows `WAITING`).
- `detached`: nobody waits; the link is kept.

**Children are ordinary runs:**
- same owner;
- repositories within the parent's allowed set (never wider);
- their own approval gates, independent review and run budget (`budget_usd`, set before they start);
- title `↳ #<parent> …`;
- linked by `inputs.delegation.id`.

## Bounds and safety

| Rule | Value |
|---|---|
| Who may delegate | Only steps with `child_workflows` config. Otherwise the request is ignored and logged. |
| Allowed targets | Only the step's allowlist. |
| Justification | `reason` is required (at least 20 characters). |
| Depth | At most 2. |
| Cycles | A workflow already in the delegation chain is refused. |
| Children | At most 5 per step (`max_children`, default 3). |
| Concurrency | At most 3 active children per delegation tree; the rest queue. |
| Cost | Each child has a run budget (step `budget_usd`, else the platform run budget, else $5), enforced by the existing preflight and after-attempt gates. |
| Duplicates | `UNIQUE(root_run_id, dedupe_key)`: workflow, normalized request and repositories. Re-executing a step or repeating a request reuses the same child. |
| Read-only parent | May only **propose** a workflow that can change code. Self-development is only ever proposed. |
| Crash safety | A child created before a crash is found again by `inputs.delegation.id`. Spawning is retried 3 times, then marked failed with the error. Resuming, joining and cascading are idempotent. |
| Cancel | Canceling (or failing) a parent cancels its non-detached children. Detached children are never canceled. |

## Visibility

- **One screen (Run view DAG):** the children are drawn under the parent's steps, in a "Child workflows" lane linked to
  the delegating step by a dashed edge coloured by the children's state.
  - The delegating step shows a `done/total` badge. While it holds for blocking children it reads "waiting for child
    workflows", not "waiting for input".
  - Each child card shows title, `#run · workflow`, a mini strip of its steps (coloured by status), progress and
    current step, plus mode and status pills, its own children count and its error.
  - Card actions: **Open**; **Start** (a proposed child); **Cancel** (an active child), both after confirmation; and
    **Needs approval** (opens the child at the step waiting for approval). Approving from the parent would skip the
    context an approval gate shows.
  - The page refreshes every 5 s while a child is active, because child events belong to the child run.
  - A child run shows "Child workflow of #parent".
- **Chat `runs.get`:** returns the same data, which also covers Telegram chat answers.
- **Notifications:** children notify like any run.
- **"Waiting for you" views:** a step waiting only on children is excluded (Run view banner, Telegram status and
  blocked filter).
- **Browser test:** `npm run smoke:run-delegation`; screenshots in `docs/validation/run-delegation-*.png`.

## Measured (offline, stub agents: `test/workflow-delegation.integration.ts`)

- **Run duration:** a parent with one blocking child completes in ≈140 ms, against ≈60–90 ms for a plain parent. The
  difference is the child run itself (≈35 ms) plus one dispatcher pass.
- **Idle dispatcher pass:** ≈2–3 ms.
- **Model calls:** delegation bookkeeping makes none.

## Limitations

- **The agent does not resume.** A blocking step's agent is not re-invoked with the results. The results go into the
  step output for downstream steps.
- **Results are summaries.** A child's result is its final step's `summary` (bounded) plus status and link, not its
  full artifacts.
- **Delegation is not retried.** A child that fails is reported, not re-spawned. Retries happen inside the child, by
  the engine.
- **The concurrency bound is per tree, not per owner.** Owners with many trees rely on existing run limits.
- **The cycle rule is by workflow key.** Fanning out to the same workflow type within one chain is refused.
