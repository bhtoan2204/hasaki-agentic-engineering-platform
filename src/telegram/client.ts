import { redactContextText } from "../context/redact.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

export const botKey = (token = config.telegram.botToken) =>
  createHash("sha256").update(token).digest("hex");
export class TelegramApiError extends Error {
  code: number;
  retryAfter: number;
  /** Set when Telegram was never reached (DNS, connect, TLS, timeout): the system error code, e.g. "ETIMEDOUT". */
  network?: string;
  constructor(code: number, retryAfter = 5, network?: string) {
    super(network ? `Telegram unreachable (${network})` : `Telegram request failed (${code})`);
    this.code = code;
    this.retryAfter = retryAfter;
    this.network = network;
  }
}
/** The system error code behind a failed fetch (undici nests it in `cause`, sometimes twice); never a URL or token. */
export function networkCode(e: unknown): string {
  const err = e as {
    name?: string;
    code?: string;
    cause?: { code?: string; cause?: { code?: string } };
  };
  if (err?.name === "TimeoutError") return "timeout";
  if (err?.name === "AbortError") return "aborted";
  const code = err?.cause?.code ?? err?.cause?.cause?.code ?? err?.code;
  return typeof code === "string" && /^[A-Za-z_]{2,40}$/.test(code) ? code : "network error";
}
/** Never return/log a token-bearing URL or remote error description. */
export async function telegramCall(
  method: string,
  body: unknown,
  options: { token?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<any> {
  const token = options.token ?? config.telegram.botToken;
  if (!token) throw new TelegramApiError(503);
  try {
    const res = await fetch(`${config.telegram.apiBase.replace(/\/$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 10000)])
        : AbortSignal.timeout(options.timeout ?? 10000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (
      data.error_code === 400 &&
      method.startsWith("editMessage") &&
      /message is not modified/i.test(data.description ?? "")
    )
      return { not_modified: true };
    if (!res.ok || data.ok !== true)
      throw new TelegramApiError(
        Number(data.error_code) || res.status,
        Math.min(3600, Math.max(1, Number(data.parameters?.retry_after) || 5)),
      );
    return data.result;
  } catch (e) {
    if (e instanceof TelegramApiError) throw e;
    // Not an answer from Telegram: keep the retry semantics of a 503, but say what actually happened.
    throw new TelegramApiError(503, 5, networkCode(e));
  }
}
export function validWebhookSecret(value: unknown) {
  const secret = config.telegram.webhookSecret;
  if (!secret || typeof value !== "string") return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(secret), digest(value));
}
export const textLimit = (s: unknown, n = 1000) =>
  Array.from(String(s ?? ""))
    .slice(0, n)
    .join("");

/** Only compact questions/titles are sent; fenced code and recognizable secrets stay on-platform. */
export function safeTelegramText(value: unknown) {
  let text = redactContextText(String(value ?? "")).replace(
    /```[\s\S]*?(?:```|$)/g,
    "[Code available in platform]",
  );
  if (config.telegram.botToken) text = text.split(config.telegram.botToken).join("[redacted]");
  return text;
}
