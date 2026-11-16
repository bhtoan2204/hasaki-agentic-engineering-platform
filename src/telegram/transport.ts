import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { config } from "../config.ts";
import { pool, q, one, withTx } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { botKey, telegramCall, TelegramApiError, validWebhookSecret } from "./client.ts";
import { advisoryKey, queue } from "./store.ts";
import { ingestUpdate, processInbox } from "./updates.ts";

/** Session lock + renewable DB lease: dropped DB sessions cannot keep consuming after another owner takes over. */
export async function claimConsumer(client: pg.PoolClient, owner: string, mode: "polling" | "webhook", key = botKey()) {
  if (!(await client.query("SELECT pg_try_advisory_lock($1::int) AS ok", [advisoryKey(key)])).rows[0].ok) return null;
  const row = await one(client, `INSERT INTO telegram_consumers(bot_key,owner_id,mode,lease_until) VALUES($1,$2,$3,now()+interval '60 seconds')
    ON CONFLICT(bot_key) DO UPDATE SET owner_id=$2,mode=$3,lease_until=now()+interval '60 seconds',epoch=telegram_consumers.epoch+1
    WHERE telegram_consumers.lease_until<now() OR telegram_consumers.owner_id=$2 RETURNING *`, [key, owner, mode]);
  if (!row) await client.query("SELECT pg_advisory_unlock($1::int)", [advisoryKey(key)]);
  return row ?? null;
}
export async function releaseConsumer(client: pg.PoolClient, owner: string, key = botKey()) {
  try { await q(client, "UPDATE telegram_consumers SET lease_until=now() WHERE bot_key=$1 AND owner_id=$2", [key, owner]); }
  finally { await client.query("SELECT pg_advisory_unlock($1::int)", [advisoryKey(key)]).catch(() => { }); }
}
export async function persistPollingBatch(updates: any[], owner: string, epoch: number, key = botKey()) {
  await withTx(async db => {
    const row = await one(db, "SELECT * FROM telegram_consumers WHERE bot_key=$1 AND owner_id=$2 AND epoch=$3 AND mode='polling' AND lease_until>now() FOR UPDATE", [key, owner, epoch]);
    if (!row) throw new HttpError(409, "Telegram consumer ownership lost");
    let offset = Number(row.update_offset);
    for (const update of updates) {
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new HttpError(400, "Invalid Telegram update");
      await q(db, "INSERT INTO telegram_updates(bot_key,update_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [key, update.update_id, JSON.stringify(update)]);
      offset = Math.max(offset, update.update_id + 1);
    }
    await q(db, "UPDATE telegram_consumers SET update_offset=$2 WHERE bot_key=$1", [key, offset]);
  });
}
export async function acceptWebhook(secret: unknown, update: any) {
  if (config.telegram.mode !== "webhook" || !validWebhookSecret(secret)) throw new HttpError(403, "Invalid Telegram webhook authentication");
  const consumer = await one(pool, "SELECT bot_key FROM telegram_consumers WHERE bot_key=$1 AND mode='webhook' AND lease_until>now()", [botKey()]);
  if (!consumer) throw new HttpError(503, "Telegram webhook consumer unavailable");
  await ingestUpdate(update);
  return { ok: true };
}
export async function deliverOutbox(limit = 50, signal?: AbortSignal) {
  const key = botKey(), token = config.telegram.botToken;
  for (let i = 0; i < limit && !signal?.aborted; i++) {
    const found = await withTx(async db => {
      const row = await one(db, "SELECT * FROM telegram_outbox WHERE bot_key=$1 AND status='pending' AND next_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", [key]);
      if (!row) return false;
      const action = row.action_ids?.length ? await one(db, "SELECT * FROM telegram_actions WHERE action_id=$1", [row.action_ids[0]]) : null;
      const userId = row.user_id ?? action?.user_id;
      if (row.action_ids?.length && !action && row.method !== "editMessageReplyMarkup") { await q(db, "UPDATE telegram_outbox SET status='dead' WHERE id=$1", [row.id]); return true; }
      const removal = row.method === "editMessageReplyMarkup" && row.payload.reply_markup?.inline_keyboard?.length === 0;
      if (userId && !removal) {
        const binding = await one(db, `SELECT b.user_id FROM telegram_bindings b JOIN users u ON u.id=b.user_id AND u.active
          WHERE b.user_id=$1 AND b.bot_key=$2 AND b.chat_id=$3 FOR UPDATE OF b`, [userId, key, String(row.payload.chat_id)]);
        if (!binding) { await q(db, "UPDATE telegram_outbox SET status='dead' WHERE id=$1", [row.id]); return true; }
      }
      if (action && row.method === "sendMessage" && (action.status !== "pending" || Date.parse(action.expires_at) <= Date.now())) {
        await q(db, "UPDATE telegram_outbox SET status='dead' WHERE id=$1", [row.id]); return true;
      }
      try {
        const result = await telegramCall(row.method, row.payload, { signal, token });
        if (row.method === "sendMessage") {
          if (!Number.isSafeInteger(result?.message_id)) throw new TelegramApiError(503);
          if (row.conversation_action_id) await q(db, "UPDATE telegram_conversations SET prompt_message_id=$2 WHERE action_id=$1", [row.conversation_action_id, result.message_id]);
          else if (row.action_ids?.length) await q(db, "UPDATE telegram_actions SET message_id=$2 WHERE action_id=ANY($1)", [row.action_ids, result.message_id]);
        }
        await q(db, "UPDATE telegram_outbox SET status='delivered',attempts=attempts+1 WHERE id=$1", [row.id]);
      } catch (e) {
        const error = e instanceof TelegramApiError ? e : new TelegramApiError(503);
        const permanent = [400, 401, 403, 404].includes(error.code) || row.attempts >= 11;
        await q(db, "UPDATE telegram_outbox SET status=$2,attempts=attempts+1,next_at=now()+make_interval(secs=>$3) WHERE id=$1", [row.id, permanent ? "dead" : "pending", Math.max(error.retryAfter, Math.min(300, 2 ** Math.min(8, row.attempts + 1)))]);
      }
      return true;
    });
    if (!found) break;
  }
}
export async function expireActions() {
  await withTx(async db => {
    const stale = await q(db, `SELECT a.* FROM telegram_actions a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_runs r ON r.id=a.run_id
      LEFT JOIN workflow_questions w ON w.id=a.question_id LEFT JOIN telegram_preferences p ON p.user_id=a.user_id JOIN users u ON u.id=a.user_id
      WHERE a.bot_key=$1 AND a.status='pending' AND (a.expires_at<=now() OR a.step_generation<>s.generation OR a.attempt_id IS DISTINCT FROM s.current_attempt_id
        OR r.status IN ('CANCELED','COMPLETED','FAILED') OR (a.question_id IS NULL AND s.status<>'WAITING_APPROVAL')
        OR (a.question_id IS NOT NULL AND (s.status<>'WAITING_INPUT' OR w.status<>'open')) OR p.interactive=false OR NOT u.active)
      ORDER BY a.created_at FOR UPDATE OF a SKIP LOCKED LIMIT 100`, [botKey()]);
    for (const a of stale) {
      await q(db, "UPDATE telegram_actions SET status='expired' WHERE action_id=$1", [a.action_id]);
      if (a.message_id) await queue(db, `expired:${a.chat_id}:${a.message_id}`, "editMessageReplyMarkup", { chat_id: a.chat_id, message_id: a.message_id, reply_markup: { inline_keyboard: [] } });
    }
    await q(db, "UPDATE telegram_conversations SET status='canceled' WHERE status='pending' AND expires_at<=now()");
    await q(db, "DELETE FROM telegram_rate_limits WHERE minute<now()-interval '1 day'");
    await q(db, "DELETE FROM telegram_bind_tokens WHERE expires_at<now()-interval '1 day'");
    await q(db, "DELETE FROM telegram_updates WHERE processed_at<now()-interval '7 days'");
    await q(db, "DELETE FROM telegram_outbox WHERE status IN ('delivered','dead') AND created_at<now()-interval '7 days'");
    // Decided/expired capabilities are kept 30 days so late taps still answer "already processed"; pending ones never.
    await q(db, "DELETE FROM telegram_actions WHERE bot_key=$1 AND status<>'pending' AND created_at<now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM telegram_outbox o WHERE o.status='pending' AND telegram_actions.action_id=ANY(o.action_ids))", [botKey()]);
  });
}
const CREDENTIAL_REFRESH_MS = 30000;
async function refreshTelegramCredentials() {
  const { refreshTelegramSettings } = await import("../integrations/accounts.ts");
  await refreshTelegramSettings();
}
/** A loggable reason: Telegram error codes and our own messages only, never URLs, tokens or payloads. */
export function consumerFailure(e: unknown) {
  if (e instanceof TelegramApiError) return e.code === 401 || e.code === 404 ? "bot token rejected by Telegram (401/404)" : e.code === 409 ? "another getUpdates/webhook consumer is active for this bot (409)" : `Telegram API error ${e.code}`;
  if (e instanceof HttpError) return e.message;
  const message = e instanceof Error ? e.message : String(e);
  const token = config.telegram.botToken;
  return textLimitSafe(token ? message.split(token).join("[redacted]") : message);
}
const textLimitSafe = (s: string) => s.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]").slice(0, 200);
export function startTelegramTransport() {
  // A reserved lock connection must not exhaust the application pool (including poolMax=1).
  const consumerPool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: config.database.connectionTimeoutMillis, keepAlive: true });
  const stopping = new AbortController();
  let lastFailure = "", refreshedAt = 0;
  const task = (async () => {
    while (!stopping.signal.aborted) {
      // Credentials saved by an administrator on ANOTHER instance must reach this receiver without a restart.
      if (Date.now() - refreshedAt >= CREDENTIAL_REFRESH_MS) { refreshedAt = Date.now(); await refreshTelegramCredentials().catch(() => { }); }
      if (!config.telegram.botToken || config.telegram.mode === "off") {
        await sleep(2000, undefined, { signal: stopping.signal }).catch(() => { }); continue;
      }
      let client: pg.PoolClient;
      try { client = await consumerPool.connect(); } catch { await sleep(2000, undefined, { signal: stopping.signal }).catch(() => { }); continue; }
      const owner = randomUUID(), key = botKey(), mode = config.telegram.mode;
      const session = new AbortController(); const abort = () => session.abort(); stopping.signal.addEventListener("abort", abort, { once: true }); client.on("error", abort);
      let claim: any;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        claim = await claimConsumer(client, owner, mode, key);
        if (!claim) { await sleep(2000, undefined, { signal: session.signal }).catch(() => { }); continue; }
        heartbeat = setInterval(() => {
          void one(client, "UPDATE telegram_consumers SET lease_until=now()+interval '60 seconds' WHERE bot_key=$1 AND owner_id=$2 AND epoch=$3 AND lease_until>now() RETURNING bot_key", [key, owner, claim.epoch]).then(row => { if (!row) session.abort(); }, () => session.abort());
        }, 10000); heartbeat.unref();
        if (mode === "polling") {
          const webhook = await telegramCall("getWebhookInfo", {}, { signal: session.signal });
          if (webhook.url) throw new Error("Remove the existing Telegram webhook before enabling polling");
        } else await telegramCall("setWebhook", { url: config.telegram.webhookUrl, secret_token: config.telegram.webhookSecret, allowed_updates: ["message", "callback_query"] }, { signal: session.signal });
        if (lastFailure) { console.log(`Telegram ${mode} receiver active`); lastFailure = ""; }
        while (!session.signal.aborted && key === botKey() && mode === config.telegram.mode) {
          if (Date.now() - refreshedAt >= CREDENTIAL_REFRESH_MS) { refreshedAt = Date.now(); await refreshTelegramCredentials().catch(() => { }); if (key !== botKey()) break; }
          const lease = await one(client, "UPDATE telegram_consumers SET lease_until=now()+interval '60 seconds' WHERE bot_key=$1 AND owner_id=$2 AND epoch=$3 AND lease_until>now() RETURNING update_offset", [key, owner, claim.epoch]);
          if (!lease) break;
          await processInbox(); await expireActions(); await deliverOutbox(30, session.signal);
          if (mode === "polling") {
            const updates = await telegramCall("getUpdates", { offset: lease.update_offset, timeout: 10, limit: 50, allowed_updates: ["message", "callback_query"] }, { signal: session.signal, timeout: 15000 });
            if (!Array.isArray(updates)) throw new Error("Invalid Telegram update batch");
            await persistPollingBatch(updates, owner, claim.epoch, key);
            if (!updates.length) await sleep(250, undefined, { signal: session.signal });
          } else await sleep(500, undefined, { signal: session.signal });
        }
      } catch (e) {
        if (!stopping.signal.aborted) {
          const reason = consumerFailure(e);
          if (reason !== lastFailure) console.warn(`Telegram ${mode} receiver unavailable: ${reason}; will retry`);
          lastFailure = reason;
          await sleep(2000, undefined, { signal: stopping.signal }).catch(() => { });
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (claim) await releaseConsumer(client, owner, key).catch(() => { });
        client.off("error", abort); stopping.signal.removeEventListener("abort", abort); client.release();
      }
    }
  })();
  return { stop: async () => { stopping.abort(); await task; await consumerPool.end(); } };
}
