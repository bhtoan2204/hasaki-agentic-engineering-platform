import { config } from "../config.ts";

/**
 * The run default remains fixed for historical compatibility. Agent steps resolve their own provider and model
 * into an immutable attempt snapshot. Historical rows without the run column default to Claude.
 */

export const AGENT_PROVIDERS = ["claude", "cursor", "codex", "antigravity"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export type ProviderFlags = Partial<Record<AgentProvider, boolean>>;

/** Missing flag means on, so an unset Settings page leaves every provider available. */
export function providerEnabled(provider: AgentProvider, flags: ProviderFlags | undefined = config.agent.enabledProviders): boolean {
  return flags?.[provider] !== false;
}

export function enabledAgentProviders(flags?: ProviderFlags): AgentProvider[] {
  return AGENT_PROVIDERS.filter((p) => providerEnabled(p, flags));
}

/** An off provider is replaced by the default when that is on, otherwise the first provider still on. */
export function substituteEnabledProvider(requested: AgentProvider): AgentProvider {
  if (providerEnabled(requested)) return requested;
  const preferred = parseAgentProvider(config.agent.defaultProvider);
  if (preferred && preferred !== requested && providerEnabled(preferred)) return preferred;
  const next = enabledAgentProviders()[0];
  if (!next) throw new Error("No agent provider is enabled in Settings");
  return next;
}

export function parseAgentProvider(v: unknown): AgentProvider | null {
  return (AGENT_PROVIDERS as readonly unknown[]).includes(v) ? (v as AgentProvider) : null;
}

/** Omitted means Claude, so existing API clients keep the previous behavior. Anything else is rejected. */
export function resolveAgentProvider(v: unknown): AgentProvider {
  if (v === undefined || v === null || v === "") return "claude";
  const p = parseAgentProvider(v);
  if (!p) throw new Error(`agent_provider must be one of ${AGENT_PROVIDERS.join(", ")}`);
  return p;
}

export function agentProvider(
  run: { agent_provider?: string | null } | null | undefined,
): AgentProvider {
  return parseAgentProvider(run?.agent_provider) ?? "claude";
}
