import { networkCode } from "../telegram/client.ts";
import { forgetBitbucketChecks } from "../repos/access.ts";
import { gitlabHosts } from "../repos/remote.ts";
import {
  GitlabError,
  glab,
  gitlabSecretKey,
  gitlabSshKeySecret,
  validSshPrivateKey,
  type GlToken,
} from "../gitlab.ts";
import { bindingStatus, advisoryKey, observedChats } from "../telegram/store.ts";
import { botKey } from "../telegram/client.ts";
import { pool, one, q } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { config } from "../config.ts";
import { settings } from "../db.ts";
import {
  deleteUserSecret,
  getUserSecret,
  putUserSecret,
  getSharedSecret,
  putSharedSecret,
} from "../auth/secrets.ts";

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
  bitbucket: {
    user: config.bitbucket.user,
    token: config.bitbucket.token,
    workspace: config.bitbucket.workspace,
    reviewers: [...config.bitbucket.reviewers],
  },
};
let saved: { telegram: TelegramSaved | null; bitbucket: BitbucketSaved | null } = {
  telegram: null,
  bitbucket: null,
};

const mask = (s: string) => (!s ? "" : s.length <= 8 ? "••••" : `••••${s.slice(-4)}`);
const readJson = async <T>(key: string): Promise<T | null> => {
  const v =
    key === "telegram"
      ? ((await getSharedSecret("telegram")) ?? (await settings.get(key)))
      : await settings.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};

/**
 * Update transport ("off" | "polling") chosen on the Integrations page, stored in `settings` (not a secret) so every
 * instance sharing the database follows it without a restart. TELEGRAM_MODE in the environment always wins (and is
 * the only way to use webhook mode, which also needs a public HTTPS URL and a secret).
 */
export type TelegramUiMode = "off" | "polling";
const envMode = process.env.TELEGRAM_MODE ? config.telegram.mode : null;
let savedMode: TelegramUiMode | null = null;
const readMode = async (): Promise<TelegramUiMode | null> => {
  const v = await settings.get("telegram_mode");
  return v === "off" || v === "polling" ? v : null;
};

function apply() {
  const t = saved.telegram ?? fromEnv.telegram;
  config.telegram.botToken = t.botToken;
  config.telegram.chatId = t.chatId;
  if (!envMode && savedMode) config.telegram.mode = savedMode;
  // Bitbucket in config stays the shared service account from startup. Personal tokens are not copied onto it.
}

/** Where the active transport mode comes from: the environment, the Integrations page, or the default (off). */
export const telegramModeSource = () => (envMode ? "env" : savedMode ? "platform" : "default");

/** Administrators turn the long-polling receiver on/off from the UI; the receiver loop picks it up within ~30 s. */
export async function setTelegramMode(mode: unknown) {
  if (mode !== "off" && mode !== "polling") throw new HttpError(400, "mode must be off or polling");
  if (envMode)
    throw new HttpError(409, `TELEGRAM_MODE=${envMode} is set in the environment; change it there`);
  if (mode === "polling" && !config.telegram.botToken)
    throw new HttpError(409, "Save the bot token first");
  await settings.set("telegram_mode", mode);
  savedMode = mode;
  apply();
  return { mode: config.telegram.mode, modeSource: telegramModeSource() };
}

/**
 * Re-read the administrator-managed bot credentials (shared, encrypted) so a token saved or cleared on another
 * instance reaches this process. A no-op while nothing changed, so in-process overrides stay untouched.
 */
export async function refreshTelegramSettings() {
  const next = await readJson<TelegramSaved>("telegram");
  const mode = await readMode();
  if (JSON.stringify(next) === JSON.stringify(saved.telegram) && mode === savedMode) return false;
  saved.telegram = next;
  savedMode = mode;
  apply();
  return true;
}

export async function loadAccountSettings() {
  saved = {
    telegram: await readJson<TelegramSaved>("telegram"),
    bitbucket: await readJson<BitbucketSaved>("bitbucket"),
  };
  savedMode = await readMode();
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
    // "fetch failed" alone says nothing: name the system error (ETIMEDOUT, ENOTFOUND, ECONNREFUSED…) and the host.
    const host = (() => {
      try {
        return new URL(config.telegram.apiBase).host;
      } catch {
        return "Telegram API";
      }
    })();
    throw new Error(
      `không gọi được Telegram (${networkCode(e)}): máy chạy platform không kết nối được tới ${host}; kiểm tra mạng, VPN hoặc proxy (TELEGRAM_API_BASE)`,
    );
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok)
    throw new Error(
      `Telegram ${method}: ${String(j.description ?? `HTTP ${res.status}`)
        .split(token)
        .join("***")}`,
    );
  return j.result;
}

