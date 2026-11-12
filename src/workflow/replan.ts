import type { StepSpec } from "./types.ts";
import { ancestors } from "./graph.ts";

/** What the developer picked in the feedback box. */
export type FeedbackMode = "auto" | "reimplement" | "replan" | "restart";
/** Where the run actually goes back to. `rediscover` = repository discovery/selection, then everything after it. */
export type FeedbackRoute = "reimplement" | "replan" | "rediscover" | "restart";
export const FEEDBACK_MODES: FeedbackMode[] = ["auto", "reimplement", "replan", "restart"];
const ORDER: FeedbackRoute[] = ["reimplement", "replan", "rediscover", "restart"];

type GraphLike = {
  steps: Array<Pick<StepSpec, "key" | "type" | "depends_on" | "config">>;
  feedback_step?: string;
  replan_step?: string;
};

export interface ReplanAnchors {
  reimplement: string | null;
  replan: string | null;
  rediscover: string | null;
  restart: string[];
}

const isDiscovery = (s: GraphLike["steps"][number]) => s.config?.action === "repository_discovery";
const isSelection = (s: GraphLike["steps"][number]) =>
  s.config?.select_repositories === true || isDiscovery(s);

/**
 * The step each route re-executes, derived from the graph (no step names hard-coded):
 * - reimplement: `feedback_step`, else the first coding step;
 * - replan: `replan_step`, else the first agent step upstream of the coding step that runs after repository selection;
 * - rediscover: the repository discovery step (its selection and everything after it re-run);
 * - restart: the root steps.
 */
export function replanAnchors(graph: GraphLike): ReplanAnchors {
  const steps = graph.steps;
  const keys = new Set(steps.map((s) => s.key));
  const reimplement =
    (graph.feedback_step && keys.has(graph.feedback_step) ? graph.feedback_step : null) ??
    steps.find((s) => s.type === "coding_agent")?.key ??
    null;
  let replan = graph.replan_step && keys.has(graph.replan_step) ? graph.replan_step : null;
  if (!replan && reimplement) {
    const up = ancestors(steps, reimplement);
    const selection = steps.filter((s) => up.has(s.key) && isSelection(s)).map((s) => s.key);
    const beforeSelection = new Set(selection.flatMap((k) => [...ancestors(steps, k), k]));
    replan =
      steps.find((s) => s.type === "agent" && up.has(s.key) && !beforeSelection.has(s.key))?.key ??
      steps.find((s) => s.type === "agent" && up.has(s.key))?.key ??
      null;
  }
  return {
    reimplement,
    replan,
    rediscover: steps.find(isDiscovery)?.key ?? null,
    restart: steps.filter((s) => !s.depends_on.length).map((s) => s.key),
  };
}

/** Steps a route re-executes; a route the graph cannot serve falls back to the next broader one. */
export function routeTargets(
  graph: GraphLike,
  route: FeedbackRoute,
): { route: FeedbackRoute; targets: string[] } {
  const a = replanAnchors(graph);
  for (const r of ORDER.slice(ORDER.indexOf(route))) {
    const t = r === "restart" ? a.restart : a[r] ? [a[r]!] : [];
    if (t.length) return { route: r, targets: t };
  }
  return { route: "restart", targets: a.restart };
}

export const broader = (a: FeedbackRoute, b: FeedbackRoute) =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

/** What the classifier (model) judged about the feedback. All flags are about the feedback, not the code. */
export interface FeedbackJudgement {
  route: FeedbackRoute;
  architecture_change?: boolean;
  scope_change?: boolean;
  requirement_change?: boolean;
  full_review?: boolean;
  confidence?: number;
  reasons?: string[];
}

export interface FeedbackSignals {
  /** Repositories the feedback names that the run has not selected (deterministic, from the repository registry). */
  unselected_repositories: string[];
}

export interface FeedbackDecision {
  mode: FeedbackMode;
  route: FeedbackRoute;
  source: "developer" | "model" | "heuristic";
  reasons: string[];
  signals: FeedbackSignals;
  judgement?: FeedbackJudgement;
}

