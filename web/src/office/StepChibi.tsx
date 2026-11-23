import { ChibiAgent } from "./ChibiAgent.tsx";
import { CHARACTERS } from "./characters.ts";
import type { Activity, Role } from "./types.ts";
import { poseOf, roleOfStep } from "./workflowToAgentMapper.ts";
import "./office.css";
import "./StepChibi.css";

const BY_ROLE: Record<Role, Activity> = {
  analyst: "reading",
  architect: "sketching",
  developer: "typing",
  tester: "testing",
  reviewer: "reviewing",
  pr: "packaging",
};

/** The hands follow the step: brainstorm → thinking, dev → typing, command → terminal, PR → submitting. */
function activityOf(step: { key: string; name?: string; type: string }, role: Role): Activity {
  const text = `${step.key} ${step.name ?? ""}`.toLowerCase();
  if (/brainstorm|ideate|idea|think/.test(text)) return "thinking";
  switch (step.type) {
    case "command":
      return "terminal";
    case "git_pull_request":
      return "submitting";
    case "task_result_report":
      return "writing";
    case "integration":
      return "delegating";
    case "human_input":
      return "asking";
  }
  return BY_ROLE[role];
}

/** Role per step with the whole graph in view, so a human gate takes the character whose work it gates. */
export function rolesOfSteps(
  steps: Array<{ key: string; name?: string; type: string; depends_on?: string[] }>,
): Record<string, Role> {
  return Object.fromEntries(
    steps.map((s) => [s.key, roleOfStep({ ...s, name: s.name ?? s.key }, steps)]),
  );
}

/** The chibi that owns a DAG step; animates only while the step is live. */
export function StepChibi({
  step,
  status,
  role: given,
}: {
  step: { key: string; name?: string; type: string };
  status?: string;
  role?: Role;
}) {
  const role = given ?? roleOfStep({ ...step, name: step.name ?? step.key }, []);
  const c = CHARACTERS[role];
  return (
    <span className="gn-chibi" title={`${c.name} · ${c.title} — ${c.does}`}>
      <svg viewBox="-2 -10 34 52" width={26} height={40} aria-hidden>
        <ChibiAgent
          role={role}
          pose={poseOf(status ?? null, null, 0)}
          activity={activityOf(step, role)}
          x={0}
          y={0}
          walking={false}
        />
      </svg>
    </span>
  );
}
