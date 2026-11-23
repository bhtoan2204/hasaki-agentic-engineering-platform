import { config } from "../config.ts";
import { pool, type Db } from "../db/pool.ts";
import { telegramUrl } from "../telegram.ts";
import { safeTelegramText } from "./client.ts";
import { preferences, type TelegramPreferences } from "./store.ts";

/** Telegram's sendMessage limit is 4096 characters; leave room for a part marker. */
export const TELEGRAM_TEXT_MAX = 3900;
/** At most this many parts of one answer are sent; the rest stays a link to the web conversation. */
export const MAX_PARTS = 4;

export type Locale = "vi" | "en";
export const tr = (locale: string, vi: string, en: string) => (locale === "en" ? en : vi);

export const conversationUrl = (id: number) =>
  telegramUrl(`${config.publicUrl.replace(/\/$/, "")}/#/chat/${id}`);
export const runUrl = (id: number) =>
  telegramUrl(`${config.publicUrl.replace(/\/$/, "")}/#/runs/${id}`);

/** Hour of day in the user's time zone. */
export function localHour(timezone: string, now = new Date()) {
  try {
    return (
      Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hour12: false })
          .format(now)
          .slice(0, 2),
      ) % 24
    );
  } catch {
    return now.getUTCHours();
  }
}
/** Quiet hours [start, end) in the user's zone; start > end wraps midnight (22 → 7). Equal or unset: none. */
export function inQuietHours(
  p: Pick<TelegramPreferences, "quiet_start" | "quiet_end" | "timezone">,
  now = new Date(),
) {
  if (p.quiet_start == null || p.quiet_end == null || p.quiet_start === p.quiet_end) return false;
  const h = localHour(p.timezone, now);
  return p.quiet_start < p.quiet_end
    ? h >= p.quiet_start && h < p.quiet_end
    : h >= p.quiet_start || h < p.quiet_end;
}
export async function quietNow(userId: number, db: Db = pool) {
  return inQuietHours(await preferences(userId, db));
}

const SEVERITY_RANK = { info: 0, important: 1, critical: 2 } as const;
export type Severity = keyof typeof SEVERITY_RANK;
const LEVEL_MIN = { all: 0, important: 1, critical: 2 } as const;
export const severityAllowed = (level: string, severity: Severity) =>
  SEVERITY_RANK[severity] >= (LEVEL_MIN[level as keyof typeof LEVEL_MIN] ?? 1);

/**
 * A chat answer as Telegram plain text: credentials redacted, code blocks replaced by a pointer to the web
 * conversation (private source stays on the platform), markdown emphasis and headings flattened.
 */
export function telegramAnswer(markdown: string) {
  return safeTelegramText(markdown)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split on paragraph, then line, then hard boundaries; never splits a surrogate pair. */
export function chunkText(text: string, max = TELEGRAM_TEXT_MAX): string[] {
  const chars = Array.from(text);
  if (chars.length <= max) return [text];
  const parts: string[] = [];
  let rest = chars;
  while (rest.length > max) {
    const window = rest.slice(0, max).join("");
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    const take = cut < max * 0.3 ? max : Array.from(window.slice(0, cut)).length;
    parts.push(rest.slice(0, take).join("").trimEnd());
    rest = rest.slice(take);
    while (rest[0] === "\n" || rest[0] === " ") rest = rest.slice(1);
  }
  if (rest.length) parts.push(rest.join(""));
  return parts;
}

export function elapsed(fromIso: string | Date | null | undefined, now = Date.now()) {
  if (!fromIso) return "—";
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const STATUS_ICON: Record<string, string> = {
  PENDING: "🕓",
  RUNNING: "▶️",
  WAITING: "⏸",
  PAUSED: "⏯",
  COMPLETED: "✅",
  FAILED: "❌",
  CANCELED: "⛔",
};
