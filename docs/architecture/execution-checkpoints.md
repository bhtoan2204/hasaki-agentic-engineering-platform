# Durable execution checkpoints

The workflow engine stores recovery milestones in `workflow_checkpoints`. Migration 065 adds a versioned envelope alongside the existing payload. Progress notes and provider submissions are historical observations. They cannot supply a successful executor result or authorize recovery.

| Boundary | Durable records |
| --- | --- |
| Begin attempt | The attempt, pinned input, generation, lease token and immutable context snapshot commit before the executor starts. |
| Executor return | A versioned checkpoint and the termination timestamp commit together under the run and job locks. The checkpoint records the result kind, remaining state transition, hashes of the pinned input and context, and references to artifacts and verification evidence. |
| Human wait or provider handoff | The checkpoint commits with the wait state. Handoff confirmation retains the accepted workspace fingerprint for revalidation immediately before dispatch. |

On lease expiry, the reaper can apply a valid, fully returned `condition` or `noop` result to the original attempt. It runs the normal state transition and does so inside the recovery transaction. External effects and interrupted provider calls retain the existing reconciliation question. After reconciliation, the attempt can reuse a compatible provider session. The provider-neutral path carries validated checkpoint and workspace evidence in the existing context pack. A missing or incompatible session starts with that evidence and the current workspace. Crash recovery, automatic retries and provider handoffs validate their workspace before dispatch. During a normal question wait, a compatible native session can continue from the live worktree after the developer answers. Verification still uses the current workspace.

Versioned records bind the exact attempt, run, step, generation, job, fencing token, snapshot and pinned input. Checkpoint and workspace artifact digests are verified on read. Continuation compares run inputs, work item, upstream and approval with the source attempt. Native sessions also use the existing provider, effective-agent and working-directory checks and must match the generation and pinned knowledge.

## Workspace recovery

At executor return, the worker inspects registered, in-scope worktrees for the applicable run or subtask. Coding and command checkpoints can archive the staged index patch, the working-tree patch relative to HEAD, and non-ignored untracked regular files with their modes. Artifacts are encrypted with the platform deployment key. Capture uses up to 2 MiB of patch and raw file bytes across the workspace. The reaper cannot reconstruct edits that existed only in a lost directory before the executor returned. Checkpoints preserve that distinction through the workspace availability and artifact fields.

An attempt can record executor return once. The latest eight executor-return checkpoints per step retain their associated workspace artifacts. Each replayable result is limited to 128 KiB. Older wait records, progress, and immutable context snapshots retain their existing history semantics.

An operator with the database connection and deployment key can export a validated archive. The export creates a new owner-readable file and refuses to overwrite a path.

```sh
node --env-file-if-exists=.env src/cli/export-workspace-checkpoint.ts ATTEMPT_ID /private/path/checkpoint.json
```

Restore in an isolated, clean checkout at the recorded HEAD. Extract the two patch strings for the repository, apply the index patch with `git apply --cached`, and apply the tracked patch to the worktree with `git apply`. Skip empty patches. Decode the untracked entries into new regular files inside the checkout and restore their recorded modes. Reconcile the reconstructed changes with the registered worktree and confirm the recovery question before execution continues.

## Observability

The step inspector separates recoverable checkpoints from notes. Recoverable checkpoints are `executor_returned` plus the `waiting_input`, `waiting_approval` and `provider_handoff` pauses; they are shown as milestones. `progress`, `submit_result`, `skill_read` and `profile_*` rows are progress notes and are grouped apart. `src/workflow/checkpointView.ts` derives the following from rows already loaded, read-only:

- the compatibility of each milestone: `compatible`, `stale_generation`, `invalidated`, `workspace_changed`, `legacy` or `unknown`;
- the latest recoverable checkpoint, with its workspace fingerprint and archive size, context snapshot and hash, and verification digest.

"Compatible" means no incompatibility was found in those rows; dispatch still runs the full binding and workspace checks. The recovery action shown comes from `planContinuation`. Each executor return records its checkpoint size, envelope plus encrypted workspace, as a `checkpoint` decision.
