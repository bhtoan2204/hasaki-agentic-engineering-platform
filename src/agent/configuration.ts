import { providerControls } from "./providerCapabilities.ts";
import { z } from "zod";
import { config, codexConfig, antigravityConfig, copilotConfig } from "../config.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";

export const ROUTING_SCOPES = ["*", "MICRO", "FAST", "STANDARD", "DEEP"] as const;
export const ROUTING_ROLES = ["agent", "coding_agent", "verifier"] as const;
export const AgentValues = z
  .object({
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
    options: z.object({ sandbox: z.boolean().optional(), max_concurrent: z.number().int().min(1).max(8).optional() }).strict().optional(),
    max_turns: z.number().int().min(1).max(500).optional(),
    timeout_ms: z.number().int().min(1000).max(86_400_000).optional(),
  })
  .strict();
export type AgentValues = z.infer<typeof AgentValues>;
export const ProviderConfiguration = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    defaults: AgentValues,
    profiles: z.partialRecord(
      z.enum(ROUTING_SCOPES),
      z.partialRecord(z.enum(ROUTING_ROLES), AgentValues),
    ),
  })
  .strict();
export const AgentConfiguration = z
  .object({
    version: z.literal(1),
    captured_at: z.iso.datetime().optional(),
    capture_source: z.enum(["run-start", "authorized-recovery"]).optional(),
    default_revision: z.number().int().nonnegative().optional(),
    default_provider: z.enum(AGENT_PROVIDERS),
    providers: z.record(z.enum(AGENT_PROVIDERS), ProviderConfiguration),
  })
  .strict();
export type AgentConfiguration = z.infer<typeof AgentConfiguration>;
export type FieldSources = Partial<Record<keyof AgentValues | "options.sandbox" | "options.max_concurrent", string>>;

export { providerControls } from "./providerCapabilities.ts";

export function validateConfigurationValues(provider: AgentProvider, values: AgentValues) {
  const controls = providerControls[provider];
  if (values.max_turns !== undefined && !controls.max_turns)
    throw new Error(`${provider} does not support max_turns`);
  if (values.reasoning_effort && !controls.efforts.includes(values.reasoning_effort)) {
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    throw new Error(provider === "cursor"
      ? "Cursor does not support explicit reasoning_effort"
      : `Unsupported ${label} reasoning_effort`);
  }
  if (values.options && Object.keys(values.options).length && !["antigravity", "copilot"].includes(provider))
    throw new Error(`${provider} does not support these provider options`);
  const model = values.model?.toLowerCase();
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
}

export function parseAgentConfiguration(raw: unknown): AgentConfiguration {
  const document = AgentConfiguration.parse(raw);
  for (const provider of AGENT_PROVIDERS) {
    const entry = document.providers[provider];
    validateConfigurationValues(provider, entry.defaults);
    for (const mapping of Object.values(entry.profiles))
      for (const values of Object.values(mapping ?? {}))
        if (values) validateConfigurationValues(provider, values);
  }
  if (!document.providers[document.default_provider].enabled)
    throw new Error("Default agent provider must be enabled");
  return document;
}

/** Import only routing inputs. Credentials and local transport/security options never enter the document. */
export function legacyAgentConfiguration(): AgentConfiguration {
  const codex = codexConfig(),
    antigravity = antigravityConfig(),
    copilot = copilotConfig();
  const legacy = {
    claude: {
      model: config.model,
      effort: "",
      timeoutMs: 45 * 60_000,
      models: config.agent.models ?? {},
    },
    codex: { ...codex, effort: codex.reasoningEffort },
    cursor: {
      model: "",
      effort: "",
      timeoutMs: Number(process.env.CURSOR_AGENT_TIMEOUT_MS) || 45 * 60_000,
      models: {},
    },
    antigravity,
    copilot,
  };
  return AgentConfiguration.parse({
    version: 1,
    default_provider: config.agent.defaultProvider ?? "claude",
    providers: Object.fromEntries(
      AGENT_PROVIDERS.map((provider) => {
        const old = legacy[provider];
        return [
          provider,
          {
            revision: 0,
            enabled: config.agent.enabledProviders?.[provider] !== false,
            defaults: {
              model: old.model || null,
              reasoning_effort: old.effort || null,
              timeout_ms: old.timeoutMs,
              ...(provider === "antigravity" || provider === "copilot" ? { options: { sandbox: legacy[provider].sandbox, max_concurrent: legacy[provider].maxConcurrent } } : {}),
              ...(provider === "claude" ? { max_turns: config.maxTurns } : {}),
            },
            profiles: Object.fromEntries(
              Object.entries(old.models).map(([scope, roles]) => [
                scope,
                Object.fromEntries(
                  Object.entries(roles)
                    .filter(([, model]) => !!model)
                    .map(([role, model]) => [role, { model }]),
                ),
              ]),
            ),
          },
        ];
      }),
    ),
  });
}

