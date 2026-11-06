# Phase 1: local instances sharing PostgreSQL

## Source audit (baseline 7370a03)

- `src/config.ts`: explicit `PLATFORM_INSTANCE`/config identity existed, otherwise hostname; no persisted generated identity or instance health registry. Worker settings and provider executables/model overrides were process-local.
- `src/workflow/scheduler.ts`: PostgreSQL `FOR UPDATE SKIP LOCKED`, expiring leases, per-job heartbeat, fencing tokens, heavy/light lanes and a periodic reaper already existed. These remain the scheduler.
- `migrations/018_run_worker_instance.sql` and `019_enforce_worker_instance.sql`: run pinning and a database claim guard existed. NULL permitted any worker. `engine.ts:adoptRun` silently changed the pin on start/resume/retry.
- `src/workflow/engine.ts`: attempts, generation invalidation, checkpoint persistence, question/approval recovery, stale-result rejection existed. Expired attempts used normal failure/retry policy; interrupted shutdown jobs were always requeued, including operations with external effects.
- `src/workflow/local.ts`: only process-local abort handles and child process groups; durable correctness comes from database leases. `src/workflow/context.ts` reconstructs upstream outputs, answers and snapshots.
- `src/workflow/executors/`: condition/human control steps, arbitrary commands, discovery, report creation, push/PR execution; arbitrary commands and agents cannot be assumed idempotent. The agent implementation already resumes compatible sessions by provider/cwd/upstream and reconstructs prompts on session failure.
- `src/git.ts` / `src/git/provider.ts`: reusable task worktrees, branch reuse and recorded run workspaces existed. Existing paths could switch branches, and worktree prune ran during preparation.
- `src/repos/service.ts`: registry, authorization, ranking and relative layout hints existed. Local discovery merged project/path metadata and disabled entries when a local directory was not Git. No explicit checkout override map. Context, knowledge importer and review/report paths use the existing `repoPath` entrypoint.
- `src/db/`, `src/cache/`: transactional state changes, append-only checksummed migrations, PostgreSQL NOTIFY cache invalidation with TTL/disconnection fallback. Reused unchanged; heartbeat health is not cached.
- `src/api/routes.ts`, `src/http/app.ts`, React `RunView` / `StepInspector`: authenticated run ownership checks existed; no instance-health display or local-only execution controls.
- `src/auth/secrets.ts`, integration modules: Hasaki Work, personal Bitbucket and notification destinations already used encrypted per-user credentials. Argo/Splunk/Kafka UI/Vault instead used global plaintext `settings` and process-wide sessions. Telegram is an intentionally shared bot, separate from each user's notification destination.

Implementation plan: persist local identity; add a small process-session registry; retain scheduler and enforce existing ownership; route interruption through safe retry or checkpointed reconciliation; centralize checkout overrides and stop filesystem-based shared edits; expose health minimally; verify with real PostgreSQL and separate Node processes.

## Upgrade and ownership policy

Stop old-version workers before upgrading all installations. Migration 025 is additive and preserves runs and history. It replaces the claim trigger to reject unassigned (`worker_instance IS NULL`) jobs. Mixed old-version workers do not understand the new process-session registry and must not be left running.

`PLATFORM_INSTANCE` takes precedence, followed by the existing explicit `config.instanceId`. Otherwise a UUID is created once at `<dataDir>/instance-id` with exclusive creation and restrictive permissions. The generated file is rejected inside Git. Keep `dataDir` on the owning installation, outside this checkout; do not copy it to another machine. Invalid/corrupt identities fail closed rather than regenerate.

On a legacy hostname installation, startup detects existing runs pinned to that hostname and requires the administrator to explicitly configure that exact legacy ID after verifying ownership. Runs are never renamed or adopted. Startup also rejects conflicting ownership records for workspaces beneath the local dataDir. Renamed hosts or restored disks require the administrator to check existing pins and local workspaces before configuring the original ID. Unassigned legacy runs are held until an administrator verifies their original worktrees/sessions and assigns the correct `worker_instance` directly in PostgreSQL. There is deliberately no cross-machine “take over” button.

Startup registers a random process session. A live duplicate ID fails startup. After a clean stop or heartbeat expiry, a replacement process using the **same** installation ID registers and expires/fences old jobs. The old process's claims, execution starts, job heartbeats and completions are rejected. A registry heartbeat is one lightweight update every 15 seconds; recursive scheduling prevents overlapping loops. Thresholds are configurable under `instance.heartbeatSeconds` and `instance.offlineSeconds` (default 60). Job heartbeat/lease settings remain separately configurable under `scheduler`.

