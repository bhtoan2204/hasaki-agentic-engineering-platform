# Intelligent Feature Engineering

Workflow key: `intelligent-feature-engineering`.

This is a built-in template for a complex feature, a cross-module change, or a change to this platform. It is the existing Work Item → Run → step engine. It does not add a scheduler, child runs, or a new learning system.

Seeded on startup like the other templates. Workflow Studio and the work-item start form list it once the server has seeded definitions. A run stays pinned to the version it started with.

## Graph

The steps are a single chain. `feedback_step` is `implement`. Review uses the existing independent verifier and `max_repairs: 2`.

| Step | Type | Depends on | Role |
| --- | --- | --- | --- |
| `understand` | agent | — | Objectives, acceptance criteria, constraints, assumptions, ambiguities, keywords, risks |
| `discover` | integration `repository_discovery` | `understand` | Rank repositories the owner may already use. Reuses a selection from an earlier run of the same work item |
| `confirm_repos` | human approval | `discover` | Developer confirms the repositories. Rejecting stops the run until they choose |
| `architecture` | agent | `confirm_repos` | Modules, dependencies, symbols, applicable knowledge and approved experience, alternatives, risks |
| `plan` | agent | `architecture` | Ordered subtasks for this run. A subtask is a plan item, not a child run |
| `approve_plan` | human approval | `plan` | Approves the plan. Rejecting re-executes `plan` and keeps the comment |
| `implement` | coding agent | `approve_plan` | Edits only inside `prepare_branch` worktrees. Two attempts |
| `targeted_test` | command | `implement` | Typecheck, lint and tests for the touched modules. Requires a worktree |
| `review` | agent | `targeted_test` | Independent review of the diff. At most two repairs back into `implement` |
| `regression_test` | command | `review` | Broader `go test ./...` or `npm test`, bounded by `-short` and the step timeout |
| `quality_gate` | human approval | `regression_test` | Blocks the pull request. Rejecting re-executes `implement` |
| `pr` | git pull request | `quality_gate` | Push and create or update the pull request after a person approves |

The engine appends its usual task-result report when the work item asks for one. That report is not a second workflow.

## Inputs

The work item title and description are the request. Optional run inputs:

- `goal` — a narrower statement than the work item text.
- `repositories` — names to change. When empty, discovery recommends from the owner's accessible repositories and `confirm_repos` asks the developer to confirm.

Repository access is the same deny-by-default grant used by every other workflow. An admin role is not a grant. Resumed steps re-check that grant.

## Outputs

Each agent step stores the object in its `output_contract`. Later steps read those outputs; the plan and implementation instructions tell the agent not to repeat repository ranking or a full search.

`targeted_test` and `regression_test` store the command log as an artifact, plus `passed`, `tested_heads` and `tested_clean` when a worktree exists. The pull-request step refuses to publish a commit those checks did not run on.

## Approval gates

1. `confirm_repos` — which repositories this run may change.
2. `approve_plan` — the plan. The approved output stays on the step and is what `implement` reads after resume.
3. `quality_gate` — targeted tests, review and regression. A rejection sends the run back to `implement`.
4. `pr` — `mode: "approval"`. The provider step updates an open pull request for the same source and target instead of opening another.

## Failure handling

Command steps use `on_failure: "ask"`. A failed attempt is retried within `max_attempts`. When attempts are exhausted the step waits for the developer and keeps the log artifact. Answering can rerun the command. The pull request does not start while a dependency is failed or waiting.

`implement` allows two attempts. A crashed coding or command step is not replayed blindly: existing recovery asks a person to continue and keeps the worktree.

Review repairs use the existing budget of two. They re-execute `implement` and then the checks. They do not start another run.

Pause, resume, retry and step inspection are the engine's. Nothing in this template bypasses them.

When the target repository is this installation, the existing self-development guards still apply: the live checkout is not a worktree, and a command in that checkout does not receive `DATABASE_URL`. The script also exits if `PLATFORM_SELF_TEST=1` and that variable or the application database name is present.

## Learning

Completing the run enqueues the existing learning effect. That effect proposes knowledge changes from human answers and approval comments. It does not publish a rule. A person reviews the proposal in the existing knowledge flow.

## Profiles

STANDARD keeps every step and marks the review independent. DEEP also makes that review strict. FAST folds the analysis agents and the plan approval into the coding step and drops the post-implementation review, then still runs regression, the quality gate and the pull request. Use STANDARD for a change that needs the written plan.