/** Repositories named in the feedback (word-bounded) that are not selected for the run. */
export function feedbackSignals(
  message: string,
  repositories: string[],
  selected: string[],
): FeedbackSignals {
  const named = repositories.filter((r) =>
    new RegExp(`(^|[^\\w-])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "i").test(
      message,
    ),
  );
  return { unselected_repositories: named.filter((r) => !selected.includes(r)) };
}

/** Route implied by the judgement's flags (the flags win over a route the model picked too narrowly). */
export function routeFromJudgement(j: FeedbackJudgement): FeedbackRoute {
  let r: FeedbackRoute = ORDER.includes(j.route) ? j.route : "reimplement";
  if (j.requirement_change || j.full_review) r = broader(r, "restart");
  if (j.scope_change) r = broader(r, j.architecture_change ? "restart" : "rediscover");
  if (j.architecture_change) r = broader(r, "replan");
  return r;
}

// Fallback only when the model is unavailable: cues for "this changes the design / scope / requirement".
const CUES: Array<[FeedbackRoute, RegExp]> = [
  [
    "restart",
    /(recheck|review lại|kiểm tra lại|xem lại)\s+(toàn bộ|tất cả|từ đầu|everything|all)|(làm|phân tích|analy[sz]e)\s+lại\s+từ đầu|start over|from scratch|đổi yêu cầu|thay đổi (yêu cầu|phạm vi|scope)|requirement(s)? (changed|change)/i,
  ],
  [
    "replan",
    /kiến trúc|architecture|refactor|thiết kế|design|generic|tổng quát|dùng chung|shared|reuse|tái sử dụng|business flow|luồng nghiệp vụ|approach|phương án/i,
  ],
];

export function heuristicJudgement(message: string): FeedbackJudgement {
  for (const [route, re] of CUES)
    if (re.test(message))
      return { route, reasons: [`fallback cue for ${route}: "${message.match(re)![0]}"`] };
  return { route: "reimplement", reasons: ["no design, scope or requirement change detected"] };
}

/**
 * Final decision. An explicit mode is the developer's call (repository signals are still reported). In auto mode the
 * model's judgement (or the fallback cues) and the deterministic repository signal are combined, broadest wins.
 */
export function decideFeedbackRoute(input: {
  mode: FeedbackMode;
  signals: FeedbackSignals;
  judgement?: FeedbackJudgement | null;
  fallback?: FeedbackJudgement;
}): FeedbackDecision {
  const { mode, signals } = input;
  if (mode !== "auto") {
    const route: FeedbackRoute = mode;
    return {
      mode,
      route,
      source: "developer",
      reasons: [`chosen by the developer: ${mode}`],
      signals,
    };
  }
  const j = input.judgement ?? input.fallback ?? { route: "reimplement" as const };
  let route = routeFromJudgement(j);
  const reasons = [...(j.reasons ?? [])];
  if (signals.unselected_repositories.length) {
    const scoped = broader(route, j.architecture_change ? "restart" : "rediscover");
    if (scoped !== route)
      reasons.push(
        `feedback names repositories outside the selection: ${signals.unselected_repositories.join(", ")}`,
      );
    route = scoped;
  }
  return {
    mode,
    route,
    source: input.judgement ? "model" : "heuristic",
    reasons,
    signals,
    judgement: j,
  };
}

/** Prompt for the one classification call (feedback text is untrusted input). */
export function classificationPrompt(input: {
  message: string;
  task: string;
  selected: string[];
  completed: Array<{ key: string; summary: string }>;
}) {
  return [
    "Classify developer feedback on an engineering workflow run. Decide how far back the run must go.",
    'Routes: "reimplement" = fix code within the approved design; "replan" = the design / architecture / business flow ' +
      'must be re-evaluated; "rediscover" = the set of repositories is wrong or incomplete; "restart" = the requirement ' +
      "or task scope changed, or the developer asks to recheck everything from the beginning.",
    "Choose the narrowest route that fully addresses the feedback. Small code fixes must not trigger replanning.",
    'Reply with JSON only: {"route": "...", "architecture_change": bool, "scope_change": bool, "requirement_change": bool, ' +
      '"full_review": bool, "confidence": 0-1, "reasons": ["..."]}',
    "",
    `Selected repositories: ${input.selected.join(", ") || "(none)"}`,
    "Completed steps:",
    ...input.completed.map((s) => `- ${s.key}: ${s.summary.slice(0, 400)}`),
    "",
    '<untrusted_input source="task">',
    input.task.slice(0, 3000),
    "</untrusted_input>",
    '<untrusted_input source="feedback">',
    input.message.slice(0, 4000),
    "</untrusted_input>",
  ].join("\n");
}

export function parseJudgement(text: string): FeedbackJudgement | null {
  const raw = text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!ORDER.includes(o.route)) return null;
    return {
      route: o.route,
      architecture_change: o.architecture_change === true,
      scope_change: o.scope_change === true,
      requirement_change: o.requirement_change === true,
      full_review: o.full_review === true,
      confidence: typeof o.confidence === "number" ? o.confidence : undefined,
      reasons: Array.isArray(o.reasons) ? o.reasons.map(String).slice(0, 5) : [],
    };
  } catch {
    return null;
  }
}
