import { isDeepStrictEqual } from "node:util";
import { StepSpec } from "./types.ts";
import { applyProfile, type Profile } from "./profiles.ts";
import { validateSpec } from "./graph.ts";
import type { BusinessRisk, WorkflowSpec } from "./types.ts";
export type { BusinessRisk } from "./types.ts";
const order: Profile[] = ["MICRO", "FAST", "STANDARD", "DEEP"];
export interface ProfileTransitionInput {
  original: WorkflowSpec;
  current: WorkflowSpec;
  from: Profile;
  target: Profile;
  risk: BusinessRisk;
  reason: string;
  revision: number;
  expectedRevision: number;
  activeKey: string;
  completed: string[];
  running: string[];
}
/** Reconcile only pending work. Completed contracts must remain identical; side effects are never replayed. */
export function planProfileTransition(input: ProfileTransitionInput) {
  if (input.revision !== input.expectedRevision) throw new Error("stale profile graph revision");
  if (!input.reason.trim()) throw new Error("profile transition needs a reason");
  if (input.running.some((key) => key !== input.activeKey))
    throw new Error("concurrent work must stop before profile transition");
  const minimum = input.risk === "high" ? "DEEP" : input.risk === "low" ? "FAST" : "STANDARD";
  const to = order[Math.max(order.indexOf(input.target), order.indexOf(minimum))];
  if (order.indexOf(to) <= order.indexOf(input.from))
    throw new Error("profile transitions must escalate");
  const resolved = applyProfile(input.original, to).spec;
  const steps = resolved.steps
    .map((step) => ({ ...step, config: { ...step.config }, depends_on: [...step.depends_on] }))
    .map((step) =>
      step.key === "self_review" && to !== "FAST"
        ? {
            ...step,
            config: {
              ...step.config,
              independent: true,
              ...(to === "DEEP" ? { strict: true } : {}),
            },
          }
        : step,
    );
  const active = steps.find((step) => step.key === input.activeKey);
  if (!active) throw new Error("target graph cannot resume the active phase");
  // Escalation is not permission to widen scope. Bind an explicit approval to a concrete revised plan.
  if (steps.some((step) => step.key === "approve_profile_scope"))
    throw new Error("scope approval key requires reconciliation");
  const scopePlan = StepSpec.parse({
    key: "profile_scope_plan",
    type: "agent",
    name: "Reassess Scope",
    depends_on: [...active.depends_on],
    config: {
      instructions: `Reassess scope and business risk before resuming code. Reason: ${input.reason}. Return canonical changes: [{repo, files: string[]}], risk (LOW|MEDIUM|HIGH), assumptions and required_tests (executable test IDs only: Go '<module>/<pkg>/TestName' or '<repo>::path/to/file.test.ts', never shell commands). Reuse valid existing analysis and evidence; do not edit files.`,
      output_contract: "{changes: [{repo, files: string[]}], risk, assumptions, required_tests}",
    },
  });
  steps.push(scopePlan);
  steps.push(
    StepSpec.parse({
      key: "approve_profile_scope",
      type: "human_approval",
      name: "Approve Revised Scope",
      depends_on: [scopePlan.key],
      config: {
        message: `Approve the revised scope before changes (${input.risk} risk): ${input.reason}`,
        show_outputs: [scopePlan.key],
        approve_scope_from: scopePlan.key,
        require_scope: true,
      },
    }),
  );
  active.depends_on = ["approve_profile_scope"];
  const retained: string[] = [];
  for (const key of input.completed) {
    const previous = input.current.steps.find((s) => s.key === key);
    const next = steps.find((s) => s.key === key);
    if (!previous) throw new Error(`missing completion contract: ${key}`);
    if (next && !isDeepStrictEqual(previous, next))
      throw new Error(`completed contract changed: ${key}; reconciliation required`);
    if (!next) steps.push(previous); // preserve completed deterministic side effects omitted by the new graph
    retained.push(key);
  }
  if (!steps.some((s) => s.key === input.activeKey))
    throw new Error("target graph cannot resume the active phase");
  return {
    from: input.from,
    to,
    reason: input.reason,
    risk: input.risk,
    revision: input.revision + 1,
    retained,
    graph: validateSpec({ ...resolved, steps }),
  };
}
