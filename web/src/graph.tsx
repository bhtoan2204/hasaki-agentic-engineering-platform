import { Handle, Position, type Edge, type Node, type NodeProps, MarkerType } from "@xyflow/react";
import {
  Bot,
  CheckCircle2,
  Circle,
  CircleDashed,
  ClipboardList,
  Code2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Hand,
  Loader2,
  MessageCircleQuestion,
  PauseCircle,
  PenLine,
  Plug,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  SquareTerminal,
  XCircle,
  Ban,
  Clock,
  Split,
  type LucideIcon,
} from "lucide-react";
import { STATUS_COLORS } from "./api.ts";
import { useI18n } from "./i18n/index.tsx";
// Node / edge styles (gn-*) live with the run page CSS; imported here so the Workflow Studio editor gets them too.
import "./pages/RunView.css";

/** Lucide icon per step type (graph nodes, inspector headers). */
export const STEP_TYPE_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  coding_agent: Code2,
  human_input: PenLine,
  human_approval: ShieldCheck,
  integration: Plug,
  command: SquareTerminal,
  condition: Split,
  git_pull_request: GitPullRequest,
  task_result_report: ClipboardList,
};
export const stepTypeIcon = (type?: string): LucideIcon =>
  (type && STEP_TYPE_ICONS[type]) || Circle;

/** Lucide icon per step/run status. */
export const STATUS_ICONS: Record<string, LucideIcon> = {
  PENDING: CircleDashed,
  READY: Clock,
  RUNNING: Loader2,
  RETRYING: RotateCcw,
  WAITING: PauseCircle,
  WAITING_INPUT: MessageCircleQuestion,
  WAITING_APPROVAL: Hand,
  PAUSED: PauseCircle,
  COMPLETED: CheckCircle2,
  FAILED: XCircle,
  STALE: XCircle,
  CANCELED: Ban,
  SKIPPED: SkipForward,
};
export const statusIcon = (s?: string): LucideIcon => (s && STATUS_ICONS[s]) || CircleDashed;

export interface StepLike {
  key: string;
  type: string;
  name?: string;
  depends_on?: string[];
  ui?: { x: number; y: number };
  run_if?: unknown;
  requires_approval?: boolean;
  config?: Record<string, any>;
  handoff?: { failure_category?: string; status?: string };
  effective_agent?: { provider?: string; model?: string | null };
}

/** Vertical layered layout by longest-path depth (later steps below); used when a definition has no saved node positions. */
export function autoLayout(steps: StepLike[]): Record<string, { x: number; y: number }> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const depth = new Map<string, number>();
  const d = (k: string, seen = new Set<string>()): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const deps = byKey.get(k)?.depends_on ?? [];
    const v = deps.length ? Math.max(...deps.map((x) => d(x, seen) + 1)) : 0;
    depth.set(k, v);
    return v;
  };
  steps.forEach((s) => d(s.key));
  const layers = new Map<number, string[]>();
  for (const s of steps)
    (
      layers.get(depth.get(s.key)!) ?? layers.set(depth.get(s.key)!, []).get(depth.get(s.key)!)!
    ).push(s.key);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [l, keys] of layers)
    keys.forEach((k, i) => (pos[k] = { x: (i - (keys.length - 1) / 2) * 250, y: l * 140 }));
  return pos;
}

/** Edge colour from the statuses at both ends: done = green, flowing into a live step = berry, failed = red, waiting = amber. */
function edgeColor(src?: string, dst?: string) {
  if (dst === "RUNNING" || dst === "RETRYING") return "var(--st-run)";
  if (dst === "FAILED" || dst === "STALE") return "var(--st-err)";
  if (dst === "WAITING_INPUT" || dst === "WAITING_APPROVAL" || dst === "WAITING")
    return "var(--st-wait)";
  if (src === "COMPLETED" || src === "SKIPPED") return "var(--st-ok)";
  return "var(--line-strong)";
}

