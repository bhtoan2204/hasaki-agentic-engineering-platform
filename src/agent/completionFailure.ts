import type { FailureCategory } from "./telemetry.ts";

/** An auxiliary completion error that carries the same failure category the agent turns report. */
export function completionFailure(
  message: string,
  failure: FailureCategory,
): Error & { failure: FailureCategory } {
  return Object.assign(new Error(message), { failure });
}
