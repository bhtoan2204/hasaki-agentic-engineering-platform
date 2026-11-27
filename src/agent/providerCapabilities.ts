import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";

/** Platform-level guarantees a provider adapter enforces for a turn (see docs/architecture/execution-lifecycle.md). */
export type Guarantee =
  | "pre_tool_policy"
  | "hook_bypass_detection"
  | "write_sandbox"
  | "network_isolation"
  | "reported_cost"
  | "incomplete_detection"
  | "resume"
  /** OS sandbox around the provider process (isolation.ts): private home/tmp, hidden credentials and other runs. */
  | "os_isolation";

export type AllowedToolsEnforcement = "native" | "hook_only" | "unsupported";
export type ReportedUsageLevel = "full" | "tokens_no_cache_creation" | "tokens_partial" | "none";

export interface ProviderCapabilities {
  id: AgentProvider;
  shortLabel: string;
  cliLabel: string;
  controls: {
    model: boolean | null;
    max_turns: boolean;
    efforts: readonly string[];
    options: readonly string[];
  };
  guarantees: {
    preToolPolicy: boolean;
    hookBypassDetection: boolean;
    writeSandbox: boolean;
    networkIsolation: boolean;
    osIsolation: boolean;
    delegation: boolean;
    microProfile: boolean;
    allowedToolsEnforcement: AllowedToolsEnforcement;
    incompleteDetection: boolean;
    resume: boolean;
  };
  runtime: {
    preflightProbe: boolean;
    sessionResume: boolean;
    settingsLayers: boolean;
    emptyModelSentinel: "default" | "";
    supportsMcpStdio: boolean;
    bridgeRpcTimeoutMs: number;
  };
  completion: {
    visionImages: boolean;
    chatNativeTools: boolean;
    streamingPartials: boolean;
    reportedCost: boolean;
    reportedUsage: ReportedUsageLevel;
    providerTelemetry: boolean;
  };
}

