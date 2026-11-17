import type { AgentProvider } from "./provider.ts";

/** Adapter support is separate from worker/account discovery. No model catalogs live in the UI. */
export const providerControls: Record<
  AgentProvider,
  { model: boolean | null; max_turns: boolean; efforts: string[]; options: string[] }
> = {
  claude: {
    model: true,
    max_turns: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    options: [],
  },
  codex: {
    model: true,
    max_turns: false,
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    options: [],
  },
  cursor: { model: null, max_turns: false, efforts: [], options: [] },
  antigravity: {
    model: true,
    max_turns: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    options: ["sandbox", "max_concurrent"],
  },
  copilot: {
    model: true,
    max_turns: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    options: ["sandbox", "max_concurrent"],
  },
};

/** null means discovery has not established whether the installed CLI supports this control. */
export function providerControlState(
  provider: AgentProvider,
  capability: { available: boolean; supportsModel?: boolean },
) {
  return {
    ...providerControls[provider],
    model:
      provider === "cursor" ? (capability.supportsModel ?? null) : providerControls[provider].model,
  };
}
