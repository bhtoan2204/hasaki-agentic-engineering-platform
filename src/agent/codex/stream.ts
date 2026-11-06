/**
 * Incremental parser for `codex exec --json` (JSON Lines on stdout).
 *
 * Event types documented for the CLI (learn.chatgpt.com/docs/non-interactive-mode) and observed on codex-cli 0.164:
 *   thread.started {thread_id} · turn.started · item.started|item.updated|item.completed {item} ·
 *   turn.completed {usage} · turn.failed {error} · error {message}
 * Items: agent_message {text} · reasoning {text} · command_execution {command, aggregated_output, exit_code, status} ·
 *   file_change {changes[{path, kind}], status} · mcp_tool_call {server, tool, arguments, result, error, status} ·
 *   web_search · todo_list · error {message}. Unknown types and fields are kept in `raw` and never fatal.
 *
 * Bytes are decoded with a streaming UTF-8 decoder, so a multi-byte character split across two stdout chunks is not
 * corrupted. A partial trailing line is kept until the next chunk or flush().
 */
import { StringDecoder } from "node:string_decoder";

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cache_write_input_tokens?: number;
}

export interface CodexItem {
  id: string;
  type: string;
  status?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  message?: string;
  raw: Record<string, unknown>;
}

export type CodexEvent =
  | { type: "thread.started"; thread_id: string; raw: unknown }
  | { type: "turn.started"; raw: unknown }
  | { type: "turn.completed"; usage: CodexUsage | null; raw: unknown }
  | { type: "turn.failed"; message: string; raw: unknown }
  | { type: "error"; message: string; raw: unknown }
  | { type: "item.started" | "item.updated" | "item.completed"; item: CodexItem; raw: unknown }
  | { type: "unknown"; name: string; raw: unknown };

export interface CodexParseError {
  line: string;
  error: string;
}

export class JsonlStream {
  private decoder = new StringDecoder("utf8");
  private buf = "";

  push(chunk: Buffer | string): { events: CodexEvent[]; errors: CodexParseError[] } {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  /** End of stdout: a trailing fragment without a newline is still one event, or a malformed line. */
  flush(): { events: CodexEvent[]; errors: CodexParseError[] } {
    this.buf += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean) {
    const events: CodexEvent[] = [];
    const errors: CodexParseError[] = [];
    const take = (line: string) => {
      if (!line.trim()) return;
      const r = parseCodexLine(line);
      if ("event" in r) events.push(r.event);
      else errors.push(r.error);
    };
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      take(this.buf.slice(0, nl).replace(/\r$/, ""));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
    if (final) {
      take(this.buf);
      this.buf = "";
    }
    return { events, errors };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function errorText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.message) ?? str(o.error) ?? JSON.stringify(o).slice(0, 1000);
  }
  return "";
}

export function parseCodexLine(line: string): { event: CodexEvent } | { error: CodexParseError } {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return { error: { line: line.slice(0, 500), error: (e as Error).message } };
  }
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return { error: { line: line.slice(0, 500), error: "event has no type" } };
  switch (raw.type) {
    case "thread.started":
      if (typeof raw.thread_id !== "string" || !raw.thread_id) return { error: { line: line.slice(0, 500), error: "thread.started without thread_id" } };
      return { event: { type: "thread.started", thread_id: raw.thread_id, raw } };
    case "turn.started":
      return { event: { type: "turn.started", raw } };
    case "turn.completed": {
      const u = raw.usage && typeof raw.usage === "object" ? raw.usage : null;
      const usage: CodexUsage | null = u
        ? {
          input_tokens: num(u.input_tokens),
          cached_input_tokens: num(u.cached_input_tokens),
          output_tokens: num(u.output_tokens),
          reasoning_output_tokens: num(u.reasoning_output_tokens),
          ...(typeof u.cache_write_input_tokens === "number" ? { cache_write_input_tokens: u.cache_write_input_tokens } : {}),
        }
        : null;
      return { event: { type: "turn.completed", usage, raw } };
    }
    case "turn.failed":
      return { event: { type: "turn.failed", message: errorText(raw.error) || "turn failed", raw } };
    case "error":
      return { event: { type: "error", message: errorText(raw.message ?? raw.error) || "error", raw } };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const it = raw.item;
      if (!it || typeof it !== "object" || typeof it.type !== "string") return { error: { line: line.slice(0, 500), error: `${raw.type} without item.type` } };
      const item: CodexItem = {
        id: String(it.id ?? ""),
        type: it.type,
        status: str(it.status),
        text: str(it.text),
        command: str(it.command),
        aggregated_output: str(it.aggregated_output),
        exit_code: typeof it.exit_code === "number" ? it.exit_code : it.exit_code === null ? null : undefined,
        changes: Array.isArray(it.changes) ? it.changes.filter((c: any) => c && typeof c.path === "string").map((c: any) => ({ path: c.path, kind: String(c.kind ?? "") })) : undefined,
        server: str(it.server),
        tool: str(it.tool),
        arguments: it.arguments,
        result: it.result,
        error: it.error,
        message: str(it.message),
        raw: it,
      };
      return { event: { type: raw.type, item, raw } };
    }
    default:
      return { event: { type: "unknown", name: raw.type, raw } };
  }
}

/** Why a Codex turn failed, from the error text the CLI printed. Drives retry and the message shown to the user. */
export type CodexFailureKind = "quota" | "auth" | "model" | "error";

export function classifyCodexError(text: string): CodexFailureKind {
  const t = text.toLowerCase();
  if (/usage limit|rate limit|quota|insufficient_quota|too many requests|\b429\b|purchase more credits|upgrade to (plus|pro)/.test(t)) return "quota";
  if (/not logged in|login required|unauthori[sz]ed|\b401\b|authentication|refresh token|token (has )?expired|please (re-?)?log ?in|codex login/.test(t)) return "auth";
  if (/model[^.\n]{0,80}(not supported|does not exist|not found|unsupported|not available|unknown)|unsupported model|invalid model|model_not_found|reasoning[^.\n]{0,40}(not supported|unsupported|invalid)/.test(t))
    return "model";
  return "error";
}

export function failureMessage(kind: CodexFailureKind, detail: string): string {
  const d = detail.trim().slice(0, 600);
  switch (kind) {
    case "quota":
      return `Codex usage limit reached for the worker's Codex account (${d}). The platform does not switch to an API key, another provider or another billing method. Retry after the limit resets, or start a new run with another provider.`;
    case "auth":
      return `Codex is not authenticated on this worker (${d}). Run \`codex login\` on the worker machine. The platform never reads or copies Codex credentials.`;
    case "model":
      return `The configured Codex model or reasoning effort is not available to the worker's Codex account (${d}). Check agent.codex.model / reasoningEffort against \`codex debug models\`.`;
    default:
      return d;
  }
}
