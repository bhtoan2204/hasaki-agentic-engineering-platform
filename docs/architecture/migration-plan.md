# Migration Plan

## Principles

* Additive schema changes; legacy tables (`tasks`, `events`, `questions`, `prs`, `inbox`, `settings`) are
  kept and remain readable. Nothing is dropped.
* Versioned SQL migrations in `migrations/NNN_name.sql`, applied by `src/db/migrate.ts` in order, each in
  its own transaction, under `pg_advisory_lock`, recorded with a checksum in `schema_migrations`. A
  changed checksum of an applied migration aborts startup.
* `001_legacy_baseline.sql` is exactly the old `migrate()` (all `IF NOT EXISTS`), so it is a no-op on an
  existing database and creates the legacy schema on a new one.

## Data backfill (`002_workflow_core.sql`)

| Legacy | New | Rule |
|---|---|---|
| `tasks` | `work_items` | `source = 'hasaki_work'` if `work_id` is set else `'legacy'`, `external_key = code`, `payload` copied, `legacy_task_code = code`. |
| `prs` | `pull_requests` | provider `bitbucket`, `source_branch = branch`, `target_branch = 'release/prod'`, linked to the backfilled work item; `run_id` null. |
| `questions`, `events` | unchanged | Still served by `GET /api/tasks/:code` (legacy view) and shown under "Legacy history" of the work item. |

## Phases

| Phase | Deliverable | Status in this milestone |
|---|---|---|
| 1 Architecture | migrations runner, `work_items`, workflow tables, backfill, legacy API kept | done |
| 2 Engine | definitions + versions, DAG validation, state machine, PG job queue with lease/heartbeat/fencing, executor registry, attempt history | done |
| 3 Human-in-the-loop | step questions, answers, resume, approvals, retry, re-execute-from with invalidation | done |
| 4 Agent integration | Claude executor with execution-aware MCP tools, explicit tool policy, worktrees, Bitbucket provider, PR step | done (needs live run against Claude/Bitbucket to validate end to end) |
| 5 Knowledge | registry, versions, scope precedence, context snapshots | done |
| 6 UX | Work Items, Runs, Workflow library, Questions inbox, Knowledge, Repositories screens | done (vanilla JS, same stack) |
| 7 Integrations | Jira adapter, extra templates, GitProvider seam | Jira read-only import; GitHub provider not implemented |

## API compatibility

| Legacy endpoint | New behaviour |
|---|---|
| `POST /api/tasks` | Imports/updates a work item. **Does not start anything** unless `?workflow=<key>` is passed or the work item's automation policy names a workflow. Response keeps `{code, started}`. |
| `GET /api/tasks`, `GET /api/tasks/:code` | Unchanged legacy view (reads legacy tables) plus `work_item_id`. |
| `POST /api/tasks/:code/answers` | Answers legacy questions; also answers open workflow questions of that work item's runs. |
| `POST /api/tasks/:code/messages` | Review feedback: re-executes the latest run's feedback step (`coding_agent` by default) with the message; downstream test/PR steps are invalidated and re-run; the PR step updates the existing PR. |
| `POST /api/tasks/:code/cancel` | Cancels active runs of the work item. |
| `POST /api/work/pick/:id` | Imports only. `hasakiWork.autoPick` now means "import + start `hasakiWork.autoWorkflow`". |

## Rollback

Migrations are additive; rolling back the code to `8c23002` keeps working against the migrated database
because legacy tables are untouched (the old `migrate()` is idempotent against them).
