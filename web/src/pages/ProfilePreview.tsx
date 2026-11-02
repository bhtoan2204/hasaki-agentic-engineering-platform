import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, type Node } from "@xyflow/react";
import { api } from "../api.ts";
import { Badge } from "../ui.tsx";
import { autoLayout, nodeTypes, toEdges, type StepNodeData } from "../graph.tsx";

export type ProfileChoice = "AUTO" | "FAST" | "STANDARD" | "DEEP";
const COLOR: Record<string, string> = { FAST: "COMPLETED", STANDARD: "READY", DEEP: "WAITING" };

export function ProfileBadge({ profile, title }: { profile?: string; title?: string }) {
  if (!profile) return null;
  return <span title={title}><Badge s={COLOR[profile] ?? "PENDING"}>{profile === "FAST" ? "⚡ " : profile === "DEEP" ? "🔬 " : ""}{profile}</Badge></span>;
}

/**
 * Profile selector + preview of the exact graph that will run (POST /api/runs/preview: same resolution as run creation).
 */
export function ProfilePreview({ workflow, workItemId, repositories, inputs, value, onChange }: {
  workflow: string;
  workItemId?: number | null;
  repositories?: string[];
  inputs?: Record<string, unknown>;
  value: ProfileChoice;
  onChange: (p: ProfileChoice) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([workflow, workItemId, repositories, inputs, value]);
  useEffect(() => {
    if (!workflow) return;
    let stop = false;
    api("/api/runs/preview", { workflow, work_item_id: workItemId ?? null, repositories, inputs, profile: value })
      .then((d) => !stop && (setData(d), setError(null)))
      .catch((e) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const steps = data.graph.steps;
    const pos = autoLayout(steps);
    const nodes: Node<StepNodeData>[] = steps.map((s: any) => ({ id: s.key, type: "step", position: pos[s.key], data: { step: s } }));
    return { nodes, edges: toEdges(steps) };
  }, [data]);
  return (
    <div>
      <div className="row tight">
        <b className="small">Execution profile</b>
        {(["AUTO", "FAST", "STANDARD", "DEEP"] as ProfileChoice[]).map((p) => (
          <button key={p} className={value === p ? "xs" : "xs ghost"} onClick={() => onChange(p)}>{p}</button>
        ))}
      </div>
      {error && <div className="err small">{error}</div>}
      {data && (
        <div style={{ marginTop: 6 }}>
          <div className="small">
            → <ProfileBadge profile={data.profile.profile} /> <span className="muted">({data.profile.confidence} confidence)</span> · {data.graph.steps.length} bước (definition có {data.published_steps})
            {data.report_step && " · + Task Result Report"}
            {data.reused_repositories && <> · dùng lại repo <b>{data.selected_repositories.join(", ")}</b></>}
          </div>
          <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>{data.profile.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>
          {data.profile.warnings.map((w: string) => <div key={w} className="small" style={{ color: "var(--warn)" }}>⚠ {w}</div>)}
          {data.changes.length > 0 && (
            <div className="small" style={{ margin: "4px 0" }}>
              {data.changes.map((c: any) => (
                <div key={c.step + c.action}>
                  {c.action === "merged_into" ? "⊕" : c.action === "removed" ? "⊘" : "✎"} <span className="mono">{c.step}</span>{" "}
                  {c.action === "merged_into" ? <>gộp vào <span className="mono">{c.into}</span></> : c.action === "removed" ? "bỏ qua" : "điều chỉnh"} — <span className="muted">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ height: 170, border: "1px solid var(--line)", borderRadius: 8 }}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 0.8 }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} panOnDrag proOptions={{ hideAttribution: true }}>
              <Background gap={16} />
            </ReactFlow>
          </div>
        </div>
      )}
    </div>
  );
}
