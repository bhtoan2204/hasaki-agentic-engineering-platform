# Workflow Platform (Claude Task Platform v2)

Workflow-driven AI engineering platform. Engineering requests (**work items**: manual, Hasaki Work, Jira) are executed
by reusable, versioned **workflows** made of typed steps (AI agent, coding agent, human input, approval, command,
condition, integration, pull request). Every step has durable state, attempt history, questions, checkpoints and
context snapshots in PostgreSQL. Claude Code (Agent SDK) is the executor for agent steps; Bitbucket is the Git provider.

Importing a task **never** executes anything. You pick a workflow and start a run (or set an explicit automation policy).

Architecture: [`docs/architecture/agent-architecture.md`](docs/architecture/agent-architecture.md) (single agent + skills + tools) ·
[`docs/architecture/performance.md`](docs/architecture/performance.md) (FAST / STANDARD / DEEP profiles, reuse, latency) ·
[`docs/architecture/current-state.md`](docs/architecture/current-state.md) ·
[`target-state.md`](docs/architecture/target-state.md) · [`migration-plan.md`](docs/architecture/migration-plan.md)

## Run

```bash
docker compose up -d                  # PostgreSQL 17 on 127.0.0.1:55432
npm install
cp config.example.json config.json    # reposRoot, projects, bitbucket, ...
export BITBUCKET_USER=you@hasaki.vn BITBUCKET_TOKEN=...   # optional; without them the PR step stores a "create PR" link
npm start                             # builds the UI, then http://localhost:4545 (migrations + seeds run on boot)
```

Development: `npm run dev` (backend with --watch) + `npm run dev:web` (Vite hot reload on http://localhost:5173,
proxying /api to :4545). `npm run typecheck` checks backend and UI, `npm test` uses a throwaway `platform_test` database.

The PostgreSQL pool defaults to 10 connections and waits at most 5 seconds for a free client
(`database.poolMax` / `database.connectionTimeoutMillis` in config.json, or `DATABASE_POOL_MAX` / `DATABASE_CONNECTION_TIMEOUT_MS`).

## UI (React + XYFlow, `web/`)

| Screen | What you can do |
|---|---|
| **Runs → run** | Live execution graph (SSE from PostgreSQL LISTEN/NOTIFY, polling fallback). Start / step mode / pause / resume / cancel. Click a node → inspector: config, resolved input, output (Markdown + JSON tree, copy), applied knowledge from the context snapshot, Claude session, Q&A, checkpoints, artifacts, attempt history; retry, re-execute from here, skip, run this step (step mode). Questions and approvals are answered in the inspector; blocked nodes pulse. |
| **Claude tab** | Execution viewer streamed while the step runs: prompts, Claude messages, tool calls with full input/result, files read / modified, commands, errors, reasoning summaries, turn cost — filterable by type. |
| **🔍 Changes** | Per workspace: commits ahead of `release/prod`, changed files, colored diff, uncommitted work, the exact PR title/description the PR step will send, test/review results. Approve the PR step from there. |
| **Workflows → editor** | Node canvas: add steps from the palette, drag, connect (dependencies), delete; per-type forms (prompts, output contract, skills, business rules, repository discovery, approval/reject routing, commands, conditions, PR mode); validate, save draft, publish version, load older versions, run (normal or step mode). |
| **Knowledge** | Business rules, architecture, conventions, repo instructions, skills; scope + applicability, version history, audit, where it is assigned and which executions actually received it. |
| **Work Items / Questions / Repositories** | Import (Hasaki list or task id, Jira, JSON), manual requests, start runs; cross-run questions inbox; repository registry and ranking preview. |

The previous vanilla UI is still served at `/classic`.

Node ≥ 22.18 (runs `.ts` directly), `claude` logged in, SSH key that can push to Bitbucket.

## Telegram notifications (optional)

When a step starts waiting for you (WAITING_INPUT: questions, WAITING_APPROVAL: approval / report review / approval gate)
the platform sends one Telegram message with the task, run, step and reason, plus a link that opens the run with that
step selected (`#/runs/<id>/<step>`). One-way only: you answer/approve in the app.

1. Send any message (e.g. `/start`) to your bot, then get your chat id:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'`
2. `cp .env.example .env` and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (`.env` is git-ignored;
   `npm start`, `npm run dev` and `npm run serve` load it with `node --env-file-if-exists=.env`).
   Exported shell variables work too.
3. Restart. Without both variables nothing is sent. Links use `publicUrl`: an `https://` publicUrl becomes a
   "Mở bước cần xử lý" button; a local URL (default `http://localhost:4545`) is sent as a text link.

Sending is fire-and-forget with a 5 s timeout (Telegram and the webhook POST). Failures are logged without the token
and never affect the workflow. Run-level "WAITING" goes to the webhook only, so Telegram gets one message per waiting step.

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
