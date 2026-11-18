import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { validateExecutionAuthorization } from "../../executionContract.ts";

/** Mandatory execution contract authorization for implementation steps. */
export async function authorizeStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, mode, independent } = s;
  if (mode === "coding" && !independent) {
    const contract = ctx.input.execution_contract;
    const problems = await validateExecutionAuthorization(ctx);
    if (problems.length)
      return {
        kind: "failed",
        retryable: false,
        error: `Mandatory execution contract is incomplete: ${problems.join("; ")}`,
      };
    await ctx.artifact(
      "execution_contract",
      "approved execution contract",
      JSON.stringify(contract),
      contract,
    );
  }
}
