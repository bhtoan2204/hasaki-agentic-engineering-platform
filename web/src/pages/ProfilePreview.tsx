import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, type Node } from "@xyflow/react";
import { api } from "../api.ts";
import {
  AlertTriangle,
  ArrowRight,
  Gauge,
  GitMerge,
  Layers,
  Microscope,
  PenLine,
  Sparkles,
  Ban,
  Zap,
} from "lucide-react";
import { Badge, ErrorBox, Segmented } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { autoLayout, nodeTypes, toEdges, type StepLike, type StepNodeData } from "../graph.tsx";
import "./RunView.css";

export type ProfileChoice = "AUTO" | "MICRO" | "FAST" | "STANDARD" | "DEEP";
export type AutonomyView = {
  mode: string;
  requested: string;
  shadow?: boolean;
  paused?: boolean;
  downgraded?: string[];
  sources?: unknown[];
};
type RunPreview = {
  graph?: { steps?: StepLike[] };
  profile: { profile: string; confidence: number; reasons?: string[]; warnings?: string[] };
  published_steps?: number;
  report_step?: boolean;
  reused_repositories?: boolean;
  selected_repositories?: string[];
  changes?: Array<{ step: string; action: string; into?: string; detail: string }>;
  autonomy?: AutonomyView;
};
const COLOR: Record<string, string> = {
  MICRO: "COMPLETED",
  FAST: "COMPLETED",
  STANDARD: "READY",
  DEEP: "WAITING",
};

export function ProfileBadge({ profile, title }: { profile?: string; title?: string }) {
  if (!profile) return null;
  const I =
    profile === "FAST" || profile === "MICRO"
      ? Zap
      : profile === "DEEP"
        ? Microscope
        : profile === "STANDARD"
          ? Layers
          : null;
  return (
    <span title={title}>
      <Badge s={COLOR[profile] ?? "PENDING"}>
        {I && <I size={11} strokeWidth={2.4} />}
        {profile}
      </Badge>
    </span>
  );
}

/**
 * Profile selector + preview of the exact graph that will run (POST /api/runs/preview: same resolution as run creation).
 */