Health uses PostgreSQL time: ONLINE until two heartbeat intervals, STALE until the offline threshold, OFFLINE on graceful stop or threshold expiry, UNKNOWN for absent registrations. These describe observed availability, not proof a process crashed. The run page polls its small authenticated worker-health endpoint every 15 seconds, independent of workflow events. Heartbeats contain no paths, environment or credentials.

## Recovery policy

No new persisted workflow status was introduced. Recovery uses existing attempts, jobs, checkpoints, questions and step states.

| Interruption | Behavior |
| --- | --- |
| Claim with no started attempt | Requeue under its original run pin |
| Condition, human control, discovery/selection/noop integration, draft report | Mark interrupted attempt STALE; requeue without consuming retry budget |
| Agent/coding agent, arbitrary command, push/PR, unknown integration/executor | WAITING_INPUT with `REQUIRES_RECONCILIATION` checkpoint and explicit question; no automatic replay |
| Compatible saved provider session | After reconciliation, reuse existing provider/cwd/upstream compatibility checks |
| Missing/incompatible saved session | Rebuild prompt from persisted history/checkpoint notes and inspect existing worktree state |
| Ordinary permanent executor failure | Existing failure classification remains in effect |

Before selecting **Reconciled — continue** / **Đã đối soát — tiếp tục**, inspect the prior attempt, saved worktree and external state: remote branch tips, open PRs, API records and integration results. The answer explicitly authorizes retry/resume; it does not claim exactly-once external effects. Choose Stop if replay is unsafe. Use existing skip/reexecute controls for a manually reconciled operation when appropriate. Original attempt IDs, checkpoints, completed upstream steps and local changes remain intact. Existing worktrees with unexpected branches/common Git directories are rejected without checkout/reset/prune. No automatic destructive cleanup runs.

The retry-budget counter excludes interruptions while attempt numbers still increase. Retired interrupted jobs receive a distinct idempotency key so confirmed recovery can enqueue a fresh attempt without colliding with history. Completion/heartbeat after lease expiry cannot revive the job; late completion leaves reconciliation to the reaper.

## Configuration boundary

`config.json` / `PLATFORM_CONFIG` is installation-local (already Git-ignored). `config.example.json` documents the shape. Environment overrides are process-local. Do not distribute a real config or `.env` containing credentials.

| Classification | Settings / storage |
| --- | --- |
| SHARED repository metadata | PostgreSQL `repositories`: name, provider/remote slug, description, projects, services, owners, tags, dependencies, architecture, allowed actions, enabled. `path` remains only a legacy **relative** layout hint; absolute paths cannot be written by registry APIs. |
| SHARED engineering policy | PostgreSQL workflow definitions/versions, run-level profile/provider choices, knowledge/rules/versions and organization conventions. Existing `organization`, `baseBranch`, `projects` and `relatedProjects` config values remain compatible bootstrap/policy inputs: distribute intentionally and consistently; editing existing registry mappings is explicit via its admin API, not startup sync. |
| SHARED integration policy | Non-secret provider URLs, project/service mappings, file URL prefix, Bitbucket workspace/reviewers, production scan namespace/index/timezone/search limits; defaults remain in config. Production scan schedule/notification preferences remain in PostgreSQL `settings.prod_errors`. |
| LOCAL runtime | `port`, `publicUrl`, `reposRoot`, `repositories` override map, `dataDir` (including worktree/temp/download/browser locations), instance identity/health timings, database URL/pool sizes/timeouts, scheduler workers/lanes/lease/heartbeat/polling, maxConcurrent/maxTurns, provider binaries and model/routing defaults, agent context/settingSources settings, local browser executable/profile, task polling/automation preferences, learning resource limits. |
| USER-SCOPED credentials | Encrypted PostgreSQL `user_secrets`: Hasaki Work, personal Bitbucket, personal Telegram destination, Argo, Splunk, Kafka UI and Vault tokens/cookies. User accounts/password hashes, auth sessions and OAuth state remain in existing auth storage. Agent CLI login state remains local to the owning worker; never read or synchronize provider auth files. |
| Explicit service credentials | `DATABASE_URL` and `AUTH_SECRET` from local deployment environment; shared-database installations must use compatible AUTH_SECRET for existing encrypted user credentials/auth. Bitbucket/Jira service credentials, webhook and Telegram bot environment values remain explicitly configured service credentials, not a developer login. New saved shared Telegram bot credentials use encrypted `shared_secrets`; legacy rows are preserved. |

