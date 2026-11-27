import { antigravityConfig } from "../../../config.ts";
import { redactSecrets } from "../../../integrations/redact.ts";
import { activityLabel, type CompletionStreamListener } from "../../completionStream.ts";
import { completionFailure } from "../../completionFailure.ts";
import {
  mergeReportedTokens,
  reportedTelemetry,
  type ProviderTelemetry,
} from "../../reportedTelemetry.ts";
import { superviseSpawn } from "../../process/supervisor.ts";
import { buildAntigravityArgs, MAX_RESPONSE_CHARS, writeAntigravityPrompt } from "./args.ts";
import { antigravityCapabilities, antigravityEnv } from "./capabilities.ts";
import { AntigravityStream, classifyAntigravityError, type AntigravityEvent } from "./stream.ts";

/** One-shot headless auxiliary completion (Phase 10). */
export async function antigravityComplete(
  prompt: string,
  opts?: {
    signal?: AbortSignal;
    model?: string;
    effort?: string;
    timeoutMs?: number;
    onStream?: CompletionStreamListener;
    session?: { keep: boolean; resume?: string | null };
  },
): Promise<{
  text: string;
  model?: string;
  tokens: Record<string, number | null> | null;
  session_id?: string | null;
  telemetry: ProviderTelemetry;
}> {
  const cfg = antigravityConfig();
  if (opts?.signal?.aborted) throw new Error("Antigravity auxiliary completion canceled");
  const cap = await antigravityCapabilities(false, {
    model: opts?.model ?? cfg.model,
    effort: opts?.effort ?? cfg.effort,
  });
  if (!cap.ok) {
    const detail = cap.error || "Antigravity CLI is not available on this worker";
    throw completionFailure(detail, classifyAntigravityError(detail));
  }
  opts?.signal?.throwIfAborted();

  const args = buildAntigravityArgs({
    model: (opts?.model ?? cfg.model) || undefined,
    effort: (opts?.effort ?? cfg.effort) || undefined,
    sandbox: false,
    conversationId: (opts?.session?.keep && opts.session.resume) || undefined,
  });

  const env = antigravityEnv(process.env);
  const timeoutMs = opts?.timeoutMs ?? cfg.timeoutMs;
  const proc = await superviseSpawn({
    command: cfg.bin,
    args,
    cwd: process.cwd(),
    env,
    class: "agent",
    graceMs: 5000,
    timeoutMs,
  });
  const child = proc.child;

  const onAbort = () => proc.stop();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });

  let text = "";
  let started = false;
  let model = opts?.model ?? cfg.model;
  let stderr = "";
  let lastError: string | undefined;
  let tokens: Record<string, number | null> | null = null;
  let conversationId: string | undefined;
  let sessionModel: string | null = null;
  let toolUses = 0;
  let modelTurns: number | null = null;
  const parser = new AntigravityStream();

  const observe = (ev: AntigravityEvent) => {
    const before = text;
    if (ev.model) {
      model = ev.model;
      sessionModel ??= ev.model;
    }
    if (ev.error) lastError = ev.error;
    if (ev.conversationId) conversationId = ev.conversationId;
    if (ev.tool) toolUses++;
    if (ev.type === "result") {
      if (ev.turns != null) modelTurns = ev.turns;
      if (ev.text != null) text = ev.text.slice(0, MAX_RESPONSE_CHARS);
    } else if (ev.text && text.length < MAX_RESPONSE_CHARS)
      text += ev.text.slice(0, MAX_RESPONSE_CHARS - text.length);
    if (ev.tokens) {
      tokens = mergeReportedTokens(tokens, {
        input: ev.tokens.input,
        output: ev.tokens.output,
        reasoning_output: ev.tokens.reasoning,
        cache_read: ev.tokens.cache_read,
      });
    }
    const stream = opts?.onStream;
    if (stream) {
      if (!started) stream({ type: "started" });
      if (ev.thinking) stream({ type: "reasoning", delta: ev.thinking });
      if (ev.tool) stream({ type: "activity", label: activityLabel("tool", ev.tool) });
      if (text !== before) stream({ type: "text", text });
    }
    started = true;
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const ev of parser.push(chunk).events) observe(ev);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16000);
  });

  child.once("error", () => {});
  const writePromise = writeAntigravityPrompt(child, prompt, opts?.signal).catch((error) => {
    if (!opts?.signal?.aborted) onAbort();
    return error as Error;
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  const inputError = await writePromise;

  opts?.signal?.removeEventListener("abort", onAbort);
  const timedOut = (await proc.done).outcome === "timeout";

  for (const ev of parser.flush().events) observe(ev);

  if (opts?.signal?.aborted) throw new Error("Antigravity auxiliary completion canceled");
  if (timedOut)
    throw completionFailure(
      `Antigravity auxiliary completion timed out after ${Math.round(timeoutMs / 1000)}s`,
      "EXECUTION_TIMEOUT",
    );
  if (inputError)
    throw completionFailure(
      `Antigravity prompt delivery failed: ${inputError.message}`,
      "AGENT_ERROR",
    );
  if (exitCode !== 0) {
    const detail =
      redactSecrets(lastError || stderr.trim()) ||
      `Antigravity auxiliary completion failed with exit code ${exitCode}`;
    throw completionFailure(detail, classifyAntigravityError(detail));
  }

  return {
    text: text.trim(),
    model: model || undefined,
    tokens,
    ...(opts?.session?.keep ? { session_id: conversationId ?? null } : {}),
    telemetry: reportedTelemetry({
      session_model: sessionModel,
      model_turns: modelTurns,
      provider_tool_uses: toolUses,
      reasoning_tokens: (tokens as Record<string, number | null> | null)?.reasoning_output ?? null,
    }),
  };
}
