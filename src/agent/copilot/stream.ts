import { StringDecoder } from "node:string_decoder";
import { classifyCliError } from "../harness/failure.ts";

export interface CopilotTokens {
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cache_read?: number | null;
  cache_creation?: number | null;
}

export interface CopilotEvent {
  type: string;
  text?: string;
  thinking?: string;
  tool?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  conversationId?: string;
  model?: string;
  tokens?: CopilotTokens;
  /** Terminal result.usage is cumulative for the whole CLI session. */
  cumulativeUsage?: boolean;
  status?: string;
  turns?: number;
  error?: string;
  raw: unknown;
}

export interface CopilotParseError {
  line: string;
  error: string;
}

export class CopilotStream {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  private readonly maxLineBytes = 16 * 1024 * 1024;

  push(chunk: Buffer | string): {
    events: CopilotEvent[];
    errors: CopilotParseError[];
  } {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  flush(): { events: CopilotEvent[]; errors: CopilotParseError[] } {
    this.buf += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): {
    events: CopilotEvent[];
    errors: CopilotParseError[];
  } {
    const events: CopilotEvent[] = [];
    const errors: CopilotParseError[] = [];

    const take = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const r = parseCopilotLine(trimmed);
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

type RawRecord = Record<string, unknown>;

function parseCopilotLine(
  line: string,
): { event: CopilotEvent } | { error: CopilotParseError } {
  let raw: unknown;
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
  const rawObj = raw as RawRecord;

  const protocolEvent = typeof rawObj.event === "string" ? rawObj.event : "";
  const payload = (
    protocolEvent === "step_update"
      ? (rawObj.step_update ?? {})
      : protocolEvent === "result"
        ? (rawObj.result ?? {})
        : protocolEvent === "init"
          ? (rawObj.init ?? rawObj)
          : rawObj
  ) as RawRecord;
  const type =
    protocolEvent === "step_update"
      ? `step_update.${String(payload.step_type ?? "unknown")}`
      : protocolEvent || String(rawObj.type ?? rawObj.event_type ?? rawObj.kind ?? "message");
  let text: string | undefined = undefined;
  let thinking: string | undefined = undefined;

  const rawDelta = rawObj.delta as RawRecord | undefined;
  const rawMsg = rawObj.message as RawRecord | undefined;

  if (typeof payload.text_delta === "string") text = payload.text_delta;
  else if (typeof payload.response === "string") text = payload.response;
  else if (typeof payload.text === "string") text = payload.text;
  else if (typeof rawObj.text === "string") text = rawObj.text;
  else if (typeof rawObj.content === "string") text = rawObj.content;
  else if (typeof rawDelta?.text === "string") text = rawDelta.text;
  else if (typeof rawMsg?.content === "string") text = rawMsg.content;
  else if (Array.isArray(rawMsg?.content)) {
    const parts = (rawMsg.content as unknown[])
      .filter((c): c is { type: string; text: string } => {
        const item = c as { type?: unknown; text?: unknown } | null;
        return Boolean(item && item.type === "text" && typeof item.text === "string");
      })
      .map((c) => c.text);
    if (parts.length) text = parts.join("");
  }

  if (typeof payload.thinking === "string") thinking = payload.thinking;
  else if (typeof rawObj.thinking === "string") thinking = rawObj.thinking;
  else if (typeof rawDelta?.thinking === "string") thinking = rawDelta.thinking;

  const conversationId =
    payload.conversationId ??
    payload.conversation_id ??
    rawObj.conversationId ??
    rawObj.conversation_id ??
    rawObj.sessionId ??
    rawObj.session_id;

  // Extract usage / tokens
  let tokens: CopilotTokens | undefined = undefined;
  const rawMetrics = rawObj.metrics as RawRecord | undefined;
  const usage = (
    payload.usage ??
    rawObj.usage ??
    rawMetrics?.tokens ??
    rawObj.tokens ??
    (rawObj.type === "tokens" || rawObj.input != null ? rawObj : null)
  ) as RawRecord | undefined;
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

  const rawError = (payload.error ?? rawObj.error) as RawRecord | string | undefined;
  const rawErrorMsg = typeof rawError === "object" && rawError !== null && typeof rawError.message === "string" ? rawError.message : undefined;
  const error =
    protocolEvent === "result" && payload.status === "ERROR"
      ? typeof rawError === "string"
        ? rawError
        : String(rawErrorMsg ?? "Copilot returned ERROR")
      : rawError
        ? typeof rawError === "string"
          ? rawError
          : rawErrorMsg
            ? String(rawErrorMsg)
            : JSON.stringify(rawError)
        : undefined;

  const payloadToolInfo = payload.tool_info as RawRecord | undefined;
  const rawToolCall = (rawObj.toolCall ?? rawObj.tool_call) as RawRecord | undefined;

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
      tool: (
        payloadToolInfo?.name ??
        payloadToolInfo?.tool_name ??
        rawToolCall?.name ??
        rawObj.tool ??
        undefined
      ) as string | undefined,
      toolArgs: (
        payloadToolInfo?.parameters ??
        rawToolCall?.args ??
        rawObj.args ??
        undefined
      ) as Record<string, unknown> | undefined,
      toolResult: payload.tool_info ?? rawObj.result ?? rawObj.toolResult ?? undefined,
      error,
      raw: rawObj,
    },
  };
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export const classifyCopilotError = classifyCliError;
