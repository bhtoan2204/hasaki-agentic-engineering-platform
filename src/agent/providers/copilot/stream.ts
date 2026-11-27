import { StringDecoder } from "node:string_decoder";
import { classifyCliError } from "../../harness/failure.ts";

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
  /** Model requests the CLI counted for the session (from its usage accounting), not a guess. */
  turns?: number;
  /** Time the CLI spent in model API calls, when it reports it. */
  durationMs?: number;
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

function parseCopilotLine(line: string): { event: CopilotEvent } | { error: CopilotParseError } {
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

  // Copilot CLI 1.0+ JSONL: { type, data, ... }
  if (typeof rawObj.type === "string" && rawObj.data && typeof rawObj.data === "object") {
    return { event: parseModernEvent(rawObj) };
  }
  // Terminal result line often has type:result without nested data wrapper fields we need.
  if (rawObj.type === "result") {
    return { event: parseModernResult(rawObj) };
  }

  // Legacy stream-json protocol (fake CLI / older builds): { event, ... }
  return { event: parseLegacyEvent(rawObj) };
}

function parseModernEvent(rawObj: RawRecord): CopilotEvent {
  const type = String(rawObj.type);
  const data = (rawObj.data ?? {}) as RawRecord;

  let text: string | undefined;
  let thinking: string | undefined;
  let model: string | undefined;
  let conversationId: string | undefined;
  let tool: string | undefined;
  let toolArgs: unknown;
  let tokens: CopilotTokens | undefined;
  let turns: number | undefined;
  let error: string | undefined;
  let status: string | undefined;
  let cumulativeUsage = false;
  let reasoningTokens: number | null = null;

  if (type === "session.start") {
    conversationId = str(data.sessionId);
  } else if (type === "session.model_change") {
    model = str(data.newModel);
  } else if (type === "session.auto_mode_resolved") {
    model = str(data.chosenModel);
  } else if (type === "model.call_start" || type === "session.tools_updated") {
    model = str(data.model);
  } else if (type === "assistant.message_delta") {
    // Preserve whitespace — deltas are often a single trailing space between tokens.
    text = textRaw(data.deltaContent);
  } else if (type === "assistant.message") {
    text = textRaw(data.content);
    model = str(data.model) ?? model;
  } else if (type === "assistant.reasoning_delta") {
    thinking = textRaw(data.deltaContent);
  } else if (type === "tool.execution_start" || type === "tool_call" || type === "tool.started") {
    tool = str(data.toolName ?? data.name ?? data.tool);
    toolArgs = data.arguments ?? data.args ?? data.toolArgs;
  } else if (type === "session.error" || type === "error") {
    error = str(data.message ?? data.error) ?? JSON.stringify(data);
    status = "ERROR";
  } else if (type === "session.usage_checkpoint") {
    tokens = tokensFromUsage(data);
    cumulativeUsage = true;
    const snap = data.accountingSnapshot as RawRecord | undefined;
    if (snap) {
      const byModel = Object.values((snap.modelMetrics ?? {}) as Record<string, RawRecord>);
      const sum = (pick: (m: RawRecord) => unknown) => {
        const values = byModel.map((m) => num(pick(m))).filter((v): v is number => v !== null);
        return values.length ? values.reduce((a, b) => a + b, 0) : null;
      };
      turns = sum((m) => (m.requests as RawRecord | undefined)?.count) ?? undefined;
      reasoningTokens = sum((m) => (m.usage as RawRecord | undefined)?.reasoningTokens);
      const td = snap.tokenDetails as RawRecord | undefined;
      if (td) {
        tokens = {
          input: num((td.input as RawRecord | undefined)?.tokenCount),
          output: num((td.output as RawRecord | undefined)?.tokenCount),
          cache_read: num((td.cache_read as RawRecord | undefined)?.tokenCount),
          cache_creation: num((td.cache_write as RawRecord | undefined)?.tokenCount),
          reasoning: reasoningTokens,
        };
      }
      model = str(snap.currentModel) ?? model;
    }
  }

  return {
    type,
    text,
    thinking,
    conversationId,
    model,
    tokens,
    cumulativeUsage,
    status,
    turns,
    tool,
    toolArgs,
    error,
    raw: rawObj,
  };
}

function parseModernResult(rawObj: RawRecord): CopilotEvent {
  const usage = rawObj.usage as RawRecord | undefined;
  return {
    type: "result",
    conversationId: str(rawObj.sessionId),
    status: rawObj.exitCode === 0 ? "SUCCESS" : "ERROR",
    cumulativeUsage: true,
    durationMs: num(usage?.totalApiDurationMs) ?? undefined,
    tokens: usage ? tokensFromUsage({ usage }) : undefined,
    error: rawObj.exitCode === 0 ? undefined : `copilot exited with code ${rawObj.exitCode}`,
    raw: rawObj,
  };
}

function parseLegacyEvent(rawObj: RawRecord): CopilotEvent {
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

  let text: string | undefined;
  let thinking: string | undefined;

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
  else if (typeof (rawObj as { thought?: unknown }).thought === "string")
    thinking = String((rawObj as { thought: string }).thought);

  const conversationId =
    payload.conversationId ??
    payload.conversation_id ??
    rawObj.conversationId ??
    rawObj.conversation_id ??
    rawObj.sessionId ??
    rawObj.session_id;

  let tokens: CopilotTokens | undefined;
  const rawMetrics = rawObj.metrics as RawRecord | undefined;
  const usage = (payload.usage ??
    rawObj.usage ??
    rawMetrics?.tokens ??
    rawObj.tokens ??
    (rawObj.type === "tokens" || rawObj.input != null ? rawObj : null)) as RawRecord | undefined;
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
  const rawErrorMsg =
    typeof rawError === "object" && rawError !== null && typeof rawError.message === "string"
      ? rawError.message
      : undefined;
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
    type,
    text,
    thinking,
    conversationId: typeof conversationId === "string" ? conversationId : undefined,
    model:
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : typeof rawObj.model === "string" && rawObj.model.trim()
          ? rawObj.model.trim()
          : undefined,
    tokens,
    cumulativeUsage: protocolEvent === "result",
    status: typeof payload.status === "string" ? payload.status : undefined,
    turns: num(payload.num_turns) ?? undefined,
    tool: (payloadToolInfo?.name ??
      payloadToolInfo?.tool_name ??
      rawToolCall?.name ??
      rawObj.tool ??
      rawObj.name ??
      undefined) as string | undefined,
    toolArgs: (payloadToolInfo?.parameters ??
      rawToolCall?.args ??
      rawObj.args ??
      rawObj.arguments ??
      undefined) as Record<string, unknown> | undefined,
    toolResult: payload.tool_info ?? rawObj.result ?? rawObj.toolResult ?? undefined,
    error,
    raw: rawObj,
  };
}

function tokensFromUsage(data: RawRecord): CopilotTokens | undefined {
  const usage = data.usage as RawRecord | undefined;
  if (!usage) return undefined;
  const tokens = {
    input: num(usage.input_tokens ?? usage.input),
    output: num(usage.output_tokens ?? usage.output),
    reasoning: num(usage.reasoning_tokens ?? usage.reasoning),
    cache_read: num(usage.cache_read_tokens ?? usage.cache_read),
    cache_creation: num(usage.cache_write_tokens ?? usage.cache_creation),
  };
  return Object.values(tokens).some((v) => v !== null) ? tokens : undefined;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Like str(), but keeps leading/trailing whitespace used by streaming deltas. */
const textRaw = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export const classifyCopilotError = classifyCliError;
