import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../../config.ts";
import { agentEnvironment } from "../../environment.ts";

const exec = promisify(execFile);

export interface ClaudeModel {
  slug: string;
  name: string;
  efforts: string[];
}

export interface ClaudeCapability {
  ok: boolean;
  models: ClaudeModel[];
}

export async function claudeDiscovery(): Promise<ClaudeCapability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  // Keep stdin open for control requests, without sending a model prompt.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (!controller.signal.aborted)
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        return { done: true, value: undefined };
      },
    }),
  };
  const session = query({
    prompt,
    options: {
      ...(config.agent.claudeBin
        ? {
            pathToClaudeCodeExecutable: config.agent.claudeBin,
          }
        : {}),
      env: agentEnvironment(process.env, "claude"),
      tools: [],
      settingSources: [],
      persistSession: false,
      abortController: controller,
    },
  });
  try {
    const models = await session.supportedModels();
    return {
      ok: true,
      models: models.map((m) => ({
        slug: m.value,
        name: m.displayName,
        efforts: m.supportedEffortLevels ?? [],
      })),
    };
  } finally {
    controller.abort();
    session.close();
    clearTimeout(timer);
  }
}

export async function claudeReadiness(): Promise<{
  ok: boolean;
  error?: string;
  quota: string;
  cost: string;
}> {
  const configured = config.agent.claudeBin;
  const bin = configured || "claude";
  const { stdout } = await exec(
    process.execPath === bin ? bin : bin.endsWith(".js") ? process.execPath : bin,
    bin.endsWith(".js") ? [bin, "auth", "status", "--json"] : ["auth", "status", "--json"],
    {
      timeout: 15000,
      maxBuffer: 64000,
      env: agentEnvironment(process.env, "claude"),
    },
  );
  const status = JSON.parse(stdout);
  return {
    ok: status.loggedIn === true,
    error: status.loggedIn === true ? undefined : "Claude authentication readiness not confirmed",
    quota: "unknown",
    cost: "unknown",
  };
}
