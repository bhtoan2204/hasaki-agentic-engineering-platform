import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";

/** Budget gate before the turn starts; run-level spend is checked when the job is queued and after the attempt. */
export async function budgetStage(_s: LifecycleState): Promise<ExecResult | void> {}
