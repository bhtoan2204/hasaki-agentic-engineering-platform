import { antigravityConfig } from "../../../config.ts";
import { redactSecrets } from "../../../integrations/redact.ts";
import { activityLabel, type CompletionStreamListener } from "../../completionStream.ts";
import { superviseSpawn } from "../../process/supervisor.ts";
import { buildAntigravityArgs, MAX_RESPONSE_CHARS, writeAntigravityPrompt } from "./args.ts";
import { antigravityCapabilities, antigravityEnv } from "./capabilities.ts";
import { AntigravityStream } from "./stream.ts";

/** One-shot headless auxiliary completion (Phase 10). */
export async function antigravityComplete(
  prompt: string,
  opts?: {
    signal?: AbortSignal;
    model?: string;
    effort?: string;
    timeoutMs?: number;
    onStream?: CompletionStreamListener;
  },
): Promise<{
  text: string;
  model?: string;
  tokens: Record<string, number | null> | null;
}> {
  const cfg = antigravityConfig();
  if (opts?.signal?.aborted) throw new Error("Antigravity auxiliary completion canceled");
  const cap = await antigravityCapabilities(false, {
    model: opts?.model ?? cfg.model,
    effort: opts?.effort ?? cfg.effort,
  });
  if (!cap.ok) {
    throw new Error(cap.error || "Antigravity CLI is not available on this worker");
  }
  opts?.signal?.throwIfAborted();

  const args = buildAntigravityArgs({
    model: (opts?.model ?? cfg.model) || undefined,
    effort: (opts?.effort ?? cfg.effort) || undefined,
    sandbox: false,
  });

  const env = antigravityEnv(process.env);
  const proc = await superviseSpawn({
    command: cfg.bin,
    args,
    cwd: process.cwd(),
    env,
    class: "agent",
    graceMs: 5000,
  });
  const child = proc.child;

  const onAbort = () => proc.stop();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = opts?.timeoutMs ?? cfg.timeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    onAbort();
  }, timeoutMs);

  let text = "";
  let started = false;
  let model = opts?.model ?? cfg.model;
  let stderr = "";
  let tokens: Record<string, number | null> | null = null;
  const parser = new AntigravityStream();

  child.stdout?.on("data", (chunk: Buffer) => {
    const { events } = parser.push(chunk);
    for (const ev of events) {
      const before = text;
      if (ev.model) model = ev.model;
      if (ev.type === "result") {
        if (ev.text != null) text = ev.text.slice(0, MAX_RESPONSE_CHARS);
      } else if (ev.text && text.length < MAX_RESPONSE_CHARS)
        text += ev.text.slice(0, MAX_RESPONSE_CHARS - text.length);
      if (ev.tokens) {
        tokens = {
          input: ev.tokens.input ?? null,
          output: ev.tokens.output ?? null,
          reasoning_output: ev.tokens.reasoning ?? null,
          cache_read: ev.tokens.cache_read ?? null,
        };
      }
      const stream = opts?.onStream;
      if (stream) {
        if (!started) stream({ type: "started" });
        if (ev.thinking) stream({ type: "reasoning", delta: ev.thinking });
        if (ev.tool) stream({ type: "activity", label: activityLabel("tool", ev.tool) });
        if (text !== before) stream({ type: "text", text });
      }
      started = true;
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16000);
  });

  child.once("error", () => {});
  const writePromise = writeAntigravityPrompt(child, prompt, opts?.signal).catch((error) => {
    if (!opts?.signal?.aborted && !timedOut) onAbort();
    return error as Error;
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  const inputError = await writePromise;
  clearTimeout(timer);

  opts?.signal?.removeEventListener("abort", onAbort);
  await proc.done;

  const tail = parser.flush();
  for (const ev of tail.events) {
    if (ev.model) model = ev.model;
    if (ev.type === "result") {
      if (ev.text != null) text = ev.text.slice(0, MAX_RESPONSE_CHARS);
    } else if (ev.text && text.length < MAX_RESPONSE_CHARS)
      text += ev.text.slice(0, MAX_RESPONSE_CHARS - text.length);
  }

  if (opts?.signal?.aborted) throw new Error("Antigravity auxiliary completion canceled");
  if (timedOut) throw new Error("Antigravity auxiliary completion timed out");
  if (inputError) throw new Error(`Antigravity prompt delivery failed: ${inputError.message}`);
  if (exitCode !== 0) {
    throw new Error(
      redactSecrets(stderr.trim()) ||
        `Antigravity auxiliary completion failed with exit code ${exitCode}`,
    );
  }

  return { text: text.trim(), model: model || undefined, tokens };
}
