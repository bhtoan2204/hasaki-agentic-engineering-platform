import { marked, type MarkedToken, type Token } from "marked";
import { config } from "../config.ts";
import { pool, type Db } from "../db/pool.ts";
import { telegramUrl } from "../telegram.ts";
import { safeTelegramText } from "./client.ts";
import { preferences, type TelegramPreferences } from "./store.ts";

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

function renderMarkdown(tokens: Token[]): string {
  return (tokens as MarkedToken[])
    .map((token, index) => {
      switch (token.type) {
        case "heading":
          return "▍" + renderMarkdown(token.tokens) + "\n";
        case "paragraph":
        case "list_item":
          return renderMarkdown(token.tokens) + "\n";
        case "list": {
          const leadingBreak = tokens[index - 1]?.type === "text" ? "\n" : "";
          return (
            leadingBreak +
            token.items
              .map((item, index) => {
                const prefix = token.ordered ? `${Number(token.start) + index}. ` : "• ";
                return prefix + renderMarkdown(item.tokens).trimEnd().replaceAll("\n", "\n   ");
              })
              .join("\n") +
            "\n"
          );
        }
        case "table": {
          const headers = token.header.map((cell) => renderMarkdown(cell.tokens));
          return (
            token.rows
              .map((row) => {
                const [first, ...rest] = row.map((cell) => renderMarkdown(cell.tokens));
                if (headers.length <= 2) return `• ${first}${rest[0] ? ` — ${rest[0]}` : ""}`;
                return [
                  `• ${first}`,
                  ...rest.flatMap((value, index) =>
                    value ? [`   ${headers[index + 1] || "–"}: ${value}`] : [],
                  ),
                ].join("\n");
              })
              .join("\n") + "\n"
          );
        }
        case "blockquote":
          return renderMarkdown(token.tokens).trimEnd().replace(/^/gm, "│ ") + "\n";
        case "link": {
          const label = renderMarkdown(token.tokens);
          return /^https?:\/\//i.test(token.href) && label !== token.href
            ? `${label} (${token.href})`
            : label;
        }
        case "image":
        case "strong":
        case "em":
        case "del":
          return renderMarkdown(token.tokens);
        case "code":
          return "[Code available in platform]\n";
        case "checkbox":
          return token.checked ? "☑ " : "☐ ";
        case "text":
          return token.tokens ? renderMarkdown(token.tokens) : token.text;
        case "codespan":
          return token.raw.startsWith("```") ? "[Code available in platform]" : token.text;
        case "escape":
        case "html":
          return token.text;
        case "br":
        case "hr":
          return "\n";
        default:
          return token.raw;
      }
    })
    .join("");
}

/** Render Markdown for a plain Telegram message and redact the resulting visible text. */
export function telegramAnswer(markdown: string) {
  return safeTelegramText(renderMarkdown(marked.lexer(markdown)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
