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

/** Platform-level guarantees a provider adapter enforces for a turn (see docs/architecture/execution-lifecycle.md). */
export type Guarantee =
  | "pre_tool_policy"
  | "hook_bypass_detection"
  | "write_sandbox"
  | "network_isolation"
  | "live_cost"
  | "incomplete_detection"
  | "resume";

export const GUARANTEES: Record<AgentProvider, readonly Guarantee[]> = {
  // In-process SDK hooks: every native tool passes decide() and cannot skip it.
  claude: [
    "pre_tool_policy",
    "hook_bypass_detection",
    "live_cost",
    "incomplete_detection",
    "resume",
  ],
  codex: [
    "pre_tool_policy",
    "hook_bypass_detection",
    "write_sandbox",
    "network_isolation",
    "incomplete_detection",
    "resume",
  ],
  copilot: [
    "pre_tool_policy",
    "hook_bypass_detection",
    "write_sandbox",
    "incomplete_detection",
    "resume",
  ],
  antigravity: [
    "pre_tool_policy",
    "hook_bypass_detection",
    "write_sandbox",
    "incomplete_detection",
    "resume",
  ],
  // cli.json rules plus a stream watcher that can only stop a tool after it started.
  cursor: ["incomplete_detection", "resume"],
};

const REQUIRED: Record<"coding" | "analysis", readonly Guarantee[]> = {
  coding: ["pre_tool_policy", "hook_bypass_detection"],
  analysis: [],
};
const PREFERRED: Record<"coding" | "analysis", readonly Guarantee[]> = {
  coding: [],
  analysis: ["pre_tool_policy", "hook_bypass_detection"],
};

export interface GuaranteeCheck {
  required: Guarantee[];
  provided: Guarantee[];
  /** Required for this mode but not provided: the step must not run. */
  unmet: Guarantee[];
  /** Preferred for this mode but not provided: the step runs, and evidence records it. */
  degraded: Guarantee[];
}

/** Fail-closed check of what a write step needs; a provider sandbox the step turned off counts as missing. */
export function guaranteeCheck(
  provider: AgentProvider,
  mode: "coding" | "analysis",
  options?: { sandbox?: unknown } | null,
): GuaranteeCheck {
  let provided = [...GUARANTEES[provider]];
  if (options?.sandbox === false) provided = provided.filter((g) => g !== "write_sandbox");
  const required = [
    ...REQUIRED[mode],
    ...(mode === "coding" && GUARANTEES[provider].includes("write_sandbox")
      ? (["write_sandbox"] as const)
      : []),
  ];
  return {
    required,
    provided,
    unmet: required.filter((g) => !provided.includes(g)),
    degraded: PREFERRED[mode].filter((g) => !provided.includes(g)),
  };
}
