import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfig } from "../../../config.ts";
import type { CompletionStreamListener } from "../../completionStream.ts";
import { addUsage, newMetrics, type AgentMetrics } from "../../metrics.ts";
import { superviseSpawn } from "../../process/supervisor.ts";
import { DISABLED_FEATURES, toml } from "./args.ts";
import { codexCapabilities, codexEnv } from "./capabilities.ts";
import {
  classifyCodexError,
  codexMetricUsage,
  codexProgress,
  failureMessage,
  JsonlStream,
  type CodexEvent,
} from "./stream.ts";

/** Never let a token-looking string from CLI stderr reach the transcript. */
export function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[redacted]")
    .replace(/\b(sk|rt|sess)-[A-Za-z0-9_-]{12,}/g, "$1-[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]");
}

export function lastLine(s: string) {
  return redact(s.trim().split("\n").filter(Boolean).at(-1) ?? "").slice(0, 500);
}

/**
 * One-shot text completion for auxiliary calls of a Codex run (ranking, report, test-failure explanation). Read-only
 * sandbox in an empty temp directory, no platform tools, ephemeral session. Returns the final agent message.
 */
export async function codexComplete(
  prompt: string,
  opts: {
    signal?: AbortSignal;
    model?: string;
    effort?: string;
    timeoutMs?: number;
    onStream?: CompletionStreamListener;
  } = {},
): Promise<{ text: string; tokens: AgentMetrics["tokens"]; model: string }> {
  const cfg = codexConfig();
  const cap = await codexCapabilities(false, {
    model: opts.model ?? cfg.model,
    effort: opts.effort ?? cfg.reasoningEffort,
  });
  if (!cap.ok) throw new Error(cap.error);
  opts.signal?.throwIfAborted();
  const dir = mkdtempSync(join(tmpdir(), "ctp-codex-complete-"));
  const model = opts.model ?? cfg.model;
  const effort = opts.effort ?? cfg.reasoningEffort;
  const args = [
    "exec",
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
  ];
  for (const f of DISABLED_FEATURES) args.push("--disable", f);
  for (const [k, v] of [
    ["sandbox_mode", "read-only"],
    ["approval_policy", "never"],
    ["web_search", "disabled"],
    ...(model ? [["model", model]] : []),
    ...(effort ? [["model_reasoning_effort", effort]] : []),
  ] as Array<[string, unknown]>)
    args.push("-c", `${k}=${toml(v)}`);
  args.push("-C", dir, "-");
  const proc = await superviseSpawn({
    command: cap.bin,
    args,
    cwd: dir,
    env: codexEnv(process.env),
    class: "agent",
    graceMs: 0,
  });
  const child = proc.child;
  const kill = () => proc.stop();
  opts.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, Math.min(opts.timeoutMs ?? cfg.timeoutMs, 10 * 60_000));
  child.stdin?.on("error", () => {});
  child.stdin?.end(
    `${prompt}\n\nReply with the requested text only. Do not run commands or modify files.`,
  );
  const parser = new JsonlStream();
  const events: CodexEvent[] = [];
  let stderr = "";
  const code = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", (b: Buffer) => {
      const fresh = parser.push(b).events;
      events.push(...fresh);
      for (const ev of fresh) {
        const p = opts.onStream && codexProgress(ev);
        if (p) opts.onStream!(p);
      }
    });
    child.stderr?.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-8000)));
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", kill);
  await proc.done;
  events.push(...parser.flush().events);
  rmSync(dir, { recursive: true, force: true });
  if (opts.signal?.aborted) throw new Error("canceled");
  let text = "";
  let done = false;
  let fail = "";
  let lastError = "";
  const usageMetrics = newMetrics(model || "");
  for (const ev of events) {
    if (ev.type === "item.completed" && ev.item.type === "agent_message" && ev.item.text)
      text = ev.item.text;
    else if (ev.type === "turn.completed") {
      done = true;
      if (ev.usage) {
        addUsage(usageMetrics, codexMetricUsage(ev.usage));
      }
    } else if (ev.type === "turn.failed") fail = ev.message;
    else if (ev.type === "error") lastError = ev.message;
  }
  if (fail || !done || code !== 0) {
    const detail =
      fail ||
      lastError ||
      lastLine(stderr) ||
      `Codex exited ${code ?? "unknown"} without completing`;
    throw new Error(failureMessage(classifyCodexError(`${detail}\n${stderr}`), detail));
  }
  if (!text.trim()) throw new Error("Codex text completion returned no message");
  return { text, tokens: usageMetrics.tokens, model: model || "" };
}
