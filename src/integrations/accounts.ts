import { config } from "../config.ts";
import { settings } from "../db.ts";
import { deleteUserSecret, getUserSecret, putUserSecret } from "../auth/secrets.ts";

/**
 * Telegram and Bitbucket credentials managed from the Integrations page instead of environment variables.
 *
 * Values saved in the UI are stored in the `settings` table and applied onto the in-memory `config` (telegram.ts and
 * bitbucket.ts read `config` at call time, so nothing else changes). A value saved in the UI wins over .env / config.json;
 * clearing it falls back to what .env / config.json provided at startup. Secrets are never returned to the browser.
 */

type TelegramSaved = { botToken: string; chatId: string };
type BitbucketSaved = { user: string; token: string; workspace?: string; reviewers?: string[] };

// What .env / config.json provided at startup (the fallback).
const fromEnv = {
  telegram: { botToken: config.telegram.botToken, chatId: config.telegram.chatId },
  bitbucket: { user: config.bitbucket.user, token: config.bitbucket.token, workspace: config.bitbucket.workspace, reviewers: [...config.bitbucket.reviewers] },
};
let saved: { telegram: TelegramSaved | null; bitbucket: BitbucketSaved | null } = { telegram: null, bitbucket: null };

const mask = (s: string) => (!s ? "" : s.length <= 8 ? "••••" : `••••${s.slice(-4)}`);
const readJson = async <T>(key: string): Promise<T | null> => {
  const v = await settings.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};

function apply() {
  const t = saved.telegram ?? fromEnv.telegram;
  config.telegram.botToken = t.botToken;
  config.telegram.chatId = t.chatId;
  // Bitbucket in config stays the shared service account from startup. Personal tokens are not copied onto it.
}

export async function loadAccountSettings() {
  saved = { telegram: await readJson<TelegramSaved>("telegram"), bitbucket: await readJson<BitbucketSaved>("bitbucket") };
  apply();
}

// ---------------------------------------------------------------- Telegram

