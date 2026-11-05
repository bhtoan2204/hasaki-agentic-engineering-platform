import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, type Node } from "@xyflow/react";
import { api } from "../api.ts";
import { AlertTriangle, ArrowRight, Gauge, GitMerge, Layers, Microscope, PenLine, Sparkles, Ban, Zap } from "lucide-react";
import { Badge, Segmented } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { autoLayout, nodeTypes, toEdges, type StepNodeData } from "../graph.tsx";
import "./RunView.css";

export type ProfileChoice = "AUTO" | "FAST" | "STANDARD" | "DEEP";
const COLOR: Record<string, string> = { FAST: "COMPLETED", STANDARD: "READY", DEEP: "WAITING" };

export function ProfileBadge({ profile, title }: { profile?: string; title?: string }) {
  if (!profile) return null;
  const I = profile === "FAST" ? Zap : profile === "DEEP" ? Microscope : profile === "STANDARD" ? Layers : null;
  return <span title={title}><Badge s={COLOR[profile] ?? "PENDING"}>{I && <I size={11} strokeWidth={2.4} />}{profile}</Badge></span>;
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
  const { t } = useI18n();
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
      <div className="row tight" style={{ gap: 10 }}>
        <b className="small" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Gauge size={15} color="var(--brand)" /> {t("pp.profile")}</b>
        <Segmented<ProfileChoice>
          label={t("pp.profile")}
          value={value}
          onChange={onChange}
          options={[
            ["AUTO", <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Sparkles size={12} />AUTO</span>],
            ["FAST", <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Zap size={12} />FAST</span>],
            ["STANDARD", <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Layers size={12} />STANDARD</span>],
            ["DEEP", <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Microscope size={12} />DEEP</span>],
          ]}
        />
      </div>
      {error && <div className="err small" style={{ marginTop: 6 }}>{error}</div>}
      {data && (
        <div style={{ marginTop: 10 }}>
          <div className="small rv-chipline">
            <ArrowRight size={13} color="var(--muted)" /> <ProfileBadge profile={data.profile.profile} /> <span className="muted">({t("pp.confidence", { n: data.profile.confidence })})</span> · {t("pp.steps", { n: data.graph.steps.length, total: data.published_steps })}
            {data.report_step && t("pp.report")}
            {data.reused_repositories && <> · {t("pp.reuse")} <b>{data.selected_repositories.join(", ")}</b></>}
          </div>
          <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>{data.profile.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>
          {data.profile.warnings.map((w: string) => <div key={w} className="rv-note" style={{ color: "var(--st-wait)", margin: "4px 0" }}><AlertTriangle size={13} />{w}</div>)}
          {data.changes.length > 0 && (
            <div className="pp-changes">
              {data.changes.map((c: any) => (
                <div key={c.step + c.action}>
                  {c.action === "merged_into" ? <GitMerge size={13} /> : c.action === "removed" ? <Ban size={13} /> : <PenLine size={13} />} <span className="mono">{c.step}</span>{" "}
                  {c.action === "merged_into" ? <>{t("pp.merged")} <span className="mono">{c.into}</span></> : c.action === "removed" ? t("pp.removed") : t("pp.adjusted")} — <span className="muted">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
          <div className="pp-graph">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 0.8 }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} panOnDrag proOptions={{ hideAttribution: true }}>
              <Background gap={16} />
            </ReactFlow>
          </div>
        </div>
      )}
    </div>
  );
}
