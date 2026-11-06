/**
 * Agent implementation for a run. Separate from the model id: Claude model strings are never sent to Cursor or Codex,
 * and each provider resolves its own model. Resolved once when the run is created; retries, resume, repair and
 * re-execution keep it. NULL is not used — rows from before this column default to claude.
 */
export const AGENT_PROVIDERS = ["claude", "cursor", "codex"] as const;
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

export function agentProvider(run: { agent_provider?: string | null } | null | undefined): AgentProvider {
  return parseAgentProvider(run?.agent_provider) ?? "claude";
}