export async function telegramStatus(userId?: number, canManage = false) {
  return {
    configured: !!config.telegram.botToken,
    canManage,
    ...(userId ? await bindingStatus(userId) : {}),
    /** Where THIS user's step notifications (question / approval) go. Without it they are not sent at all. */
    myChatId: userId ? await getUserSecret(userId, "telegram_chat") : null,
    source: saved.telegram
      ? "platform"
      : fromEnv.telegram.botToken || fromEnv.telegram.chatId
        ? "env"
        : "none",
    envAvailable: !!(fromEnv.telegram.botToken && fromEnv.telegram.chatId),
    chatId: config.telegram.chatId || null,
    botToken: mask(config.telegram.botToken),
    mode: config.telegram.mode,
    modeSource: telegramModeSource(),
  };
}

/** Save; an empty botToken keeps the current one (change only the chat id). Validated with getMe before saving. */
export async function setTelegram(input: { botToken?: string; chatId?: string }) {
  const botToken = (input.botToken ?? "").trim() || config.telegram.botToken;
  const chatId = String(input.chatId ?? "").trim();
  if (!botToken) throw new Error("cần bot token (lấy từ @BotFather)");
  if (!/^\d+:[\w-]{20,}$/.test(botToken))
    throw new Error("bot token không đúng dạng <số>:<chuỗi> của @BotFather");
  if (chatId && !/^-?\d+$/.test(chatId) && !/^@\w{4,}$/.test(chatId))
    throw new Error("chat id là một số (vd 123456789 hoặc -100… cho group) hoặc @channel");
  const me = await telegramApi(botToken, "getMe");
  saved.telegram = { botToken, chatId };
  await putSharedSecret("telegram", JSON.stringify(saved.telegram));
  apply();
  return { ...(await telegramStatus()), bot: me?.username ? `@${me.username}` : null };
}

/** Recent chats that wrote to the bot (getUpdates), to pick the chat id without curl. */
export async function telegramChats(input: { botToken?: string }) {
  const token = (input.botToken ?? "").trim() || config.telegram.botToken;
  if (!token) throw new Error("nhập bot token trước, rồi nhắn /start cho bot");
  const key = botKey(token),
    client = await pool.connect();
  let updates: any[];
  const locked = (
    await client.query("SELECT pg_try_advisory_lock($1::int) AS ok", [advisoryKey(key)])
  ).rows[0].ok;
  try {
    const active = await one(
      client,
      "SELECT bot_key FROM telegram_consumers WHERE bot_key=$1 AND lease_until>now()",
      [key],
    );
    if (!locked || active || config.telegram.mode !== "off") return observedChats(key);
    updates = await telegramApi(token, "getUpdates");
  } finally {
    if (locked)
      await client.query("SELECT pg_advisory_unlock($1::int)", [advisoryKey(key)]).catch(() => {});
    client.release();
  }
  const chats = new Map<string, { id: string; name: string; type: string }>();
  for (const u of updates) {
    const c =
      u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat ?? u.edited_message?.chat;
    if (c)
      chats.set(String(c.id), {
        id: String(c.id),
        name: c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? c.username ?? "",
        type: c.type,
      });
  }
  return [...chats.values()];
}

/** Test the user's own destination when set (what step notifications use); otherwise the shared chat (admin only). */
export async function testTelegram(userId?: number, isAdmin = false) {
  if (!config.telegram.botToken) throw new Error("Telegram chưa cấu hình");
  const mine = userId ? await getUserSecret(userId, "telegram_chat") : null;
  const chatId = mine ?? (isAdmin ? config.telegram.chatId : "");
  if (!chatId) throw new Error("chưa có chat nhận thông báo của bạn");
  await telegramApi(config.telegram.botToken, "sendMessage", {
    chat_id: chatId,
    text: mine
      ? "✅ Claude Task Platform: thông báo bước (câu hỏi / duyệt) của bạn sẽ gửi vào chat này."
      : "✅ Claude Task Platform: kết nối Telegram hoạt động (chat chung).",
  });
  return { ok: true, chat: mine ? "mine" : "shared" };
}

export async function clearTelegram() {
  saved.telegram = null;
  await putSharedSecret("telegram", "null");
  apply();
  return telegramStatus();
}

// ---------------------------------------------------------------- Bitbucket

