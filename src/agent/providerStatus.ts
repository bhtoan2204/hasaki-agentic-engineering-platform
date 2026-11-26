import { config } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { discoverProviderAdapter } from "./providerProbes.ts";

import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";
import { primeSharedAgentHealth, probeAgentHealth } from "./health.ts";
import { DiscoveryCache } from "./providerDiscovery.ts";
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

export async function discoverProvider(provider: AgentProvider, refresh = false) {
  const adapter = discoverProviderAdapter(provider, refresh);
  return catalogs.get(
    `${provider}:${adapter.bin}:${config.instanceId}:${currentUserId() ?? "worker"}`,
    adapter.probe,
    refresh,
  );
}
