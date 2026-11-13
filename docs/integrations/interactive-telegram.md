# Interactive Telegram workflows

The bot uses the existing approval, rejection and question-answer services. It does not execute commands or implement another workflow engine. Ordinary approvals and predefined choices can be completed inside Telegram. Rejection requires a reason through a specific ForceReply prompt. Free-text answers must reply to the exact question prompt. Multiple pending questions are independent.

## Local / WSL setup (long polling)

1. Create a bot with BotFather. Keep the bot token private. Use a dedicated bot for this installation.
2. Configure the token through the administrator's Integrations → Telegram settings, or `TELEGRAM_BOT_TOKEN` in the ignored `.env` file. UI credentials retain their existing encrypted shared-secret storage. A shared chat ID is optional for interactive use.
3. Set `TELEGRAM_MODE=polling` and restart the server. No public URL, tunnel, ngrok or inbound Telegram connection is needed. Outbound HTTPS to Telegram and PostgreSQL access are required.
4. Open Integrations → Telegram as your own platform user and select **Connect Telegram**. Open the generated bot link and press Start. The link expires after ten minutes and is single-use.
5. Return to the settings page and use **Check connection**. Choose approval/question/failure/completion notifications, interactive buttons, and VI/EN independently.

Example environment:

```dotenv
TELEGRAM_MODE=polling
TELEGRAM_BOT_TOKEN=<private bot token, or configure through the admin UI>
# Optional legacy shared Production Error scan summaries:
# TELEGRAM_CHAT_ID=<shared destination>
```

### Configuration and precedence

| Variable | Where it comes from | Notes |
|---|---|---|
| `TELEGRAM_MODE` | environment only | `off` (default), `polling` or `webhook`; any other value fails startup. |
| `TELEGRAM_BOT_TOKEN` | admin UI (encrypted shared secret) **overrides** environment | Never logged or returned; the UI shows a masked suffix only. |
| `TELEGRAM_CHAT_ID` | admin UI overrides environment | Legacy shared chat (Production Error summaries). Not used for authorization. |
| `TELEGRAM_WEBHOOK_URL` | environment only | Must be `https://…`; required in webhook mode. |
| `TELEGRAM_WEBHOOK_SECRET` | environment only | 16-256 characters `A-Z a-z 0-9 _ -`; required in webhook mode. |
| `TELEGRAM_API_BASE` | environment only | Defaults to `https://api.telegram.org`; tests point it at a mock. |

Credentials saved in the admin UI are loaded at startup before the receiver starts, and every instance re-reads them about every 30 seconds. A token saved or cleared on one instance therefore reaches all receivers without a restart. Changing `TELEGRAM_MODE` or webhook settings still requires a restart.

`TELEGRAM_MODE` defaults to `off`, preserving one-way notifications for installations that have not enabled the receiver. A bot token is never returned by the API; the administrator sees only its existing masked representation. Members do not see bot credential controls.

Polling refuses to start while Telegram reports an existing webhook. Disable the old webhook before changing transport. Using a trusted administrator terminal and a privately supplied environment token:

```bash
curl --fail --silent --show-error --request POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" \
  --header 'Content-Type: application/json' \
  --data '{"drop_pending_updates":false}'
```

Do not run a separate `getUpdates` consumer while the platform is receiving updates. The UI's old “find chats” action uses the durable observed-update history when an interactive transport is enabled; its legacy discovery mode takes the same PostgreSQL bot lock.

## HTTPS webhook setup

Expose only the application behind your normal HTTPS reverse proxy. The Node listener may remain loopback behind that proxy. Set:

```dotenv
TELEGRAM_MODE=webhook
TELEGRAM_BOT_TOKEN=<private token, or configure through the admin UI>
TELEGRAM_WEBHOOK_URL=https://platform.example.com/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<random 16-256 character A-Z a-z 0-9 _ - value>
```

Generate a strong secret, for example with `openssl rand -hex 32`. Do not use the bot token as the webhook secret. Keep both out of logs, screenshots and source control. Restart after changing transport settings.

The elected consumer registers `setWebhook` with the secret and accepts only `message` and `callback_query` updates. `POST /api/telegram/webhook` requires the exact `X-Telegram-Bot-Api-Secret-Token` header and an active webhook-mode lease. It does not require browser session/CSRF authentication; this exception applies only to that one authenticated Telegram route. Invalid secrets/mode return 403, and an unavailable consumer returns 503 so Telegram can retry. Bodies are bounded to 256 KiB. The route persists the update before returning 200; domain processing and delivery are durable background work.

Set the platform's existing `publicUrl` configuration to a public HTTPS address when run buttons should open remotely. Local URLs retain the existing clickable 127.0.0.1 text-link fallback. A Telegram phone cannot reach the WSL machine's loopback address; interactive decisions still work without opening the link.

## Interaction behavior

