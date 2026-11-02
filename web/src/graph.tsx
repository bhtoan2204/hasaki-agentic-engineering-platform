import { Handle, Position, type Edge, type Node, type NodeProps, MarkerType } from "@xyflow/react";
import { STATUS_COLORS } from "./api.ts";

export const STEP_ICONS: Record<string, string> = {
  agent: "🤖",
  coding_agent: "🧑‍💻",
  human_input: "✍️",
  human_approval: "✅",
  integration: "🔌",
  command: "⌨️",
  condition: "🔀",
  git_pull_request: "🔀",
};
STEP_ICONS.git_pull_request = "⤴️";

export interface StepLike {
  key: string;
  type: string;
  name?: string;
  depends_on?: string[];
  ui?: { x: number; y: number };
  run_if?: unknown;
  requires_approval?: boolean;
}

/** Layered layout by longest-path depth; used when a definition has no saved node positions. */
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
  for (const s of steps) (layers.get(depth.get(s.key)!) ?? layers.set(depth.get(s.key)!, []).get(depth.get(s.key)!)!).push(s.key);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [l, keys] of layers) keys.forEach((k, i) => (pos[k] = { x: l * 270, y: (i - (keys.length - 1) / 2) * 120 }));
  return pos;
}

export function toEdges(steps: StepLike[], statusOf?: (k: string) => string | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const s of steps)
    for (const d of s.depends_on ?? []) {
      const st = statusOf?.(d);
      const active = st === "COMPLETED" || st === "SKIPPED";
      edges.push({
        id: `${d}->${s.key}`,
        source: d,
        target: s.key,
        animated: statusOf?.(s.key) === "RUNNING",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: { stroke: statusOf ? (active ? STATUS_COLORS.COMPLETED : "var(--muted)") : "var(--muted)", strokeWidth: 1.6, opacity: statusOf && !active ? 0.6 : 1 },
        label: (s.run_if as any)?.step === d ? `if = ${JSON.stringify((s.run_if as any).equals)}` : undefined,
        labelStyle: { fontSize: 10, fill: "var(--muted)" },
        labelBgStyle: { fill: "var(--panel)" },
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
  const { step, status } = data;
  const color = status ? STATUS_COLORS[status] : "var(--line)";
  const blocked = status === "WAITING_INPUT" || status === "WAITING_APPROVAL";
  const cls = ["node", data.selected && "selected", blocked && "blocked", status === "RUNNING" && "running"].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ borderColor: data.invalid ? "var(--err)" : color }}>
      <Handle type="target" position={Position.Left} />
      <div className="t">
        {STEP_ICONS[step.type] ?? "•"} {step.name || step.key}
      </div>
      <div className="sub">
        {step.key} · {step.type}
      </div>
      {status && (
        <div className="row tight" style={{ marginTop: 4, gap: 4 }}>
          <span className="badge" style={{ color }}>{status === "RUNNING" ? "● RUNNING" : status}</span>
          {!!data.attempts && <span className="muted small">#{data.attempts}</span>}
          {!!data.openQuestions && <span className="badge" style={{ color: "var(--warn)" }}>❓ {data.openQuestions}</span>}
        </div>
      )}
      <div className="flags">
        {step.requires_approval && <span className="flag">approval gate</span>}
        {!!step.run_if && <span className="flag">conditional</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { step: StepNode };
