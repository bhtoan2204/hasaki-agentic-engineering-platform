/** Provider-neutral reading of run metrics: the agent_* fields, falling back to the legacy claude_* ones. */

export const agentMs = (x: { agent_ms?: number; claude_ms?: number }) =>
  x.agent_ms ?? x.claude_ms ?? 0;

export const agentSessions = (x: { agent_sessions?: number; claude_sessions?: number }) =>
  x.agent_sessions ?? x.claude_sessions ?? 0;

export const agentAttemptsPerRun = (x: {
  agent_attempts_per_run?: string | number | null;
  claude_attempts_per_run?: string | number | null;
}) => x.agent_attempts_per_run ?? x.claude_attempts_per_run;

/** A test-failure explanation written by a provider's model (any of them), not by the rules alone. */
export const explainedByAi = (by: string | null | undefined) => !!by && by !== "rules";

/** i18n key of what "no model named" means for a provider; Claude names its model, so it has none. */
export const defaultModelKey = (provider: string) =>
  provider === "claude" ? null : `run.${provider}.defaultModel`;
