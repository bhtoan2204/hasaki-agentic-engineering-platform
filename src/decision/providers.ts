import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { antigravityCapabilities } from "../agent/antigravity/capabilities.ts";
import { antigravityComplete } from "../agent/antigravity/run.ts";
import { codexCapabilities, codexComplete } from "../agent/codex/run.ts";
import { agentEnvironment } from "../agent/environment.ts";
import type { AgentProvider } from "../agent/provider.ts";

export class DecisionProviderError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
export interface DecisionTarget {
  provider: AgentProvider;
  model: string;
  effort: "medium" | "high";
}
export interface DecisionTransport {
  resolve(target: DecisionTarget, signal: AbortSignal): Promise<DecisionTarget>;
  execute(
    target: DecisionTarget,
    prompt: string,
    schema: string,
    signal: AbortSignal,
  ): Promise<{ text: string; tokens: Record<string, number | null | undefined> | null }>;
}
const exec = promisify(execFile);
/** Catalog order is not a version guarantee. Only published effort variants prove the requested budget exists. */
export function flashModel(slugs: string[], requested: string, effort: string) {
  const pinnedEffort = requested.match(/-(low|medium|high|xhigh|max)$/)?.[1];
  if (pinnedEffort && pinnedEffort !== effort)
    throw new DecisionProviderError(
      "Decision model variant conflicts with requested effort; configure its unsuffixed family or a per-type variant",
      "UNSUPPORTED",
    );
  const base = requested.replace(/-(low|medium|high|xhigh|max)$/, "");
  const available = slugs.filter(
    (s) =>
      /^gemini-.*flash/.test(s) &&
      s.endsWith(`-${effort}`) &&
      (requested === "gemini-flash" || s === `${base}-${effort}`),
  );
  const model = available.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (!model)
    throw new DecisionProviderError(
      `No catalog Gemini Flash ${effort} variant for ${requested}`,
      "UNSUPPORTED",
    );
  return model;
}
function capabilityError(c: { kind?: string; error?: string }): never {
  throw new DecisionProviderError(
    c.error ?? "Decision provider readiness failed",
    c.kind === "auth"
      ? "AUTHENTICATION"
      : c.kind === "missing" && /not found|ENOENT|not installed|does not exist/i.test(c.error ?? "")
        ? "PROVIDER_UNAVAILABLE"
        : "UNSUPPORTED",
  );
}
export const subscriptionTransport: DecisionTransport = {
  async resolve(t, signal) {
    signal.throwIfAborted();
    if (t.provider === "antigravity") {
      const cap = await antigravityCapabilities(false, { model: "", effort: "" });
      if (!cap.ok) capabilityError(cap);
      if (cap.auth !== "Google Account (Worker)")
        throw new DecisionProviderError(
          "Decision calls require worker Google Account OAuth authentication",
          "AUTHENTICATION",
        );
      const model = flashModel(
        (cap.models ?? []).map((m) => m.slug),
        t.model || "gemini-flash",
        t.effort,
      );
      const help = await exec(cap.bin, ["--help"], {
        signal,
        timeout: 10000,
        maxBuffer: 64000,
        env: agentEnvironment(process.env, "antigravity"),
      });
      for (const flag of ["--settings", "--json-schema", "--disable-slash-commands"])
        if (!help.stdout.includes(flag))
          throw new DecisionProviderError(`Decision adapter requires ${flag}`, "UNSUPPORTED");
      return { ...t, model };
    }
    if (t.provider === "codex") {
      const cap = await codexCapabilities(false, { model: t.model, effort: t.effort });
      if (!cap.ok) capabilityError(cap);
      if (!/chatgpt/i.test(cap.auth ?? ""))
        throw new DecisionProviderError(
          "Decision fallback requires Codex ChatGPT subscription login",
          "AUTHENTICATION",
        );
      if (!t.model || !cap.models?.some((m) => m.slug === t.model && m.efforts.includes(t.effort)))
        throw new DecisionProviderError(
          "Decision fallback requires explicit catalog model/effort",
          "UNSUPPORTED",
        );
      return t;
    }
    if (t.provider === "claude") {
      if (!t.model)
        throw new DecisionProviderError(
          "Claude decision fallback needs an explicit model",
          "UNSUPPORTED",
        );
      const r = await exec(config.agent.claudeBin || "claude", ["auth", "status", "--json"], {
        signal,
        timeout: 10000,
        env: agentEnvironment(process.env, "claude"),
      });
      const auth = JSON.parse(r.stdout);
      if (
        !auth.loggedIn ||
        !["oauth_token", "claude.ai"].includes(auth.authMethod) ||
        !auth.subscriptionType
      )
        throw new DecisionProviderError(
          "Claude decision fallback requires verified subscription OAuth",
          "AUTHENTICATION",
        );
      return t;
    }
    throw new DecisionProviderError(
      "Cursor cannot enforce explicit decision effort; adapter unavailable",
      "UNSUPPORTED",
    );
  },
  async execute(t, prompt, schema, signal) {
    if (t.provider === "antigravity") {
      const dir = await mkdtemp(join(tmpdir(), "ctp-decision-"));
      try {
        await mkdir(join(dir, ".agents"));
        // The normal platform hook fails closed without a broker. No decision tools are authorized.
        const hook = join(import.meta.dirname, "../agent/antigravity/hook.ts");
        await writeFile(
          join(dir, ".agents/hooks.json"),
          JSON.stringify({
            "decision-policy": {
              enabled: true,
              PreToolUse: [
                {
                  matcher: "*",
                  hooks: [
                    {
                      type: "command",
                      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
                      timeout: 5,
                    },
                  ],
                },
              ],
            },
          }),
        );
        const settings = JSON.stringify({
          modelProvider: "",
          useG1Credits: false,
          toolPermission: "strict",
          allowNonWorkspaceAccess: false,
          permissions: {
            allow: [],
            deny: [
              "command(*)",
              "read_file(*)",
              "write_file(*)",
              "read_url(*)",
              "execute_url(*)",
              "mcp(*)",
              "unsandboxed(*)",
            ],
          },
          statusLine: { enabled: false },
          title: { enabled: false },
        });
        return await antigravityComplete(prompt, {
          signal,
          model: t.model,
          effort: "",
          cwd: dir,
          settings,
          schema,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (t.provider === "codex")
      return codexComplete(prompt, {
        signal,
        model: t.model,
        effort: t.effort,
        decisionOnly: true,
      });
    if (t.provider === "claude") {
      const env = agentEnvironment(process.env, "claude");
      for (const k of Object.keys(env)) if (/^ANTHROPIC_/.test(k)) delete env[k];
      env.CLAUDE_CODE_USE_BEDROCK = "0";
      env.CLAUDE_CODE_USE_VERTEX = "0";
      env.CLAUDE_CODE_USE_FOUNDRY = "0";
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let text = "";
      try {
        signal.throwIfAborted();
        for await (const msg of query({
          prompt,
          options: {
            env,
            tools: [],
            settingSources: [],
            maxTurns: 1,
            persistSession: false,
            model: t.model,
            effort: t.effort,
            abortController: controller,
          },
        })) {
          if (msg.type === "result") {
            if (msg.subtype !== "success")
              throw new DecisionProviderError("Claude decision failed", "UNKNOWN");
            text = msg.result;
          }
        }
        return { text, tokens: null };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
    throw new DecisionProviderError("Unsupported decision transport", "UNSUPPORTED");
  },
};
