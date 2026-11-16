import { StringDecoder } from "node:string_decoder";
import { normalizeProviderFailure, type FailureCategory } from "../telemetry.ts";

export interface AntigravityTokens {
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cache_read?: number | null;
  cache_creation?: number | null;
}

export interface AntigravityEvent {
  type: string;
  text?: string;
  thinking?: string;
  tool?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  conversationId?: string;
  model?: string;
  tokens?: AntigravityTokens;
  /** Terminal result.usage is cumulative for the whole CLI session. */
  cumulativeUsage?: boolean;
  status?: string;
  turns?: number;
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
  private readonly maxLineBytes = 16 * 1024 * 1024;

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
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      if (Buffer.byteLength(line) > this.maxLineBytes)
        errors.push({ line: line.slice(0, 500), error: "NDJSON event exceeds the 16 MiB limit" });
      else take(line);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }

    if (Buffer.byteLength(this.buf) > this.maxLineBytes) {
      errors.push({ line: this.buf.slice(0, 500), error: "NDJSON event exceeds the 16 MiB limit" });
      this.buf = "";
    }

    if (final && this.buf.trim()) {
      take(this.buf);
      this.buf = "";
    }

    return { events, errors };
  }
}

/** Join streamed text until a line break or a word boundary, instead of one log row per token. */
export class TextBatch {
  private buf = "";

  push(delta: string, limit = 480): string | null {
    if (!delta) return null;
    this.buf += delta;
    const nl = this.buf.lastIndexOf("\n");
    if (nl >= 0) return this.take(nl + 1);
    if (this.buf.length >= limit) {
      const sp = this.buf.lastIndexOf(" ");
      return this.take(sp >= 80 ? sp + 1 : this.buf.length);
    }
    return null;
  }

  flush(): string {
    const rest = this.buf;
    this.buf = "";
    return rest;
  }

  private take(end: number): string {
    const done = this.buf.slice(0, end);
    this.buf = this.buf.slice(end);
    return done;
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

  const protocolEvent = typeof raw.event === "string" ? raw.event : "";
  const payload =
    protocolEvent === "step_update"
      ? (raw.step_update ?? {})
      : protocolEvent === "result"
        ? (raw.result ?? {})
        : protocolEvent === "init"
          ? (raw.init ?? raw)
          : raw;
  const type =
    protocolEvent === "step_update"
      ? `step_update.${String(payload.step_type ?? "unknown")}`
      : protocolEvent || String(raw.type ?? raw.event_type ?? raw.kind ?? "message");
  let text: string | undefined = undefined;
  let thinking: string | undefined = undefined;

  if (typeof payload.text_delta === "string") text = payload.text_delta;
  else if (typeof payload.response === "string") text = payload.response;
  else if (typeof payload.text === "string") text = payload.text;
  else if (typeof raw.text === "string") text = raw.text;
  else if (typeof raw.content === "string") text = raw.content;
  else if (typeof raw.delta?.text === "string") text = raw.delta.text;
  else if (typeof raw.message?.content === "string") text = raw.message.content;
  else if (Array.isArray(raw.message?.content)) {
    const parts = raw.message.content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (parts.length) text = parts.join("");
  }

  if (typeof payload.thinking === "string") thinking = payload.thinking;
  else if (typeof raw.thinking === "string") thinking = raw.thinking;
  else if (typeof raw.delta?.thinking === "string") thinking = raw.delta.thinking;

  const conversationId =
    payload.conversationId ??
    payload.conversation_id ??
    raw.conversationId ??
    raw.conversation_id ??
    raw.sessionId ??
    raw.session_id;

  // Extract usage / tokens
  let tokens: AntigravityTokens | undefined = undefined;
  const usage =
    payload.usage ??
    raw.usage ??
    raw.metrics?.tokens ??
    raw.tokens ??
    (raw.type === "tokens" || raw.input != null ? raw : null);
  if (usage && typeof usage === "object") {
    tokens = {
      input: num(usage.input_tokens ?? usage.input ?? usage.prompt_tokens),
      output: num(usage.output_tokens ?? usage.output ?? usage.completion_tokens),
      reasoning: num(
        usage.thinking_output_tokens ??
          usage.reasoning_tokens ??
          usage.thinking_tokens ??
          usage.reasoning,
      ),
      cache_read: num(usage.cache_read_tokens ?? usage.cached_tokens ?? usage.cache_read),
      cache_creation: num(usage.cache_creation_tokens ?? usage.cache_creation),
    };
  }

  const rawError = payload.error ?? raw.error;
  const error =
    protocolEvent === "result" && payload.status === "ERROR"
      ? typeof rawError === "string"
        ? rawError
        : String(rawError?.message ?? "Antigravity returned ERROR")
      : rawError
        ? typeof rawError === "string"
          ? rawError
          : rawError.message
            ? String(rawError.message)
            : JSON.stringify(rawError)
        : undefined;

  return {
    event: {
      type,
      text,
      thinking,
      conversationId: typeof conversationId === "string" ? conversationId : undefined,
      model:
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model.trim()
          : undefined,
      tokens,
      cumulativeUsage: protocolEvent === "result",
      status: typeof payload.status === "string" ? payload.status : undefined,
      turns: num(payload.num_turns) ?? undefined,
      tool:
        payload.tool_info?.name ??
        payload.tool_info?.tool_name ??
        raw.toolCall?.name ??
        raw.tool_call?.name ??
        raw.tool ??
        undefined,
      toolArgs:
        payload.tool_info?.parameters ??
        raw.toolCall?.args ??
        raw.tool_call?.args ??
        raw.args ??
        undefined,
      toolResult: payload.tool_info ?? raw.result ?? raw.toolResult ?? undefined,
      error,
      raw,
    },
  };
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function classifyAntigravityError(err: unknown): FailureCategory {
  const text = String(
    (err as any)?.message ?? (err as any)?.error?.message ?? (err as any)?.error ?? err ?? "",
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
