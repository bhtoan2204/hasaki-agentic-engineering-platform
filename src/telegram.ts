import { config } from "./config.ts";
import type { OutputLocale } from "./agent/language.ts";
import { getUserSecret } from "./auth/secrets.ts";

/**
 * One-way Telegram notifications through the Bot API `sendMessage`. Optional: without TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID nothing is sent. The token is never logged: errors are reported without the request URL.
 */
export interface StepWaiting {
  runId: number;
  runTitle: string;
  stepKey: string;
  stepName: string;
  status: "WAITING_INPUT" | "WAITING_APPROVAL";
  /** Why the step waits, in a few words (e.g. "2 câu hỏi cần trả lời"). */
  detail: string;
  /** Run output locale. Omitted keeps the original Vietnamese template (legacy callers). */
  locale?: OutputLocale;
  /** Private notifications go to this user's destination, never the shared team chat. */
  ownerId?: number | null;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
export const stepLink = (runId: number, stepKey: string) => `${config.publicUrl.replace(/\/$/, "")}/#/runs/${runId}/${encodeURIComponent(stepKey)}`;
/**
 * Telegram drops links to `localhost` (neither auto-linked nor kept as <a href>), but links to 127.0.0.1 stay
 * clickable (verified via the entities Telegram returns). Same machine, so the link still opens the local UI.
 */
export const telegramUrl = (url: string) => url.replace(/^(https?:\/\/)localhost(?=[:/?#]|$)/i, "$1127.0.0.1");
/** Telegram only accepts public http(s) URLs in inline buttons; local links are sent as a text link. */
export const isPublicHttps = (url: string) => /^https:\/\//i.test(url) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);

export const RULE = "━━━━━━━━━━━━━━━━";
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

/** Call-to-action footer: an inline button for public https links, otherwise a short text link. */
export function linkFooter(url: string, label: string) {
  const u = telegramUrl(url);
  return isPublicHttps(u) ? { text: "", reply_markup: { inline_keyboard: [[{ text: label, url: u }]] } } : { text: `👉 <a href="${attr(u)}">${esc(label)}</a>`, reply_markup: undefined };
}

export function buildStepMessage(w: StepWaiting) {
  const input = w.status === "WAITING_INPUT";
  const en = w.locale === "en";
  const footer = linkFooter(stepLink(w.runId, w.stepKey), input ? (en ? "Open to answer" : "Mở để trả lời") : (en ? "Open to approve" : "Mở để duyệt"));
  const text = [
    input ? (en ? "❓ <b>NEEDS YOUR ANSWER</b>" : "❓ <b>CẦN BẠN TRẢ LỜI</b>") : (en ? "✋ <b>NEEDS YOUR APPROVAL</b>" : "✋ <b>CẦN BẠN DUYỆT</b>"),
    RULE,
    `📋 <b>${esc(w.runTitle)}</b>`,
    "",
    `▸ ${en ? "Step" : "Bước"}: <b>${esc(w.stepName)}</b> · <code>${esc(w.stepKey)}</code>`,
    `▸ Run: #${w.runId}`,
    `▸ ${en ? "Reason" : "Lý do"}: <i>${esc(w.detail)}</i>`,
    ...(footer.text ? ["", footer.text] : []),
  ].join("\n");
  return { text, parse_mode: "HTML", disable_web_page_preview: true, ...(footer.reply_markup ? { reply_markup: footer.reply_markup } : {}) };
}

const sent = new Map<string, number>(); // dedupe key → time (guards against double emission of one transition)

export async function sendTelegramStepWaiting(w: StepWaiting, dedupeKey: string) {
  const botToken = config.telegram.botToken;
  const chatId = w.ownerId ? await getUserSecret(w.ownerId, "telegram_chat") : null;
  if (!botToken || !chatId) return { skipped: "not configured" as const };
  if (sent.has(dedupeKey)) return { skipped: "duplicate" as const };
  sent.set(dedupeKey, Date.now());
  if (sent.size > 2000) for (const k of [...sent.keys()].slice(0, 1000)) sent.delete(k);
  return postMessage(buildStepMessage(w), chatId);
}

export const escapeHtml = esc;

/** Send an HTML message (already escaped by the caller) to the configured chat. Never throws. */
export async function sendTelegramHtml(html: string, replyMarkup?: unknown) {
  if (!config.telegram.botToken || !config.telegram.chatId) return { skipped: "not configured" as const };
  return postMessage({ text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

async function postMessage(message: Record<string, unknown>, chatId = config.telegram.chatId) {
  const { botToken, apiBase } = config.telegram;
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      console.error(`telegram sendMessage failed: HTTP ${res.status} ${String(body?.description ?? "").slice(0, 200)}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    // never include the request URL (it contains the token)
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const why = err.name === "TimeoutError" ? "timeout" : [err.message, err.cause?.code, err.cause?.message].filter(Boolean).join(" | ");
    const hint = err.cause?.code === "SELF_SIGNED_CERT_IN_CHAIN" || err.cause?.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ? " (TLS-intercepting proxy? start node with --use-system-ca or set NODE_EXTRA_CA_CERTS)" : "";
    console.error(`telegram sendMessage failed: ${why.split(botToken).join("***")}${hint}`);
    return { ok: false };
  }
}
