import type { RunStatus, StepStatus } from "./types.ts";

/**
 * Allowed step transitions. Every status change in the engine goes through `assertStepTransition`,
 * so an illegal jump (e.g. COMPLETED -> RUNNING without re-execution) fails loudly inside the transaction.
 */
export const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  PENDING: ["READY", "SKIPPED", "CANCELED", "WAITING_APPROVAL"],
  READY: ["RUNNING", "CANCELED", "SKIPPED", "WAITING_APPROVAL", "PENDING"],
  RUNNING: ["COMPLETED", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL", "RETRYING", "CANCELED", "PENDING", "READY"],
  // SKIPPED: the developer chose "skip this step" while it was waiting (skipStep allows it from these states).
  WAITING_INPUT: ["READY", "COMPLETED", "CANCELED", "PENDING", "FAILED", "SKIPPED"],
  WAITING_APPROVAL: ["COMPLETED", "READY", "FAILED", "CANCELED", "PENDING", "SKIPPED"],
  RETRYING: ["RUNNING", "READY", "FAILED", "CANCELED", "PENDING"],
  FAILED: ["READY", "SKIPPED", "CANCELED", "PENDING"],
  COMPLETED: ["READY", "PENDING"],
  SKIPPED: ["READY", "PENDING"],
  CANCELED: ["READY", "PENDING"],
};

export class TransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`illegal ${entity} transition ${from} -> ${to}`);
  }
}

export function canTransitionStep(from: StepStatus, to: StepStatus) {
  return from === to || STEP_TRANSITIONS[from].includes(to);
}

export function assertStepTransition(from: StepStatus, to: StepStatus) {
  if (!canTransitionStep(from, to)) throw new TransitionError("step", from, to);
}

export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  PENDING: ["RUNNING", "CANCELED"],
  RUNNING: ["PAUSED", "WAITING", "COMPLETED", "FAILED", "CANCELED"],
  WAITING: ["RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELED"],
  PAUSED: ["RUNNING", "CANCELED"],
  // A finished run can be re-opened by retrying / re-executing a step.
  COMPLETED: ["RUNNING", "WAITING"],
  FAILED: ["RUNNING", "WAITING", "CANCELED"],
  CANCELED: [],
};

export function assertRunTransition(from: RunStatus, to: RunStatus) {
  if (from !== to && !RUN_TRANSITIONS[from].includes(to)) throw new TransitionError("run", from, to);
}

/** Statuses that satisfy a dependency. */
export const DONE: readonly StepStatus[] = ["COMPLETED", "SKIPPED"];
/** Statuses a step can be manually re-executed from. */
export const RETRYABLE: readonly StepStatus[] = ["FAILED", "COMPLETED", "CANCELED", "SKIPPED", "WAITING_INPUT", "WAITING_APPROVAL"];

/**
 * Derive the run status from its steps. PAUSED and CANCELED are sticky: only explicit actions leave them.
 */
export function deriveRunStatus(current: RunStatus, steps: { status: StepStatus; depends_on: string[]; key: string }[]): RunStatus {
  if (current === "PAUSED" || current === "CANCELED") return current;
  const has = (...s: StepStatus[]) => steps.some((x) => s.includes(x.status));
  if (has("READY", "RUNNING", "RETRYING")) return "RUNNING";
  if (has("WAITING_INPUT", "WAITING_APPROVAL")) return "WAITING";
  if (steps.every((s) => DONE.includes(s.status))) return "COMPLETED";
  if (has("FAILED", "CANCELED")) return "FAILED";
  // Only PENDING steps whose dependencies are not satisfiable remain, or the run has not advanced yet.
  return "RUNNING";
}
