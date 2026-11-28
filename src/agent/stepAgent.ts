import { z } from "zod";
import { isModelBlocked } from "./modelPolicy.ts";
import {
  AgentValues,
  legacyAgentConfiguration,
  resolveAgentValues,
  validateConfigurationValues,
  type AgentConfiguration,
  type FieldSources,
} from "./configuration.ts";
import {
  agentProvider,
  AGENT_PROVIDERS,
  substituteEnabledProvider,
  type AgentProvider,
} from "./provider.ts";
import { providerCapabilities } from "./providerCapabilities.ts";

export const FallbackPolicy = z
  .object({
    mode: z.enum(["disabled", "manual", "automatic"]).default("manual"),
    providers: z
      .array(z.enum(AGENT_PROVIDERS))
      .min(1)
      .max(5)
      .refine((v) => new Set(v).size === v.length, "Duplicate fallback provider")
      .default(["claude", "codex", "cursor", "antigravity"]),
    max_switches: z.number().int().min(0).max(10).default(2),
    allow_unknown_cost: z.boolean().default(false),
    allow_budget_failure: z.boolean().default(false),
    /** When the chosen agent is disconnected or out of quota, start the next healthy provider. No manual switch step. */
    auto_health: z.boolean().default(true),
    max_reported_cost_usd: z.number().nonnegative().optional(),
    max_reported_tokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type FallbackPolicy = z.infer<typeof FallbackPolicy>;
export const fallbackPolicy = (step: { config: Record<string, unknown> }) => {
  const agent = step.config.agent;
  const fallback =
    agent && typeof agent === "object" && "fallback" in agent ? agent.fallback : undefined;
  return FallbackPolicy.parse(fallback ?? step.config.fallback ?? {});
};

export const StepAgentConfig = z
  .object({
    fallback: FallbackPolicy.optional(),
    provider: z.enum(AGENT_PROVIDERS).optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9._:/-]+$/)
      .refine(
        (m) => !isModelBlocked(m),
        "model is blocked by platform policy (agent.blockedModels)",
      )
      .nullable()
      .optional(),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional(),
    execution_profile: z.enum(["MICRO", "FAST", "STANDARD", "DEEP"]).optional(),
    options: AgentValues.shape.options,
    max_turns: z.number().int().min(1).max(500).optional(),
    timeout_ms: z.number().int().min(1000).max(86_400_000).optional(),
    idle_timeout_ms: z.number().int().min(10_000).max(86_400_000).optional(),
    max_tool_calls: z.number().int().min(1).max(10_000).optional(),
    retry: z
      .object({
        max_attempts: z.number().int().min(1).max(10),
        backoff_seconds: z.number().int().min(0).max(3600).optional(),
      })
      .strict()
      .optional(),
    allowed_tools: z
      .array(
        z
          .string()
          .regex(/^(?:[A-Za-z][A-Za-z0-9_]*|platform\.[a-z_]+|integration:[a-zA-Z0-9_.-]+)$/),
      )
      .max(100)
      .nullable()
      .optional(),
    context_tokens: z.number().int().min(2000).max(64000).optional(),
    verification: z
      .object({
        command: z.string().trim().min(1).max(8000).optional(),
        max_repairs: z.number().int().min(0).max(5).optional(),
        timeout_seconds: z.number().int().min(30).max(3600).optional(),
        baseline: z.union([z.literal("go"), z.literal(false), z.null()]).optional(),
        allow_test_weakening: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Verification commands remain trusted definition data, never a run-owner override. */
export const StepAgentOverrideConfig = StepAgentConfig.omit({
  verification: true,
  fallback: true,
});
export type StepAgentConfig = z.infer<typeof StepAgentConfig>;
export interface EffectiveAgent extends StepAgentConfig {
  provider: AgentProvider;
  model: string | null;
  execution_profile: "MICRO" | "FAST" | "STANDARD" | "DEEP";
  source: string;
  field_sources?: FieldSources;
}

export function validateAgentOptions(a: StepAgentConfig, provider = a.provider) {
  if (!provider) return;
  validateConfigurationValues(provider, a);
  const caps = providerCapabilities(provider);
  if (caps.guarantees.allowedToolsEnforcement === "unsupported" && a.allowed_tools != null)
    throw new Error(
      `${caps.shortLabel} cannot enforce a custom native tool allowlist; use its existing platform policy`,
    );
  if (!caps.guarantees.microProfile && a.execution_profile === "MICRO")
    throw new Error(
      `${caps.shortLabel} cannot enforce pre-execution tool boundaries required by MICRO profile`,
    );
}

/** Resolve once at claim time; the persisted result is the execution authority. */
export function resolveStepAgent(
  run: {
    agent_provider?: string | null;
    profile?: string | null;
    agent_configuration?: AgentConfiguration | null;
  },
  step: { type: string; config: Record<string, unknown>; agent_override?: unknown },
): EffectiveAgent | null {
  if (!["agent", "coding_agent"].includes(step.type)) return null;
  step = { ...step, config: step.config ?? {} };
  const snapshot = run.agent_configuration ?? legacyAgentConfiguration();
  const base = StepAgentConfig.parse(step.config.agent ?? {});
  const override =
    step.agent_override == null ? null : StepAgentOverrideConfig.parse(step.agent_override);
  const changedProvider =
    override?.provider != null && override.provider !== (base.provider ?? agentProvider(run));
  const merged = {
    ...base,
    ...(changedProvider
      ? { model: undefined, reasoning_effort: undefined, max_turns: undefined, options: undefined }
      : {}),
    ...override,
  };
  let provider =
    merged.provider ?? (run.agent_provider ? agentProvider(run) : snapshot.default_provider);
  validateAgentOptions(merged, provider);
  // A frozen run never substitutes a provider because today's enabled flags changed.
  if (!run.agent_configuration) provider = substituteEnabledProvider(provider);
  const profile =
    run.profile === "MICRO" ? "MICRO" : (merged.execution_profile ?? run.profile ?? "STANDARD");
  if (run.profile === "MICRO") {
    merged.context_tokens = Math.min(12000, merged.context_tokens ?? 12000);
  }
  const explicit = Object.fromEntries(
    (["model", "reasoning_effort", "max_turns", "timeout_ms", "options"] as const)
      .filter((key) => merged[key] !== undefined)
      .map((key) => [key, merged[key]]),
  );
  const role = step.config.independent === true ? "verifier" : step.type;
  const { values, sources } = resolveAgentValues(snapshot, provider, profile, role, explicit);
  if (run.profile === "MICRO") {
    if ((values.timeout_ms ?? 600000) > 600000) sources.timeout_ms = "MICRO safety cap";
    values.timeout_ms = Math.min(600000, values.timeout_ms ?? 600000);
  }
  validateAgentOptions({ ...merged, ...values }, provider);
  return {
    ...merged,
    provider,
    ...values,
    model: values.model ?? null,
    field_sources: sources,
    execution_profile: profile as EffectiveAgent["execution_profile"],
    source: override
      ? "manual override"
      : base.provider
        ? "step"
        : run.agent_provider
          ? "run default"
          : "platform default",
  };
}

export function effectiveStepConfig(
  config: Record<string, unknown>,
  a: EffectiveAgent | null,
): Record<string, unknown> {
  if (!a) return config;
  return {
    ...config,
    ...(a.max_turns !== undefined ? { max_turns: a.max_turns } : {}),
    ...(a.timeout_ms !== undefined ? { timeout_ms: a.timeout_ms } : {}),
    ...(a.context_tokens ? { context_tokens: a.context_tokens } : {}),
    ...(a.verification ? { verify: a.verification } : {}),
  };
}