Local models and executables never overwrite run-level provider selection. Claude supports `agent.claudeBin` / `CLAUDE_CODE_EXECUTABLE`; Codex retains `agent.codex` / `CODEX_*`; Cursor retains `agent.cursorBin` / `CURSOR_AGENT_BIN`. No provider fallback is added. Startup warns when optional executables/checkouts are absent; authentication is checked by existing execution-time provider probes, without model calls.

Argo/Splunk/Kafka/Vault legacy global settings have no verified user owner: they are preserved for administrator review but are **not** loaded. Every user reconnects through Integrations; session memory resolves through the authenticated request principal or persisted run owner. Credential caches refresh from encrypted storage within 15 seconds. The existing scheduled production scan now requires explicit local `prodErrors.userId`; it runs with that active user's Splunk credential. Without it, manual scans stay usable and the schedule emits an actionable startup warning. An arbitrary user's browser session is never chosen for unattended work.

## Local repository mapping

```json
{
  "reposRoot": "/home/developer/work",
  "dataDir": "/home/developer/.claude-task-platform",
  "repositories": {
    "oms-api": "/home/developer/work/oms-api",
    "payment": "/mnt/repos/payment"
  },
  "instance": { "heartbeatSeconds": 15, "offlineSeconds": 60 }
}
```

The centralized resolver (`src/repos/paths.ts`, exported via existing `repoPath`) uses local overrides first, then the legacy relative hint/name under reposRoot. Paths normalize and reject traversal/absolute shared hints. Checkout validation checks Git and compares origin to remote_slug when both exist; mismatches block workspace preparation. Coding preflight pauses for missing/mismatched selected checkouts before any model call. Overrides are never written to PostgreSQL. Authorization and availability stay separate: missing optional checkouts warn locally and cannot disable shared metadata. Discovery only inserts absent repositories; it never merges over existing metadata or disables an entry. Concurrent initial inserts are conflict-safe.

Existing run workspace paths and session cwd values remain persisted operational records of their owner, not shared configuration. Reusing an identity on a different installation does not move those files. Claude/Cursor primary-checkout protection includes override directories; worktree roots reject escaping symlinks and conflicting existing worktrees.

## Verification

`test/instances.test.ts` uses real PostgreSQL and separate Node processes, with fake executors and no model calls. It covers persistence/identity conflicts, ownership, lease expiry, concurrent reapers, stale completion, safe owner recovery, checkpoint/session preservation and explicit reconciliation, local paths/remotes, shared registry isolation, optional providers and per-user encrypted sessions. Updated existing engine/repository tests reflect the deliberate removal of automatic adoption/replay.

Run `npm run typecheck`, `npm run build`, and `npm test`. The suite creates only the isolated local `platform_test` database through `test/setup.ts`; remote test URLs are refused. See the task's final report for checks actually executed.

Verified on 2026-11-06 in the isolated task worktree: `npm run typecheck` passed, `npm run build` passed, `npm test` passed all **324 tests** (zero failures/skips), and `git diff --check` passed. The PostgreSQL-backed tests ran against the local container, including separate-process claim/registration checks. No live model calls were made. One pre-existing credential-test timestamp fixture was made deterministic after a second-boundary failure during verification.

## Repairing an existing installation

If another instance's legacy `repositories.path` points into a missing group folder, local resolution now falls back to an existing `reposRoot/<name>` checkout. Explicit `repositories` overrides still take precedence. Group discovery excludes linked Git worktrees (identified by their `commondir` marker), while retaining ordinary repositories and submodules. Existing incorrect registry entries still require an intentional operator correction; startup never disables them automatically.

After explicitly verifying the legacy credential owner, an operator can run:

```sh
node --env-file=.env src/cli/claim-integration-credentials.ts --user-id 1 --kind splunk_cookie
```

The target must be an active administrator. The command encrypts and verifies the complete credential, refuses to overwrite a different personal credential, clears only the migrated plaintext value while retaining the settings row, and records an audit entry in the same transaction. Repetition is harmless. It never prints tokens or chooses an owner automatically. Without verified ownership, reconnect through Integrations instead.

Repair verification on 2026-11-06: the real installation returned `startupWarnings: []` after explicit local mapping repairs, four requested clones, verified-owner Splunk credential transfer, and correction of the mistakenly registered worktree alias. `npm test` passed **328 tests**, typecheck/build passed, and `git diff --check` passed.
