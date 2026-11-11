/**
 * The run default remains fixed for historical compatibility. Agent steps resolve their own provider and model
 * into an immutable attempt snapshot. Historical rows without the run column default to Claude.
 */
export const AGENT_PROVIDERS = ["claude", "cursor", "codex", "antigravity"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

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
