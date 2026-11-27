import { copilotConfig } from "../../../config.ts";
import { redactSecrets } from "../../../integrations/redact.ts";
import { activityLabel, type CompletionStreamListener } from "../../completionStream.ts";
import { completionFailure } from "../../completionFailure.ts";
import {
  mergeReportedTokens,
  reportedTelemetry,
  type ProviderTelemetry,
} from "../../reportedTelemetry.ts";
import { superviseSpawn } from "../../process/supervisor.ts";
import {
  buildCopilotArgs,
  MAX_RESPONSE_CHARS,
  shouldUseStdinPrompt,
  writeCopilotStdinPrompt,
} from "./args.ts";
import { copilotCapabilities, copilotEnv } from "./capabilities.ts";
import { CopilotStream, classifyCopilotError, type CopilotEvent } from "./stream.ts";

/** One-shot headless auxiliary completion (Phase 10). */
export async function copilotComplete(
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
  const cfg = copilotConfig();
  if (opts?.signal?.aborted) throw new Error("Copilot auxiliary completion canceled");
  const cap = await copilotCapabilities(false, {
    model: opts?.model ?? cfg.model,
    effort: opts?.effort ?? cfg.effort,
  });
  if (!cap.ok) {
    const detail = cap.error || "Copilot CLI is not available on this worker";
    throw completionFailure(detail, classifyCopilotError(detail));
  }
  opts?.signal?.throwIfAborted();

  const useStdin = shouldUseStdinPrompt(prompt);
  const args = buildCopilotArgs({
    prompt: useStdin ? undefined : prompt,
    useStdinPrompt: useStdin,
    model: (opts?.model ?? cfg.model) || undefined,
    effort: (opts?.effort ?? cfg.effort) || undefined,
    conversationId: (opts?.session?.keep && opts.session.resume) || undefined,
    allowTools: false,
  });

  const env = copilotEnv(process.env);
  const timeoutMs = opts?.timeoutMs ?? cfg.timeoutMs;
  const proc = await superviseSpawn({
    command: cfg.bin,
    args,
    cwd: process.cwd(),
    env,
    stdin: useStdin ? "pipe" : "ignore",
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
  const apiModels = new Set<string>();
  let toolUses = 0;
  let modelTurns: number | null = null;
  let apiDurationMs: number | null = null;
  const parser = new CopilotStream();

  const observe = (ev: CopilotEvent) => {
    const before = text;
    if (ev.model) model = ev.model;
    if (ev.error) lastError = ev.error;
    if (ev.conversationId) conversationId = ev.conversationId;
    if (ev.type === "session.auto_mode_resolved" && ev.model) sessionModel = ev.model;
    else if (ev.type === "session.model_change" && ev.model && ev.model !== "auto")
      sessionModel ??= ev.model;
    if ((ev.type === "assistant.message" || ev.type === "model.call_start") && ev.model)
      apiModels.add(ev.model);
    if (ev.tool) toolUses++;
    if (ev.turns != null) modelTurns = ev.turns;
    if (ev.durationMs != null) apiDurationMs = ev.durationMs;
    if (ev.type === "result") {
      if (ev.text != null) text = ev.text.slice(0, MAX_RESPONSE_CHARS);
    } else if (ev.type === "assistant.message" && ev.text) {
      text = ev.text.slice(0, MAX_RESPONSE_CHARS);
    } else if (ev.text && text.length < MAX_RESPONSE_CHARS)
      text += ev.text.slice(0, MAX_RESPONSE_CHARS - text.length);
    if (ev.tokens) {
      tokens = mergeReportedTokens(tokens, {
        input: ev.tokens.input,
        output: ev.tokens.output,
        reasoning_output: ev.tokens.reasoning,
        cache_read: ev.tokens.cache_read,
        cache_creation: ev.tokens.cache_creation,
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
  const writePromise = useStdin
    ? writeCopilotStdinPrompt(child, prompt, opts?.signal).catch((error) => {
        if (!opts?.signal?.aborted) onAbort();
        return error as Error;
      })
    : Promise.resolve(undefined);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  const inputError = await writePromise;

  opts?.signal?.removeEventListener("abort", onAbort);
  const timedOut = (await proc.done).outcome === "timeout";

  for (const ev of parser.flush().events) observe(ev);

  if (opts?.signal?.aborted) throw new Error("Copilot auxiliary completion canceled");
  if (timedOut)
    throw completionFailure(
      `Copilot auxiliary completion timed out after ${Math.round(timeoutMs / 1000)}s`,
      "EXECUTION_TIMEOUT",
    );
  if (inputError)
    throw completionFailure(`Copilot prompt delivery failed: ${inputError.message}`, "AGENT_ERROR");
  if (exitCode !== 0) {
    const detail =
      redactSecrets(lastError || stderr.trim()) ||
      `Copilot auxiliary completion failed with exit code ${exitCode}`;
    throw completionFailure(detail, classifyCopilotError(detail));
  }

  return {
    text: text.trim(),
    model: model || undefined,
    tokens,
    ...(opts?.session?.keep ? { session_id: conversationId ?? null } : {}),
    telemetry: reportedTelemetry({
      session_model: sessionModel,
      api_models: [...apiModels].sort(),
      model_turns: modelTurns,
      provider_tool_uses: toolUses,
      provider_duration_ms: apiDurationMs,
      reasoning_tokens: (tokens as Record<string, number | null> | null)?.reasoning_output ?? null,
    }),
  };
}
