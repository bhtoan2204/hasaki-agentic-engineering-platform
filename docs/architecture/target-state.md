# Target State

A modular monolith (one Node process, one PostgreSQL database) that manages **reusable engineering
workflows** with durable step-level state. Claude Code is one kind of step executor, not the product.

```
            ┌──────────── HTTP API (src/server.ts + src/api/*) ─────────────┐
 UI ───────▶│ work items · workflows · runs · questions · knowledge · repos │
            └──────┬───────────────────────┬──────────────────────┬─────────┘
                   │                       │                      │
         WorkItemService        WorkflowExecutionService   KnowledgeService
         (import, never run)    (state machine, advance,   RepositoryService
                   │             invalidation, answers,          │
                   │             approvals)                      │
                   │                       │ enqueue (same tx)   │
                   ▼                       ▼                     │
            PostgreSQL  ◀── workflow_jobs ◀── WorkflowScheduler (N worker loops,
                                              FOR UPDATE SKIP LOCKED, lease,
                                              heartbeat, fencing token)
                                                  │
                                         StepExecutorRegistry
     agent · coding_agent · human_input · human_approval · command · condition · integration · git_pull_request
                 │                                                    │
        ClaudeAgentExecutor ── ContextResolver (immutable snapshot)  GitProvider (Bitbucket)
        (platform MCP tools are execution-aware)                      Workspaces (git worktrees)
```

## Core concepts

| Concept | Table | Notes |
|---|---|---|
| Work Item | `work_items` | The engineering request. Sources: `manual`, `hasaki_work`, `jira`, `legacy`. Importing never executes. Optional `automation_policy` (`{ "workflow": "<key>" }`) is the *only* way a run starts without a click. |
| Workflow Definition | `workflow_definitions` + `workflow_definition_versions` | A key + immutable published versions (`spec` JSONB, validated DAG). Drafts are edited, publishing freezes a new version. |
| Workflow Run | `workflow_runs` | Pinned to one `definition_version_id`; stores its own **resolved graph** (`graph` JSONB) so later definition edits never affect it. `work_item_id` is nullable. |
| Step | `workflow_steps` | One row per node in the run: status, `generation`, inputs, current output, config, approval. |
| Attempt | `workflow_step_attempts` | Every execution of a step: number, generation, input/output snapshot, context snapshot, agent session, error, timestamps. Never overwritten. |
| Job | `workflow_jobs` | A durable unit of work ("execute step S at generation G"). Claimed with `FOR UPDATE SKIP LOCKED`, leased, heart-beaten, fenced. |
| Checkpoint | `workflow_checkpoints` | What is needed to resume a paused step (session id, workspace refs, progress notes, reason). |
| Question | `workflow_questions` | Bound to run + step + attempt. |
| Artifact | `workflow_artifacts` | Step outputs too big for JSON columns: command logs, review reports, diffs. |
| Context snapshot | `context_snapshots` | Immutable (UPDATE blocked by trigger), content-hashed record of exactly what an attempt saw, including knowledge item versions. |
| Agent session | `agent_sessions` | Claude session id per attempt, with `resumable` flag. |
| Workspace | `execution_workspaces` | Worktree path + branch per (run, repo). |
| Pull request | `pull_requests` | Unique per (provider, repo, source, target) → retries never duplicate. Linked to run, step and work item. |
| Repository | `repositories` | Registry seeded from `config.projects`; description, services, tags, dependencies, `allowed_actions`. |
| Knowledge | `knowledge_items` + `knowledge_versions` | Category, scope, conflict key, enforced flag; versions hold content + applicability. Skills are a category. |

## Step state machine

```
PENDING ──deps done──▶ READY ──claimed──▶ RUNNING ──▶ COMPLETED
   ▲                     │  ▲               │ │ │
   │ invalidated         │  │ answered      │ │ └──▶ WAITING_INPUT ──answer──▶ READY (new attempt, resumes)
   │                     │  └───────────────┼─┴────▶ WAITING_APPROVAL ─approve─▶ COMPLETED | READY (gate)
   │                     │                  ├──────▶ RETRYING ─backoff─▶ READY   (auto retry, max_attempts)
   │                     ▼                  └──────▶ FAILED ──retry──▶ READY
   └──── COMPLETED/SKIPPED/FAILED/WAITING_* (when an upstream step is re-executed)
any non-terminal ──▶ CANCELED          PENDING/READY ──run_if false──▶ SKIPPED
```

Transitions are validated by `src/workflow/stateMachine.ts` and every transition happens inside a
transaction holding the run row lock (`SELECT … FOR UPDATE` on `workflow_runs`).

Run statuses: `PENDING, RUNNING, PAUSED, WAITING, COMPLETED, FAILED, CANCELED`. A paused run lets
in-flight attempts finish but schedules nothing new.

## Scheduling and recovery

