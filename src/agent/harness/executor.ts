import type { StepExecutor } from "../../workflow/executors/registry.ts";
import type { ExecResult } from "../../workflow/types.ts";
import { liveRuntime } from "../../eval/liveRuntime.ts";
import { captureContextContinuity } from "../../context/continuity.ts";
import { contextPackFailure } from "../../context/pack.ts";
import { runLifecycle, type Stages } from "./lifecycle.ts";
import { harnessEvidence } from "./evidence.ts";
import { newLifecycleState, type LifecycleState } from "./state.ts";
import { preflightStage } from "./stages/preflight.ts";
import { contextStage } from "./stages/context.ts";
import { authorizeStage } from "./stages/authorize.ts";
import { budgetStage } from "./stages/budget.ts";
import { checkpointStage } from "./stages/checkpoint.ts";
import { executeStage } from "./stages/execute.ts";
import { outputStage } from "./stages/output.ts";
import { verifyStage } from "./stages/verify.ts";
import { finalizeStage } from "./stages/finalize.ts";
import { log } from "../../logging.ts";

export const AGENT_STAGES: Stages<LifecycleState> = {
  preflight: preflightStage,
  context: contextStage,
  authorize: authorizeStage,
  budget: budgetStage,
  checkpoint: checkpointStage,
  execute: executeStage,
  output: outputStage,
  verify: verifyStage,
  finalize: finalizeStage,
};

/** The step executor for every agent provider: one lifecycle, then durable context continuity. */
export const agentExecutor: StepExecutor = {
  async execute(ctx) {
    let result: ExecResult | undefined;
    try {
      const live = liveRuntime.getStore();
      if (ctx.step.config?.evaluation_phase && !live) {
        const { executeProviderPhase } = await import("../../eval/providerPhase.ts");
        result = await executeProviderPhase(ctx);
        return result;
      }
      const state = newLifecycleState(ctx, live);
      try {
        result = await runLifecycle(state, AGENT_STAGES, state.trace);
        return result;
      } finally {
        try {
          const evidence = harnessEvidence(state, result);
          await ctx.artifact(
            "harness_evidence",
            "agent lifecycle evidence",
            JSON.stringify(evidence),
            evidence,
          );
        } catch (error) {
          log.error(`harness evidence persistence failed: ${(error as Error).message}`);
        }
      }
    } finally {
      await captureContextContinuity(ctx, result).catch((error) =>
        log.error(`context continuity persistence failed: ${contextPackFailure(error)}`),
      );
    }
  },
};
