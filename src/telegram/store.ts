import { createHash, randomBytes } from "node:crypto";
import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { encryptSecret } from "../auth/crypto.ts";
import { config } from "../config.ts";
import { HttpError } from "../http/error.ts";
import { botKey, telegramCall } from "./client.ts";

export const opaqueId = () => randomBytes(18).toString("base64url");
const tokenHash = (s:string) => createHash("sha256").update(s).digest("hex");
export const defaults = {approvals:true,questions:true,failures:true,completions:true,interactive:true,locale:"vi"};
export async function preferences(userId:number, db:Db=pool) {
  return {...defaults,...await one(db,"SELECT * FROM telegram_preferences WHERE user_id=$1",[userId])};
}
export async function savePreferences(userId:number, input:Record<string,unknown>) {
  const old=await preferences(userId);
  for(const k of ["approvals","questions","failures","completions","interactive"] as const){if(input[k]!==undefined && typeof input[k]!=="boolean")throw new HttpError(400,`Invalid ${k}`);}
  if(input.locale!==undefined && !["vi","en"].includes(String(input.locale)))throw new HttpError(400,"Invalid language");
  const value={...old,...Object.fromEntries(Object.entries(input).filter(([k])=>Object.keys(defaults).includes(k)))};
  await q(pool,`INSERT INTO telegram_preferences(user_id,approvals,questions,failures,completions,interactive,locale) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(user_id) DO UPDATE SET approvals=$2,questions=$3,failures=$4,completions=$5,interactive=$6,locale=$7`,[userId,value.approvals,value.questions,value.failures,value.completions,value.interactive,value.locale]);
  return preferences(userId);
}
export async function telegramAudit(db:Db,userId:number|null,action:string,resourceId:string,detail:unknown={}) {
  await q(db,"INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,$2,'telegram',$3,$4)",[userId,`telegram.${action}`,resourceId,JSON.stringify(detail)]);
}
export async function limited(subject:string, db:Db=pool,key=botKey(),limit=30) {
  return !!await one(db,`INSERT INTO telegram_rate_limits(bot_key,subject,minute) VALUES($1,$2,date_trunc('minute',now()))
    ON CONFLICT(bot_key,subject,minute) DO UPDATE SET hits=telegram_rate_limits.hits+1 WHERE telegram_rate_limits.hits<$3 RETURNING hits`,[key,subject,limit]);
}
export async function bindingStatus(userId:number) {
  return {needsRebind:!!await one(pool,"SELECT user_id FROM telegram_bindings WHERE user_id=$1 AND bot_key<>$2",[userId,botKey()]),binding:await one(pool,"SELECT telegram_user_id,chat_id,created_at FROM telegram_bindings WHERE user_id=$1 AND bot_key=$2",[userId,botKey()]) ?? null, preferences:await preferences(userId),mode:config.telegram.mode};
}
export async function createBinding(userId:number) {
  if(!config.telegram.botToken || config.telegram.mode==="off")throw new HttpError(409,"Enable Telegram polling or webhook mode first");
  if(!await limited(`bind:${userId}`))throw new HttpError(429,"Try again later");
  const me=await telegramCall("getMe",{});
  if(!/^[A-Za-z0-9_]{5,32}$/.test(me.username??""))throw new HttpError(409,"Bot username unavailable");
  const token=opaqueId();
  await withTx(async db=>{
    await q(db,"SELECT id FROM users WHERE id=$1 FOR UPDATE",[userId]);
    if(await one(db,"SELECT user_id FROM telegram_bindings WHERE user_id=$1",[userId]))throw new HttpError(409,"Disconnect Telegram before rebinding");
    await q(db,"DELETE FROM telegram_bind_tokens WHERE user_id=$1",[userId]);
    await q(db,"INSERT INTO telegram_bind_tokens(token_hash,user_id,bot_key) VALUES($1,$2,$3)",[tokenHash(token),userId,botKey()]);
    await telegramAudit(db,userId,"binding.requested",String(userId));
  });
  return {url:`https://t.me/${me.username}?start=bind_${token}`,expiresIn:600};
}
export async function bindFromStart(token:string,telegramUser:string,chat:string) {
  if(!/^[A-Za-z0-9_-]{24}$/.test(token) || telegramUser!==chat)throw new HttpError(403,"Invalid binding");
  return withTx(async db=>{
    const row=await one(db,`SELECT t.* FROM telegram_bind_tokens t JOIN users u ON u.id=t.user_id AND u.active
      WHERE token_hash=$1 AND bot_key=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE OF t`,[tokenHash(token),botKey()]);
    if(!row)throw new HttpError(403,"Binding link expired or already used");
    await q(db,"SELECT id FROM users WHERE id=$1 FOR UPDATE",[row.user_id]);
    if(await one(db,"SELECT user_id FROM telegram_bindings WHERE user_id=$1 OR telegram_user_id=$2",[row.user_id,telegramUser]))throw new HttpError(409,"Telegram account already linked; disconnect first");
    await q(db,"INSERT INTO telegram_bindings(user_id,bot_key,telegram_user_id,chat_id) VALUES($1,$2,$3,$4)",[row.user_id,botKey(),telegramUser,chat]);
    await q(db,"UPDATE telegram_bind_tokens SET consumed_at=now() WHERE token_hash=$1",[tokenHash(token)]);
    await q(db,`INSERT INTO user_secrets(user_id,kind,ciphertext) VALUES($1,'telegram_chat',$2) ON CONFLICT(user_id,kind) DO UPDATE SET ciphertext=$2,updated_at=now()`,[row.user_id,encryptSecret(chat)]);
    await telegramAudit(db,row.user_id,"binding.connected",String(row.user_id));
    await queue(db,`bind:${row.token_hash}`,"sendMessage",{chat_id:chat,text:"✅ Telegram connected / Đã kết nối Telegram. Private workflow actions are now linked to your account."});
    return row.user_id as number;
  });
}
export async function disconnect(userId:number) {
  await withTx(async db=>{
    await q(db,"SELECT id FROM users WHERE id=$1 FOR UPDATE",[userId]);
    await q(db,"SELECT user_id FROM telegram_bindings WHERE user_id=$1 FOR UPDATE",[userId]);
    for(const row of await q(db,"SELECT DISTINCT bot_key,chat_id,message_id FROM telegram_actions WHERE user_id=$1 AND status='pending' AND message_id IS NOT NULL",[userId])){
      if(row.bot_key===botKey())await queue(db,`disconnect:${userId}:${row.chat_id}:${row.message_id}`,"editMessageReplyMarkup",{chat_id:row.chat_id,message_id:row.message_id,reply_markup:{inline_keyboard:[]}});
    }
    await q(db,"UPDATE telegram_actions SET status='canceled' WHERE user_id=$1 AND status='pending'",[userId]);
    await q(db,"UPDATE telegram_conversations SET status='canceled' WHERE action_id IN (SELECT action_id FROM telegram_actions WHERE user_id=$1)",[userId]);
    await q(db,"DELETE FROM telegram_bindings WHERE user_id=$1",[userId]);
    await q(db,"DELETE FROM telegram_bind_tokens WHERE user_id=$1",[userId]);
    await q(db,"DELETE FROM user_secrets WHERE user_id=$1 AND kind='telegram_chat'",[userId]);
    await telegramAudit(db,userId,"binding.disconnected",String(userId));
  });
  return {ok:true};
}
export async function queue(db:Db,key:string,method:string,payload:unknown,actionIds:string[]=[],conversation?:string,userId?:number) {
  await q(db,`INSERT INTO telegram_outbox(bot_key,dedupe_key,method,payload,action_ids,conversation_action_id,user_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[botKey(),key,method,JSON.stringify(payload),actionIds,conversation??null,userId??null]);
}
/** One session-level Postgres lock coordinates BOTH update transports and legacy chat discovery. */
export function advisoryKey(key=botKey()){return parseInt(key.slice(0,8),16)|0;}
export async function observedChats(key=botKey()) {
  return q(pool,`SELECT DISTINCT ON(payload->'message'->'chat'->>'id') payload->'message'->'chat'->>'id' AS id,
    COALESCE(payload->'message'->'chat'->>'title',payload->'message'->'chat'->>'first_name','') AS name,payload->'message'->'chat'->>'type' AS type
    FROM telegram_updates WHERE bot_key=$1 AND payload->'message'->'chat'->>'id' IS NOT NULL ORDER BY payload->'message'->'chat'->>'id',update_id DESC LIMIT 100`,[key]);
}
