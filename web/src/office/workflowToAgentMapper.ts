import { translate, type UiLocale } from "../i18n/messages.ts";
import { CHARACTERS } from "./characters.ts";
import type { Activity, AgentView, AttemptLite, EventLite, GraphStepLite, OfficeSnapshot, Pose, Role, StepLite, StepStatus } from "./types.ts";

/**
 * Workflow state → office characters. Pure functions: no timers, no randomness — the office only shows what the run
 * actually did (step statuses, attempts, open questions, transcript tool calls).
 */

export const ROLES: Role[] = ["analyst", "architect", "developer", "tester", "reviewer", "pr"];

/** Display info per role — configured in characters.ts (names, looks, personality are not mapping logic). */
export const ROLE_INFO = CHARACTERS;

const ACTIVE: string[] = ["RUNNING", "RETRYING", "WAITING_INPUT", "WAITING_APPROVAL"];
const CELEBRATE_MS = 8000;

/** Which character owns a step. Human gates belong to the character whose work they gate (their first dependency). */
export function roleOfStep(step: Pick<StepLite, "key" | "name" | "type">, graph: GraphStepLite[], seen = new Set<string>()): Role {
  const text = `${step.key} ${step.name ?? ""}`.toLowerCase();
  switch (step.type) {
    case "coding_agent":
      return "developer";
    case "command":
      return "tester";
    case "git_pull_request":
    case "task_result_report":
      return "pr";
    case "human_input":
    case "human_approval":
    case "condition": {
      const dep = graph.find((g) => g.key === step.key)?.depends_on?.[0];
      const up = dep ? graph.find((g) => g.key === dep) : undefined;
      if (up && !seen.has(up.key)) return roleOfStep({ key: up.key, name: up.name ?? up.key, type: up.type }, graph, seen.add(step.key));
      return "analyst";
    }
    case "integration":
      if (/pull.?request|bitbucket|merge|publish_pr/.test(text)) return "pr";
      if (/review|report/.test(text)) return "reviewer";
      return "analyst";
    default: // agent — design words win over "review" ("Architecture Review & Plan" is planning)
      if (/plan|design|architect|proposal|approach/.test(text)) return "architect";
      if (/review|security|audit|\bqa\b|report/.test(text)) return "reviewer";
      if (/test/.test(text)) return "tester";
      return "analyst";
  }
}

const RANK: Record<string, number> = { RUNNING: 0, RETRYING: 0, WAITING_INPUT: 1, WAITING_APPROVAL: 2, READY: 3, FAILED: 4, COMPLETED: 5, CANCELED: 6, PENDING: 7, SKIPPED: 8 };

/** The step that should drive the character: active first, then the most recent outcome, then what is next. */
export function primaryStep(steps: StepLite[], attempts: AttemptLite[]): StepLite | null {
  if (!steps.length) return null;
  const finished = (s: StepLite) => {
    const a = attempts.find((x) => x.id === s.current_attempt_id);
    return a?.finished_at ? Date.parse(a.finished_at) : 0;
  };
  return [...steps].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || finished(b) - finished(a) || (a.position ?? 0) - (b.position ?? 0))[0];
}

export function poseOf(status: string | null, finishedAt: string | null | undefined, now: number): Pose {
  switch (status) {
    case "READY":
      return "prepare";
    case "RUNNING":
    case "RETRYING":
      return "work";
    case "WAITING_INPUT":
      return "ask";
    case "WAITING_APPROVAL":
      return "approval";
    case "COMPLETED":
      return finishedAt && now - Date.parse(finishedAt) < CELEBRATE_MS ? "celebrate" : "done";
    case "FAILED":
      return "frustrated";
    case "CANCELED":
      return "stopped";
    case "SKIPPED":
      return "skipped";
    default:
      return "idle";
  }
}

const DEFAULT_ACTIVITY: Record<Role, Activity> = {
  analyst: "reading",
  architect: "sketching",
  developer: "typing",
  tester: "testing",
  reviewer: "reviewing",
  pr: "packaging",
};

