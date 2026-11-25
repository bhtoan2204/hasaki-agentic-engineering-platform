import { memo } from "react";
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import {
  ExternalLink,
  GitFork,
  Hand,
  Hourglass,
  Lightbulb,
  Network,
  Play,
  Square,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { api, STATUS_COLORS } from "../api.ts";
import { dialog } from "../dialog/index.ts";
import { useI18n } from "../i18n/index.tsx";
import { act, navigate } from "../ui.tsx";
import { statusIcon } from "../graph.tsx";

/** One delegated child workflow, as returned by GET /api/runs/:id (delegation.children). */
export interface ChildWorkflow {
  id: number;
  workflow: string;
  mode: "propose" | "blocking" | "parallel" | "detached" | string;
  delegation_status: string;
  child_run_id: number | null;
  run_status: string | null;
  title: string | null;
  requested_title?: string | null;
  reason: string | null;
  error: string | null;
  step_key: string;
  steps?: Array<{ key: string; name: string; type: string; status: string }>;
  grandchildren?: number;
}

const TERMINAL = ["COMPLETED", "FAILED", "CANCELED"];
const LIVE = ["RUNNING", "RETRYING", "WAITING_INPUT", "WAITING_APPROVAL", "READY"];
const MODE_ICON: Record<string, LucideIcon> = {
  propose: Lightbulb,
  blocking: Hourglass,
  parallel: GitFork,
  detached: Unlink,
};
const CARD_W = 268;
const GAP = 24;
const LANE_PAD = 22;

/** The status a child shows: its run's, or the delegation's while no run exists yet. */
export function childStatus(c: ChildWorkflow) {
  if (c.run_status) return c.run_status;
  return c.delegation_status === "failed"
    ? "FAILED"
    : c.delegation_status === "canceled"
      ? "CANCELED"
      : "PENDING";
}
export const childActive = (c: ChildWorkflow) =>
  c.delegation_status === "queued" || (!!c.run_status && !TERMINAL.includes(c.run_status));

/** Per delegating step: how many children, how many finished, whether one failed. Drives the badge on the step node. */
export function childSummary(children: ChildWorkflow[]) {
  const by: Record<string, { total: number; done: number; failed: number; active: number }> = {};
  for (const c of children) {
    const s = (by[c.step_key] ??= { total: 0, done: 0, failed: 0, active: 0 });
    const st = childStatus(c);
    s.total++;
    if (st === "COMPLETED") s.done++;
    else if (st === "FAILED" || st === "CANCELED") s.failed++;
    else s.active++;
  }
  return by;
}

type ChildNodeData = {
  child: ChildWorkflow;
  parentRunId: number;
  onChanged: () => void;
  showStep: boolean;
};
type LaneNodeData = { label: string; count: number; width: number; height: number };

function ChildRunNodeImpl({ data }: NodeProps<Node<ChildNodeData>>) {
  const { t, status: statusName } = useI18n();
  const c = data.child;
  const st = childStatus(c);
  const color = STATUS_COLORS[st] ?? "var(--st-idle)";
  const StIcon = statusIcon(st);
  const ModeIcon = MODE_ICON[c.mode] ?? Network;
  const steps = c.steps ?? [];
  const done = steps.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
  const current = steps.find((s) => LIVE.includes(s.status));
  const approval = steps.find((s) => s.status === "WAITING_APPROVAL");
  const title = (c.title ?? "").replace(/^↳ #\d+\s*/, "") || c.requested_title || c.workflow;
  const proposed = c.delegation_status === "proposed" && c.run_status === "PENDING";
  const cancellable =
    !!c.child_run_id && !!c.run_status && !TERMINAL.includes(c.run_status) && !proposed;
  const open = (path = "") => c.child_run_id && navigate(`/runs/${c.child_run_id}${path}`);
  const start = async () => {
    const ok = await dialog.confirm({
      title: t("child.startTitle"),
      description: t("child.startBody", { title, workflow: c.workflow }),
      confirmLabel: t("child.start"),
    });
    if (ok && (await act(() => api(`/api/runs/${c.child_run_id}/start`, {}), t("child.started"))))
      data.onChanged();
  };
  const cancel = async () => {
    const ok = await dialog.confirm({
      title: t("child.cancelTitle"),
      description: t("child.cancelBody", { title }),
      confirmLabel: t("child.cancel"),
      variant: "destructive",
    });
    if (ok && (await act(() => api(`/api/runs/${c.child_run_id}/cancel`, {}), t("child.canceled"))))
      data.onChanged();
  };
  // Buttons act; the rest of the card opens the child run.
  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
  return (
    <div
      className={`node gn gc${st === "RUNNING" ? " running" : ""}${approval || proposed ? " blocked" : ""}`}
      style={{ ["--gn-c" as string]: color }}
      data-testid="child-workflow-node"
      role="link"
      tabIndex={0}
      title={c.reason ?? undefined}
      onClick={() => open()}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}
    >
      <span className="gn-rail" aria-hidden />
      <div className="gn-head">
        <span className="gn-type" title={c.workflow}>
          <Network size={15} strokeWidth={2} />
        </span>
        <div className="gn-titles">
          <div className="t">{title}</div>
          <div className="sub">
            {c.child_run_id ? `#${c.child_run_id} · ` : ""}
            {c.workflow}
          </div>
        </div>
        <span className="gn-st" title={statusName(st)}>
          <StIcon
            size={16}
            strokeWidth={2.2}
            className={st === "RUNNING" ? "gn-spin" : undefined}
          />
        </span>
      </div>
      {steps.length > 0 && (
        <div className="gc-strip" aria-label={t("child.progress", { done, total: steps.length })}>
          {steps.map((s) => (
            <span
              key={s.key}
              className={`gc-seg${s.status === "RUNNING" ? " live" : ""}`}
              style={{ background: STATUS_COLORS[s.status] ?? "var(--line)" }}
              title={`${s.name}: ${statusName(s.status)}`}
            />
          ))}
        </div>
      )}
      <div className="gc-line">
        <span>{t("child.progress", { done, total: steps.length })}</span>
        {current && (
          <span className="gc-current" title={current.name}>
            · {current.name}
          </span>
        )}
      </div>
      <div className="flags">
        <span className="gn-pill gn-pill-st">
          {c.delegation_status === "queued" ? t("child.queued") : statusName(st)}
        </span>
        <span className="gn-pill" title={t(`child.modeHint.${c.mode}`)}>
          <ModeIcon size={10} strokeWidth={2.4} />
          {t(`child.mode.${c.mode}`)}
        </span>
        {data.showStep && (
          <span className="gn-pill" title={t("child.fromStep", { step: c.step_key })}>
            ↳ {c.step_key}
          </span>
        )}
        {!!c.grandchildren && (
          <span className="gn-pill" title={t("child.grandchildren", { n: c.grandchildren })}>
            <Network size={10} strokeWidth={2.4} />
            {c.grandchildren}
          </span>
        )}
      </div>
      {c.error && <div className="gc-error">{c.error}</div>}
      <div className="gc-actions" onPointerDown={stop} onClick={stop}>
        {approval && (
          <button type="button" className="xs gc-approve" onClick={() => open(`/${approval.key}`)}>
            <Hand size={12} /> {t("child.needsApproval", { step: approval.name })}
          </button>
        )}
        {proposed && (
          <button type="button" className="xs" onClick={start}>
            <Play size={12} /> {t("child.start")}
          </button>
        )}
        {cancellable && (
          <button type="button" className="xs ghost" onClick={cancel}>
            <Square size={11} /> {t("child.cancel")}
          </button>
        )}
        {c.child_run_id && (
          <button
            type="button"
            className="xs ghost"
            onClick={() => open()}
            aria-label={t("child.open")}
          >
            <ExternalLink size={12} /> {t("child.open")}
          </button>
        )}
      </div>
    </div>
  );
}

function LaneNodeImpl({ data }: NodeProps<Node<LaneNodeData>>) {
  const { t } = useI18n();
  return (
    <div className="gc-lane" style={{ width: data.width, height: data.height }} aria-hidden>
      <Handle type="target" position={Position.Top} />
      <span className="gc-lane-label">
        <Network size={13} /> {t("child.lane", { n: data.count })}
      </span>
    </div>
  );
}

export const childNodeTypes = { child: memo(ChildRunNodeImpl), childLane: memo(LaneNodeImpl) };

const ROW_H = 240;

/**
 * Child workflows as nodes in the parent's DAG: a lane under the steps, cards in a grid as wide as the step layout (so the
 * lane fits the same view), each linked to the step that delegated it by a dashed edge coloured by the child's status.
 */
export function childGraph(
  children: ChildWorkflow[],
  steps: Record<string, { x: number; y: number }>,
  parentRunId: number,
  onChanged: () => void,
) {
  if (!children.length) return { nodes: [] as Node[], edges: [] as Edge[] };
  const ys = Object.values(steps).map((p) => p.y);
  const xs = Object.values(steps).map((p) => p.x);
  const top = (ys.length ? Math.max(...ys) : 0) + 190;
  const left0 = xs.length ? Math.min(...xs) : 0;
  const span = xs.length ? Math.max(...xs) + 224 - left0 : CARD_W;
  const cols = Math.max(2, Math.min(4, Math.floor((span + GAP) / (CARD_W + GAP))));
  // Children of earlier steps first, then in the order they were requested.
  const ordered = [...children].sort(
    (a, b) => (steps[a.step_key]?.x ?? 0) - (steps[b.step_key]?.x ?? 0) || a.id - b.id,
  );
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const delegating = [...new Set(ordered.map((c) => c.step_key))];
  ordered.forEach((c, i) => {
    const id = `child:${c.id}`;
    nodes.push({
      id,
      type: "child",
      position: {
        x: left0 + (i % cols) * (CARD_W + GAP),
        y: top + LANE_PAD + 14 + Math.floor(i / cols) * ROW_H,
      },
      data: { child: c, parentRunId, onChanged, showStep: delegating.length > 1 },
      draggable: false,
      selectable: false,
      className: "nopan",
    });
  });
  // One dashed trunk per delegating step into the lane (per-card edges would cross the cards of earlier rows).
  for (const key of delegating) {
    if (!steps[key]) continue;
    const mine = ordered.map(childStatus).filter((_, i) => ordered[i].step_key === key);
    const st = mine.some((x) => x === "FAILED")
      ? "FAILED"
      : mine.some((x) => ["RUNNING", "RETRYING"].includes(x))
        ? "RUNNING"
        : mine.every((x) => x === "COMPLETED")
          ? "COMPLETED"
          : "WAITING";
    edges.push({
      id: `${key}->child-lane`,
      source: key,
      target: "child-lane",
      type: "smoothstep",
      animated: st === "RUNNING",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: {
        stroke: STATUS_COLORS[st] ?? "var(--line-strong)",
        strokeWidth: 1.8,
        strokeDasharray: "6 5",
      },
    });
  }
  const rows = Math.ceil(ordered.length / cols);
  const used = Math.min(cols, ordered.length);
  nodes.unshift({
    id: "child-lane",
    type: "childLane",
    position: { x: left0 - LANE_PAD, y: top },
    data: {
      label: "",
      count: children.length,
      width: used * (CARD_W + GAP) - GAP + 2 * LANE_PAD,
      height: rows * ROW_H + LANE_PAD + 4,
    },
    draggable: false,
    selectable: false,
    zIndex: -1,
    style: { pointerEvents: "none" },
    className: "gc-lane-node",
  });
  return { nodes, edges };
}
