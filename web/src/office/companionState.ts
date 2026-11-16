import type { AgentView, OfficeSnapshot, StepLite } from "./types.ts";

export const COMPANION_STATES = [
  "IDLE",
  "WALKING",
  "WORKING",
  "THINKING",
  "RESEARCHING",
  "CODING",
  "TESTING",
  "REVIEWING",
  "WAITING",
  "ASKING",
  "APPROVAL_REQUIRED",
  "SUCCESS",
  "CELEBRATING",
  "FAILED",
  "RETRYING",
  "HANDOFF",
  "SLEEPING",
] as const;
export type CompanionState = (typeof COMPANION_STATES)[number];
export interface CompanionActivity {
  state: CompanionState;
  run: OfficeSnapshot["run"];
  step: StepLite | null;
  role: AgentView["role"] | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  failureCategory: string | null;
  detail: string | null;
  action: "run" | "question" | "approval" | "handoff" | "failure" | "office";
}

const STATUS_WEIGHT: Record<string, number> = {
  WAITING_INPUT: 0,
  WAITING_APPROVAL: 0,
  RETRYING: 1,
  RUNNING: 1,
  WAITING: 2,
  PAUSED: 2,
  FAILED: 4,
  COMPLETED: 4,
  CANCELED: 4,
};

/** Human gates and active runs take precedence over history. No state is synthesized from elapsed time. */
export function prioritizeCompanionRuns(runs: any[]) {
  return (
    [...runs].sort((a, b) => {
      const weight = (r: any) => {
        const stepWeights = (r.steps ?? []).map(
          (s: any) => STATUS_WEIGHT[s.status] ?? 20,
        );
        return Math.min(STATUS_WEIGHT[r.status] ?? 20, ...stepWeights);
      };
      const timestamp = (r: any) =>
        Date.parse(String(r.updated_at ?? r.created_at ?? "")) || 0;
      return (
        weight(a) - weight(b) ||
        timestamp(b) - timestamp(a) ||
        Number(b.id) - Number(a.id)
      );
    })[0] ?? null
  );
}

function isHandoff(step: any) {
  return !!(
    step?.handoff ||
    step?.pending_input?.provider_handoff ||
    step?.input?.pending?.provider_handoff
  );
}
function providerFailureCategory(attempt: any) {
  return (
    String(
      attempt?.normalized_failure_category ??
        attempt?.failure_category ??
        attempt?.metrics?.normalized_failure_category ??
        attempt?.error?.failure_category ??
        "",
    ).toUpperCase() || null
  );
}

/** A compact display state derived only from the canonical office mapper and run/step records. */
export function companionActivity(
  run: OfficeSnapshot["run"],
  step: StepLite | null,
  agent: AgentView | null,
  attempt: any,
  now: number,
  pendingQuestion = false,
): CompanionActivity {
  const detail = step?.name || null;
  const provider =
    attempt?.provider ??
    attempt?.metrics?.provider ??
    (step as any)?.agent?.provider ??
    (run as any)?.agent_provider ??
    null;
  const model =
    attempt?.model ??
    attempt?.metrics?.model ??
    (step as any)?.agent?.model ??
    null;
  const failureCategory = providerFailureCategory(attempt);
  const common = {
    run,
    step,
    role: agent?.role ?? null,
    provider: provider ? String(provider) : null,
    model: model ? String(model) : null,
    status: step?.status ?? run?.status ?? null,
    failureCategory,
    detail,
    action: "run" as const,
  };
  if (!run) return { ...common, state: "SLEEPING", action: "office" };
  if (step && isHandoff(step))
    return { ...common, state: "HANDOFF", action: "handoff" };
  if (
    step?.status === "FAILED" &&
    ["RATE_LIMIT", "QUOTA_EXHAUSTED", "PROVIDER_UNAVAILABLE"].includes(
      failureCategory ?? "",
    )
  )
    return { ...common, state: "HANDOFF", action: "handoff" };
  if (
    step?.status === "WAITING_INPUT" ||
    pendingQuestion ||
    agent?.pose === "ask"
  )
    return { ...common, state: "ASKING", action: "question" };
  if (step?.status === "WAITING_APPROVAL" || agent?.pose === "approval")
    return { ...common, state: "APPROVAL_REQUIRED", action: "approval" };
  if (
    step?.status === "FAILED" ||
    run.status === "FAILED" ||
    agent?.pose === "frustrated"
  )
    return { ...common, state: "FAILED", action: "failure" };
  if (step?.status === "RETRYING" || agent?.retrying)
    return { ...common, state: "RETRYING" };
  if (step?.status === "RUNNING") {
    if (agent?.activity === "testing" || step?.type === "command")
      return { ...common, state: "TESTING" };
    if (
      agent?.activity === "reviewing" ||
      /review|audit|security/i.test(`${step?.key} ${step?.name}`)
    )
      return { ...common, state: "REVIEWING" };
    if (
      ["searching", "reading", "browsing", "knowledge"].includes(
        agent?.activity ?? "",
      )
    )
      return { ...common, state: "RESEARCHING" };
    if (["thinking", "sketching", "planning"].includes(agent?.activity ?? ""))
      return { ...common, state: "THINKING" };
    if (step?.type === "coding_agent") return { ...common, state: "CODING" };
    return { ...common, state: "WORKING" };
  }
  if (
    step?.status === "COMPLETED" &&
    !["COMPLETED", "CANCELED", "FAILED"].includes(run.status)
  )
    return { ...common, state: "SUCCESS" };
  if (run.status === "COMPLETED") {
    const finished = attempt?.finished_at ? Date.parse(attempt.finished_at) : 0;
    if (finished && now - finished >= 0 && now - finished < 9000)
      return { ...common, state: "CELEBRATING" };
  }
  if (run.status === "PAUSED" || run.status === "WAITING")
    return { ...common, state: "WAITING" };
  return { ...common, state: "SLEEPING", action: "office" };
}
