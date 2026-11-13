import { z } from "zod";
import { config, codexConfig, antigravityConfig } from "../config.ts";
import { agentProvider, AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";

export const FallbackPolicy = z
  .object({
    mode: z.enum(["disabled", "manual", "automatic"]).default("manual"),
    providers: z
      .array(z.enum(AGENT_PROVIDERS))
      .min(1)
      .max(4)
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
export const fallbackPolicy = (step: { config: Record<string, any> }) =>
  FallbackPolicy.parse(step.config.agent?.fallback ?? step.config.fallback ?? {});

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
      .nullable()
      .optional(),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional(),
    execution_profile: z.enum(["FAST", "STANDARD", "DEEP"]).optional(),
    timeout_ms: z.number().int().min(1000).max(86_400_000).optional(),
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
  execution_profile: "FAST" | "STANDARD" | "DEEP";
  source: string;
}

export function validateAgentOptions(a: StepAgentConfig, provider = a.provider) {
  if (!provider) return;
  const model = a.model?.toLowerCase();
  if (model && provider === "codex" && /claude|^(sonnet|opus|haiku)/.test(model))
    throw new Error("Codex cannot use a Claude model identifier");
  if (model && provider === "claude" && /^(gpt|codex|o[134](?:-|$))/.test(model))
    throw new Error("Claude cannot use a Codex/OpenAI model identifier");
  if (model && provider === "cursor" && /^claude-/.test(model))
    throw new Error("Cursor requires its own model alias, not a Claude SDK model identifier");
  if (model && provider === "antigravity" && /^(o[134](?:-|$))/.test(model))
    throw new Error(
      "Antigravity requires supported Gemini, Claude, or OSS models, not OpenAI model identifiers",
    );
  if (a.reasoning_effort) {
    if (provider === "cursor") throw new Error("Cursor does not support explicit reasoning_effort");
    if (provider === "claude" && ["none", "minimal"].includes(a.reasoning_effort))
      throw new Error("Unsupported Claude reasoning_effort");
    if (provider === "codex" && a.reasoning_effort === "max")
      throw new Error("Unsupported Codex reasoning_effort");
    if (provider === "antigravity" && ["none", "minimal"].includes(a.reasoning_effort))
      throw new Error("Unsupported Antigravity reasoning_effort");
  }
  if (provider === "cursor" && a.allowed_tools != null)
    throw new Error(
      "Cursor cannot enforce a custom native tool allowlist; use its existing platform policy",
    );
}

export function modelFor(
  step: { type: string; config: Record<string, any> },
  profile?: string | null,
): { model: string; source: string } {
  if (typeof step.config.model === "string" && step.config.model)
    return { model: step.config.model, source: "step config" };
  const role = step.config.independent === true ? "verifier" : step.type;
  for (const scope of [profile ?? "", "*"]) {
    const m = config.agent.models?.[scope]?.[role];
    if (m) return { model: m, source: `routing ${scope}/${role}` };
  }
  return {
    model: config.model ?? "",
    source: config.model ? "global default" : "sdk default",
  };
}
export function codexModelFor(
  step: { type: string; config: Record<string, any> },
  profile?: string | null,
): { model: string; source: string; effort: string } {
  const c = codexConfig();
  const effort = step.config.codex_reasoning_effort || c.reasoningEffort;
  if (step.config.codex_model)
    return {
      model: step.config.codex_model,
      source: "step config (codex_model)",
      effort,
    };
  const role = step.config.independent === true ? "verifier" : step.type;
  for (const scope of [profile ?? "", "*"]) {
    const model = c.models[scope]?.[role];
    if (model) return { model, source: `codex routing ${scope}/${role}`, effort };
  }
  return {
    model: c.model,
    source: c.model ? "agent.codex.model" : "codex account default",
    effort,
  };
}

export function antigravityModelFor(
  step: { type: string; config: Record<string, any> },
  profile?: string | null,
): { model: string; source: string; effort: string } {
  const c = antigravityConfig();
  const effort =
    step.config.agent?.reasoning_effort ||
    step.config.antigravity_effort ||
    step.config.effort ||
    c.effort;
  if (step.config.agent?.model)
    return {
      model: step.config.agent.model,
      source: "step config (agent.model)",
      effort,
    };
  if (step.config.antigravity_model)
    return {
      model: step.config.antigravity_model,
      source: "step config (antigravity_model)",
      effort,
    };
  const role = step.config.independent === true ? "verifier" : step.type;
  for (const scope of [profile ?? "", "*"]) {
    const model = c.models[scope]?.[role];
    if (model) return { model, source: `antigravity routing ${scope}/${role}`, effort };
  }
  return {
    model: c.model,
    source: c.model ? "agent.antigravity.model" : "antigravity default",
    effort,
  };
}

/** Resolve once at claim time; the persisted result is the execution authority. */
export function resolveStepAgent(
  run: { agent_provider?: string | null; profile?: string | null },
  step: { type: string; config: Record<string, any>; agent_override?: unknown },
): EffectiveAgent | null {
  if (!["agent", "coding_agent"].includes(step.type)) return null;
  step = { ...step, config: step.config ?? {} };
  const base = StepAgentConfig.parse(step.config.agent ?? {});
  const override = step.agent_override == null ? null : StepAgentConfig.parse(step.agent_override);
  const changedProvider =
    override?.provider != null && override.provider !== (base.provider ?? agentProvider(run));
  const merged = {
    ...base,
    ...(changedProvider ? { model: null, reasoning_effort: null } : {}),
    ...override,
  };
  const provider =
    merged.provider ??
    (run.agent_provider ? agentProvider(run) : (config.agent.defaultProvider ?? "claude"));
  validateAgentOptions(merged, provider);
  const profile = merged.execution_profile ?? run.profile ?? "STANDARD";
  const legacy = { ...step, config: { ...step.config } };
  if (Object.hasOwn(merged, "model")) {
    delete legacy.config.model;
    delete legacy.config.codex_model;
    delete legacy.config.antigravity_model;
  }
  const routed =
    provider === "claude"
      ? modelFor(legacy, profile)
      : provider === "codex"
        ? codexModelFor(legacy, profile)
        : provider === "antigravity"
          ? antigravityModelFor(legacy, profile)
          : { model: "" };
  const model = merged.model ?? routed.model ?? null;
  const reasoning_effort =
    merged.reasoning_effort === undefined && (provider === "codex" || provider === "antigravity")
      ? (provider === "codex"
          ? codexModelFor(legacy, profile).effort
          : antigravityModelFor(legacy, profile).effort) || null
      : merged.reasoning_effort;
  validateAgentOptions(
    {
      ...merged,
      model: model || null,
      reasoning_effort: reasoning_effort as StepAgentConfig["reasoning_effort"],
    },
    provider,
  );
  return {
    ...merged,
    provider,
    model: model || null,
    reasoning_effort: reasoning_effort as EffectiveAgent["reasoning_effort"],
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
  config: Record<string, any>,
  a: EffectiveAgent | null,
): Record<string, any> {
  if (!a) return config;
  return {
    ...config,
    ...(a.context_tokens ? { context_tokens: a.context_tokens } : {}),
    ...(a.verification ? { verify: a.verification } : {}),
  };
}
