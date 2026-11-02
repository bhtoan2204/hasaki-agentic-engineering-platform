# Workflow Platform (Claude Task Platform v2)

Workflow-driven AI engineering platform. Engineering requests (**work items**: manual, Hasaki Work, Jira) are executed
by reusable, versioned **workflows** made of typed steps (AI agent, coding agent, human input, approval, command,
condition, integration, pull request). Every step has durable state, attempt history, questions, checkpoints and
context snapshots in PostgreSQL. Claude Code (Agent SDK) is the executor for agent steps; Bitbucket is the Git provider.

Importing a task **never** executes anything. You pick a workflow and start a run (or set an explicit automation policy).

Architecture: [`docs/architecture/current-state.md`](docs/architecture/current-state.md) ·
[`target-state.md`](docs/architecture/target-state.md) · [`migration-plan.md`](docs/architecture/migration-plan.md)

## Run

```bash
npm install
docker compose up -d                  # PostgreSQL 17 on 127.0.0.1:55432
cp config.example.json config.json    # reposRoot, projects, bitbucket, ...
export BITBUCKET_USER=you@hasaki.vn BITBUCKET_TOKEN=...   # optional; without them the PR step stores a "create PR" link
npm start                             # http://localhost:4545 — applies migrations, seeds templates/repos/knowledge
npm test                              # creates a throwaway platform_test database on the same server
```

Node ≥ 22.18 (runs `.ts` directly), `claude` logged in, SSH key that can push to Bitbucket.

## Concepts

| | |
|---|---|
| Work item | The request. `REQ-n` (manual), Hasaki task code, Jira key. The code is the branch name. Many runs per item. |
| Workflow | Key + immutable published versions. Built-ins: Feature Implementation, Bug Investigation, Code Review, Refactoring, Work Item Analysis. Edit in the UI → draft → publish. |
| Run | One execution, pinned to a definition version, with its own resolved graph, allowed/selected repositories and branch. Can exist without a work item. |
| Step / attempt | Status `PENDING READY RUNNING WAITING_INPUT WAITING_APPROVAL COMPLETED FAILED RETRYING CANCELED SKIPPED`; every execution is an attempt with input, output, context snapshot, Claude session, error. |

Human-in-the-loop: agents call `ask_user` → step `WAITING_INPUT` (no worker held) → answer in the run page or the
Questions inbox → the step resumes its Claude session if safe, otherwise rebuilds context from persisted history.
Approvals: `human_approval` steps, or `requires_approval: true` on any step (PR mode `approval`).
Retry / re-execute from any step: downstream steps are invalidated (generation bump); upstream results are reused.

Scheduling is PostgreSQL-only: `workflow_jobs` claimed with `FOR UPDATE SKIP LOCKED`, leases + heartbeats + fencing
tokens; crashed workers' jobs are reaped and retried. Several processes may share the database.

## Safety

- No `bypassPermissions`. Each agent step gets an explicit tool list and a PreToolUse/`canUseTool` policy
  (`src/agent/toolPolicy.ts`): analysis steps are read-only (shell allowlist); coding steps may edit only inside the
  run's worktrees; `git push`, `reset --hard`, `clean`, `rm -rf`, checking out `release/prod` are always denied.
- Code is edited only in worktrees under `~/.claude-task-platform/worktrees/<branch>/<repo>`; the primary checkout is never used.
- Repositories outside a run's allowed set (project mapping in the registry) are rejected at selection, at `prepare_branch` and at PR time.
- Task text and earlier agent output are passed as `<untrusted_input>`; platform rules and curated knowledge go in the system prompt.
- PRs are opened by the `git_pull_request` step (`auto | approval | draft | none`), idempotent per repo/branch. Nothing is merged or deployed.
- The API has no auth — it listens on loopback only.

## Main API

| | |
|---|---|
| `GET/POST /api/work-items`, `POST /api/work-items/import`, `GET/POST /api/work-items/:id` | work items (POST creates a manual request; import = Hasaki/Jira, no execution) |
| `POST /api/work-items/:id/runs` `{workflow, repositories?, inputs?, start?}` · `POST /api/work-items/:id/analyze` | start a run / read-only analysis |
| `GET/POST /api/workflows`, `POST /api/workflows/:key/draft`, `/publish`, `/validate` | workflow library |
| `GET/POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/{start,pause,resume,cancel,repositories,feedback}` | runs |
| `POST /api/runs/:id/steps/:key/{retry,reexecute,approve,reject,skip}` | step controls |
| `GET /api/questions`, `POST /api/questions/answers` `{answers:{id:text}}` | questions inbox |
| `GET/POST /api/knowledge`, `POST /api/knowledge/preview`, `GET/POST /api/repositories`, `POST /api/repositories/rank` | knowledge, repository registry |
| `/api/tasks*`, `/api/work/*` | legacy endpoints, kept compatible (`POST /api/tasks?workflow=<key>` imports and starts) |