- Approval: **Approve / Reject**, then **View run**. A normal Approve records the decision using `approveStep` and lets the existing scheduler continue.
- Rejection: press Reject, then reply to the specific bot prompt with a non-empty reason to confirm rejection. `rejectStep` preserves `on_reject.reexecute` and the existing failure/recovery policy.
- Predefined question: each option is an opaque callback button. Only the registered current option can be answered; `answerQuestions` records the platform username and user ID in `answered_by`.
- Free text: **Reply with answer** creates a ForceReply prompt. Reply to that exact prompt; unthreaded messages cannot be attached to an unrelated run.
- Cancellation: `/cancel` while replying to a prompt cancels that conversation. Without a reply target it cancels the user's pending conversations, not workflows. A canceled/expired conversation can be explicitly reopened from a still-valid action.
- Required answers: answering one question does not resume a step while other required questions remain open; the existing engine owns that policy.
- High-impact approval/option steps: set `config.telegram_confirm: true` or `config.high_impact: true` to require an explicit confirmation keyboard before applying the decision. Rejections already require the separate reason/confirmation reply.
- Questions with more than 20 string options get a **Reply with answer** prompt instead of buttons; the reply must match one of the exact options.
- Approval forms requiring repository/branch selections, questions with non-text options, and provider handoffs remain **View run** actions. Telegram never guesses missing form data or bypasses workspace inspection/fencing.
- Retry failed step, provider switching, arbitrary shell commands and generic paused-run continuation are not exposed as Telegram write actions. Existing web/domain services retain those workflows.

Prompts expire after 15 minutes; action buttons expire after 24 hours or become invalid as soon as their workflow context changes. Successful decisions replace the original message's buttons with its final decision, actor and time. Final messages say the decision was saved; they do not imply that an offline or paused worker has executed anything. Assigned worker ownership/fencing and pause policy remain unchanged.

Question text and titles are bounded, recognizable credentials are redacted, and fenced code is replaced by a platform-reference notice. Context snapshots, raw logs, rejection reasons and arbitrary private source files are not copied into Telegram messages. Full evidence remains on the platform.

## Identity, authorization and persistence

A client-entered chat ID is only a legacy notification destination, never authorization. Binding records are created only from authenticated Telegram updates in private chats where `from.id` matches the private chat ID. Binding tokens are random, hashed at rest, single-use and scoped to the bot and active platform user. One Telegram account cannot silently link multiple platform users. Disconnect invalidates pending actions/conversations and removes the private destination. Changing the bot token invalidates the old bot fingerprint: pending buttons from the old bot stop working, and the settings page asks each user to disconnect and rebind.