export function ProfilePreview({
  workflow,
  workItemId,
  repositories,
  inputs,
  value,
  onChange,
  autonomy = "",
  onAutonomy,
}: {
  workflow: string;
  workItemId?: number | null;
  repositories?: string[];
  inputs?: Record<string, unknown>;
  value: ProfileChoice;
  onChange: (p: ProfileChoice) => void;
  /** Requested autonomy ("" = the policy default); the server only ever narrows it. */
  autonomy?: string;
  onAutonomy?: (a: string) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<RunPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([workflow, workItemId, repositories, inputs, value, autonomy]);
  useEffect(() => {
    if (!workflow) return;
    let stop = false;
    api<RunPreview>("/api/runs/preview", {
      workflow,
      work_item_id: workItemId ?? null,
      repositories,
      inputs,
      profile: value,
      autonomy: autonomy || undefined,
    })
      .then((d) => !stop && (setData(d), setError(null)))
      .catch((e) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [key]);
  const { nodes, edges } = useMemo(() => {
    const steps = Array.isArray(data?.graph?.steps) ? data.graph.steps : [];
    if (!steps.length) return { nodes: [], edges: [] };
    const pos = autoLayout(steps);
    const nodes: Node<StepNodeData>[] = steps.map((s) => ({
      id: s.key,
      type: "step",
      position: pos[s.key],
      data: { step: s },
    }));
    return { nodes, edges: toEdges(steps, undefined, pos) };
  }, [data]);
  return (
    <div>
      <div className="pp-profiles">
        <b className="small" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Gauge size={15} color="var(--brand)" /> {t("pp.profile")}
        </b>
        <Segmented<ProfileChoice>
          label={t("pp.profile")}
          value={value}
          onChange={onChange}
          options={[
            [
              "AUTO",
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Sparkles size={12} />
                AUTO
              </span>,
            ],
            ["MICRO", <span>MICRO</span>],
            [
              "FAST",
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Zap size={12} />
                FAST
              </span>,
            ],
            [
              "STANDARD",
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Layers size={12} />
                STANDARD
              </span>,
            ],
            [
              "DEEP",
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Microscope size={12} />
                DEEP
              </span>,
            ],
          ]}
        />
      </div>
      {onAutonomy && (
        <div className="pp-profiles" style={{ marginTop: 8 }}>
          <b className="small">{t("au.request")}</b>
          <Segmented<string>
            label={t("au.request")}
            value={autonomy}
            onChange={onAutonomy}
            options={[
              ["", <span>{t("au.default")}</span>],
              ["MANUAL", <span>MANUAL</span>],
              ["SUPERVISED", <span>SUPERVISED</span>],
              ["AUTONOMOUS", <span>AUTONOMOUS</span>],
            ]}
          />
        </div>
      )}
      {data?.autonomy && <AutonomySummary a={data.autonomy} />}
      {error && <ErrorBox error={error} />}
      {data && (
        <div style={{ marginTop: 10 }}>
          <div className="small rv-chipline">
            <ArrowRight size={13} color="var(--muted)" />{" "}
            <ProfileBadge profile={data.profile?.profile} />{" "}
            <span className="muted">({t("pp.confidence", { n: data.profile?.confidence })})</span> ·{" "}
            {t("pp.steps", {
              n: data.graph?.steps?.length ?? 0,
              total: data.published_steps ?? 0,
            })}
            {data.report_step && t("pp.report")}
            {data.reused_repositories && (
              <>
                {" "}
                · {t("pp.reuse")} <b>{(data.selected_repositories ?? []).join(", ")}</b>
              </>
            )}
          </div>
          <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>
            {(data.profile?.reasons ?? []).map((r: string) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {(data.profile?.warnings ?? []).map((w: string) => (
            <div key={w} className="rv-note" style={{ color: "var(--st-wait)", margin: "4px 0" }}>
              <AlertTriangle size={13} />
              {w}
            </div>
          ))}
          {(data.changes ?? []).length > 0 && (
            <div className="pp-changes">
              {(data.changes ?? []).map((c) => (
                <div key={c.step + c.action}>
                  {c.action === "merged_into" ? (
                    <GitMerge size={13} />
                  ) : c.action === "removed" ? (
                    <Ban size={13} />
                  ) : (
                    <PenLine size={13} />
                  )}{" "}
                  <span className="mono">{c.step}</span>{" "}
                  {c.action === "merged_into" ? (
                    <>
                      {t("pp.merged")} <span className="mono">{c.into}</span>
                    </>
                  ) : c.action === "removed" ? (
                    t("pp.removed")
                  ) : (
                    t("pp.adjusted")
                  )}{" "}
                  — <span className="muted">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
          <div className="pp-graph">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 0.8 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              zoomOnScroll={false}
              panOnDrag
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} />
            </ReactFlow>
          </div>
        </div>
      )}
    </div>
  );
}

/** Requested vs effective autonomy and why it was narrowed (run form and run view). */
export function AutonomySummary({ a }: { a?: AutonomyView | null }) {
  const { t } = useI18n();
  if (!a?.sources?.length)
    return (
      <div className="small muted" style={{ marginTop: 6 }}>
        {t("au.off")}
      </div>
    );
  return (
    <div className="small" style={{ marginTop: 6 }}>
      <b>{t("au.effective", { mode: a.mode })}</b>
      {a.requested !== a.mode && (
        <span className="muted"> · {t("au.requested", { mode: a.requested })}</span>
      )}
      {a.shadow && <span className="muted"> · {t("au.shadow")}</span>}
      {a.paused && <span className="muted"> · {t("au.paused")}</span>}
      {(a.downgraded ?? []).map((d: string) => (
        <div key={d} className="rv-note" style={{ color: "var(--st-wait)", margin: "2px 0" }}>
          <AlertTriangle size={13} />
          {d}
        </div>
      ))}
    </div>
  );
}
