import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../../config.ts";
import { activityLabel, type CompletionStreamListener } from "../../completionStream.ts";
import type { CompletionRunner } from "../../completionTypes.ts";
import { completionFailure } from "../../completionFailure.ts";
import { superviseSpawn } from "../../process/supervisor.ts";
import { normalizeProviderFailure } from "../../telemetry.ts";
import { cursorCapabilities, cursorEnv } from "./capabilities.ts";
import { writeCursorPolicy } from "./permissions.ts";
import { isDuplicateAssistant, NdjsonStream, toolCallShape } from "./stream.ts";

/** One-shot text completion for auxiliary calls (ranking, report, test explanation). No tools that mutate. */
export async function cursorComplete(
  prompt: string,
  signal?: AbortSignal,
  options?: { model?: string; timeoutMs?: number; onStream?: CompletionStreamListener },
): Promise<string> {
  signal?.throwIfAborted();
  const cap = await cursorCapabilities();
  if (!cap.ok)
    throw completionFailure(
      cap.error ?? "Cursor CLI is not available",
      normalizeProviderFailure({ message: cap.error }),
    );
  signal?.throwIfAborted();
  const dir = join(tmpdir(), `cursor-complete-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "prompt.txt");
  writeFileSync(file, prompt);
  writeCursorPolicy(dir, { reposRoot: config.reposRoot, workspaces: [] });
  const args = [
    "--print",
    "--output-format",
    ...(options?.onStream ? ["stream-json", "--stream-partial-output"] : ["json"]),
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--trust",
    "--workspace",
    dir,
    `Reply using only the instructions in ${file}. Do not modify files.`,
  ];
  if (options?.model) {
    if (!cap.supportsModel) throw new Error("Cursor CLI does not support model selection");
    args.push("--model", options.model);
  }
  const timeoutMs = Math.min(
    options?.timeoutMs ?? config.agent.cursorTimeoutMs ?? 10 * 60_000,
    10 * 60_000,
  );
  const proc = await superviseSpawn({
    command: cap.bin,
    args,
    cwd: dir,
    env: cursorEnv(process.env),
    stdin: "ignore",
    class: "agent",
    graceMs: 0,
    timeoutMs,
  });
  const child = proc.child;
  const kill = () => proc.stop();
  signal?.addEventListener("abort", kill, { once: true });
  let stdout = "";
  let stderr = "";
  const stream = options?.onStream;
  const parser = stream && new NdjsonStream();
  let answer = "";
  const code = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", (b: Buffer) => {
      // The answer is the last line: a flooding CLI cannot grow this beyond the last megabyte.
      stdout = (stdout + b.toString("utf8")).slice(-1_048_576);
      if (!parser) return;
      for (const ev of parser.push(b.toString("utf8")).events) {
        if (ev.type === "system") stream({ type: "started" });
        else if (ev.type === "thinking" && ev.text && ev.subtype !== "completed")
          stream({ type: "reasoning", delta: ev.text });
        else if (ev.type === "assistant" && ev.text && !isDuplicateAssistant(ev, true))
          stream({ type: "text", text: (answer += ev.text) });
        else if (ev.type === "tool_call" && ev.subtype === "started")
          stream({
            type: "activity",
            label: activityLabel("tool", toolCallShape(ev.tool_call)?.name),
          });
      }
    });
    child.stderr?.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-8000)));
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });
  signal?.removeEventListener("abort", kill);
  const timedOut = (await proc.done).outcome === "timeout";
  rmSync(dir, { recursive: true, force: true });
  if (signal?.aborted) throw new Error("canceled");
  if (timedOut)
    throw completionFailure(
      `Cursor text completion timed out after ${Math.round(timeoutMs / 1000)}s`,
      "EXECUTION_TIMEOUT",
    );
  if (code !== 0) {
    const detail = `Cursor text completion failed (${code}): ${stderr.slice(0, 300)}`;
    throw completionFailure(detail, normalizeProviderFailure({ message: detail }));
  }
  try {
    const msg = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) || "{}");
    if (typeof msg.result === "string") return msg.result;
  } catch {
    /* text fallback */
  }
  if (parser && answer.trim()) return answer;
  if (!stdout.trim()) throw new Error("Cursor text completion returned no result");
  return stdout.trim();
}

export const cursorCompleteRunner: CompletionRunner = async (prompt, options) => ({
  text: await cursorComplete(prompt, options.signal, options),
  model: options.model,
  tokens: null,
});
