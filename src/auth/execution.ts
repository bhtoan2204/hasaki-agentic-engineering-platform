import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a piece of work is running as. Workers set this from the persisted run owner.
 * It is not optional ambient identity and it never rewrites process-global config.
 */
export type ExecutionPrincipal = { userId: number; runId?: number; evaluation?: { codeIntelligence: boolean; fixtureAgent?: boolean }; kind: "user" | "run" };

export const execution = new AsyncLocalStorage<ExecutionPrincipal>();

export function currentUserId(): number | null {
  const id = execution.getStore()?.userId;
  return typeof id === "number" && id > 0 ? id : null;
}
