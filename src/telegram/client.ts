import { redactContextText } from "../context/redact.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

export const botKey = (token = config.telegram.botToken) => createHash("sha256").update(token).digest("hex");
export class TelegramApiError extends Error {
  code: number; retryAfter: number;
  constructor(code: number, retryAfter = 5) { super(`Telegram request failed (${code})`); this.code=code; this.retryAfter=retryAfter; }
}
/** Never return/log a token-bearing URL or remote error description. */
export async function telegramCall(method: string, body: unknown, options: { token?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<any> {
  const token = options.token ?? config.telegram.botToken;
  if (!token) throw new TelegramApiError(503);
  try {
    const res = await fetch(`${config.telegram.apiBase.replace(/\/$/, "")}/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeout ?? 10000)]) : AbortSignal.timeout(options.timeout ?? 10000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (data.error_code===400 && method.startsWith("editMessage") && /message is not modified/i.test(data.description??""))return {not_modified:true};
    if (!res.ok || data.ok !== true) throw new TelegramApiError(Number(data.error_code) || res.status, Math.min(3600,Math.max(1,Number(data.parameters?.retry_after)||5)));
    return data.result;
  } catch (e) {
    if (e instanceof TelegramApiError) throw e;
    throw new TelegramApiError(503);
  }
}
export function validWebhookSecret(value: unknown) {
  const secret = config.telegram.webhookSecret;
  if (!secret || typeof value !== "string") return false;
  const digest = (s:string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(secret), digest(value));
}
export const textLimit = (s: unknown, n = 1000) => Array.from(String(s ?? "")).slice(0,n).join("");

/** Only compact questions/titles are sent; fenced code and recognizable secrets stay on-platform. */
export function safeTelegramText(value:unknown) {
  let text=redactContextText(String(value??"")).replace(/```[\s\S]*?(?:```|$)/g,"[Code available in platform]");
  if(config.telegram.botToken)text=text.split(config.telegram.botToken).join("[redacted]");
  return text;
}