const BB = "https://api.bitbucket.org/2.0";
async function bbGet(user: string, token: string, path: string) {
  const res = await fetch(BB + path, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${user}:${token}`).toString("base64"),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: j };
}

export async function bitbucketStatus(userId?: number) {
  const personalUser = userId ? await getUserSecret(userId, "bitbucket_user") : null;
  const personalToken = userId ? await getUserSecret(userId, "bitbucket_token") : null;
  const personal = !!(personalUser && personalToken);
  const personalAttempt = !!(personalUser || personalToken);
  const sharedAllowed = config.bitbucket.allowSharedCredentials !== false;
  const user = personalAttempt ? (personalUser ?? "") : sharedAllowed ? config.bitbucket.user : "";
  const token = personalAttempt
    ? (personalToken ?? "")
    : sharedAllowed
      ? config.bitbucket.token
      : "";
  return {
    configured: !!(user && token),
    source: personalAttempt ? "user" : user || token ? "shared" : "none",
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
export async function setBitbucket(
  input: { user?: string; token?: string; workspace?: string; reviewers?: string[] | string },
  userId?: number,
) {
  const user = String(input.user ?? "").trim();
  const token =
    String(input.token ?? "").trim() ||
    (userId ? ((await getUserSecret(userId, "bitbucket_token")) ?? "") : "");
  const workspace = String(input.workspace ?? "").trim() || config.bitbucket.workspace;
  const reviewers = (
    Array.isArray(input.reviewers) ? input.reviewers : String(input.reviewers ?? "").split(/[\s,]+/)
  )
    .map((r) => r.trim())
    .filter(Boolean);
  if (!user || !token)
    throw new Error("cần user (email Atlassian hoặc username Bitbucket) và token");
  const bad = reviewers.find((r) => !/^\{[0-9a-f-]{36}\}$/i.test(r));
  if (bad) throw new Error(`reviewer "${bad}" không phải UUID Bitbucket dạng {xxxxxxxx-xxxx-…}`);
  if (!userId) throw new Error("Bitbucket credentials are saved per user");
  const repos = await bbGet(
    user,
    token,
    `/repositories/${encodeURIComponent(workspace)}?pagelen=1`,
  );
  if (repos.status === 401)
    throw new Error(
      "Bitbucket 401: user/token sai (API token Atlassian: user là email; app password: user là username)",
    );
  if (!repos.ok)
    throw new Error(
      `Bitbucket ${repos.status} khi đọc workspace ${workspace}: ${repos.body?.error?.message ?? "không có quyền"}`,
    );
  const me = await bbGet(user, token, "/user").catch(() => null);
  await putUserSecret(userId, "bitbucket_user", user);
  await putUserSecret(userId, "bitbucket_token", token);
  // New credentials may see different repositories: forget the cached permission checks of this user.
  await forgetBitbucketChecks({ userId });
  return {
    ...(await bitbucketStatus(userId)),
    account: me?.ok ? (me.body.display_name ?? me.body.username ?? null) : null,
  };
}

export async function githubStatus(userId?: number) {
  const personal = userId ? await getUserSecret(userId, "github_token") : null;
  const shared =
    config.github.allowSharedCredentials && config.github.token ? config.github.token : "";
  const token = personal || shared || "";
  return {
    configured: !!token,
    source: personal ? "user" : shared ? "shared" : "none",
    personal: !!personal,
    token: mask(token),
  };
}

/** Save a personal GitHub token. A classic token must include repo or public_repo. Fine-grained tokens omit scopes. */
export async function setGithub(input: { token?: string }, userId?: number) {
  const token = String(input.token ?? "").trim();
  if (!token) throw new Error("GitHub token is required");
  if (!userId) throw new Error("GitHub credentials are saved per user");
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "hasaki-agentic-engineering-platform",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error("GitHub token was rejected");
  if (!res.ok) throw new Error(`GitHub ${res.status} while checking the token`);
  const scopes = res.headers.get("x-oauth-scopes");
  if (scopes && scopes.trim()) {
    const list = scopes.split(",").map((s) => s.trim());
    if (!list.some((s) => s === "repo" || s === "public_repo"))
      throw new Error(
        "GitHub token needs the repo or public_repo scope, or use a fine-grained token with Contents and Pull requests on this repository only",
      );
  }
  const body = await res.json().catch(() => ({}));
  await putUserSecret(userId, "github_token", token);
  await q(
    pool,
    `DELETE FROM repository_bitbucket_permissions p USING repositories r
     WHERE p.repository_id = r.id AND p.user_id = $1 AND r.provider = 'github'`,
    [userId],
  );
  return { ...(await githubStatus(userId)), login: body.login ?? null };
}

export async function clearGithub(userId?: number) {
  if (userId) {
    await deleteUserSecret(userId, "github_token");
    await q(
      pool,
      `DELETE FROM repository_bitbucket_permissions p USING repositories r
       WHERE p.repository_id = r.id AND p.user_id = $1 AND r.provider = 'github'`,
      [userId],
    );
  }
  return githubStatus(userId);
}

/** Allowed instances and, per instance, whether this user saved a token. Tokens are never returned. */
export async function gitlabStatus(userId?: number) {
  const shared = !!(config.gitlab.allowSharedCredentials && config.gitlab.token);
  const instances = [];
  for (const host of gitlabHosts()) {
    const personal = userId ? !!(await getUserSecret(userId, gitlabSecretKey(host))) : false;
    const instance = config.gitlab.instances.find((i) => i.host === host);
    instances.push({
      host,
      base_url: `https://${host}`,
      configured: personal || shared,
      personal,
      source: personal ? "user" : shared ? "shared" : "none",
      // SSH transport needs pinned host keys in config plus the user's own key; only presence is reported.
      ssh_available: !!instance?.sshHostKeys?.length,
      ssh_key: userId ? !!(await getUserSecret(userId, gitlabSshKeySecret(host))) : false,
    });
  }
  return { instances, shared };
}

