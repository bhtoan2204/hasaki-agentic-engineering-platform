import { config } from "../config.ts";
import { z } from "zod";
import { pool, one, q } from "../db/pool.ts";
import type { RunRow, StepRow } from "../workflow/types.ts";
import { resolveStepAgent } from "../agent/stepAgent.ts";
import { DEFAULT_LIMITS } from "../workflow/decomposition.ts";
import { providerPerformance } from "../learning/providerPerformance.ts";
import { decisionEngine } from "./index.ts";
import type { DecisionConstraints } from "./schemas.ts";

export const RecommendationInput = z
  .object({
    type: z.enum([
      "provider_selection",
      "reasoning_effort",
      "workflow_routing",
      "decomposition",
      "recovery",
    ]),
    stepKey: z.string().max(150).optional(),
    question: z.string().max(4000).default(""),
  })
  .strict();
/** Advisory entrypoint for operations that previously had deterministic policy only. Never changes the graph or agent snapshot. */
export async function recommendForRun(runId: number, raw: unknown) {
  if (!config.decisionEngine.enabled) throw new Error("Decision engine disabled");
  const input = RecommendationInput.parse(raw);
  const run = await one<RunRow>(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]);
  if (!run) throw new Error("Run not found");
  const steps = await q<StepRow>(
    pool,
    "SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY position",
    [runId],
  );
  const step = steps.find((s) => s.key === input.stepKey);
  if (input.stepKey && !step) throw new Error("Step not found in this run");
  const constraints: DecisionConstraints = {};
  let extra: unknown = null;
  if (input.type === "provider_selection" || input.type === "reasoning_effort") {
    if (!step) throw new Error("Agent recommendations require stepKey");
    const effective = resolveStepAgent(run, step);
    if (!effective?.model)
      throw new Error("Explicit coding model required; account defaults cannot be ranked safely");
    // A run provider is a user selection. Recommendations may not broaden it to another provider/model.
    constraints.agentOverride = {
      provider: effective.provider,
      model: effective.model,
      ...(effective.reasoning_effort ? { effort: effective.reasoning_effort } : {}),
    };
    if (input.type === "provider_selection") {
      // Readiness and capabilities are checked by the existing handoff readiness adapter; this never invokes handoff.
      const { handoffReadiness } = await import("../agent/handoff.ts");
      const readiness = await handoffReadiness(effective);
      constraints.permittedAgents = [
        {
          provider: effective.provider,
          model: effective.model,
          efforts: effective.reasoning_effort ? [effective.reasoning_effort] : ["medium"],
          available: readiness.ok,
        },
      ];
      extra = await providerPerformance({ ownerId: run.owner_id });
    } else {
      // Until a worker publishes model-specific effort capabilities, an explicit effort cannot be raised by AI.
      if (
        !effective.reasoning_effort ||
        !["low", "medium", "high"].includes(effective.reasoning_effort)
      )
        throw new Error("Explicit supported coding effort required");
      constraints.supportedEfforts = [effective.reasoning_effort];
    }
  }
  if (input.type === "workflow_routing") {
    // Current profile is pinned. Returning advice must never remove gates or re-resolve a running graph.
    constraints.allowedProfiles = run.profile === "DEEP" ? ["DEEP"] : ["STANDARD", "DEEP"];
  }
  if (input.type === "decomposition") {
    constraints.allowedRepositories = run.selected_repositories;
    constraints.expansion = {
      existingKeys: steps.map((s) => s.key),
      allowedRepositories: run.selected_repositories,
      limits: DEFAULT_LIMITS,
      existingSteps: steps.map((s) => ({
        key: s.key,
        depends_on: s.depends_on,
        status: s.status,
        type: s.type,
        subtask_id: s.subtask_id,
        config: { action: s.config.action },
      })),
      planStepKey: step?.key,
      existingSubtasks: steps.filter((s) => s.subtask_id).length,
    };
  }
  if (input.type === "recovery") {
    // With no verified idempotency/failure budget evidence, only non-executing actions are eligible.
    constraints.allowedActions = ["human", "stop", "replan"];
    if (!step || !["FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(step.status))
      throw new Error("Recovery requires a failed or waiting step");
  }
  const revision = JSON.stringify(
    steps.map((s) => [s.id, s.generation, s.status, s.current_attempt_id]),
  );
  const result = await decisionEngine.decide({
    type: input.type,
    input: {
      question: input.question,
      title: run.title,
      profile: run.profile,
      selectedRepositories: run.selected_repositories,
      steps: steps.map((s) => ({
        key: s.key,
        type: s.type,
        status: s.status,
        depends_on: s.depends_on,
        subtask_id: s.subtask_id,
        error: s.error?.slice(0, 1000),
      })),
      performance: extra,
    },
    constraints,
    complexity: ["decomposition", "recovery"].includes(input.type) ? "high" : "medium",
    scope: { runId, stepId: step?.id, revision },
  });
  return { ...result, advisoryOnly: true };
}
