import { z } from "zod";
import { AGENT_PROVIDERS } from "../agent/provider.ts";

const target = z
  .object({
    provider: z.enum(AGENT_PROVIDERS),
    model: z.string().default(""),
    effort: z.enum(["medium", "high"]).optional(),
  })
  .strict();
export const DecisionConfig = z
  .object({
    enabled: z.boolean().default(false),
    primary: target.default({ provider: "antigravity", model: "gemini-flash", effort: "medium" }),
    highComplexityEffort: z.enum(["medium", "high"]).default("high"),
    overrides: z.record(z.string(), target).default({}),
    fallback: z
      .object({
        enabled: z.boolean().default(true),
        providers: z.array(z.enum(AGENT_PROVIDERS)).max(4).default(["codex", "claude", "cursor"]),
        models: z.record(z.string(), z.string()).default({}),
        maxSwitches: z.number().int().min(0).max(3).default(2),
      })
      .default({
        enabled: true,
        providers: ["codex", "claude", "cursor"],
        models: {},
        maxSwitches: 2,
      }),
    timeoutMs: z.number().int().min(100).max(180000).default(60000),
    rateLimitRetries: z.number().int().min(0).max(2).default(1),
    cache: z.boolean().default(true),
    observability: z.boolean().default(true),
    maxInputChars: z.number().int().min(1000).max(64000).default(24000),
  })
  .strict();
export type DecisionConfig = z.infer<typeof DecisionConfig>;
