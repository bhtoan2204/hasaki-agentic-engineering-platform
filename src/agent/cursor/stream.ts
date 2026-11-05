/**
 * Incremental parser for Cursor CLI `--output-format stream-json` (NDJSON).
 * Documented at https://cursor.com/docs/cli/reference/output-format (CLI 2026.11.05).
 * Unknown fields are ignored. A partial trailing line is kept until the next chunk or flush.
 */

export interface CursorEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  text?: string;
  /** Present on streaming deltas; absent on the final duplicate flush. */
  timestamp_ms?: number;
  /** Present only on the buffered duplicate flushed before a tool call. */
  model_call_id?: string;
  call_id?: string;
  tool_call?: Record<string, unknown>;
  is_error?: boolean;
  duration_ms?: number;
  result?: string;
  raw: unknown;
}

export interface ParseError {
  type: "malformed";
  line: string;
  error: string;
}

export class NdjsonStream {
  private buf = "";
  push(chunk: string): { events: CursorEvent[]; errors: ParseError[] } {
    this.buf += chunk;
    const events: CursorEvent[] = [];
    const errors: ParseError[] = [];
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) {
        const parsed = parseLine(line);
        if (parsed.ok) events.push(parsed.event);
        else errors.push(parsed.error);
      }
      nl = this.buf.indexOf("\n");
    }
    return { events, errors };
  }
  /** End of stdout. A trailing fragment without a newline is still one event, or a malformed line. */
  flush(): { events: CursorEvent[]; errors: ParseError[] } {
    const rest = this.buf;
    this.buf = "";
    if (!rest.trim()) return { events: [], errors: [] };
    const parsed = parseLine(rest.trim());
    return parsed.ok ? { events: [parsed.event], errors: [] } : { events: [], errors: [parsed.error] };
  }
}

function parseLine(line: string): { ok: true; event: CursorEvent } | { ok: false; error: ParseError } {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return { ok: false, error: { type: "malformed", line: line.slice(0, 500), error: (e as Error).message } };
  }
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string")
    return { ok: false, error: { type: "malformed", line: line.slice(0, 500), error: "event has no type" } };
  const text = assistantText(raw);
  return {
    ok: true,
    event: {
      type: raw.type,
      subtype: typeof raw.subtype === "string" ? raw.subtype : undefined,
      session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
      model: typeof raw.model === "string" ? raw.model : undefined,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      text,
      timestamp_ms: typeof raw.timestamp_ms === "number" ? raw.timestamp_ms : undefined,
      model_call_id: typeof raw.model_call_id === "string" ? raw.model_call_id : undefined,
      call_id: typeof raw.call_id === "string" ? raw.call_id : undefined,
      tool_call: raw.tool_call && typeof raw.tool_call === "object" ? raw.tool_call : undefined,
      is_error: typeof raw.is_error === "boolean" ? raw.is_error : undefined,
      duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
      result: typeof raw.result === "string" ? raw.result : undefined,
      raw,
    },
  };
}

function assistantText(raw: any): string | undefined {
  const content = raw.message?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text);
  return parts.length ? parts.join("") : undefined;
}

/**
 * With --stream-partial-output the CLI repeats assistant text. Only the delta
 * (timestamp_ms set, model_call_id absent) is new. Other assistant events are duplicates.
 * Without partial streaming, assistant events have neither field and are the full message.
 */
export function isDuplicateAssistant(ev: CursorEvent, partial: boolean): boolean {
  if (ev.type !== "assistant" || !partial) return false;
  if (ev.model_call_id) return true;
  if (ev.timestamp_ms == null) return true;
  return false;
}

/** First key of a tool_call object, e.g. readToolCall → { name: "read", body }. */
export function toolCallShape(toolCall: Record<string, unknown> | undefined): { name: string; body: any } | null {
  if (!toolCall) return null;
  if (toolCall.function && typeof toolCall.function === "object") {
    const fn = toolCall.function as { name?: string; arguments?: unknown };
    return { name: String(fn.name ?? "function"), body: { args: fn.arguments } };
  }
  const key = Object.keys(toolCall)[0];
  if (!key) return null;
  const base = key.replace(/ToolCall$/, "");
  const name = base.charAt(0).toLowerCase() + base.slice(1);
  return { name, body: toolCall[key] };
}
