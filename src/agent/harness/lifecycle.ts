import type { ExecResult } from "../../workflow/types.ts";

/** Fixed order of one agent attempt; see docs/architecture/execution-lifecycle.md. */
export const STAGE_ORDER = [
  "preflight",
  "context",
  "authorize",
  "budget",
  "checkpoint",
  "execute",
  "output",
  "verify",
  "finalize",
] as const;
export type StageName = (typeof STAGE_ORDER)[number];

/** A stage either stops the attempt with its result or lets the next stage run. */
export type Stage<S> = (state: S) => Promise<ExecResult | void>;
export type Stages<S> = Record<StageName, Stage<S>>;

export interface StageTrace {
  stage: StageName;
  ms: number;
  outcome: "continue" | ExecResult["kind"] | "error";
}

export class LifecycleIncompleteError extends Error {}

/** Runs every stage in STAGE_ORDER until one returns a result; `finalize` must return one. */
export async function runLifecycle<S>(
  state: S,
  stages: Stages<S>,
  trace: StageTrace[] = [],
): Promise<ExecResult> {
  for (const stage of STAGE_ORDER) {
    const started = Date.now();
    let result: ExecResult | void;
    try {
      result = await stages[stage](state);
    } catch (error) {
      trace.push({ stage, ms: Date.now() - started, outcome: "error" });
      throw error;
    }
    trace.push({ stage, ms: Date.now() - started, outcome: result ? result.kind : "continue" });
    if (result) return result;
  }
  throw new LifecycleIncompleteError("agent lifecycle finished without a result");
}
