import { type ResolvedContext, type StepInput } from "../context.ts";
import type { AttemptRow, RunRow, StepRow } from "../types.ts";

// ---------------------------------------------------------------- worker side

export interface BegunAttempt {
  run: RunRow;
  step: StepRow;
  attempt: AttemptRow;
  input: StepInput;
  context: ResolvedContext;
}

export interface PreparedHandoff {
  content?: unknown;
  fingerprint?: string;
  blocked?: string;
  failure?: string | null;
}