export function toEdges(steps: StepLike[], statusOf?: (k: string) => string | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const s of steps)
    for (const d of s.depends_on ?? []) {
      const st = statusOf?.(d);
      const dst = statusOf?.(s.key);
      const active = st === "COMPLETED" || st === "SKIPPED";
      const stroke = statusOf ? edgeColor(st, dst) : "var(--muted)";
      edges.push({
        id: `${d}->${s.key}`,
        source: d,
        target: s.key,
        animated: dst === "RUNNING",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: {
          stroke,
          strokeWidth: statusOf && (active || dst === "RUNNING") ? 2 : 1.6,
          opacity: statusOf && !active && stroke === "var(--line-strong)" ? 0.85 : 1,
        },
        label:
          (s.run_if as any)?.step === d
            ? `if = ${JSON.stringify((s.run_if as any).equals)}`
            : undefined,
        labelStyle: { fontSize: 10, fontWeight: 600, fill: "var(--ink-2)" },
        labelBgStyle: { fill: "var(--surface)", stroke: "var(--line)" },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
      });
    }
  return edges;
}

export type StepNodeData = {
  step: StepLike;
  status?: string;
  attempts?: number;
  openQuestions?: number;
  selected?: boolean;
  invalid?: boolean;
};

export function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const { t, status: statusName } = useI18n();
  const { step, status } = data;
  const color = data.invalid
    ? "var(--st-err)"
    : status
      ? (STATUS_COLORS[status] ?? "var(--st-idle)")
      : "var(--line-strong)";
  const blocked = status === "WAITING_INPUT" || status === "WAITING_APPROVAL";
  const cls = [
    "node",
    "gn",
    status ? "has-status" : "no-status",
    data.selected && "selected",
    blocked && "blocked",
    status === "RUNNING" && "running",
    data.invalid && "invalid",
  ]
    .filter(Boolean)
    .join(" ");
  const isAgent = ["agent", "coding_agent"].includes(step.type);
  const provider = step.effective_agent?.provider ?? step.config?.agent?.provider;
  const TypeIcon = stepTypeIcon(step.type);
  const StIcon = statusIcon(status);
  const merged: string[] = Array.isArray((step as any).config?.merged_from)
    ? (step as any).config.merged_from
    : [];
  return (
    <div className={cls} style={{ ["--gn-c" as any]: color }}>
      <Handle type="target" position={Position.Top} />
      <span className="gn-rail" aria-hidden />
      <div className="gn-head">
        <span className="gn-type" title={step.type}>
          <TypeIcon size={15} strokeWidth={2} />
        </span>
        <div className="gn-titles">
          <div className="t">{step.name || step.key}</div>
          <div className="sub">
            {step.key} · {step.type}
          </div>
        </div>
        {status && (
          <span className="gn-st" title={`${statusName(status)} (${status})`}>
            <StIcon
              size={16}
              strokeWidth={2.2}
              className={status === "RUNNING" ? "gn-spin" : undefined}
            />
          </span>
        )}
      </div>
      {(isAgent ||
        status ||
        !!data.attempts ||
        !!data.openQuestions ||
        step.requires_approval ||
        !!step.run_if ||
        merged.length > 0) && (
        <div className="flags">
          {isAgent && (
            <span
              className="gn-pill"
              title={step.effective_agent?.model ?? step.config?.agent?.model ?? undefined}
            >
              {provider
                ? ((
                    {
                      claude: "Claude",
                      codex: "Codex",
                      cursor: "Cursor",
                      antigravity: "Antigravity",
                    } as Record<string, string>
                  )[provider] ?? provider)
                : t("agent.inherit")}
            </span>
          )}
          {step.handoff && (
            <span className="gn-pill gn-pill-wait" title={step.handoff.failure_category}>
              {t("handoff.paused")}
            </span>
          )}
          {status && <span className="gn-pill gn-pill-st">{statusName(status)}</span>}
          {!!data.attempts && (
            <span className="gn-pill" title={t("graph.attempts", { n: data.attempts })}>
              <RotateCcw size={10} strokeWidth={2.4} />
              {data.attempts}
            </span>
          )}
          {!!data.openQuestions && (
            <span className="gn-pill gn-pill-wait" title={t("graph.questions")}>
              <MessageCircleQuestion size={10} strokeWidth={2.4} />
              {data.openQuestions}
            </span>
          )}
          {step.requires_approval && (
            <span className="gn-pill" title={t("graph.approval")}>
              <ShieldCheck size={10} strokeWidth={2.4} />
            </span>
          )}
          {!!step.run_if && (
            <span className="gn-pill" title={t("graph.condition")}>
              <GitBranch size={10} strokeWidth={2.4} />
            </span>
          )}
          {merged.length > 0 && (
            <span className="gn-pill" title={t("graph.merged")}>
              <GitMerge size={10} strokeWidth={2.4} />
              {merged.join(" + ")}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const nodeTypes = { step: StepNode };
