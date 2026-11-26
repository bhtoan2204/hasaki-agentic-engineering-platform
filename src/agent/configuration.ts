import { providerCapabilities } from "./providerCapabilities.ts";
import { z } from "zod";
import { config, codexConfig, antigravityConfig, copilotConfig } from "../config.ts";
import { isOwned } from "../platform/operatorState.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";
import { assertModelAllowed } from "./modelPolicy.ts";

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
    options: z
      .object({
        sandbox: z.boolean().optional(),
        max_concurrent: z.number().int().min(1).max(8).optional(),
      })
      .strict()
      .optional(),
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
    default_sources: z
      .partialRecord(
        z.enum([
          "model",
          "reasoning_effort",
          "max_turns",
          "timeout_ms",
          "options.sandbox",
          "options.max_concurrent",
        ]),
        z.string(),
      )
      .optional(),
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
export interface CompletionRun {
  agent_provider?: string | null;
  profile?: string | null;
  agent_configuration?: AgentConfiguration | null;
}
export type FieldSources = Partial<
  Record<keyof AgentValues | "options.sandbox" | "options.max_concurrent", string>
>;

export { providerControls } from "./providerCapabilities.ts";

export function validateConfigurationValues(provider: AgentProvider, values: AgentValues) {
  const caps = providerCapabilities(provider);
  const controls = caps.controls;
  if (values.max_turns !== undefined && !controls.max_turns)
    throw new Error(`${provider} does not support max_turns`);
  if (values.reasoning_effort && !controls.efforts.includes(values.reasoning_effort)) {
    throw new Error(
      !controls.efforts.length
        ? `${caps.shortLabel} does not support explicit reasoning_effort`
        : `Unsupported ${caps.shortLabel} reasoning_effort`,
    );
  }
  if (values.options && Object.keys(values.options).length && !controls.options.length)
    throw new Error(`${provider} does not support these provider options`);
  assertModelAllowed(values.model, `${provider} configuration`);
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

/** Whether an environment variable named in the table below currently supplies a value (read from config.agentEnv). */
function suppliedByEnvironment(name: string): boolean {
  const e = config.agentEnv;
  const values: Record<string, string | undefined> = {
    CODEX_MODEL: e.codexModel,
    CODEX_REASONING_EFFORT: e.codexReasoningEffort,
    CODEX_TIMEOUT_MS: e.codexTimeoutMs,
    CURSOR_AGENT_TIMEOUT_MS: e.cursorTimeoutMs,
    AGY_MODEL: e.agyModel,
    ANTIGRAVITY_MODEL: e.antigravityModel,
    AGY_EFFORT: e.agyEffort,
    ANTIGRAVITY_EFFORT: e.antigravityEffort,
    AGY_TIMEOUT_MS: e.agyTimeoutMs,
    ANTIGRAVITY_TIMEOUT_MS: e.antigravityTimeoutMs,
    AGY_SANDBOX: e.agySandbox,
    AGY_MAX_CONCURRENT: e.agyMaxConcurrent,
    COPILOT_MODEL: e.copilotModel,
    COPILOT_EFFORT: e.copilotEffort,
    COPILOT_TIMEOUT_MS: e.copilotTimeoutMs,
    COPILOT_SANDBOX: e.copilotSandbox,
    COPILOT_MAX_CONCURRENT: e.copilotMaxConcurrent,
  };
  return !!values[name];
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
      timeoutMs: config.agent.cursorTimeoutMs ?? 45 * 60_000,
      models: {},
    },
    antigravity,
    copilot,
  };
  const environment: Record<
    AgentProvider,
    Partial<Record<"model" | "reasoning_effort" | "timeout_ms", string[]>>
  > = {
    claude: {},
    codex: {
      model: ["CODEX_MODEL"],
      reasoning_effort: ["CODEX_REASONING_EFFORT"],
      timeout_ms: ["CODEX_TIMEOUT_MS"],
    },
    cursor: { timeout_ms: ["CURSOR_AGENT_TIMEOUT_MS"] },
    antigravity: {
      model: ["AGY_MODEL", "ANTIGRAVITY_MODEL"],
      reasoning_effort: ["AGY_EFFORT", "ANTIGRAVITY_EFFORT"],
      timeout_ms: ["AGY_TIMEOUT_MS", "ANTIGRAVITY_TIMEOUT_MS"],
    },
    copilot: {
      model: ["COPILOT_MODEL"],
      reasoning_effort: ["COPILOT_EFFORT"],
      timeout_ms: ["COPILOT_TIMEOUT_MS"],
    },
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
            default_sources: Object.fromEntries(
              [
                "model",
                "reasoning_effort",
                "timeout_ms",
                "max_turns",
                "options.sandbox",
                "options.max_concurrent",
              ].map((key) => {
                const env = environment[provider][
                  key as "model" | "reasoning_effort" | "timeout_ms"
                ]?.find((name) => suppliedByEnvironment(name));
                const optionEnv =
                  key === "options.sandbox"
                    ? provider === "copilot"
                      ? "COPILOT_SANDBOX"
                      : "AGY_SANDBOX"
                    : key === "options.max_concurrent"
                      ? provider === "copilot"
                        ? "COPILOT_MAX_CONCURRENT"
                        : "AGY_MAX_CONCURRENT"
                      : undefined;
                const ownedKey =
                  key === "reasoning_effort"
                    ? provider === "codex"
                      ? "reasoningEffort"
                      : "effort"
                    : key;
                const selectedEnv =
                  env ?? (optionEnv && suppliedByEnvironment(optionEnv) ? optionEnv : undefined);
                return [
                  key,
                  selectedEnv && !isOwned(`${provider}.${ownedKey}`)
                    ? `environment ${selectedEnv}`
                    : "legacy provider default",
                ];
              }),
            ),
            defaults: {
              model: old.model || null,
              reasoning_effort: old.effort || null,
              timeout_ms: old.timeoutMs,
              ...(provider === "antigravity" || provider === "copilot"
                ? {
                    options: {
                      sandbox: legacy[provider].sandbox,
                      max_concurrent: legacy[provider].maxConcurrent,
                    },
                  }
                : {}),
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
    sources[key] =
      layer?.[0] === "provider default"
        ? (entry.default_sources?.[key] ?? "provider default")
        : (layer?.[0] ?? "account/CLI default (external)");
  }
  for (const key of ["sandbox", "max_concurrent"] as const) {
    const layer = layers.find(([, value]) => value?.options?.[key] !== undefined);
    if (layer) {
      values.options = { ...values.options, [key]: layer[1]!.options![key] };
      sources[`options.${key}`] =
        layer[0] === "provider default"
          ? (entry.default_sources?.[`options.${key}`] ?? layer[0])
          : layer[0];
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
  if (
    typeof legacy.defaultProvider === "string" &&
    AGENT_PROVIDERS.includes(legacy.defaultProvider as AgentProvider)
  )
    next.default_provider = legacy.defaultProvider as AgentProvider;
  const flags = legacy.enabledProviders as Record<string, unknown> | undefined;
  for (const provider of AGENT_PROVIDERS) {
    const entry = next.providers[provider];
    if (typeof flags?.[provider] === "boolean") entry.enabled = flags[provider];
    const old = (provider === "claude" ? legacy : legacy[provider]) as
      Record<string, unknown> | undefined;
    if (!old) continue;
    if (Object.hasOwn(old, "model"))
      entry.defaults.model = old.model === "" ? null : AgentValues.shape.model.parse(old.model);
    const effort = provider === "codex" ? old.reasoningEffort : old.effort;
    if (effort !== undefined)
      entry.defaults.reasoning_effort =
        effort === "" ? null : AgentValues.shape.reasoning_effort.parse(effort);
    if (provider === "claude" && old.maxTurns !== undefined)
      entry.defaults.max_turns = AgentValues.shape.max_turns.parse(old.maxTurns);
    if (provider === "antigravity" || provider === "copilot") {
      if (old.sandbox !== undefined)
        entry.defaults.options = {
          ...entry.defaults.options,
          sandbox: z.boolean().parse(old.sandbox),
        };
      if (old.maxConcurrent !== undefined)
        entry.defaults.options = {
          ...entry.defaults.options,
          max_concurrent: z.number().int().min(1).max(8).parse(old.maxConcurrent),
        };
    }
    if (old.models !== undefined) {
      const models = z.record(z.string(), z.record(z.string(), z.string())).parse(old.models);
      entry.profiles = Object.fromEntries(
        Object.entries(models).map(([scope, roles]) => [
          scope,
          Object.fromEntries(
            Object.entries(roles)
              .filter(([, model]) => !!model)
              .map(([role, model]) => [role, { model }]),
          ),
        ]),
      );
    }
    entry.default_sources = {
      ...entry.default_sources,
      ...(Object.hasOwn(old, "model") ? { model: "provider default" } : {}),
      ...(effort !== undefined ? { reasoning_effort: "provider default" } : {}),
      ...(provider === "claude" && old.maxTurns !== undefined
        ? { max_turns: "provider default" }
        : {}),
      ...(old.sandbox !== undefined ? { "options.sandbox": "provider default" } : {}),
      ...(old.maxConcurrent !== undefined ? { "options.max_concurrent": "provider default" } : {}),
    };
  }
  return parseAgentConfiguration(next);
}

export const ProviderPatch = ProviderConfiguration.omit({
  revision: true,
  default_sources: true,
})
  .partial()
  .extend({
    default_fields: z
      .array(
        z.enum([
          "model",
          "reasoning_effort",
          "max_turns",
          "timeout_ms",
          "options.sandbox",
          "options.max_concurrent",
        ]),
      )
      .max(6)
      .optional(),
  })
  .refine(
    (patch) => !patch.default_fields?.length || patch.defaults !== undefined,
    "Edited default fields require defaults",
  );
export function patchProviderConfiguration(
  document: AgentConfiguration,
  provider: AgentProvider,
  revision: number,
  raw: unknown,
): AgentConfiguration {
  if (document.providers[provider].revision !== revision)
    throw new Error("Agent configuration revision conflict");
  const patch = ProviderPatch.parse(raw);
  const { default_fields, ...settings } = patch;
  const next = structuredClone(document);
  const old = document.providers[provider];
  next.providers[provider] = { ...next.providers[provider], ...settings, revision: revision + 1 };
  if (default_fields !== undefined) {
    const defaults = structuredClone(old.defaults);
    const sources = { ...old.default_sources };
    for (const key of default_fields) {
      if (key === "options.sandbox" || key === "options.max_concurrent") {
        const option = key === "options.sandbox" ? "sandbox" : "max_concurrent";
        const value = patch.defaults?.options?.[option];
        defaults.options = { ...defaults.options };
        if (value === undefined) delete defaults.options[option];
        else Object.assign(defaults.options, { [option]: value });
        sources[key] = value === undefined ? "legacy provider default" : "provider default";
      } else {
        const value = patch.defaults?.[key];
        if (value === undefined) delete defaults[key];
        else Object.assign(defaults, { [key]: value });
        sources[key] = value === undefined ? "legacy provider default" : "provider default";
      }
    }
    next.providers[provider].defaults = defaults;
    next.providers[provider].default_sources = sources;
  } else if (patch.defaults) {
    next.providers[provider].default_sources = Object.fromEntries(
      (["model", "reasoning_effort", "timeout_ms", "max_turns"] as const).map((key) => [
        key,
        patch.defaults![key] !== undefined ? "provider default" : "legacy provider default",
      ]),
    );
    for (const key of ["sandbox", "max_concurrent"] as const)
      next.providers[provider].default_sources![`options.${key}`] =
        patch.defaults.options?.[key] !== undefined
          ? "provider default"
          : "legacy provider default";
  }
  return parseAgentConfiguration(next);
}

/** Draft previews apply precisely the same edits and source rules as persistence. */
export function previewAgentValues(
  document: AgentConfiguration,
  provider: AgentProvider,
  scope: string,
  role: string,
  draft: unknown,
) {
  const patch = ProviderPatch.parse(draft);
  const preview = patchProviderConfiguration(
    document,
    provider,
    document.providers[provider].revision,
    { ...patch, enabled: true },
  );
  return resolveAgentValues(refreshEnvironmentDefaults(preview), provider, scope, role);
}

/** Refresh only imported fallback inputs. Explicitly saved defaults and old run snapshots remain untouched. */
export function refreshEnvironmentDefaults(document: AgentConfiguration): AgentConfiguration {
  const next = structuredClone(document);
  const current = legacyAgentConfiguration();
  for (const provider of AGENT_PROVIDERS) {
    const entry = next.providers[provider];
    for (const key of ["model", "reasoning_effort", "timeout_ms", "max_turns"] as const) {
      const source = entry.default_sources?.[key];
      if (source?.startsWith("environment ") || source === "legacy provider default") {
        const value = current.providers[provider].defaults[key];
        if (value === undefined) delete entry.defaults[key];
        else Object.assign(entry.defaults, { [key]: value });
        entry.default_sources = {
          ...entry.default_sources,
          [key]: current.providers[provider].default_sources?.[key],
        };
      }
    }
    if (provider === "copilot" || provider === "antigravity")
      for (const key of ["sandbox", "max_concurrent"] as const) {
        const source = entry.default_sources?.[`options.${key}`];
        if (
          entry.defaults.options?.[key] === undefined ||
          source?.startsWith("environment ") ||
          source === "legacy provider default"
        ) {
          entry.defaults.options = {
            ...entry.defaults.options,
            [key]: current.providers[provider].defaults.options?.[key],
          };
          entry.default_sources = {
            ...entry.default_sources,
            [`options.${key}`]: current.providers[provider].default_sources?.[`options.${key}`],
          };
        }
      }
  }
  return next;
}