function gitlabHostOf(input: unknown): string {
  // Accept a bare host or a base URL ("https://gitlab.hasaki.work/"); it must be an allow-listed instance.
  const raw = String(input ?? "")
    .trim()
    .toLowerCase();
  const host = raw.replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!host || !gitlabHosts().includes(host))
    throw new HttpError(
      400,
      `GitLab instance is not allowed: use one of ${gitlabHosts().join(", ") || "(none configured)"} (config.gitlab.instances)`,
    );
  return host;
}

type GitlabCheck = {
  ok: boolean;
  /** ok | auth | permission | connectivity | http | scope */
  kind: string;
  message: string;
  account: string | null;
  scopes: string[] | null;
};

/**
 * Validate a token against one instance: who it belongs to and which scopes it has. Personal and project access
 * tokens answer /personal_access_tokens/self (GitLab 15.5+); older instances fall back to /user (scopes unknown).
 */
async function checkGitlabToken(host: string, token: string): Promise<GitlabCheck> {
  try {
    let scopes: string[] | null = null;
    let account: string | null = null;
    try {
      const { body } = await glab<GlToken>(host, token, "/personal_access_tokens/self");
      scopes = Array.isArray(body?.scopes) ? body.scopes.map(String) : null;
      if (body?.active === false || body?.revoked === true)
        return {
          ok: false,
          kind: "auth",
          message: `GitLab ${host}: the token is revoked or expired`,
          account,
          scopes,
        };
    } catch (e) {
      if (!(e instanceof GitlabError) || e.kind === "auth" || e.kind === "connectivity") throw e;
    }
    const { body: me } = await glab<{ username?: string }>(host, token, "/user");
    account = me?.username ?? null;
    if (scopes) {
      const has = (x: string) => scopes!.includes(x);
      if (!has("api") && !(has("write_repository") && (has("read_api") || has("read_repository"))))
        return {
          ok: false,
          kind: "scope",
          message:
            "GitLab token needs the api scope (merge requests, comments, merge), or read_api + read_repository + write_repository for read and push only",
          account,
          scopes,
        };
    }
    return {
      ok: true,
      kind: "ok",
      message: `Connected to ${host}${account ? ` as ${account}` : ""}`,
      account,
      scopes,
    };
  } catch (e) {
    if (e instanceof GitlabError)
      return { ok: false, kind: e.kind, message: e.message, account: null, scopes: null };
    return {
      ok: false,
      kind: "http",
      message: `GitLab ${host}: check failed`,
      account: null,
      scopes: null,
    };
  }
}

async function forgetGitlabChecks(userId: number) {
  await q(
    pool,
    `DELETE FROM repository_bitbucket_permissions p USING repositories r
     WHERE p.repository_id = r.id AND p.user_id = $1 AND r.provider = 'gitlab'`,
    [userId],
  );
}

/** Save a personal or project access token for one allow-listed instance after checking it. */
export async function setGitlab(
  input: { host?: string; base_url?: string; token?: string },
  userId?: number,
) {
  const host = gitlabHostOf(input.host ?? input.base_url);
  const token = String(input.token ?? "").trim();
  if (!token) throw new HttpError(400, "GitLab token is required");
  if (!userId) throw new HttpError(400, "GitLab credentials are saved per user");
  const check = await checkGitlabToken(host, token);
  if (!check.ok) throw new HttpError(check.kind === "connectivity" ? 502 : 400, check.message);
  await putUserSecret(userId, gitlabSecretKey(host), token);
  await forgetGitlabChecks(userId);
  return { ...(await gitlabStatus(userId)), host, account: check.account, scopes: check.scopes };
}