async function telegramApi(token: string, method: string, body?: unknown) {
  const res = await fetch(`${config.telegram.apiBase.replace(/\/$/, "")}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  }).catch((e: Error) => {
    throw new Error(`không gọi được Telegram: ${e.name === "TimeoutError" ? "timeout" : e.message.split(token).join("***")}`);
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`Telegram ${method}: ${j.description ?? `HTTP ${res.status}`}`);
  return j.result;
}

export async function telegramStatus(userId?: number) {
  return {
    configured: !!(config.telegram.botToken && config.telegram.chatId),
    /** Where THIS user's step notifications (question / approval) go. Without it they are not sent at all. */
    myChatId: userId ? await getUserSecret(userId, "telegram_chat") : null,
    source: saved.telegram ? "platform" : fromEnv.telegram.botToken || fromEnv.telegram.chatId ? "env" : "none",
    envAvailable: !!(fromEnv.telegram.botToken && fromEnv.telegram.chatId),
    chatId: config.telegram.chatId || null,
    botToken: mask(config.telegram.botToken),
  };
}

/** Save; an empty botToken keeps the current one (change only the chat id). Validated with getMe before saving. */
export async function setTelegram(input: { botToken?: string; chatId?: string }) {
  const botToken = (input.botToken ?? "").trim() || config.telegram.botToken;
  const chatId = String(input.chatId ?? "").trim();
  if (!botToken) throw new Error("cần bot token (lấy từ @BotFather)");
  if (!/^\d+:[\w-]{20,}$/.test(botToken)) throw new Error("bot token không đúng dạng <số>:<chuỗi> của @BotFather");
  if (!/^-?\d+$/.test(chatId) && !/^@\w{4,}$/.test(chatId)) throw new Error("chat id là một số (vd 123456789 hoặc -100… cho group) hoặc @channel");
  const me = await telegramApi(botToken, "getMe");
  saved.telegram = { botToken, chatId };
  await settings.set("telegram", JSON.stringify(saved.telegram));
  apply();
  return { ...(await telegramStatus()), bot: me?.username ? `@${me.username}` : null };
}

/** Recent chats that wrote to the bot (getUpdates), to pick the chat id without curl. */
export async function telegramChats(input: { botToken?: string }) {
  const token = (input.botToken ?? "").trim() || config.telegram.botToken;
  if (!token) throw new Error("nhập bot token trước, rồi nhắn /start cho bot");
  const updates: any[] = await telegramApi(token, "getUpdates");
  const chats = new Map<string, { id: string; name: string; type: string }>();
  for (const u of updates) {
    const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat ?? u.edited_message?.chat;
    if (c) chats.set(String(c.id), { id: String(c.id), name: c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? c.username ?? "", type: c.type });
  }
  return [...chats.values()];
}

/** Test the user's own destination when set (what step notifications use); otherwise the shared chat (admin only). */
export async function testTelegram(userId?: number, isAdmin = false) {
  if (!config.telegram.botToken) throw new Error("Telegram chưa cấu hình");
  const mine = userId ? await getUserSecret(userId, "telegram_chat") : null;
  const chatId = mine ?? (isAdmin ? config.telegram.chatId : "");
  if (!chatId) throw new Error("chưa có chat nhận thông báo của bạn");
  await telegramApi(config.telegram.botToken, "sendMessage", { chat_id: chatId, text: mine ? "✅ Claude Task Platform: thông báo bước (câu hỏi / duyệt) của bạn sẽ gửi vào chat này." : "✅ Claude Task Platform: kết nối Telegram hoạt động (chat chung)." });
  return { ok: true, chat: mine ? "mine" : "shared" };
}

export async function clearTelegram() {
  saved.telegram = null;
  await settings.set("telegram", "");
  apply();
  return telegramStatus();
}

// ---------------------------------------------------------------- Bitbucket

const BB = "https://api.bitbucket.org/2.0";
async function bbGet(user: string, token: string, path: string) {
  const res = await fetch(BB + path, {
    headers: { Authorization: "Basic " + Buffer.from(`${user}:${token}`).toString("base64"), Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: j };
}

export async function bitbucketStatus(userId?: number) {
  const personalUser = userId ? await getUserSecret(userId, "bitbucket_user") : null;
  const personalToken = userId ? await getUserSecret(userId, "bitbucket_token") : null;
  const personal = !!(personalUser && personalToken);
  const user = personal ? personalUser : config.bitbucket.user;
  const token = personal ? personalToken! : config.bitbucket.token;
  return {
    configured: !!(user && token),
    source: personal ? "user" : user || token ? "shared" : "none",
    personal,
    envAvailable: !!(fromEnv.bitbucket.user && fromEnv.bitbucket.token),
    user: user || null,
    token: mask(token),
    workspace: config.bitbucket.workspace,
    reviewers: config.bitbucket.reviewers,
  };
}

/**
 * Save; an empty token keeps the current one. Checked against the workspace (list one repository) before saving —
 * the token needs read and write access to pull requests and read access to repositories.
 */
export async function setBitbucket(input: { user?: string; token?: string; workspace?: string; reviewers?: string[] | string }, userId?: number) {
  const user = String(input.user ?? "").trim();
  const token = String(input.token ?? "").trim() || (userId ? (await getUserSecret(userId, "bitbucket_token")) ?? "" : "");
  const workspace = String(input.workspace ?? "").trim() || config.bitbucket.workspace;
  const reviewers = (Array.isArray(input.reviewers) ? input.reviewers : String(input.reviewers ?? "").split(/[\s,]+/)).map((r) => r.trim()).filter(Boolean);
  if (!user || !token) throw new Error("cần user (email Atlassian hoặc username Bitbucket) và token");
  const bad = reviewers.find((r) => !/^\{[0-9a-f-]{36}\}$/i.test(r));
  if (bad) throw new Error(`reviewer "${bad}" không phải UUID Bitbucket dạng {xxxxxxxx-xxxx-…}`);
  if (!userId) throw new Error("Bitbucket credentials are saved per user");
  const repos = await bbGet(user, token, `/repositories/${encodeURIComponent(workspace)}?pagelen=1`);
  if (repos.status === 401) throw new Error("Bitbucket 401: user/token sai (API token Atlassian: user là email; app password: user là username)");
  if (!repos.ok) throw new Error(`Bitbucket ${repos.status} khi đọc workspace ${workspace}: ${repos.body?.error?.message ?? "không có quyền"}`);
  const me = await bbGet(user, token, "/user").catch(() => null);
  await putUserSecret(userId, "bitbucket_user", user);
  await putUserSecret(userId, "bitbucket_token", token);
  return { ...(await bitbucketStatus(userId)), account: me?.ok ? (me.body.display_name ?? me.body.username ?? null) : null };
}

export async function clearBitbucket(userId?: number) {
  if (userId) {
    await deleteUserSecret(userId, "bitbucket_user");
    await deleteUserSecret(userId, "bitbucket_token");
  }
  return bitbucketStatus(userId);
}

/** Copy what .env provides into the platform (after which the variables can be removed from .env). */
export async function adoptEnv(which: "telegram" | "bitbucket", userId?: number) {
  if (which === "telegram") {
    if (!fromEnv.telegram.botToken || !fromEnv.telegram.chatId) throw new Error(".env không có TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID");
    return setTelegram(fromEnv.telegram);
  }
  if (!fromEnv.bitbucket.user || !fromEnv.bitbucket.token) throw new Error(".env không có BITBUCKET_USER và BITBUCKET_TOKEN");
  return setBitbucket(fromEnv.bitbucket, userId);
}

/** The chat that receives this user's private run notifications. The shared bot token is unchanged. */
export async function setTelegramDestination(userId: number, chatId: string) {
  const id = String(chatId ?? "").trim();
  if (!id) {
    await deleteUserSecret(userId, "telegram_chat");
    return { chatId: null };
  }
  if (!/^-?\d+$/.test(id) && !/^@\w{4,}$/.test(id)) throw new Error("chat id là một số (vd 123456789 hoặc -100… cho group) hoặc @channel");
  await putUserSecret(userId, "telegram_chat", id);
  return { chatId: id };
}
