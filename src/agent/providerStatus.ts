import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, codexConfig, antigravityConfig, copilotConfig } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { agentEnvironment } from "./environment.ts";
import { cursorBinary, cursorCapabilities } from "./cursor/run.ts";
import { codexCapabilities } from "./codex/run.ts";
import { antigravityCapabilities } from "./antigravity/capabilities.ts";
import { copilotCapabilities } from "./copilot/capabilities.ts";

import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";
import { primeSharedAgentHealth, probeAgentHealth } from "./health.ts";
import { DiscoveryCache, type DiscoveryProbe } from "./providerDiscovery.ts";
import { providerControlState } from "./providerCapabilities.ts";
import { loadAgentConfiguration } from "./configurationStore.ts";

/** Operational availability, discovery and supported controls are independent facts. */
export async function agentProviderStatus(refresh = false) {
  const [document, health, discoveries] = await Promise.all([
    loadAgentConfiguration(),
    probeAgentHealth(),
    Promise.all(AGENT_PROVIDERS.map((provider) => discoverProvider(provider, refresh))),
  ]);
  // A fresh probe ("Refresh health" included) is what the next chat admissions see.
  primeSharedAgentHealth(health);
  return AGENT_PROVIDERS.map((id, index) => {
    const discovery = discoveries[index];
    const status = health.find((entry) => entry.provider === id);
    return {
      id,
      enabled: document.providers[id].enabled,
      ok: discovery.available && status?.connected === true && status.quota !== "exhausted",
      error: discovery.available
        ? undefined
        : "Provider unavailable on this worker; check Integrations",
      quota: status?.quota ?? "unknown",
      controls: providerControlState(id, discovery),
      ...discovery,
      model: document.providers[id].defaults.model ?? null,
      reasoning_effort: document.providers[id].defaults.reasoning_effort ?? null,
    };
  });
}

const catalogs = new DiscoveryCache();
async function claudeDiscovery() {
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
export async function discoverProvider(provider: AgentProvider, refresh = false) {
  const probes: Record<AgentProvider, { bin: string; probe: DiscoveryProbe }> = {
    claude: { bin: config.agent.claudeBin ?? "sdk", probe: claudeDiscovery },
    codex: {
      bin: codexConfig().bin,
      probe: async () => {
        const c = await codexCapabilities(refresh, { model: "", effort: "" });
        return { ...c, models: c.models?.map((m) => ({ ...m, name: m.slug })) };
      },
    },
    cursor: { bin: cursorBinary(), probe: async () => cursorCapabilities(refresh) },
    antigravity: {
      bin: antigravityConfig().bin,
      probe: async () => antigravityCapabilities(refresh, { model: "", effort: "" }),
    },
    copilot: {
      bin: copilotConfig().bin,
      probe: async () => copilotCapabilities(refresh, { model: "", effort: "" }),
    },
  };
  const adapter = probes[provider];
  return catalogs.get(
    `${provider}:${adapter.bin}:${config.instanceId}:${currentUserId() ?? "worker"}`,
    adapter.probe,
    refresh,
  );
}
