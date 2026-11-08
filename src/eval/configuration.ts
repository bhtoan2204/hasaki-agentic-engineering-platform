import { z } from "zod";
import { StepAgentConfig, validateAgentOptions } from "../agent/stepAgent.ts";
export const ConfigurationSchema = z
  .object({
    provider_sequence: z
      .array(StepAgentConfig.pick({ provider: true, model: true, reasoning_effort: true }).required({ provider: true }))
      .min(1)
      .max(3)
      .optional(),
    context_variant: z.enum(["minimal", "pack", "tools"]).optional(),
    allowed_tools: StepAgentConfig.shape.allowed_tools.optional(),
    context_tokens: z.number().int().min(2000).max(64000).default(24000),
    mode: z.enum(["fixture", "dry_run", "live"]).default("fixture"),
    adapter: z.enum(["baseline", "reference", "agent_fixture", "provider_fixture"]).default("baseline"),
    provider: z.enum(["fixture", "claude", "codex", "cursor"]).default("fixture"),
    model: z.string().max(100).nullable().default(null),
    prompt_version: z.enum(["p2-task-v1", "p2-task-v2"]).default("p2-task-v1"),
    workflow_version: z.literal("p2-workflow-v1").default("p2-workflow-v1"),
    code_intelligence: z.boolean().default(false),
    context_strategy: z.enum(["none", "symbols"]).default("none"),
    repetitions: z.number().int().min(1).max(3).default(1),
    case_limit: z.number().int().min(1).max(20).default(15),
    max_case_seconds: z.number().int().min(1).max(30).default(20),
    max_tokens: z.number().int().min(1).max(20000).default(10000),
    max_cost_usd: z.number().min(0).max(2).default(0),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.provider_sequence) {
      if (c.adapter !== "provider_fixture" && c.mode !== "live")
        ctx.addIssue({
          code: "custom",
          message: "Provider sequences require the provider_fixture adapter or live mode",
        });
      if (!c.context_variant)
        ctx.addIssue({
          code: "custom",
          message: "Provider sequences require an explicit minimal, pack, or tools context variant",
        });
      for (const agent of c.provider_sequence) {
        try {
          validateAgentOptions(agent);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
        }
      }
    } else if (c.adapter === "provider_fixture")
      ctx.addIssue({ code: "custom", message: "provider_fixture requires provider_sequence" });

    if (c.mode !== "live" && c.provider !== "fixture")
      ctx.addIssue({
        code: "custom",
        message: "Fixture runs must be labeled fixture provider",
      });
    if (c.context_strategy === "symbols" && !c.code_intelligence)
      ctx.addIssue({
        code: "custom",
        message: "Symbol context requires code intelligence",
      });
  });