const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A real tool call → what the hands do + a short human description. Unknown tools fall back to the role's work. */
export function activityFromTool(name: string, input: any, locale: UiLocale = "vi"): { activity: Activity; text: string } | null {
  const n = name.replace(/^mcp__platform__/, "");
  const i = input ?? {};
  const say = (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
  const fileWord = say("office.act.file");
  switch (n) {
    case "Read":
      return { activity: "reading", text: say("office.act.read", { file: base(i.file_path) || fileWord }) };
    case "Grep":
      return { activity: "searching", text: say("office.act.grep", { q: clip(String(i.pattern ?? ""), 28) }) };
    case "Glob":
    case "LS":
      return { activity: "searching", text: say("office.act.glob", { q: clip(String(i.pattern ?? i.path ?? say("office.act.folder")), 28) }) };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { activity: "typing", text: say("office.act.edit", { file: base(i.file_path ?? i.notebook_path) || fileWord }) };
    case "Bash": {
      const cmd = String(i.command ?? "").trim();
      if (/\b(go test|npm (run )?test|pytest|jest|vitest|cargo test|make test)\b/.test(cmd)) return { activity: "testing", text: say("office.act.test") };
      if (/^\s*(cd \S+\s*&&\s*)?git\b/.test(cmd)) return { activity: "git", text: `git ${clip(cmd.replace(/^.*?git\s+(-C\s+\S+\s+)?/, ""), 30)}` };
      return { activity: "terminal", text: `$ ${clip(cmd.split("\n")[0], 34)}` };
    }
    case "WebFetch":
    case "WebSearch":
      return { activity: "browsing", text: say("office.act.web") };
    case "Task":
    case "Agent":
      return { activity: "delegating", text: say("office.act.delegate", { who: i.subagent_type ? ` ${i.subagent_type}` : "" }) };
    case "TodoWrite":
      return { activity: "planning", text: say("office.act.todo") };
    case "ask_user":
      return { activity: "asking", text: say("office.act.ask") };
    case "submit_result":
      return { activity: "submitting", text: say("office.act.submit") };
    case "prepare_branch":
      return { activity: "git", text: say("office.act.worktree") };
    case "post_update":
      return { activity: "writing", text: say("office.act.progress") };
    case "read_knowledge":
    case "search_knowledge":
      return { activity: "knowledge", text: say("office.act.skill", { q: clip(String(i.key ?? i.query ?? ""), 24) }).trim() };
    case "read_step_output":
      return { activity: "reading", text: say("office.act.stepOut", { step: i.step_key ?? "" }).trim() };
    case "list_tools":
    case "describe_tool":
    case "call_tool":
      return { activity: "browsing", text: say("office.act.tool", { name: clip(String(i.name ?? ""), 24) }).trim() };
    default:
      return null;
  }
}

/** Latest real activity of an attempt from its transcript; null when there is nothing to show. */
export function activityFromEvents(events: EventLite[] | undefined, stepType: string, locale: UiLocale = "vi"): { activity: Activity; text: string } | null {
  if (!events?.length) return null;
  const say = (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "tool" && e.data?.name) return activityFromTool(String(e.data.name), e.data.input, locale);
    if (e.kind === "thinking") return { activity: "thinking", text: say("office.act.thinking") };
    if (e.kind === "agent" && e.content?.trim()) return { activity: "writing", text: clip(e.content.trim().split("\n")[0], 40) };
    if (stepType === "command" && e.content?.trim()) {
      const line = e.content.trim().split("\n").filter(Boolean).pop() ?? "";
      if (line) return { activity: /test/.test(line) ? "testing" : "terminal", text: clip(line.replace(/^==\s*/, ""), 40) };
    }
  }
  return null;
}

function firstLine(err: any) {
  const m = typeof err === "string" ? err : err?.message ?? err?.error ?? (err ? JSON.stringify(err) : "");
  return clip(String(m).split("\n")[0], 60);
}

export function mapOffice(snap: OfficeSnapshot, now: number, locale: UiLocale = "vi"): AgentView[] {
  const say = (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
  const byRole = new Map<Role, StepLite[]>(ROLES.map((r) => [r, []]));
  for (const s of [...snap.steps].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) byRole.get(roleOfStep(s, snap.graph))!.push(s);

  return ROLES.map((role) => {
    const steps = byRole.get(role)!;
    const step = primaryStep(steps, snap.attempts);
    const status = (step?.status ?? null) as StepStatus | null;
    const attempt = step?.current_attempt_id ? snap.attempts.find((a) => a.id === step.current_attempt_id) ?? null : null;
    const pose = step ? poseOf(status, attempt?.finished_at, now) : "idle";
    const openQuestions = step ? snap.questions.filter((q) => q.step_key === step.key && q.status === "open").length : 0;
    const activeCount = steps.filter((s) => ACTIVE.includes(s.status)).length;
    const live = step && pose === "work" ? activityFromEvents(attempt ? snap.events[attempt.id] : undefined, step.type, locale) : null;
    const activity: Activity | null = pose === "work" ? live?.activity ?? DEFAULT_ACTIVITY[role] : pose === "ask" ? "asking" : null;
    const started = attempt?.started_at ? Date.parse(attempt.started_at) : null;
    const durationMs = started ? (attempt?.finished_at ? Date.parse(attempt.finished_at) : now) - started : null;
    const retrying = status === "RETRYING";
    const stepName = step?.name ?? "";

    let bubble: string;
    switch (pose) {
      case "idle":
        bubble = step ? say("office.bubble.waitTurn", { step: stepName }) : snap.run ? say("office.bubble.noStep") : say("office.bubble.idle");
        break;
      case "prepare":
        bubble = say("office.bubble.prepare");
        break;
      case "work":
        bubble = (retrying ? say("office.bubble.retryPrefix") : "") + (live?.text ?? `${stepName}…`);
        break;
      case "ask":
        bubble = openQuestions ? say("office.bubble.questions", { n: openQuestions }) : say("office.bubble.needInput");
        break;
      case "approval":
        bubble = say("office.bubble.approve");
        break;
      case "celebrate":
        bubble = say("office.bubble.celebrate");
        break;
      case "done":
        bubble = say("office.bubble.done");
        break;
      case "frustrated":
        bubble = attempt?.error ? say("office.bubble.error", { msg: firstLine(attempt.error) }) : say("office.bubble.failed");
        break;
      case "stopped":
        bubble = say("office.bubble.stopped");
        break;
      case "skipped":
        bubble = say("office.bubble.skipped");
        break;
      default:
        bubble = "";
    }
    const info = ROLE_INFO[role];
    const title = say(`office.role.${role}.title`);
    const detail = step
      ? `${info.name} · ${title} — ${stepName} (${status})${pose === "work" && live ? `: ${live.text}` : ""}`
      : `${info.name} · ${title} — ${snap.run ? say("office.bubble.noStep") : say("office.bubble.noWork")}`;
    return { role, step, steps, status, pose, activity, bubble, detail, activeCount, retrying, openQuestions, attempt, durationMs };
  });
}
