# Swallowed errors that need a decision

Found while replacing `.catch(() => {})` with `ignoreError(context)` (src/ignoreError.ts, 95 sites: cleanup in `finally`
blocks, response-body cancels, advisory unlocks, best-effort metrics, listener shutdown). Those are deliberate and
harmless, so only their logging changed.

The 20 sites below **still use `.catch(() => {})`**, untouched. Each one hides a failure that can leave data missing
or stale with no trace. No control flow was changed; each needs your decision: log it (`ignoreError` gives a debug
line and a counter), log at warn, retry, or fail the caller.

| #   | Where                                         | What is swallowed                                                                   | Consequence if it fails                                                                                       |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `src/repos/access.ts:585`                     | background `refreshBitbucket` after the first refresh                               | repository permissions stay stale, no trace                                                                   |
| 2   | `src/workflow/prLifecycle.ts:472`             | `recordRunOutcome` for a terminal PR                                                | the run's learning outcome is silently missing                                                                |
| 3   | `src/learning/outcomes.ts:600`                | `recordRunOutcome` in the sync loop                                                 | same, and `errors` in the result does not list it                                                             |
| 4   | `src/workflow/effects.ts:89`                  | `UPDATE ... claimed_until = NULL` after an effect failed                            | the effect stays claimed until the lease expires (delayed retry); the effect's own error is logged just after |
| 5   | `src/git/provider.ts:609`                     | `enqueueIndex` after a workspace is prepared                                        | repository not (re)indexed, code search is stale                                                              |
| 6   | `src/codeIntelligence/goSearch.ts:162`        | `enqueue` of repositories platform-go found unindexed                               | same                                                                                                          |
| 7   | `src/agent/harness/stages/execute.ts:632`     | `enqueueIndex` in the harness `finally`                                             | same                                                                                                          |
| 8   | `src/server.ts:140`                           | `enqueueCodeIndex` at startup                                                       | same, for every repository                                                                                    |
| 9   | `src/agent/antigravity/run.ts:417`            | `INSERT INTO agent_sessions`                                                        | the provider session is not linked to the attempt, so it cannot be resumed                                    |
| 10  | `src/agent/copilot/run.ts:415`                | same insert                                                                         | same                                                                                                          |
| 11  | `src/telegram/transport.ts:376` and `:441`    | `refreshTelegramCredentials`                                                        | credentials saved on another instance are not picked up, silently                                             |
| 12  | `src/radar/scan.ts:657`                       | the notification enqueue, followed by `UPDATE radar_findings SET notified_severity` | the finding is marked notified although no notification was queued                                            |
| 13  | `src/telegram/updates.ts:583`                 | `telegramAudit(... "update.dead_lettered")`                                         | the audit record of a dead-lettered update is lost                                                            |
| 14  | `src/integrations/database.ts:110` and `:116` | status update after a project-database check                                        | the UI shows a stale connection status                                                                        |
| 15  | `src/agent/platformTools.ts:488`              | durable `submit_rejected` checkpoint                                                | the harness cannot tell "submitted but rejected" from "never submitted"                                       |
| 16  | `src/agent/toolRuntime.ts:189`                | `audit_log` row `platform_tool.denied`                                              | a denied tool call leaves no audit entry                                                                      |
| 17  | `src/agent/harness/stages/execute.ts:389`     | recording the "cost budget exceeded" event                                          | the budget stop is not visible on the run timeline                                                            |
| 18  | `src/chat/runtime.ts:311`                     | `loadPersonalIntegrations(true)` before a resume brief                              | the brief is built without the user's integration tools, silently                                             |

Suggested default if you want one rule: items 15, 16 (durability and audit) should fail loudly or at least log at
`warn`; 2, 3, 12, 13 (lost bookkeeping) should log at `warn`; the indexing and refresh ones (1, 5 to 8, 11, 14) are
fine as `ignoreError` once you accept a stale cache.