export const PROVIDER_CAPABILITIES: Record<AgentProvider, ProviderCapabilities> = {
  claude: {
    id: "claude",
    shortLabel: "Claude",
    cliLabel: "Claude",
    controls: {
      model: true,
      max_turns: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      options: [],
    },
    guarantees: {
      // In-process SDK hooks: every native tool passes decide() and cannot skip it.
      preToolPolicy: true,
      hookBypassDetection: true,
      writeSandbox: false,
      networkIsolation: false,
      osIsolation: true,
      delegation: true,
      microProfile: true,
      allowedToolsEnforcement: "native",
      incompleteDetection: true,
      resume: true,
    },
    runtime: {
      preflightProbe: false,
      sessionResume: true,
      settingsLayers: true,
      emptyModelSentinel: "default",
      supportsMcpStdio: true,
      bridgeRpcTimeoutMs: 0,
    },
    completion: {
      visionImages: true,
      chatNativeTools: true,
      streamingPartials: true,
      reportedCost: true,
      reportedUsage: "full",
      providerTelemetry: true,
    },
  },
  codex: {
    id: "codex",
    shortLabel: "Codex",
    cliLabel: "OpenAI Codex",
    controls: {
      model: true,
      max_turns: false,
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      options: [],
    },
    guarantees: {
      preToolPolicy: true,
      hookBypassDetection: true,
      writeSandbox: true,
      networkIsolation: true,
      osIsolation: false,
      delegation: false,
      microProfile: true,
      allowedToolsEnforcement: "hook_only",
      incompleteDetection: true,
      resume: true,
    },
    runtime: {
      preflightProbe: true,
      sessionResume: true,
      settingsLayers: false,
      emptyModelSentinel: "",
      supportsMcpStdio: true,
      bridgeRpcTimeoutMs: 30 * 60_000,
    },
    completion: {
      visionImages: false,
      chatNativeTools: false,
      streamingPartials: true,
      reportedCost: false,
      reportedUsage: "tokens_no_cache_creation",
      providerTelemetry: false,
    },
  },
  copilot: {
    id: "copilot",
    shortLabel: "Copilot",
    cliLabel: "GitHub Copilot CLI",
    controls: {
      model: true,
      max_turns: false,
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      options: ["sandbox", "max_concurrent"],
    },
    guarantees: {
      preToolPolicy: true,
      hookBypassDetection: true,
      // Copilot's own --sandbox covers shell commands only (built-in file edits are not OS-sandboxed) and needs host
      // prerequisites the platform does not probe, so no OS write sandbox is promised; edits are held by the hook.
      writeSandbox: false,
      networkIsolation: false,
      osIsolation: false,
      delegation: false,
      microProfile: true,
      allowedToolsEnforcement: "hook_only",
      incompleteDetection: true,
      resume: true,
    },
    runtime: {
      preflightProbe: true,
      sessionResume: true,
      settingsLayers: false,
      emptyModelSentinel: "",
      supportsMcpStdio: true,
      bridgeRpcTimeoutMs: 30 * 60_000,
    },
    completion: {
      visionImages: false,
      chatNativeTools: false,
      streamingPartials: true,
      reportedCost: false,
      reportedUsage: "tokens_partial",
      providerTelemetry: false,
    },
  },
  antigravity: {
    id: "antigravity",
    shortLabel: "Antigravity",
    cliLabel: "Google Antigravity CLI",
    controls: {
      model: true,
      max_turns: false,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      options: ["sandbox", "max_concurrent"],
    },
    guarantees: {
      preToolPolicy: true,
      hookBypassDetection: true,
      writeSandbox: true,
      networkIsolation: false,
      osIsolation: false,
      delegation: false,
      microProfile: true,
      allowedToolsEnforcement: "hook_only",
      incompleteDetection: true,
      resume: true,
    },
    runtime: {
      preflightProbe: true,
      sessionResume: true,
      settingsLayers: false,
      emptyModelSentinel: "",
      supportsMcpStdio: true,
      bridgeRpcTimeoutMs: 30 * 60_000,
    },
    completion: {
      visionImages: false,
      chatNativeTools: false,
      streamingPartials: true,
      reportedCost: false,
      reportedUsage: "tokens_partial",
      providerTelemetry: false,
    },
  },
  cursor: {
    id: "cursor",
    shortLabel: "Cursor",
    cliLabel: "This Cursor CLI",
    controls: { model: null, max_turns: false, efforts: [], options: [] },
    guarantees: {
      // cli.json rules plus a stream watcher that can only stop a tool after it started.
      preToolPolicy: false,
      hookBypassDetection: false,
      writeSandbox: false,
      networkIsolation: false,
      osIsolation: false,
      delegation: false,
      microProfile: false,
      allowedToolsEnforcement: "unsupported",
      incompleteDetection: true,
      resume: true,
    },
    runtime: {
      preflightProbe: true,
      sessionResume: true,
      settingsLayers: false,
      emptyModelSentinel: "",
      supportsMcpStdio: true,
      bridgeRpcTimeoutMs: 30 * 60_000,
    },
    completion: {
      visionImages: false,
      chatNativeTools: false,
      streamingPartials: false,
      reportedCost: false,
      reportedUsage: "none",
      providerTelemetry: false,
    },
  },
};

export function providerCapabilities(provider: AgentProvider): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider];
}

function providersWhere(pred: (caps: ProviderCapabilities) => boolean): readonly AgentProvider[] {
  return AGENT_PROVIDERS.filter((provider) => pred(PROVIDER_CAPABILITIES[provider]));
}

function toGuarantees(caps: ProviderCapabilities): readonly Guarantee[] {
  const list: Guarantee[] = [];
  if (caps.guarantees.preToolPolicy) list.push("pre_tool_policy");
  if (caps.guarantees.hookBypassDetection) list.push("hook_bypass_detection");
  if (caps.guarantees.writeSandbox) list.push("write_sandbox");
  if (caps.guarantees.networkIsolation) list.push("network_isolation");
  if (caps.completion.reportedCost) list.push("reported_cost");
  if (caps.guarantees.incompleteDetection) list.push("incomplete_detection");
  if (caps.guarantees.resume) list.push("resume");
  return list;
}

/** Adapter support is separate from worker/account discovery. No model catalogs live in the UI. */
export const providerControls: Record<
  AgentProvider,
  { model: boolean | null; max_turns: boolean; efforts: string[]; options: string[] }