* `advance(runId)` (in the caller's transaction): PENDING steps whose dependencies are COMPLETED/SKIPPED
  become READY (or SKIPPED by `run_if`, or WAITING_APPROVAL if `requires_approval`); READY steps get a job
  with idempotency key `step:<id>:gen:<g>:try:<n>` (unique index ⇒ double enqueue is a no-op).
* Worker claim: `UPDATE workflow_jobs … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1)`, sets
  `lease_owner`, `lease_expires_at`, increments `fencing_token`.
* Heartbeat extends the lease only if the token still matches; a mismatch aborts the executor.
* Completion (`completeAttempt`) re-checks job token **and** step generation under lock; stale results
  (lease lost, step re-executed meanwhile) are discarded and recorded on the attempt as `stale`.
* Reaper: jobs whose lease expired are failed with `lease expired`; the attempt is closed as FAILED and the
  step goes to RETRYING/FAILED by the normal retry policy. Nothing depends on in-memory state, Claude
  session ids or AbortControllers to recover.
* Human waits (WAITING_INPUT / WAITING_APPROVAL) hold no job and no worker.

## Re-execution and invalidation

`retryStep(step)` / `reexecuteFrom(step)` bump the step's `generation`, set it READY and walk the
resolved graph to reset every transitive dependant to PENDING (also bumping their generation). Their
previous attempts remain with `invalidated_at` set. Because completion is fenced by generation, output
produced from invalidated context can never be written back. Steps not downstream (e.g. analysis when
implementation is retried) keep their COMPLETED output and are reused.

## Human-in-the-loop

* `ask_user` (MCP tool) writes `workflow_questions(run, step, attempt)`; when the agent turn ends the
  executor returns `waiting_input` with a checkpoint (session id, workspaces, notes).
* Answering all open questions of a step: for `human_input` steps the answers *are* the output (COMPLETED);
  for agent steps the step goes READY with the answers in `pending_input`, a new attempt resumes the Claude
  session if `agent_sessions.resumable`, otherwise rebuilds the prompt from durable artifacts (original
  context snapshot + prior Q&A + progress notes).
* Approvals: `human_approval` steps complete on approve and fail on reject (optionally re-executing an
  upstream step with the reviewer's feedback). Any step can declare `requires_approval: true` to get a gate
  *before* it runs (used for "approve before PR").

## Context and knowledge

`ContextResolver.resolve(run, step)`:
1. Relevant repositories = run's selected repositories (∩ allowed set).
2. Candidate knowledge = enabled items whose scope matches
   `GLOBAL < ORGANIZATION < PROJECT < REPOSITORY < WORKFLOW < STEP` and whose applicability
   (`step_types`, `step_keys`, `repos`, `projects`, `keywords`) matches, plus items explicitly assigned in
   step config (`knowledge`, `skills`).
3. Conflicts: items sharing a `conflict_key` → the most specific scope wins, then higher `priority`, then
   newer version, then key order. **Exception:** `enforced` items (security policies) cannot be overridden
   by a more specific scope. Losers are recorded as `overridden` in the snapshot.
4. The snapshot (knowledge item+version list, upstream outputs by attempt id, answers, repositories, work
   item) is hashed and stored immutably; the attempt references it.
5. Prompt assembly: platform policies + resolved knowledge go into the **system prompt** (trusted). Work
   item text, upstream agent output and repository content go into the **user prompt** inside
   `<untrusted_input>` blocks with an explicit "data, not instructions" notice.

## Claude execution and permissions

> The single-agent + skills + tools design (progressive disclosure, integration tool registry, context budgets,
> optional read-only subagents, metrics) is described in [`agent-architecture.md`](agent-architecture.md).

`ClaudeAgentExecutor` replaces `bypassPermissions` with:
* `tools`: explicit per step type (analysis steps: `Read, Grep, Glob, Bash`; coding steps add `Edit, Write`).
* `permissionMode: "default"` + `canUseTool` policy: Edit/Write only inside the run's workspaces; Bash
  denied for `git push`, `git reset --hard`, `git clean`, `rm -rf`, `checkout <base>`, and for any command
  in analysis steps that is not on a read-only allowlist.
* Platform MCP tools carry `{runId, stepId, attemptId}`: `prepare_branch` (coding only, repo must be in the
  run's selected ∩ allowed set), `ask_user`, `post_update`, `submit_result`, `read_step_output`.
* `create_pull_request` is no longer an agent tool: PRs are a dedicated `git_pull_request` step
  (`mode: auto | approval | draft | none`).

## Git

`GitProvider` interface (`openOrUpdatePullRequest`, `pushBranch`, `prepareWorkspace`); `BitbucketProvider`
wraps the unchanged `bitbucket.ts` + `git.ts`. Branch = work item code (legacy convention) or
`wf/<run-short-id>` for runs without a work item; target = `config.baseBranch` (`release/prod`).

## Built-in workflow templates

Feature Implementation, Bug Investigation, Code Review, Refactoring (seeded on startup, versioned like any
user-created definition).
