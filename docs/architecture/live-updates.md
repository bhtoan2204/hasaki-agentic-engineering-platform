# Live updates (SSE) and polling

One-way realtime updates use the infrastructure that already existed: every `workflow_events` INSERT fires
`pg_notify('workflow_events', {id, run_id, step_id, attempt_id, kind})` (migration 005), one `LISTEN` connection per
server relays it over Server-Sent Events, and each browser tab keeps **one** `EventSource` shared by every component
(`useLive` in `web/src/api.ts`). Commands, initial loads, pagination and CRUD stay on REST. No broker, Redis or
WebSocket is involved.

## Contract

| Piece | Behaviour |
| --- | --- |
| `GET /api/stream[?run_id=][&after=<id>][&scope=all]` | Session-authenticated. Events are filtered to the viewer's runs (admins see other members' runs only with the audited `scope=all`; ownerless runs are visible to nobody). Every frame has `id: <workflow_events.id>`. |
| Payload | `{id, run_id, step_id, attempt_id, kind}` only, never content. Views fetch what they show through REST. |
| Replay | `Last-Event-ID` (browser reconnect) or `?after=` (reopened stream) replays the gap from `workflow_events` before live delivery resumes. Live events that arrive during the replay are queued and de-duplicated by id. |
| `hello` | `{live, cursor, replayed?, reset?}`. `live: false` means the server's LISTEN connection is down: clients use the fallback until a new `hello` with `live: true` (sent after the server has replayed what LISTEN missed). `reset: true` means the gap was larger than 500 events: reload views instead. |
| `GET /api/events?after=<id>[&run_id=]` | Polling fallback with the same filter: `{events, reset, cursor}`. |

Client rules (`web/src/api.ts`):

- The tab keeps a cursor (newest event id seen) and drops duplicate ids.
- Hidden tab: the stream is closed. Shown again: it reopens with `?after=<cursor>` and only the views touched by missed events reload.
- Stream unavailable: poll `/api/events?after=<cursor>` every 5 s (one small request) instead of reloading every view; reopen a dead stream with backoff (2 s → 30 s).
- `useLive` batches events (first call after 250 ms, then at most once a second; a steady stream cannot starve it) and passes the most significant payload of the batch: catch-up (`undefined`) › `status` › other state change › transcript activity.
- `isStateChange(p)` is false for transcript lines (`tool`, `tool_result`, `agent`, `thinking`, `prompt`, `system_prompt`, `result`, `log`, attempt-level `system`). Run, step, question, cost and totals views reload only on state changes; transcripts and the run timeline fetch incrementally (`?after=`) on every batch; the git diff (`Changes`) refreshes on state changes and at most every 10 s during activity.

Known limit: event ids are assigned just before COMMIT, so an event can in theory commit after one with a higher id. A live client still receives it (NOTIFY is sent on commit); only a reconnect that falls in that millisecond window could skip it in replay, and the next state event reloads the affected views anyway.

## Polling that stays (on purpose)

| Where | Interval | Why it is not an event |
| --- | --- | --- |
| Run page worker health (`/api/runs/:id/worker`) | 15 s, visible tab, unfinished runs only | Instance heartbeats are not workflow events. |
| Overview 30-day metrics | 60 s, visible tab | Aggregates; a minute-old figure is fine. |
| Production errors while a scan runs | 1.5 s, visible tab | Scan progress is in-memory server state. |
| Hasaki Work login window | 1.5 s while the window is open | External browser state. |
| `/classic` UI | 3 s, visible tab | Legacy page; not worth wiring to SSE. |
| Local clocks (`useNow`, queue banner, command log) | 1–5 s | Re-render only, no request. |

## Measuring

`npm run build && npm run bench:live-updates` drives the production bundle in headless Chromium against a real server
and database while an agent writes 12 bursts of transcript events (tool call, result, text; ~1.5 s apart) plus
2 status changes, and prints browser API requests per endpoint, server DB statements and server CPU per scenario.
`npm run smoke:live-updates` asserts the browser behaviour; `test/live-updates.test.ts` covers the server contract.
