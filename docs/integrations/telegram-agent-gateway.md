# Telegram Agent Gateway

Telegram is a transport for the platform's existing Chat Runtime, run operations and notifications. A bound user writes
to the bot in natural language and gets the same assistant as the web chat: same provider/model routing (AUTO), tools,
permissions, history and confirmations. There is no second chat runtime, workflow engine, executor, scheduler or policy
engine; the gateway calls `chat.postMessage`, `decideOperation`, `executeDelegation` and the workflow engine exactly as
the web UI does.

Workflow approval/question buttons and ForceReply prompts work as before (see
[interactive-telegram.md](interactive-telegram.md)); this document covers what was added on top.

## Setup (local / WSL, no ngrok)

1. Follow the long-polling setup in [interactive-telegram.md](interactive-telegram.md#local--wsl-setup-long-polling):
   save the bot token on Integrations → Telegram, set the receiver mode to **polling**, then **Connect Telegram** as your
   own user. Polling needs only outbound HTTPS; no public URL or tunnel.
2. Apply migration `097_telegram_agent_gateway.sql` (automatic at startup).
3. Write anything to the bot. The first message creates a chat conversation (mode AUTO, provider AUTO) that also
   appears in the web chat.

Preferences (Integrations → Telegram, per user): chat on/off, per-kind subscriptions (approvals, questions, failures,
completions, blocked runs, recovered steps, pull requests, autonomous decisions, intake items), notification level
(`all` / `important` / `critical`), quiet hours (hour range in the user's time zone, default `Asia/Ho_Chi_Minh`) and
language (VI/EN).

## Using it

Free text goes to the Chat Runtime, for example:

- "REQ-126 đang làm gì?" / "What is REQ-126 doing?" — `work_items.search`, `runs.get`
- "Show my blocked workflows" — `runs.list`
- "Investigate payment refund errors" — investigation tools, or a `work.delegate` proposal for a durable investigation
- "Create a task to fix this bug" / "Run the appropriate workflow" — a `work.delegate` proposal
- "Explain why this step failed" / "Retry this step" — `runs.get`, then a `runs.retry_step` operation

A quick turn sends one answer. After two seconds, a turn that is still running can show a progress message that updates
as the phase changes. The answer replaces that message when the turn finishes. Long answers show a preview with a link
to the full conversation. Telegram displays Markdown as plain text, replaces code blocks with
“[Code available in platform]” and redacts recognizable credentials.

Replying to one of the bot's answers continues **that** conversation (and makes it the linked one). Turns started in the
web chat of the linked conversation are mirrored to Telegram ("💻 From the web: …").

| Command | Effect |
|---|---|
| `/help` | Usage and examples |
| `/new [title]` | New conversation; Telegram now talks to it |
| `/link <id>` | Attach Telegram to one of your web conversations (`#/chat/<id>`) |
| `/status` | Account, linked conversation, running answer, autonomy, run counts, provider health |
| `/tasks` | Your ten most recent work items |
| `/runs [blocked\|active\|failed]` | Your runs with 👁 buttons to follow one live |
| `/mode` | Show autonomy; `/mode manual\|semi\|auto` sets your own policy, `/mode pause\|resume`; `/mode chat <AUTO\|ASK\|INVESTIGATE\|PLAN\|DELEGATE>` sets the conversation mode |
| `/stop` | Cancel the running answer. `/stop all`: emergency stop (pauses your autonomy policy and the runs it started) |
| `/cancel` | Cancel a pending workflow ForceReply prompt (unchanged) |

Following a run (👁) keeps one status message with the current step, blocker, PR links and a link to the run.
Unfollow removes the button. Following again reuses the existing message.

## Actions and confirmation

The chat never executes anything on its own. A mutating tool call becomes a pending **operation**
(`chat_operations`, the same as the web). Telegram shows it with **✅ Confirm / ❌ Reject**:

- Run operations: `runs.start`, `runs.pause`, `runs.resume`, `runs.cancel`, `runs.retry_step`.
- Protected operations — `runs.approve_step`, `runs.reject_step` and integration writes (`kafka.publish`,
  `qc_http.request`) — need a second, explicit **Confirm again** tap.
- `work.delegate` proposals show workflow, repositories, risk and warnings with **▶️ Start / Dismiss**. Start calls
  `executeDelegation` with the preview hash shown to the user; if the conversation changed meanwhile the hash no longer
  matches and nothing starts ("review it again").

Every tap re-checks the binding (bot, Telegram user, private chat), the action owner, the exact message the button is
on, expiry (operations: 15 minutes, delegations: 60 minutes) and status. The services behind the buttons are
idempotent (operation status claim + idempotency key; delegation preview hash), so duplicate taps, Telegram redelivery
and crash replays never run an action twice. Engine authorization (`ownedRun`, run locks, approval policies,
evidence/risk acknowledgement gates) is unchanged and still applies. Arbitrary shell commands are never accepted.

## Autonomy policies (Manual / Semi-auto / Autonomous)

`chat_autonomy_policies` decides whether the platform may confirm a chat-proposed action on the owner's behalf. It
never decides workflow gates: approvals, verification and security gates inside runs keep their own policies
(`autonomy_policies`, `workflow/autonomy.ts`) and apply to every run started from chat.

Resolution is most-restrictive across the applicable policies:

- **global** (administrator ceiling) — required; absent means MANUAL for everyone;
- **owner** (the user's explicit opt-in, `/mode` or the API) — required; absent means MANUAL;
- **repository** policies for the run's repositories and a **workflow** policy for its workflow, where present.

Mode is the minimum; allowlisted `actions` are intersected; limits take the minimum. `workflows`: the **global** list is
the ceiling — `null` there means no workflow can be started autonomously, whatever an owner policy names — and owner,
repository and workflow policies can only narrow it. `paused` at any level is an emergency stop. Decisions are
serialised per owner; the concurrency limit counts PENDING/RUNNING/WAITING runs plus starts allowed in the last ten
minutes whose run is not attached yet.

| Field | Meaning |
|---|---|
| `mode` | `MANUAL` (always ask), `SEMI` (LOW-risk only), `AUTONOMOUS` (up to `max_risk`) |
| `actions` | Subset of `runs.pause`, `runs.resume` (LOW), `runs.retry_step`, `runs.start`, `runs.cancel`, `work.delegate` (MEDIUM). Anything else is rejected as protected |
| `workflows` | Workflow keys `runs.start`/`work.delegate` may start |
| `max_risk` | `LOW` or `MEDIUM`; HIGH is never autonomous |
| `max_concurrent_runs` | Your RUNNING/WAITING runs must be below it |
| `max_cost_usd_per_day`, `max_tokens_per_day` | Your last 24 h of reported agent cost/tokens |
| `run_budget_usd` | Budget set on runs it starts (enforced by the existing budget gates) |
| `retry_budget` | Autonomous `retry_step` per run per 24 h |
| `timeout_minutes` | Runs it started are paused after this (scheduler reconcile tick) |

Risk: the action's base risk is raised to HIGH by a protected workflow (`deploy`, `release`, `merge`, `migrat…`,
`secret`, `credential`, `rotate`, production data), by the subject text (payments, refunds, inventory, security, order
state transitions, destructive SQL, production writes — `assessRisk`) or by risky effects. Production deployment, PR
merging, database mutations and secrets therefore stay with a human.

An action also runs autonomously only if its values come from the owner's own words: the runtime provenance check
(ADR 0010) must return `allow` — a run id, title or repository taken from logs, documents or tool results needs a tap.
For `work.delegate` **every** field must be traced to the owner's messages — title, repositories, the workflow and the
description that becomes the run's instructions. Today's delegation description includes the assistant's answer, so
an autonomous delegation is refused (recorded as `require_human` with the reason) and the owner gets **Start/Dismiss**;
autonomous starts in practice come from `runs.start` on an existing pending run, or from the radar/intake path.

`run_budget_usd` and `timeout_minutes` attach only to runs the policy **started** (`runs.start`, `work.delegate`), never
to runs it paused, resumed, cancelled or retried for the owner. The timeout sweep pauses started runs past their
timeout (a failed pause is retried after five minutes); a PENDING run executes nothing and is not swept.

Every decision (allowed or not) is stored in `chat_autonomy_decisions` with mode, risk, reasons and policy sources, and
audited as `chat.autonomy.allow` / `chat.autonomy.require_human`. Policy changes are audited as
`chat.autonomy.policy.save` / `.revoke`.

API (session + CSRF like every other route):

```http
GET  /api/chat/autonomy/policies                 # admin: all; member: global + own
POST /api/chat/autonomy/policies                 # {scope_kind, scope_ref, mode, actions, workflows, ...}
POST /api/chat/autonomy/policies/:id/revoke
```

Example: allow every user to opt into autonomous read-only investigations and pause/resume.

```json
{ "scope_kind": "global", "mode": "AUTONOMOUS", "actions": ["runs.pause", "runs.resume", "work.delegate"],
  "workflows": ["incident-investigation", "production-incident-investigation"], "max_risk": "MEDIUM",
  "max_concurrent_runs": 2, "max_cost_usd_per_day": 10, "run_budget_usd": 3, "timeout_minutes": 60 }
```

A user then sends `/mode auto` (their owner policy starts with `runs.pause`/`runs.resume` only and one concurrent
run; widen it through the API).

## Notifications

Approval and question notices link to the affected step. Run completion and failure notices are keyed to the status
transition. The gateway also checks active and recently changed runs about every ten seconds:

| Kind | Severity | When |
|---|---|---|
| failure | critical | A step failed while the run continues (retry/recovery) |
| blocked | critical | Run paused (budget, timeout, emergency stop) or waiting without a question/approval |
| recovered | important | A failed/retrying step runs or completes again |
| pr | important | A pull request was created for the run |
| autonomy | important | A workflow gate was decided by the workflow autonomy policy |
| intake | critical/important | An intake item became eligible, or a high/critical one was deferred |

Subscriptions and severity levels filter updates before they enter the notification queue. Non-critical updates wait
20 seconds so they can arrive in one digest. Updates for a single run include a link to that run. During quiet hours,
the digest holds non-critical updates and sends critical updates silently.

## Security model

- Identity: only private chats of a bound Telegram account whose `from.id` equals the chat id (unchanged binding).
  Unbound users get a generic denial.
- Authorization: every read and write goes through the owner-scoped chat tools and engine functions; administrators
  get no cross-owner Telegram override.
- Prompt injection: Telegram text is the owner's own message (the same authority as the web chat). Forwarded messages
  are refused as instructions **and as commands** (a forwarded `/mode auto` or `/stop all` does nothing); non-text media
  is refused. Values observed from tools/documents cannot select targets
  or run autonomously (provenance check). Tool output is never sent raw to Telegram.
- Data leaving the platform: answers are redacted and stripped of code blocks; run/step titles and reasons are bounded
  and redacted; logs, diffs and evidence stay behind a deep link.
- Rate limits: 30 updates/min per Telegram user (unchanged) and 6 chat messages/min; Telegram 429s are retried with
  `retry_after`. One edit per turn status every 3 s, per run status every 5 s.
- Audit: `telegram.chat.message`, `telegram.command.*`, `telegram.chat_action.confirmed/rejected`,
  `telegram.autonomy.emergency_stop`, plus the existing `chat.operation.*` and `chat.delegate` rows.

## Reliability and recovery

- Updates are persisted before processing (unchanged inbox/lease/fencing). A chat message's turn uses
  `client_message_id = tg-<bot>-<update_id>` (unique per conversation), so redelivery or a retried inbox row never
  creates a second turn.
- Answers are delivered from a per-user cursor (`telegram_chat_links.delivered_turn_id`) advanced in the same
  transaction that queues the outbox rows; all outbox rows carry deterministic dedupe keys. A crash re-derives the same
  keys. Delegation proposals of a turn are processed before the cursor moves (idempotent per tool call); a turn that
  cannot be delivered yet (its status message still queued, or a proposal failed) stops the pass, so no later turn
  moves the cursor past it.
- Chat turns run in the receiver's process and are recovered by the existing chat turn recovery after a restart.
- The receiver polls Telegram with a 1 s timeout while a linked conversation has a turn in flight, else 10 s.
- Telegram cannot confirm sendMessage idempotently: a crash between send and commit can duplicate one message (same as
  before); state changes are still exactly-once.

Troubleshooting (read-only):

```sql
-- Linked conversations and their delivery cursor
SELECT l.user_id, l.conversation_id, l.delivered_turn_id,
       (SELECT max(id) FROM chat_turns t WHERE t.conversation_id = l.conversation_id) AS latest_turn
FROM telegram_chat_links l;

-- Pending/armed chat buttons
SELECT kind, status, count(*), min(expires_at) FROM telegram_chat_actions GROUP BY kind, status;

-- Recent autonomy decisions
SELECT owner_id, action, allowed, mode, risk, reasons, run_id, created_at
FROM chat_autonomy_decisions ORDER BY id DESC LIMIT 20;

-- Held / unsent notifications
SELECT user_id, kind, severity, count(*) FROM telegram_notifications WHERE sent_at IS NULL GROUP BY 1, 2, 3;
```

Recovery: a stuck answer (cursor behind `latest_turn` while no turn is active) is retried every loop; a dead outbox row
is visible in `telegram_outbox`. To reset a user's Telegram chat, `/new`. Emergency stop: `/stop all` (owner),
or `paused: true` on the global policy (administrator) — effective on the next decision, no restart.

## Limitations

- Text only: photos, files and voice are refused (use the web chat for attachments).
- Full-length answers, code blocks, diffs, logs and complex forms (repository/branch selection, provider
  handoffs, risk acknowledgement) are on the web via deep links.
- No admin UI for chat autonomy policies yet: administrators use the API above; users use `/mode`.
- The gateway runs on the elected receiver; when the receiver mode is `off`, Telegram chat is unavailable (the web chat
  is unaffected).
- Provider fallback is the Chat Runtime's (AUTO strategy, health probe); the gateway reports provider health in
  `/status` and the failure class of a failed turn.

## Tests

```bash
node --disable-warning=ExperimentalWarning --import ./test/env.ts --test test/telegram-gateway.test.ts
node --disable-warning=ExperimentalWarning test/run-integration.ts test/telegram-gateway.integration.ts test/telegram.integration.ts
```

`test/telegram-gateway.integration.ts` uses a mocked Bot API, real PostgreSQL and the real Chat Runtime with scripted
providers (no agent or Telegram network call). It covers chat answers and redaction, duplicate/replayed updates,
reply-to-conversation and web mirroring, unbound/forwarded/non-text input, busy and /stop, owner-scoped commands and run
watching, confirmation with cross-user/stale-message/replay taps, protected two-tap approvals, SEMI autonomy and
emergency stop, confirmed and autonomous delegations (budget, timeout, untouched workflow gate, HIGH-risk fallback),
notification dedupe/aggregation/quiet hours/levels, and coexistence with workflow ForceReply prompts.
