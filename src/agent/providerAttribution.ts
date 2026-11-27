import type { AgentProvider } from "./provider.ts";
import { resolveStepAgent } from "./stepAgent.ts";

const ATTRIBUTION: Record<AgentProvider, { name: string; url: string }> = {
  claude: { name: "Claude Code", url: "https://claude.com/claude-code" },
  codex: { name: "OpenAI Codex", url: "https://openai.com/codex" },
  copilot: { name: "GitHub Copilot", url: "https://github.com/features/copilot" },
  antigravity: { name: "Google Antigravity", url: "https://antigravity.google" },
  cursor: { name: "Cursor", url: "https://cursor.com" },
};

/** The product name and link a generated artifact (a PR) credits for the provider that did the work. */
export function providerAttribution(provider: AgentProvider) {
  return ATTRIBUTION[provider];
}

/** The provider a run uses by default (its own choice, else the frozen configuration's default). */
export function runProvider(run: {
  agent_provider?: string | null;
  agent_configuration?: unknown;
}): AgentProvider {
  try {
    return resolveStepAgent(run as never, { type: "agent", config: {} })?.provider ?? "claude";
  } catch {
    return "claude";
  }
}