Callbacks contain only `a:` plus a 24-character cryptographically random identifier (26 bytes, below Telegram's 64-byte callback limit). Every action revalidates active user/binding, private chat, original message, run owner, current step status, generation, attempt, approval/question context hash, question status and option membership. Administrators do not get a cross-owner Telegram override.

The action guard runs under the existing engine run lock in the same transaction as the domain transition. Consumption, sibling invalidation, workflow event, successful audit and message outbox entry commit or roll back together. Duplicate updates and button races cannot create a second workflow transition. Denied attempts and replays are audited without raw answers or credentials. Requests are limited to 30 per Telegram user/minute; link creation is separately bounded per platform user.

Additive migration `038_interactive_telegram.sql` creates binding/preferences, action/conversation, consumer/inbox, outbox and rate-limit tables. Existing workflow tables and historical migrations are unchanged.

## Multi-instance operation and recovery

All instances sharing one bot must share PostgreSQL. A session-level PostgreSQL advisory lock and a renewable 60-second database lease elect one receiver per bot fingerprint across polling/webhook modes. An independent one-connection consumer pool avoids exhausting a small application pool. A monotonic lease epoch fences stale poll responses. Poll batches and offsets commit together; offsets never acknowledge updates that were not persisted.

Inbox processing has a durable 30-second claim. An update whose processing fails is retried with exponential backoff (5 s doubling, capped at 5 minutes). After 8 failures it is dead-lettered: it is marked processed with its `failures` count kept, and a `telegram.update.dead_lettered` audit row is written. Group/channel messages (for example the legacy shared chat) are stored only for chat discovery: no reply and no audit row. A crash after a domain commit is safe: the consumed capability prevents replay when the inbox is retried. Persisted polling offsets and inbox/outbox work survive worker restarts. Consumer leases renew every ten seconds and release on graceful shutdown. Different databases or external bot consumers cannot coordinate through this lease; use one shared installation/database per bot.

Telegram delivery is retried with backoff, including API rate-limit retry delays. Permanent errors and exhausted retries become `dead` outbox rows. Unknown outcomes of `sendMessage` can cause a duplicate notification after a crash because Telegram has no send-message idempotency key; workflow transitions remain exactly once through the action registry. Stale duplicate-message buttons fail original-message/state checks. Callback responses are queued for every callback, with a direct best-effort fallback if response persistence fails. Network outages can still prevent Telegram delivery; no success is displayed before the database transition commits.

Normal receiver loops remove expired/stale keyboards and deactivate expired conversations. Processed update payloads and delivered/dead outbox payloads are retained seven days; decided/expired/canceled actions are retained 30 days (so late taps still answer “already processed”); pending actions are never deleted by cleanup. Expired binding tokens and rate-limit counters are cleaned after a day.

Receiver problems are logged once per distinct reason (for example `Telegram polling receiver unavailable: bot token rejected by Telegram (401/404); will retry`, or `Remove the existing Telegram webhook before enabling polling`), and recovery logs `Telegram polling receiver active`. Logs never include the token, request URL or update payloads. Integrations → Telegram shows **Receiver active** or **Receiver not running** from the shared lease, so users can see whether taps are being processed. Workflow events, decisions, bindings/preferences and audit history retain their existing durable policies.

## Disabling the receiver safely

1. Set `TELEGRAM_MODE=off` on **every** instance and restart them. Shutdown releases the lease. One-way notifications keep working through the legacy path while a token is configured.
2. Pending buttons expire on their own (24 h); taps in the meantime are stored but not processed until a receiver runs again. No workflow state changes while the receiver is off.
3. If you used webhook mode and want to stop Telegram delivering to the URL, call `deleteWebhook` (see above) from a trusted terminal.
4. To revoke completely, clear the platform credentials (Integrations → Telegram → **Remove from the platform**, admin only) and revoke the token in BotFather.

## Database troubleshooting

Read-only queries; run as a DB administrator. None of them print tokens, callback identifiers' meaning, or message contents.

```sql
-- Receiver lease: who owns the bot right now (owner_id is a random per-process UUID)
SELECT mode, lease_until > now() AS active, lease_until, epoch, update_offset FROM telegram_consumers;

-- Inbox backlog and failures
SELECT count(*) FILTER (WHERE processed_at IS NULL) AS pending,
       count(*) FILTER (WHERE processed_at IS NULL AND failures > 0) AS retrying,
       count(*) FILTER (WHERE processed_at IS NOT NULL AND failures >= 8) AS dead_lettered,
       min(received_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending
FROM telegram_updates;

-- Outbox delivery: pending and dead rows by method
SELECT method, status, count(*), max(attempts) AS max_attempts, min(next_at) FILTER (WHERE status = 'pending') AS next_retry
FROM telegram_outbox GROUP BY method, status ORDER BY method, status;

-- Pending actions (buttons) per run/step, with expiry
SELECT run_id, step_id, action_type, count(*), min(expires_at) AS expires_at, bool_or(message_id IS NULL) AS unsent
FROM telegram_actions WHERE status = 'pending' GROUP BY run_id, step_id, action_type ORDER BY run_id;

-- Conversations (ForceReply prompts) that are still pending but already expired (cleared on the next receiver loop)
SELECT a.run_id, c.status, c.expires_at FROM telegram_conversations c JOIN telegram_actions a USING (action_id)
WHERE c.status = 'pending' AND c.expires_at <= now();

-- Decision/denial audit summary
SELECT action, count(*) FROM audit_log WHERE resource_type = 'telegram' GROUP BY action ORDER BY action;
```

Typical findings:

- `active = false` with `TELEGRAM_MODE` enabled: no instance holds the lease. Check the server log for the `receiver unavailable: …` reason (invalid token, leftover webhook, database connectivity).
- Growing `pending` updates while the lease is active: look at `retrying`, then at `telegram.action.denied` / `telegram.update.dead_lettered` audit rows.
- `dead` outbox rows: 400/401/403/404 from Telegram are permanent (bot blocked by the user, message deleted, chat not found). Other errors are retried with backoff and become `dead` after 12 attempts.
- Do not delete rows from `telegram_actions` or `telegram_outbox` by hand while a receiver runs; disconnecting a user or letting expiry run is the supported way to invalidate buttons.

## Tests and actual verification

CI does not need a live bot. `test/telegram.integration.ts` starts a mocked Telegram HTTP server and runs real PostgreSQL/domain transactions. It covers binding/privacy, callbacks, >20-option ForceReply fallback, bounded inbox retries/dead-lettering, receiver status, cross-instance credential refresh, cleanup retention, replay/concurrency, expired/stale/changed contexts, canceled/paused/offline runs, rejection policy/reasons, choices/free text, simultaneous prompts, cancel/reopen, confirmations, handoff fencing, API failures, transaction rollback, webhook authentication, session/CSRF, receiver ownership/crash takeover, polling offsets, and both transport runtimes.

`test/telegram.browser.ts` runs real Chromium/settings UI and HTTP/DB with a mocked bot. It verifies connection links, binding completion, receiver status, owner preferences/language, credential visibility, disconnect and VI/EN light/dark layouts at 1440px/390px.

```bash
node --disable-warning=ExperimentalWarning --import ./test/setup.ts --test test/telegram.integration.ts
CHROMIUM_BIN=/path/to/chromium node --disable-warning=ExperimentalWarning --import ./test/setup.ts test/telegram.browser.ts
npm run typecheck
npm run build
npm test
```

See `docs/validation/telegram/` for browser screenshots/results and the implementation validation report. No live Telegram bot, public webhook, real chat, paid agent, or production database was used during verification.

Protocol reference: [official Telegram Bot API](https://core.telegram.org/bots/api) (inline keyboards, callback byte limit, `answerCallbackQuery`, mutually exclusive transports, webhook secret headers and polling offsets).