> = {
  claude: {
    model: PROVIDER_CAPABILITIES.claude.controls.model,
    max_turns: PROVIDER_CAPABILITIES.claude.controls.max_turns,
    efforts: [...PROVIDER_CAPABILITIES.claude.controls.efforts],
    options: [...PROVIDER_CAPABILITIES.claude.controls.options],
  },
  codex: {
    model: PROVIDER_CAPABILITIES.codex.controls.model,
    max_turns: PROVIDER_CAPABILITIES.codex.controls.max_turns,
    efforts: [...PROVIDER_CAPABILITIES.codex.controls.efforts],
    options: [...PROVIDER_CAPABILITIES.codex.controls.options],
  },
  cursor: {
    model: PROVIDER_CAPABILITIES.cursor.controls.model,
    max_turns: PROVIDER_CAPABILITIES.cursor.controls.max_turns,
    efforts: [...PROVIDER_CAPABILITIES.cursor.controls.efforts],
    options: [...PROVIDER_CAPABILITIES.cursor.controls.options],
  },
  antigravity: {
    model: PROVIDER_CAPABILITIES.antigravity.controls.model,
    max_turns: PROVIDER_CAPABILITIES.antigravity.controls.max_turns,
    efforts: [...PROVIDER_CAPABILITIES.antigravity.controls.efforts],
    options: [...PROVIDER_CAPABILITIES.antigravity.controls.options],
  },
  copilot: {
    model: PROVIDER_CAPABILITIES.copilot.controls.model,
    max_turns: PROVIDER_CAPABILITIES.copilot.controls.max_turns,
    efforts: [...PROVIDER_CAPABILITIES.copilot.controls.efforts],
    options: [...PROVIDER_CAPABILITIES.copilot.controls.options],
  },
};

/** null means discovery has not established whether the installed CLI supports this control. */
export function providerControlState(
  provider: AgentProvider,
  capability: { available: boolean; supportsModel?: boolean },
) {
  const controls = providerControls[provider];
  return {
    ...controls,
    model: controls.model === null ? (capability.supportsModel ?? null) : controls.model,
  };
}

export const GUARANTEES: Record<AgentProvider, readonly Guarantee[]> = {
  claude: toGuarantees(PROVIDER_CAPABILITIES.claude),
  codex: toGuarantees(PROVIDER_CAPABILITIES.codex),
  copilot: toGuarantees(PROVIDER_CAPABILITIES.copilot),
  antigravity: toGuarantees(PROVIDER_CAPABILITIES.antigravity),
  cursor: toGuarantees(PROVIDER_CAPABILITIES.cursor),
};

/** Providers whose process the platform can run inside the OS sandbox today (providers/claude/run.ts). */
export const OS_ISOLATED_PROVIDERS: readonly AgentProvider[] = providersWhere(
  (c) => c.guarantees.osIsolation,
);

/** Providers whose completion path accepts image blocks. Others get a capability error, never a silently dropped image. */
export const VISION_PROVIDERS: readonly AgentProvider[] = providersWhere(
  (c) => c.completion.visionImages,
);

/** Providers whose completion path offers native structured tool calls (see `NativeTools`). */
export const NATIVE_TOOL_PROVIDERS: readonly AgentProvider[] = providersWhere(
  (c) => c.completion.chatNativeTools,
);

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

/**
 * Fail-closed check of what a write step needs; a provider sandbox the step turned off counts as missing. With
 * `isolation.enforce`, guarantees are effective rather than advertised: os_isolation (and, through it, write and network
 * isolation) exist only when the runtime probe succeeded and the provider is wired into the sandbox; every step then
 * requires os_isolation, and coding also network isolation.
 */
export function guaranteeCheck(
  provider: AgentProvider,
  mode: "coding" | "analysis",
  options?: { sandbox?: unknown } | null,
  isolation?: { enforce: boolean; runtimeAvailable: boolean },
): GuaranteeCheck {
  const caps = PROVIDER_CAPABILITIES[provider];
  let provided = [...GUARANTEES[provider]];
  if (options?.sandbox === false) provided = provided.filter((g) => g !== "write_sandbox");
  if (isolation?.enforce) {
    provided = provided.filter((g) => g !== "write_sandbox" && g !== "network_isolation");
    if (isolation.runtimeAvailable && caps.guarantees.osIsolation)
      provided.push("os_isolation", "write_sandbox", "network_isolation");
  }
  const required = [
    ...REQUIRED[mode],
    ...(mode === "coding" && caps.guarantees.writeSandbox ? (["write_sandbox"] as const) : []),
    ...(isolation?.enforce
      ? ([
          "os_isolation",
          ...(mode === "coding" ? (["write_sandbox", "network_isolation"] as const) : []),
        ] as const)
      : []),
  ].filter((g, i, a) => a.indexOf(g) === i) as Guarantee[];
  return {
    required,
    provided,
    unmet: required.filter((g) => !provided.includes(g)),
    degraded: PREFERRED[mode].filter((g) => !provided.includes(g)),
  };
}
