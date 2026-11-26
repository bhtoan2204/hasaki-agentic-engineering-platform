# Legacy schema removal (migration 083)

`migrations/083_remove_legacy_schema.sql` removes the pre-workflow schema and database objects that no runtime code
uses. The platform has a single operator, so backward compatibility with the pre-workflow architecture is not kept.

## Before migrating

The migration runs automatically on startup. Take a backup first:

```sh
pg_dump --format=custom --file=platform-before-083.dump "$DATABASE_URL"
# restore: pg_restore --clean --if-exists --dbname="$DATABASE_URL" platform-before-083.dump
```

## Removed database objects

| Object                                                                                                                                                                                                                     | Kind         | Notes                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `tasks`, `events`, `questions`, `prs`                                                                                                                                                                                      | tables       | Pre-workflow history. Rows are discarded; work items and pull requests backfilled from them by 002 stay. |
| `events_task_code_fkey`, `questions_task_code_fkey`, `prs_task_code_fkey`, `work_items_legacy_task_code_fkey`                                                                                                              | foreign keys | Dropped explicitly before the tables.                                                                    |
| `work_items.legacy_task_code`                                                                                                                                                                                              | column       |                                                                                                          |
| `work_items.source = 'legacy'`                                                                                                                                                                                             | CHECK value  | Existing rows become `manual`.                                                                           |
| `workflow_step_attempts.workspace`, `agent_sessions.ended_at`, `platform_instances.display_name`, `chat_conversations.budget`, `telegram_updates.received_at`, `outcome_observations.recorded_at`, `intake_items.priority` | columns      | Never written or read. `intake_items_queue` is recreated without `priority`.                             |
| `agent_sessions_attempt`                                                                                                                                                                                                   | index        | Prefix of `agent_sessions_provider`.                                                                     |
| `execution_decisions_autonomy_idx`, `execution_decisions_kind_idx`, `splunk_searches_user`, `chat_turns_owner_idx`, `evaluation_comparisons_owner`, `knowledge_items_scope`                                                | indexes      | No query filters or sorts on their leading columns.                                                      |
| `evaluation_runs_cache`, `agent_recommendations_cache`, `agent_optimization_policies_cache`                                                                                                                                | triggers     | `cache_invalidate` notifications no cache listens to.                                                    |

`inbox` and `settings` stay: the Hasaki Work poller, operator settings, integrations and Telegram still use them.

## Removed code

- `/api/tasks`, `/api/tasks/:code`, `/api/tasks/:code/answers|messages|cancel` and the `#TASK-CODE` hash redirect.
- The "older history" section of the work item page and the `legacy` source filter.
- The `/classic` vanilla UI (`public/`) and its dialog browser test.
- Legacy helpers in `src/db.ts`, `src/workitems/repository.ts` and `src/workflow/runRepository.ts`.