/** Test the saved token of one instance; reports auth, permission and connectivity failures distinctly. */
export async function testGitlab(input: { host?: string; base_url?: string }, userId?: number) {
  const host = gitlabHostOf(input.host ?? input.base_url);
  const token =
    (userId ? await getUserSecret(userId, gitlabSecretKey(host)) : null) ||
    (config.gitlab.allowSharedCredentials ? config.gitlab.token : "");
  if (!token)
    return {
      host,
      ok: false,
      kind: "auth",
      message: `No GitLab token saved for ${host}`,
      account: null,
      scopes: null,
    };
  return { host, ...(await checkGitlabToken(host, token)) };
}

/**
 * Save the user's SSH private key for Git transport to one instance. Accepted only when the instance pins its host
 * keys (config.gitlab.instances[].sshHostKeys) and the key is an unencrypted OpenSSH/PEM private key. The key is
 * stored encrypted like other personal secrets and never returned.
 */
export async function setGitlabSshKey(
  input: { host?: string; base_url?: string; ssh_key?: string },
  userId?: number,
) {
  const host = gitlabHostOf(input.host ?? input.base_url);
  if (!userId) throw new HttpError(400, "GitLab credentials are saved per user");
  if (!config.gitlab.instances.find((i) => i.host === host)?.sshHostKeys?.length)
    throw new HttpError(
      400,
      `SSH is not enabled for ${host}: an operator must pin its host keys in config.gitlab.instances[].sshHostKeys`,
    );
  const key = String(input.ssh_key ?? "");
  if (!validSshPrivateKey(key))
    throw new HttpError(
      400,
      "Paste an unencrypted OpenSSH private key (-----BEGIN OPENSSH PRIVATE KEY-----); passphrase-protected keys cannot be used non-interactively",
    );
  await putUserSecret(userId, gitlabSshKeySecret(host), key.trim() + "\n");
  return gitlabStatus(userId);
}

export async function clearGitlab(input: { host?: string; base_url?: string }, userId?: number) {
  if (userId) {
    const hosts =
      input?.host || input?.base_url ? [gitlabHostOf(input.host ?? input.base_url)] : gitlabHosts();
    for (const host of hosts) {
      await deleteUserSecret(userId, gitlabSecretKey(host));
      await deleteUserSecret(userId, gitlabSshKeySecret(host));
    }
    await forgetGitlabChecks(userId);
  }
  return gitlabStatus(userId);
}

export async function clearBitbucket(userId?: number) {
  if (userId) {
    await deleteUserSecret(userId, "bitbucket_user");
    await deleteUserSecret(userId, "bitbucket_token");
    await forgetBitbucketChecks({ userId });
  }
  return bitbucketStatus(userId);
}

/** Copy what .env provides into the platform (after which the variables can be removed from .env). */
export async function adoptEnv(which: "telegram" | "bitbucket", userId?: number) {
  if (which === "telegram") {
    if (!fromEnv.telegram.botToken || !fromEnv.telegram.chatId)
      throw new Error(".env không có TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID");
    return setTelegram(fromEnv.telegram);
  }
  if (!fromEnv.bitbucket.user || !fromEnv.bitbucket.token)
    throw new Error(".env không có BITBUCKET_USER và BITBUCKET_TOKEN");
  return setBitbucket(fromEnv.bitbucket, userId);
}

/** The chat that receives this user's private run notifications. The shared bot token is unchanged. */
export async function setTelegramDestination(userId: number, chatId: string) {
  const id = String(chatId ?? "").trim();
  const binding = await one(pool, "SELECT chat_id FROM telegram_bindings WHERE user_id=$1", [
    userId,
  ]);
  if (binding && binding.chat_id !== id)
    throw new HttpError(409, "Disconnect Telegram before changing its verified destination");
  if (!id) {
    await deleteUserSecret(userId, "telegram_chat");
    return { chatId: null };
  }
  if (!/^-?\d+$/.test(id) && !/^@\w{4,}$/.test(id))
    throw new Error("chat id là một số (vd 123456789 hoặc -100… cho group) hoặc @channel");
  await putUserSecret(userId, "telegram_chat", id);
  return { chatId: id };
}
