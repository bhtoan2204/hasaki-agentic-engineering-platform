import type { AgentProvider } from "./provider.ts";

/** Adapter support is separate from worker/account discovery. No model catalogs live in the UI. */
export const providerControls: Record<
  AgentProvider,
  { max_turns: boolean; efforts: string[]; options: string[] }
> = {
  claude: { max_turns: true, efforts: ["low", "medium", "high", "xhigh", "max"], options: [] },
  codex: {
    max_turns: false,
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    options: [],
  },
  cursor: { max_turns: false, efforts: [], options: [] },
  antigravity: {
    max_turns: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    options: ["sandbox", "max_concurrent"],
  },
  copilot: {
    max_turns: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    options: ["sandbox", "max_concurrent"],
  },
};
