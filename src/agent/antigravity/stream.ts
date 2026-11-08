import { StringDecoder } from "node:string_decoder";
import {
  normalizeProviderFailure,
  type FailureCategory,
} from "../telemetry.ts";

export interface AntigravityTokens {
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cache_read?: number | null;
}

export interface AntigravityEvent {
  type: string;
  text?: string;
  thinking?: string;
  tool?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  conversationId?: string;
  tokens?: AntigravityTokens;
  error?: string;
  raw: unknown;
}

export interface AntigravityParseError {
  line: string;
  error: string;
}

export class AntigravityStream {
  private decoder = new StringDecoder("utf8");
  private buf = "";

  push(chunk: Buffer | string): {
    events: AntigravityEvent[];
    errors: AntigravityParseError[];
  } {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  flush(): { events: AntigravityEvent[]; errors: AntigravityParseError[] } {
    this.buf += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): {
    events: AntigravityEvent[];
    errors: AntigravityParseError[];
  } {
    const events: AntigravityEvent[] = [];
    const errors: AntigravityParseError[] = [];

    const take = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const r = parseAntigravityLine(trimmed);
      if ("event" in r) events.push(r.event);
      else errors.push(r.error);
    };

    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      take(this.buf.slice(0, nl).replace(/\r$/, ""));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }

    if (final && this.buf.trim()) {
      take(this.buf);
      this.buf = "";
    }

    return { events, errors };
  }
}

function parseAntigravityLine(
  line: string,
): { event: AntigravityEvent } | { error: AntigravityParseError } {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return {
      error: { line: line.slice(0, 500), error: (e as Error).message },
    };
  }

  if (!raw || typeof raw !== "object") {
    return { error: { line: line.slice(0, 500), error: "event has no type" } };
  }

  const type = String(raw.type ?? raw.event_type ?? raw.kind ?? "message");
  let text: string | undefined = undefined;
  let thinking: string | undefined = undefined;

  if (typeof raw.text === "string") text = raw.text;
  else if (typeof raw.content === "string") text = raw.content;
  else if (typeof raw.delta?.text === "string") text = raw.delta.text;
  else if (typeof raw.message?.content === "string") text = raw.message.content;
  else if (Array.isArray(raw.message?.content)) {
    const parts = raw.message.content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (parts.length) text = parts.join("");
  }

  if (typeof raw.thinking === "string") thinking = raw.thinking;
  else if (typeof raw.delta?.thinking === "string")
    thinking = raw.delta.thinking;

  const conversationId =
    raw.conversationId ??
    raw.conversation_id ??
    raw.sessionId ??
    raw.session_id;

  // Extract usage / tokens
  let tokens: AntigravityTokens | undefined = undefined;
  const usage =
    raw.usage ??
    raw.metrics?.tokens ??
    raw.tokens ??
    (raw.type === "tokens" || raw.input != null ? raw : null);
  if (usage && typeof usage === "object") {
    tokens = {
      input: num(usage.input_tokens ?? usage.input ?? usage.prompt_tokens),
      output: num(
        usage.output_tokens ?? usage.output ?? usage.completion_tokens,
      ),
      reasoning: num(
        usage.thinking_output_tokens ??
          usage.reasoning_tokens ??
          usage.thinking_tokens ??
          usage.reasoning,
      ),
      cache_read: num(
        usage.cache_read_tokens ?? usage.cached_tokens ?? usage.cache_read,
      ),
    };
  }

  const error = raw.error
    ? typeof raw.error === "string"
      ? raw.error
      : raw.error.message
        ? String(raw.error.message)
        : JSON.stringify(raw.error)
    : undefined;

  return {
    event: {
      type,
      text,
      thinking,
      conversationId:
        typeof conversationId === "string" ? conversationId : undefined,
      tokens,
      tool: raw.toolCall?.name ?? raw.tool_call?.name ?? raw.tool ?? undefined,
      toolArgs:
        raw.toolCall?.args ?? raw.tool_call?.args ?? raw.args ?? undefined,
      toolResult: raw.result ?? raw.toolResult ?? undefined,
      error,
      raw,
    },
  };
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function classifyAntigravityError(err: unknown): FailureCategory {
  const text = String(
    (err as any)?.message ??
      (err as any)?.error?.message ??
      (err as any)?.error ??
      err ??
      "",
  ).toLowerCase();
  if (/quota|resource has been exhausted|rate_limit|too many requests|429/.test(text)) {
    if (/quota|credit|billing|exhausted/.test(text)) return "QUOTA_EXHAUSTED";
    return "RATE_LIMIT";
  }
  if (/login|auth|unauthorized|credential|token/.test(text)) return "AUTHENTICATION";
  if (/timeout|timed out/.test(text)) return "EXECUTION_TIMEOUT";
  if (/cancel|abort/.test(text)) return "CANCELED";
  return normalizeProviderFailure(err);
}
