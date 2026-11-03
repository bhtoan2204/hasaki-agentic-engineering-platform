import { config } from "./config.ts";

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
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
export const stepLink = (runId: number, stepKey: string) => `${config.publicUrl.replace(/\/$/, "")}/#/runs/${runId}/${encodeURIComponent(stepKey)}`;
/** Telegram only accepts public http(s) URLs in inline buttons; local links are sent as text. */
export const isPublicHttps = (url: string) => /^https:\/\//i.test(url) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);

export function buildStepMessage(w: StepWaiting) {
  const url = stepLink(w.runId, w.stepKey);
  const reason = w.status === "WAITING_INPUT" ? "❓ Cần bạn trả lời câu hỏi" : "✋ Cần bạn duyệt";
  const button = isPublicHttps(url);
  const text = [
    `<b>${reason}</b>`,
    `Task: ${esc(w.runTitle)}`,
    `Run: #${w.runId}`,
    `Bước: ${esc(w.stepName)} (<code>${esc(w.stepKey)}</code>)`,
    `Lý do: ${esc(w.detail)}`,
    ...(button ? [] : ["", `Mở bước cần xử lý: ${esc(url)}`]),
  ].join("\n");
  return {
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(button ? { reply_markup: { inline_keyboard: [[{ text: "Mở bước cần xử lý", url }]] } } : {}),
  };
}

const sent = new Map<string, number>(); // dedupe key → time (guards against double emission of one transition)

export async function sendTelegramStepWaiting(w: StepWaiting, dedupeKey: string) {
  const { botToken, chatId, apiBase } = config.telegram;
  if (!botToken || !chatId) return { skipped: "not configured" as const };
  if (sent.has(dedupeKey)) return { skipped: "duplicate" as const };
  sent.set(dedupeKey, Date.now());
  if (sent.size > 2000) for (const k of [...sent.keys()].slice(0, 1000)) sent.delete(k);
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...buildStepMessage(w) }),
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
    console.error(`telegram sendMessage failed: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message.replace(botToken, "***")}`);
    return { ok: false };
  }
}
