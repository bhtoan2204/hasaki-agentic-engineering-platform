import { antigravityConfig, codexConfig, config, copilotConfig } from "../config.ts";
import type { AgentProvider } from "./provider.ts";
import type { DiscoveryProbe } from "./providerDiscovery.ts";
import { antigravityCapabilities } from "./providers/antigravity/capabilities.ts";
import { claudeCapabilities, claudeDiscovery } from "./providers/claude/capabilities.ts";
import { codexCapabilities } from "./providers/codex/capabilities.ts";
import { copilotCapabilities } from "./providers/copilot/capabilities.ts";
import { cursorBinary, cursorCapabilities } from "./providers/cursor/capabilities.ts";

export interface ProviderReadiness {
  ok: boolean;
  error?: string;
  quota: string;
  cost: string;
}

export interface ProviderProbeAdapter {
  discovery(refresh: boolean): { bin: string; probe: DiscoveryProbe };
  preflight(opts: { model: string; effort: string }): Promise<{ ok: boolean; error?: string }>;
  readiness(opts: {
    model?: string | null;
    reasoning_effort?: string | null;
  }): Promise<ProviderReadiness>;
}

const ADAPTERS: Record<AgentProvider, ProviderProbeAdapter> = {
  claude: {
    discovery: () => ({
      bin: config.agent.claudeBin ?? "sdk",
      probe: claudeDiscovery,
    }),
    preflight: () => claudeCapabilities(),
    readiness: () => claudeCapabilities(),
  },
  codex: {
    discovery: (refresh) => ({
      bin: codexConfig().bin,
      probe: async () => {
        const c = await codexCapabilities(refresh, { model: "", effort: "" });
        return { ...c, models: c.models?.map((m) => ({ ...m, name: m.slug })) };
      },
    }),
    preflight: (opts) => codexCapabilities(false, opts),
    readiness: async (agent) => {
      const c = await codexCapabilities(false, {
        model: agent.model ?? "",
        effort: agent.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    },
  },
  cursor: {
    discovery: (refresh) => ({
      bin: cursorBinary(),
      probe: async () => cursorCapabilities(refresh),
    }),
    preflight: () => cursorCapabilities(),
    readiness: async (agent) => {
      const c = await cursorCapabilities();
      return {
        ok: c.ok && (!agent.model || !!c.supportsModel),
        error:
          c.error ?? (agent.model && !c.supportsModel ? "Cursor --model unsupported" : undefined),
        quota: "unknown",
        cost: "unknown",
      };
    },
  },
  antigravity: {
    discovery: (refresh) => ({
      bin: antigravityConfig().bin,
      probe: async () => antigravityCapabilities(refresh, { model: "", effort: "" }),
    }),
    preflight: (opts) => antigravityCapabilities(false, opts),
    readiness: async (agent) => {
      const c = await antigravityCapabilities(false, {
        model: agent.model ?? "",
        effort: agent.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    },
  },
  copilot: {
    discovery: (refresh) => ({
      bin: copilotConfig().bin,
      probe: async () => copilotCapabilities(refresh, { model: "", effort: "" }),
    }),
    preflight: (opts) => copilotCapabilities(false, opts),
    readiness: async (agent) => {
      const c = await copilotCapabilities(false, {
        model: agent.model ?? "",
        effort: agent.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    },
  },
};

/** Returns the binary identifier and catalog discovery probe for a provider. */
export function discoverProviderAdapter(provider: AgentProvider, refresh = false) {
  return ADAPTERS[provider].discovery(refresh);
}

/** Runs the preflight CLI/auth readiness check for providers whose runtime enables preflight probes. */
export function probePreflightCapability(
  provider: AgentProvider,
  opts: { model: string; effort: string },
) {
  return ADAPTERS[provider].preflight(opts);
}

/** Checks provider readiness prior to run creation, optimization, or handoff. */
export function probeHandoffReadiness(
  provider: AgentProvider,
  agent: { model?: string | null; reasoning_effort?: string | null },
) {
  return ADAPTERS[provider].readiness(agent);
}
