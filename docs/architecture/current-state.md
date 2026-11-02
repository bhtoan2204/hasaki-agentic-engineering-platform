# Current State (audit of commit `8c23002`)

~1,300 lines of TypeScript run directly by Node ≥ 22.18 (type stripping, no build step), a single
static `public/index.html`, and PostgreSQL 17 via `docker-compose.yml`.

## Modules

| File | Responsibility | Assessment |
|---|---|---|
| `src/config.ts` | Loads `config.json` + env overrides (secrets, `DATABASE_URL`, `PORT`). | **Reuse as is.** Extend with new keys only. |
| `src/db.ts` | `pg` pool, one `migrate()` that runs a block of `CREATE TABLE IF NOT EXISTS`, and thin repositories for `tasks`, `events`, `questions`, `prs`, `inbox`, `settings`. | **Refactor.** No versioning, no transactions, no FKs between runs and questions. Keep the repository objects for the legacy tables; move schema to versioned migrations. |
| `src/agent.ts` | In-memory FIFO queue + `AbortController` map, Claude Agent SDK `query()` call, platform MCP server (`prepare_branch`, `ask_user`, `post_update`, `create_pull_request`), result classification into task status. | **Split.** Four concerns in one file. Queue state is lost on restart. One Claude session = one task: there is no notion of steps, attempts or re-execution. MCP tools close over the task code only. |
| `src/prompt.ts` | `normalizeTask()` (Hasaki payload → fields), `buildTaskPrompt()`, `systemAppend()` (workflow rules + TECH-HD-001 commit convention). | **Reuse.** `normalizeTask` and the commit convention text are kept verbatim; the prompt gets split into trusted (system) and untrusted (task) parts. |
| `src/git.ts` | `allowedRepos(project)` from `config.projects`, worktree per task under `~/.claude-task-platform/worktrees/<code>/<repo>`, `prepareBranch` (reuse local → track origin → cut from `origin/release/prod`), `pushBranch` (refuses dirty trees and empty branches). | **Reuse unchanged.** Wrapped by the workspace service and the Bitbucket `GitProvider`. |
| `src/bitbucket.ts` | Opens or updates the PR for `branch → baseBranch`; falls back to a "create PR" link without credentials. Already idempotent per open PR (query before POST). | **Reuse.** Wrapped behind a `GitProvider` interface; add `draft`. |
| `src/hasakiAuth.ts` | Human-in-the-loop Hasaki Work login (CDP-captured or pasted JWT), `workApi()`. | **Reuse unchanged.** |
| `src/work.ts` | Task list → `inbox`, `pickTask` imports detail **and immediately enqueues the agent**; optional poller with `autoPick`. | **Refactor.** Import must not execute. Auto-execution becomes an explicit automation policy. |
| `src/notify.ts` | Webhook notifications. | **Reuse.** |
| `src/server.ts` | `node:http` router (regex table), JSON helpers, startup (migrate, load token, re-enqueue `running/queued` tasks, start polling). | **Extend.** Keep router style; move routes into modules. |
| `public/index.html` | Vanilla JS SPA: Hasaki login, inbox, task list, task detail (questions, PRs, message box, timeline), 3 s polling. | **Extend** into a multi-screen SPA, same stack. |

## Data model

```
tasks(code PK, work_id, name, project, payload, status, session_id, error)
events(task_code → tasks)        questions(task_code → tasks, answer)
prs(task_code → tasks, repo, UNIQUE(task_code, repo))
inbox(work_id PK, code, raw, picked)        settings(key, value)
```

The task row *is* the execution: status, Claude `session_id` and error live on the request itself, so a
task can only ever have one execution and history is overwritten.

## Execution flow

`POST /api/tasks` or "Execute" → `tasks.upsert` → `enqueue(code)` (in-memory) → `run()` → one long Claude
session with `bypassPermissions` → agent prepares branches, may call `ask_user` (task → `waiting_answer`,
session ends) → answers resume the same `session_id` → agent calls `create_pull_request` → `review`.

## Gaps against the target

1. **No durability.** Queue and cancellation live in memory; restart re-enqueues with a generic message.
   No leases, no fencing: two processes on one DB would both run the same task.
2. **No workflow model.** The whole engineering process is one prompt. Nothing can be retried in isolation,
   no intermediate output can be reviewed, nothing other than an AI agent can be a step.
3. **Import == execute.** `pickTask` and `POST /api/tasks` start the agent.
4. **Permissions by prompt.** `bypassPermissions` plus a short `disallowedTools` deny-list; nothing confines
   edits to the worktree.
5. **Context.** Every rule is in one system prompt string; no business rules / skills registry, no record of
   which knowledge was applied.
6. **Repositories.** Only `config.projects`; no metadata, no ranking, no explanation.
7. **Schema evolution.** No migration versioning; no FKs from questions/PRs to an execution.
8. **No tests.**

## What must be preserved

Claude Agent SDK integration (`settingSources: ["user"]`, `claude_code` preset, in-process MCP server),
Hasaki Work auth/list/detail, Bitbucket PR creation into `release/prod`, git worktree isolation (never edit
`reposRoot`), branch = task code, TECH-HD-001 commit format, Vietnamese questions with context and options,
review feedback that updates the existing PR, and the existing `/api/tasks` / `/api/work/*` endpoints.
