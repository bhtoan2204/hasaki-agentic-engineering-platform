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
- Approval forms requiring repository/branch selections, questions with more than 20 options, and provider handoffs remain **View run** actions. Telegram never guesses missing form data or bypasses workspace inspection/fencing.
- Retry failed step, provider switching, arbitrary shell commands and generic paused-run continuation are not exposed as Telegram write actions. Existing web/domain services retain those workflows.

Prompts expire after 15 minutes; action buttons expire after 24 hours or become invalid as soon as their workflow context changes. Successful decisions replace the original message's buttons with its final decision, actor and time. Final messages say the decision was saved; they do not imply that an offline or paused worker has executed anything. Assigned worker ownership/fencing and pause policy remain unchanged.

Question text and titles are bounded, recognizable credentials are redacted, and fenced code is replaced by a platform-reference notice. Context snapshots, raw logs, rejection reasons and arbitrary private source files are not copied into Telegram messages. Full evidence remains on the platform.

## Identity, authorization and persistence

A client-entered chat ID is only a legacy notification destination, never authorization. Binding records are created only from authenticated Telegram updates in private chats where `from.id` matches the private chat ID. Binding tokens are random, hashed at rest, single-use and scoped to the bot and active platform user. One Telegram account cannot silently link multiple platform users. Disconnect invalidates pending actions/conversations and removes the private destination. Changing the bot token invalidates the old bot fingerprint; explicitly disconnect/rebind after rotation.

Callbacks contain only `a:` plus a 24-character cryptographically random identifier (26 bytes, below Telegram's 64-byte callback limit). Every action revalidates active user/binding, private chat, original message, run owner, current step status, generation, attempt, approval/question context hash, question status and option membership. Administrators do not get a cross-owner Telegram override.

The action guard runs under the existing engine run lock in the same transaction as the domain transition. Consumption, sibling invalidation, workflow event, successful audit and message outbox entry commit or roll back together. Duplicate updates and button races cannot create a second workflow transition. Denied attempts and replays are audited without raw answers or credentials. Requests are limited to 30 per Telegram user/minute; link creation is separately bounded per platform user.

Additive migration `038_interactive_telegram.sql` creates binding/preferences, action/conversation, consumer/inbox, outbox and rate-limit tables. Existing workflow tables and historical migrations are unchanged.

## Multi-instance operation and recovery

All instances sharing one bot must share PostgreSQL. A session-level PostgreSQL advisory lock and a renewable 60-second database lease elect one receiver per bot fingerprint across polling/webhook modes. An independent one-connection consumer pool avoids exhausting a small application pool. A monotonic lease epoch fences stale poll responses. Poll batches and offsets commit together; offsets never acknowledge updates that were not persisted.

Inbox processing has a durable 30-second claim. A crash after a domain commit is safe: the consumed capability prevents replay when the inbox is retried. Persisted polling offsets and inbox/outbox work survive worker restarts. Consumer leases renew every ten seconds and release on graceful shutdown. Different databases or external bot consumers cannot coordinate through this lease; use one shared installation/database per bot.

Telegram delivery is retried with backoff, including API rate-limit retry delays. Permanent errors and exhausted retries become `dead` outbox rows. Unknown outcomes of `sendMessage` can cause a duplicate notification after a crash because Telegram has no send-message idempotency key; workflow transitions remain exactly once through the action registry. Stale duplicate-message buttons fail original-message/state checks. Callback responses are queued for every callback, with a direct best-effort fallback if response persistence fails. Network outages can still prevent Telegram delivery; no success is displayed before the database transition commits.

Normal receiver loops remove expired/stale keyboards and deactivate expired conversations. Processed update payloads and delivered/dead outbox payloads are retained seven days; expired binding tokens and rate-limit counters are cleaned after a day. Workflow events, decisions, bindings/preferences and audit history retain their existing durable policies.

Operational checks (DB administrator only, no credentials/payloads needed):

```sql
SELECT mode, lease_until, epoch, update_offset FROM telegram_consumers;
SELECT status, count(*) FROM telegram_outbox GROUP BY status;
SELECT count(*) FROM telegram_updates WHERE processed_at IS NULL;
SELECT action, count(*) FROM audit_log WHERE resource_type='telegram' GROUP BY action;
```

## Tests and actual verification

CI does not need a live bot. `test/telegram.test.ts` starts a mocked Telegram HTTP server and runs real PostgreSQL/domain transactions. It covers binding/privacy, callbacks, replay/concurrency, expired/stale/changed contexts, canceled/paused/offline runs, rejection policy/reasons, choices/free text, simultaneous prompts, cancel/reopen, confirmations, handoff fencing, API failures, transaction rollback, webhook authentication, session/CSRF, receiver ownership/crash takeover, polling offsets, and both transport runtimes.

`test/telegram.browser.ts` runs real Chromium/settings UI and HTTP/DB with a mocked bot. It verifies connection links, binding completion, owner preferences/language, credential visibility, disconnect and VI/EN light/dark layouts at 1440px/390px.

```bash
node --disable-warning=ExperimentalWarning --import ./test/setup.ts --test test/telegram.test.ts
CHROMIUM_BIN=/path/to/chromium node --disable-warning=ExperimentalWarning --import ./test/setup.ts test/telegram.browser.ts
npm run typecheck
npm run build
npm test
```

See `docs/validation/telegram/` for browser screenshots/results and the implementation validation report. No live Telegram bot, public webhook, real chat, paid agent, or production database was used during verification.

Protocol reference: [official Telegram Bot API](https://core.telegram.org/bots/api) (inline keyboards, callback byte limit, `answerCallbackQuery`, mutually exclusive transports, webhook secret headers and polling offsets).
