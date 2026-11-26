import type { ChildProcess } from "node:child_process";

export const PROMPT_CHUNK_CHARS = 16 * 1024;
export const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
/** Prefer argv `-p` under this size; larger prompts are piped on stdin (CLI 1.0+). */
export const PROMPT_ARGV_MAX = 48 * 1024;

function processError(message: string) {
  return Object.assign(new Error(message), { code: "COPILOT_INPUT_CLOSED" });
}

function waitForDrain(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  const stdin = child.stdin;
  if (!stdin) return Promise.reject(processError("Copilot stdin is unavailable"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.removeListener("drain", drained);
      stdin.removeListener("error", failed);
      stdin.removeListener("close", closed);
      child.removeListener("close", exited);
      signal?.removeEventListener("abort", aborted);
    };
    const done = (error?: Error) => {
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const drained = () => done();
    const failed = (error: Error) => done(error);
    const closed = () => done(processError("Copilot closed stdin before the prompt was sent"));
    const exited = () => done(processError("Copilot exited before the prompt was sent"));
    const aborted = () => done(processError("Copilot prompt write was aborted"));
    stdin.once("drain", drained);
    stdin.once("error", failed);
    stdin.once("close", closed);
    child.once("close", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/** Deliver the user prompt on stdin (plain text). Used when the prompt is too large for `-p`. */
export async function writeCopilotStdinPrompt(
  child: ChildProcess,
  prompt: string,
  signal?: AbortSignal,
) {
  const stdin = child.stdin;
  if (!stdin) throw processError("Copilot stdin is unavailable");
  let inputFailure: Error | undefined;
  stdin.once("error", (error) => {
    inputFailure = error;
  });
  const write = async (chunk: string) => {
    if (inputFailure) throw inputFailure;
    if (signal?.aborted) throw processError("Copilot prompt write was aborted");
    if (stdin.destroyed || child.exitCode !== null || child.signalCode !== null)
      throw processError("Copilot exited before the prompt was sent");
    if (!stdin.write(chunk)) await waitForDrain(child, signal);
  };

  for (let offset = 0; offset < prompt.length; offset += PROMPT_CHUNK_CHARS) {
    await write(prompt.slice(offset, offset + PROMPT_CHUNK_CHARS));
  }
  if (signal?.aborted) throw processError("Copilot prompt write was aborted");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stdin.removeListener("finish", finished);
      stdin.removeListener("error", failed);
      stdin.removeListener("close", closed);
      child.removeListener("close", exited);
      signal?.removeEventListener("abort", aborted);
    };
    const done = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const finished = () => done();
    const failed = (error: Error) => done(error);
    const closed = () => done(processError("Copilot closed stdin before the prompt was flushed"));
    const exited = () => done(processError("Copilot exited before the prompt was flushed"));
    const aborted = () => done(processError("Copilot prompt write was aborted"));
    stdin.once("finish", finished);
    stdin.once("error", failed);
    stdin.once("close", closed);
    child.once("close", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    stdin.end();
  });
}

/** Pure helper to build argv for Copilot CLI ≥ 1.0 headless execution. */
export function buildCopilotArgs(opts: {
  prompt?: string;
  /** When true, omit `-p` and deliver the prompt on stdin instead. */
  useStdinPrompt?: boolean;
  model?: string;
  effort?: string;
  sandbox?: boolean;
  conversationId?: string;
  additionalDirs?: string[];
  mcpConfigPath?: string;
  allowTools?: boolean;
}): string[] {
  const args = ["--silent", "--output-format", "json"];
  if (!opts.useStdinPrompt && opts.prompt != null) args.push("-p", opts.prompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--reasoning-effort", opts.effort);
  if (opts.conversationId) args.push("--resume", opts.conversationId);
  if (opts.additionalDirs) {
    for (const d of opts.additionalDirs) {
      if (d) args.push("--add-dir", d);
    }
  }
  if (opts.mcpConfigPath) args.push("--additional-mcp-config", `@${opts.mcpConfigPath}`);
  // Headless cannot answer permission prompts; approve tools and rely on platform hooks + broker.
  if (opts.allowTools !== false) args.push("--allow-all-tools");
  // Sandbox subcommand exists separately; keep fail-closed coding isolation via env/hooks when requested.
  void opts.sandbox;
  return args;
}

export function shouldUseStdinPrompt(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") > PROMPT_ARGV_MAX;
}