/** Each field inherits independently; null is an intentional account default, not an absent value. */
export function resolveAgentValues(
  document: AgentConfiguration,
  provider: AgentProvider,
  scope: string,
  role: string,
  explicit: AgentValues = {},
): { values: AgentValues; sources: FieldSources } {
  const entry = document.providers[provider];
  if (!entry.enabled)
    throw new Error(`Agent provider ${provider} is disabled in this run configuration`);
  const profiles = entry.profiles as Record<string, Record<string, AgentValues> | undefined>;
  const layers: Array<[string, AgentValues | undefined]> = [
    ["step", explicit],
    [`profile ${scope}/${role}`, profiles[scope]?.[role]],
    [`profile */${role}`, profiles["*"]?.[role]],
    ["provider default", entry.defaults],
  ];
  const values: AgentValues = {},
    sources: FieldSources = {};
  for (const key of ["model", "reasoning_effort", "max_turns", "timeout_ms"] as const) {
    const layer = layers.find(([, value]) => value?.[key] !== undefined);
    if (layer) Object.assign(values, { [key]: layer[1]![key] });
    sources[key] = layer?.[0] ?? "account/CLI default (external)";
  }
  for (const key of ["sandbox", "max_concurrent"] as const) {
    const layer = layers.find(([, value]) => value?.options?.[key] !== undefined);
    if (layer) {
      values.options = { ...values.options, [key]: layer[1]!.options![key] };
      sources[`options.${key}`] = layer[0];
    }
  }
  validateConfigurationValues(provider, values);
  return { values, sources };
}

/** Canonical data is authoritative; legacy inputs are read without mutation and remain stored separately. */
export function convertLegacyConfiguration(
  fallback: AgentConfiguration,
  legacy: Record<string, unknown>,
  canonical?: unknown,
): AgentConfiguration {
  if (canonical !== undefined) return parseAgentConfiguration(canonical);
  const next = structuredClone(fallback);
  if (typeof legacy.defaultProvider === "string" && AGENT_PROVIDERS.includes(legacy.defaultProvider as AgentProvider))
    next.default_provider = legacy.defaultProvider as AgentProvider;
  const flags = legacy.enabledProviders as Record<string, unknown> | undefined;
  for (const provider of AGENT_PROVIDERS) {
    const entry = next.providers[provider];
    if (typeof flags?.[provider] === "boolean") entry.enabled = flags[provider];
    const old = (provider === "claude" ? legacy : legacy[provider]) as Record<string, unknown> | undefined;
    if (!old) continue;
    if (Object.hasOwn(old, "model")) entry.defaults.model = old.model === "" ? null : AgentValues.shape.model.parse(old.model);
    const effort = provider === "codex" ? old.reasoningEffort : old.effort;
    if (effort !== undefined) entry.defaults.reasoning_effort = effort === "" ? null : AgentValues.shape.reasoning_effort.parse(effort);
    if (provider === "claude" && old.maxTurns !== undefined)
      entry.defaults.max_turns = AgentValues.shape.max_turns.parse(old.maxTurns);
    if (provider === "antigravity" || provider === "copilot") {
      if (old.sandbox !== undefined) entry.defaults.options = { ...entry.defaults.options, sandbox: z.boolean().parse(old.sandbox) };
      if (old.maxConcurrent !== undefined) entry.defaults.options = { ...entry.defaults.options, max_concurrent: z.number().int().min(1).max(8).parse(old.maxConcurrent) };
    }
    if (old.models !== undefined) {
      const models = z.record(z.string(), z.record(z.string(), z.string())).parse(old.models);
      entry.profiles = Object.fromEntries(Object.entries(models).map(([scope, roles]) => [scope,
        Object.fromEntries(Object.entries(roles).filter(([, model]) => !!model).map(([role, model]) => [role, { model }])),
      ]));
    }
  }
  return parseAgentConfiguration(next);
}

export const ProviderPatch = ProviderConfiguration.omit({ revision: true }).partial();
export function patchProviderConfiguration(
  document: AgentConfiguration,
  provider: AgentProvider,
  revision: number,
  raw: unknown,
): AgentConfiguration {
  if (document.providers[provider].revision !== revision) throw new Error("Agent configuration revision conflict");
  const patch = ProviderPatch.parse(raw);
  const next = structuredClone(document);
  next.providers[provider] = { ...next.providers[provider], ...patch, revision: revision + 1 };
  return parseAgentConfiguration(next);
}
