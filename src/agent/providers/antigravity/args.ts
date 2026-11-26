import type { ChildProcess } from "node:child_process";

export const PROMPT_CHUNK_CHARS = 16 * 1024;
export const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

function processError(message: string) {
  return Object.assign(new Error(message), { code: "AGY_INPUT_CLOSED" });
}

function waitForDrain(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  const stdin = child.stdin;
  if (!stdin) return Promise.reject(processError("Antigravity stdin is unavailable"));
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
      if (error) reject(error);
      else resolve();
    };
    const drained = () => done();
    const failed = (error: Error) => done(error);
    const closed = () => done(processError("Antigravity closed stdin before the prompt was sent"));
    const exited = () => done(processError("Antigravity exited before the prompt was sent"));
    const aborted = () => done(processError("Antigravity prompt write was aborted"));
    stdin.once("drain", drained);
    stdin.once("error", failed);
    stdin.once("close", closed);
    child.once("close", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export async function writeAntigravityPrompt(
  child: ChildProcess,
  prompt: string,
  signal?: AbortSignal,
) {
  const stdin = child.stdin;
  if (!stdin) throw processError("Antigravity stdin is unavailable");
  let inputFailure: Error | undefined;
  // Always observe EPIPE, including writes that do not reach the backpressure path.
  stdin.once("error", (error) => {
    inputFailure = error;
  });
  const write = async (chunk: string) => {
    if (inputFailure) throw inputFailure;
    if (signal?.aborted) throw processError("Antigravity prompt write was aborted");
    if (stdin.destroyed || child.exitCode !== null || child.signalCode !== null)
      throw processError("Antigravity exited before the prompt was sent");
    if (!stdin.write(chunk)) await waitForDrain(child, signal);
  };

  // Stream JSON escaping in bounded pieces so the full serialized prompt is never duplicated in memory.
  await write('{"event":"user","message":{"content":"');
  for (let offset = 0; offset < prompt.length; offset += PROMPT_CHUNK_CHARS) {
    const piece = prompt.slice(offset, offset + PROMPT_CHUNK_CHARS);
    await write(JSON.stringify(piece).slice(1, -1));
  }
  await write('"}}\n');
  if (signal?.aborted) throw processError("Antigravity prompt write was aborted");
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
    const closed = () =>
      done(processError("Antigravity closed stdin before the prompt was flushed"));
    const exited = () => done(processError("Antigravity exited before the prompt was flushed"));
    const aborted = () => done(processError("Antigravity prompt write was aborted"));
    stdin.once("finish", finished);
    stdin.once("error", failed);
    stdin.once("close", closed);
    child.once("close", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    stdin.end();
  });
}

/** Pure helper to build argv for `agy` execution. */
export function buildAntigravityArgs(opts: {
  model?: string;
  effort?: string;
  sandbox?: boolean;
  timeoutSeconds?: number;
  conversationId?: string;
  additionalDirs?: string[];
  settingsPath?: string;
}): string[] {
  const args = ["--output-format", "stream-json", "--input-format", "stream-json"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.sandbox !== false) args.push("--sandbox");
  // agy uses Go's time.ParseDuration. A bare millisecond count is rejected and the
  // process exits before stdin is read, which surfaces as EPIPE.
  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
    args.push("--print-timeout", `${opts.timeoutSeconds}s`);
  }
  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  }
  if (opts.additionalDirs) {
    for (const d of opts.additionalDirs) {
      if (d) args.push("--add-dir", d);
    }
  }
  if (opts.settingsPath) args.push("--settings", opts.settingsPath);
  return args;
}
