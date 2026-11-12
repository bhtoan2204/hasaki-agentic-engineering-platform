import { useEffect, useMemo, useRef, useState } from "react";
import { RunSummaryCard } from "./WorkItems.tsx";
import { InvestigationRunCard } from "./Investigations.tsx";
import { agentKey } from "../agentProvider.tsx";
import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Hand,
  Hourglass,
  Info,
  ListTree,
  MessageCircleQuestion,
  MessageSquareText,
  Pause,
  Play,
  Send,
  Square,
  StepForward,
  Ticket,
  Timer,
  Workflow,
  Zap,
  CheckCircle2,
  XCircle,
  GitMerge,
  Ban,
  PenLine,
} from "lucide-react";
import { api, isStateChange, STATUS_COLORS, useApi, useLive } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { CostPanel } from "../components/Cost.tsx";
import { act, Badge, Copy, ErrorBox, Loading, navigate, time } from "../ui.tsx";
import { autoLayout, nodeTypes, toEdges, type StepNodeData } from "../graph.tsx";
import { StepInspector } from "./StepInspector.tsx";
import { ProfileBadge } from "./ProfilePreview.tsx";
import { Changes } from "./Changes.tsx";
import "./RunView.css";

/** Display order of statuses in the run summary strip. */
const STATUS_ORDER = [
  "COMPLETED",
  "RUNNING",
  "RETRYING",
  "READY",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "WAITING",
  "PAUSED",
  "PENDING",
  "FAILED",
  "STALE",
  "SKIPPED",
  "CANCELED",
];
const byOrder = (a: string, b: string) =>
  (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99);

/** Live execution graph of one run + inspector. Route: #/runs/:id[/:stepKey | /~changes]. */
const PANE_KEY = "rv.inspectorWidth";
const PANE_MIN = 360;
const paneMax = () => Math.round(window.innerWidth * 0.85);

/** Width of the step inspector, set by dragging its left edge (or the arrow keys); remembered per browser. */
function useInspectorWidth() {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(PANE_KEY));
      return v >= PANE_MIN ? v : null;
    } catch {
      return null;
    }
  });
  const latest = useRef(width);
  latest.current = width;
  const save = (w: number | null) => {
    try {
      if (w == null) localStorage.removeItem(PANE_KEY);
      else localStorage.setItem(PANE_KEY, String(Math.round(w)));
    } catch {}
  };
  const clamp = (w: number) => Math.min(paneMax(), Math.max(PANE_MIN, w));
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pane = e.currentTarget.nextElementSibling as HTMLElement | null;
    if (!pane) return;
    e.preventDefault();
    const startX = e.clientX,
      startW = pane.getBoundingClientRect().width;
    document.body.classList.add("rv-resizing");
    const move = (ev: PointerEvent) => setWidth(clamp(startW + (startX - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("rv-resizing");
      save(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const pane = e.currentTarget.nextElementSibling as HTMLElement | null;
    const w = clamp(
      (latest.current ?? pane?.getBoundingClientRect().width ?? 560) +
        (e.key === "ArrowLeft" ? 40 : -40),
    );
    setWidth(w);
    save(w);
  };
  const reset = () => (setWidth(null), save(null));
  return { width, onPointerDown, onKeyDown, reset };
}

export function RunView({ id, stepKey }: { id: number; stepKey?: string }) {
  const pane = useInspectorWidth();
  const { t, status } = useI18n();
  const { data: run, error, loading, reload } = useApi<any>(`/api/runs/${id}`);
  const { data: health, reload: reloadHealth } = useApi<any>(`/api/runs/${id}/worker`);
  // Worker heartbeats are not workflow events: poll them, but only for a run that can still execute and a visible tab.
  const finished = ["COMPLETED", "FAILED", "CANCELED"].includes(run?.status);
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(
      () => document.visibilityState === "visible" && reloadHealth(),
      15000,
    );
    return () => clearInterval(timer);
  }, [id, reloadHealth, finished]);
  // tick: state changed (run, steps, cost, totals, changes); activity: any event (incremental transcript/timeline).
  const [tick, setTick] = useState(0);
  const [activity, setActivity] = useState(0);
  const live = useLive(id, (p) => {
    if (isStateChange(p)) {
      reload();
      setTick((t) => t + 1);
    }
    setActivity((a) => a + 1);
  });
  const [feedback, setFeedback] = useState("");
  const [feedbackMode, setFeedbackMode] = useState<"auto" | "reimplement" | "replan" | "restart">(
    "auto",
  );

  const { nodes, edges } = useMemo(() => {
    if (!run) return { nodes: [], edges: [] };
    const specSteps = run.graph.steps as any[];
    const pos = autoLayout(specSteps);
    const st = new Map<string, any>(run.steps.map((s: any) => [s.key, s]));
    const openQ: Record<string, number> = {};
    for (const q of run.questions)
      if (q.status === "open") openQ[q.step_key] = (openQ[q.step_key] ?? 0) + 1;
    const attempts: Record<string, number> = {};
    for (const a of run.attempts) attempts[a.step_key] = (attempts[a.step_key] ?? 0) + 1;
    const lastReplan = (run.inputs?.replans as any[] | undefined)?.at(-1);
    const rerun = new Set<string>(lastReplan?.invalidated ?? []);
    const nodes: Node<StepNodeData>[] = specSteps.map((s) => {
      const row = st.get(s.key);
      const latestAttempt = [...run.attempts].reverse().find((a: any) => a.step_key === s.key);
      const effectiveAgent = latestAttempt
        ? {
            provider:
              latestAttempt.agent_provider ?? latestAttempt.metrics?.provider ?? run.agent_provider,
            model: latestAttempt.agent_model ?? null,
          }
        : {
            provider:
              row?.agent_override?.provider ?? s.config?.agent?.provider ?? run.agent_provider,
            model: row?.agent_override?.model ?? s.config?.agent?.model,
          };
      return {
        id: s.key,
        type: "step",
        position: s.ui ?? pos[s.key],
        data: {
          step: {
            ...s,
            handoff:
              row?.status === "WAITING_INPUT" ? row?.pending_input?.provider_handoff : undefined,
            effective_agent: effectiveAgent,
            name: row?.name ?? s.name,
            requires_approval: row?.requires_approval ?? s.requires_approval,
          },
          status: row?.status,
          attempts: attempts[s.key],
          openQuestions: openQ[s.key],
          selected: s.key === stepKey,
          generation: row?.generation,
          replan: lastReplan
            ? rerun.has(s.key)
              ? "rerun"
              : row?.status === "COMPLETED" || row?.status === "SKIPPED"
                ? "reused"
                : undefined
            : undefined,
        },
      };
    });
    return { nodes, edges: toEdges(specSteps, (k) => st.get(k)?.status) };
  }, [run, stepKey]);

  // Deep link (#/runs/:id/:stepKey, e.g. from Telegram) to a step that is not in this run any more: open the run itself.
  useEffect(() => {
    if (run && stepKey && stepKey !== "~changes" && !run.steps.some((s: any) => s.key === stepKey))
      navigate(`/runs/${id}`);
  }, [run, stepKey, id]);
  if (loading && !run) return <Loading />;
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} onRetry={reload} />
      </div>
    );

  const runAction = async (a: string, body: any = {}) => {
    if (a === "cancel" && !confirm(t("rv.cancelConfirm"))) return;
    if (await act(() => api(`/api/runs/${id}/${a}`, body))) reload();
  };
  const blocked = run.steps.filter(
    (s: any) => s.status === "WAITING_INPUT" || s.status === "WAITING_APPROVAL",
  );
  const counts: Record<string, number> = {};
  for (const s of run.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const countEntries = Object.entries(counts).sort(([a], [b]) => byOrder(a, b));
  const total = run.steps.length;
  const done = (counts.COMPLETED ?? 0) + (counts.SKIPPED ?? 0);
  const hasWorkspaces = run.workspaces.length > 0;
  const canFeedback =
    run.status !== "CANCELED" &&
    (run.graph.feedback_step || run.steps.some((s: any) => s.type === "coding_agent"));
  const openFeedback = () => {
    if (stepKey) navigate(`/runs/${id}`);
    setTimeout(() => {
      const el = document.getElementById("rv-feedback");
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
    }, 80);
  };

  return (
    <>
      <header className="rv-head">
        <div className="rv-headrow">
          <nav className="rv-crumbs" aria-label="Breadcrumb">
            <a href="#/runs">
              <Activity size={13} /> {t("nav.runs")}
            </a>
            <ChevronRight size={13} aria-hidden />
            <span className={stepKey ? undefined : "rv-cur"}>
              {stepKey ? <a href={`#/runs/${id}`}>Run #{run.id}</a> : `Run #${run.id}`}
            </span>
            {stepKey && (
              <>
                <ChevronRight size={13} aria-hidden />
                <span className="rv-cur">
                  {stepKey === "~changes"
                    ? t("ch.title")
                    : (run.steps.find((s: any) => s.key === stepKey)?.name ?? stepKey)}
                </span>
              </>
            )}
          </nav>
          <span className={`rv-live is-${live}`} title={t("rv.channel")}>
            <i />
            {live === "sse"
              ? t("rv.live")
              : live === "polling"
                ? t("rv.polling")
                : t("rv.connecting")}
          </span>
        </div>

        <div className="rv-top">
          <div className="rv-titlebox">
            <span className="rv-icon">
              <Workflow size={21} strokeWidth={2} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h1 className="rv-title">
                <span className="rv-id">#{run.id}</span>
                <span className="rv-name">{run.title || run.definition_key}</span>
                <Badge s={run.status} label />
                <ProfileBadge
                  profile={run.profile}
                  title={(run.profile_decision?.reasons ?? []).join("\n")}
                />
                <span className="pill" title={t("run.agentHint")}>
                  {t("run.agent")}: {t(agentKey(run.agent_provider))}
                </span>
                <span
                  className="pill"
                  title={run.output_locale ? t("run.outputCurrent") : t("run.outputLegacyHint")}
                >
                  {t("run.outputCurrent")}:{" "}
                  {run.output_locale === "en"
                    ? t("lang.en")
                    : run.output_locale === "vi"
                      ? t("lang.vi")
                      : t("run.outputLegacy")}
                </span>
              </h1>
              <div className="rv-meta">
                <span title={t("common.workflow")}>
                  <Workflow size={13} />
                  <a href={`#/workflows/${run.definition_key}`}>{run.definition_key}</a>{" "}
                  <span className="muted">v{run.definition_version}</span>
                </span>
                <span title={t("common.branch")}>
                  <GitBranch size={13} />
                  <span className="mono">{run.branch}</span>
                </span>
                {Object.entries((run.inputs?.branches ?? {}) as Record<string, string>).map(
                  ([repo, b]) => (
                    <span
                      key={repo}
                      className="pill chip-brand"
                      title={t("rv.continueTip", {
                        source: run.inputs?.branches_source
                          ? t("rv.from", { source: run.inputs.branches_source })
                          : "",
                      })}
                    >
                      <GitBranch size={12} /> {repo === "*" ? t("rv.allRepos") : repo} →{" "}
                      <span className="mono">{b}</span> ({t("rv.continueOn")})
                      {run.status !== "COMPLETED" && run.status !== "CANCELED" && (
                        <button
                          type="button"
                          className="quiet"
                          title={t("rv.editBranch")}
                          onClick={() => {
                            const next = prompt(
                              t("rv.editBranchPrompt", {
                                repo: repo === "*" ? t("rv.allRepos") : repo,
                              }),
                              b,
                            );
                            if (next !== null && next.trim() !== b)
                              void runAction("branches", {
                                branches: { ...(run.inputs?.branches ?? {}), [repo]: next.trim() },
                              });
                          }}
                        >
                          ✎
                        </button>
                      )}
                    </span>
                  ),
                )}
                {run.work_item && (
                  <span title={t("common.workItem")}>
                    <Ticket size={13} />
                    <a href={`#/work-items/${run.work_item.id}`}>{run.work_item.code}</a>
                  </span>
                )}
                {run.created_at && (
                  <span title={t("common.created")}>
                    <CalendarClock size={13} />
                    {time(run.created_at)}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="rv-actions">
            {run.status === "PENDING" && run.worker?.local && (
              <>
                <button className="sm" onClick={() => runAction("start")}>
                  <Play size={14} /> {t("rv.start")}
                </button>
                <button
                  className="sm ghost"
                  title={t("rv.stepModeTip")}
                  onClick={() => runAction("start", { step_mode: true })}
                >
                  <StepForward size={14} /> {t("rv.stepMode")}
                </button>
              </>
            )}
            {["RUNNING", "WAITING", "FAILED"].includes(run.status) && (
              <button className="sm ghost" onClick={() => runAction("pause")}>
                <Pause size={14} /> {t("rv.pause")}
              </button>
            )}
            {run.status === "PAUSED" && run.worker?.local && (
              <button className="sm" onClick={() => runAction("resume")}>
                <Play size={14} /> {t("rv.resume")}
              </button>
            )}
            {canFeedback && (
              <button className="sm ghost" onClick={openFeedback} title={t("rv.feedbackTip")}>
                <MessageSquareText size={14} /> {t("rv.feedback")}
              </button>
            )}
            <button
              className={stepKey === "~changes" ? "sm" : "sm ghost"}
              disabled={!hasWorkspaces}
              title={hasWorkspaces ? "" : t("rv.noChanges")}
              onClick={() => navigate(`/runs/${id}/~changes`)}
            >
              <FileDiff size={14} /> {t("ch.title")}
            </button>
            {!["CANCELED", "COMPLETED"].includes(run.status) && (
              <button className="sm danger" onClick={() => runAction("cancel")}>
                <Square size={13} /> {t("rv.cancel")}
              </button>
            )}
          </div>
        </div>

        {total > 0 && (
          <div className="rv-summary">
            <span className="rv-total">{t("rv.doneOf", { done, total })}</span>
            <div
              className="progress rv-progress"
              role="img"
              aria-label={t("rv.doneOf", { done, total })}
            >
              {countEntries.map(([s, n]) => (
                <span
                  key={s}
                  style={{
                    width: `${(n / total) * 100}%`,
                    background: STATUS_COLORS[s] ?? "var(--st-idle)",
                  }}
                  title={`${status(s)}: ${n}`}
                />
              ))}
            </div>
            <div className="rv-counts">
              {countEntries.map(([s, n]) => (
                <Badge key={s} s={s}>
                  {status(s)} · {n}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </header>

      {run.steps
        .filter((s: any) => s.status === "WAITING_INPUT" && s.pending_input?.provider_handoff)
        .map((s: any) => (
          <div key={s.id} className="rv-banner wait">
            <b>
              {t("handoff.paused")}: {s.name} ·{" "}
              {s.pending_input.provider_handoff.failure_category ?? ""}
            </b>{" "}
            <button className="ghost xs" onClick={() => navigate(`/runs/${id}/${s.key}`)}>
              {t("handoff.review")}
            </button>
          </div>
        ))}
      {blocked.length > 0 && (
        <div className="rv-banner wait" role="status">
          <Hand size={16} />
          <b>{t("rv.waitingYou")}</b>
          {blocked.map((s: any) => (
            <button
              key={s.key}
              className="ghost xs"
              onClick={() => navigate(`/runs/${id}/${s.key}`)}
            >
              {s.status === "WAITING_INPUT" ? (
                <MessageCircleQuestion size={12} />
              ) : (
                <Hand size={12} />
              )}{" "}
              {s.name}
            </button>
          ))}
        </div>
      )}
      {run.worker && (
        <div className="rv-banner idle" role="status">
          <Info size={15} />
          <span>
            {t("rv.assignedInstance")}: {health?.instance_id ?? run.worker.instance_id ?? "UNKNOWN"}{" "}
            · {health?.health ?? run.worker.health}
            {" · "}
            {t("rv.lastSeen")}:{" "}
            {(health?.last_seen_at ?? run.worker.last_seen_at)
              ? time(health?.last_seen_at ?? run.worker.last_seen_at)
              : "UNKNOWN"}
            {" · "}
            {t("rv.workerAvailable")}:{" "}
            {(health?.available ?? run.worker.available) ? "ONLINE" : "WAITING_FOR_WORKER"}
            {run.worker.recovery && <> · {run.worker.recovery}</>}
            {(!run.worker.local || !(health?.available ?? run.worker.available)) && (
              <> — {t("rv.ownerOnly")}</>
            )}
            {run.worker.recovery === "NEEDS_ATTENTION" && <> — {t("rv.reconcile")}</>}
          </span>
        </div>
      )}
      <QueueBanner run={run} tick={tick} />
      {run.status === "PAUSED" && (
        <div className="rv-banner idle">
          <Info size={15} />
          <span>{t("rv.pausedHint")}</span>
        </div>
      )}
      <div className="split">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => navigate(`/runs/${id}/${n.id}`)}
            onPaneClick={() => stepKey && navigate(`/runs/${id}`)}
            nodesConnectable={false}
            fitView
            // Long workflows: fit around the selected step (or the start) at a readable zoom instead of shrinking everything.
            fitViewOptions={{
              padding: 0.25,
              maxZoom: 1,
              minZoom: 0.7,
              nodes: focusNodes(
                nodes.map((n) => n.id),
                stepKey,
              ),
            }}
            minZoom={0.2}
            ariaLabelConfig={{
              "controls.ariaLabel": t("flow.controls"),
              "controls.zoomIn.ariaLabel": t("flow.zoomIn"),
              "controls.zoomOut.ariaLabel": t("flow.zoomOut"),
              "controls.fitView.ariaLabel": t("flow.fit"),
              "controls.interactive.ariaLabel": t("flow.interactive"),
            }}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div
          className="rv-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("rv.resize")}
          title={t("rv.resize")}
          tabIndex={0}
          onPointerDown={pane.onPointerDown}
          onKeyDown={pane.onKeyDown}
          onDoubleClick={pane.reset}
        />
        <aside
          className={`${stepKey === "~changes" ? "inspector wide rv-inspector" : "inspector rv-inspector"}${pane.width ? " sized" : ""}`}
          style={
            pane.width
              ? ({
                  ["--rv-pane-w" as any]: `${pane.width}px`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {stepKey === "~changes" ? (
            <div className="rv-pane">
              <Changes run={run} tick={tick} activity={activity} onChanged={reload} />
            </div>
          ) : stepKey ? (
            <StepInspector
              key={stepKey}
              run={run}
              stepKey={stepKey}
              tick={tick}
              activity={activity}
              onChanged={reload}
            />
          ) : (
            <div className="rv-pane">
              <div className="rv-card-head" style={{ marginBottom: 4 }}>
                <h4 style={{ fontSize: "var(--fs-lg)" }}>
                  <ListTree size={18} /> {t("rv.overview")}
                </h4>
              </div>
              <div className="rv-minis">
                <div className="rv-mini">
                  <span>{t("rv.totalSteps")}</span>
                  <b>{total}</b>
                </div>
                <div className="rv-mini tone-ok">
                  <span>{t("rv.finished")}</span>
                  <b>{done}</b>
                </div>
                <div className="rv-mini tone-run">
                  <span>{t("rv.running")}</span>
                  <b>{(counts.RUNNING ?? 0) + (counts.RETRYING ?? 0)}</b>
                </div>
                <div className="rv-mini tone-wait">
                  <span>{t("rv.needYou")}</span>
                  <b>{blocked.length}</b>
                </div>
                <div className="rv-mini tone-err">
                  <span>{t("rv.errors")}</span>
                  <b>{counts.FAILED ?? 0}</b>
                </div>
              </div>
              <div className="rv-card">
                <div className="rv-kv">
                  <span>{t("rv.selectedRepos")}</span>
                  <span>
                    {run.selected_repositories.join(", ") || (
                      <span className="muted">{t("rv.noneSelected")}</span>
                    )}
                  </span>
                  <span>{t("rv.allowedRepos")}</span>
                  <span className="small">{run.allowed_repositories.join(", ")}</span>
                  <span>{t("rv.created")}</span>
                  <span>{time(run.created_at)}</span>
                  <span>{t("rv.finishedAt")}</span>
                  <span>{time(run.finished_at) || "—"}</span>
                  {run.error && (
                    <>
                      <span>{t("common.error")}</span>
                      <span className="err">{run.error}</span>
                    </>
                  )}
                </div>
              </div>
              <ReportCard run={run} />
              <InvestigationRunCard run={run} />
              <ProfileCard run={run} />
              <RunTotals runId={id} tick={tick} />
              <CostPanel kind="run" id={id} tick={tick} />
              {run.status === "PENDING" && <RepoPicker run={run} onDone={reload} />}
              <div className="rv-note">
                <Info size={14} />
                {t("rv.clickNode")}
              </div>
              {run.pull_requests.length > 0 && (
                <div className="rv-sec">
                  <div className="rv-sec-title">
                    <GitPullRequest size={14} /> {t("common.pullRequests")}
                  </div>
                  {run.pull_requests.map((p: any) => (
                    <div
                      key={p.id}
                      className="rv-card soft"
                      style={{ padding: "9px 12px", margin: "6px 0" }}
                    >
                      <div className="small">
                        <b>{p.repo}</b> ·{" "}
                        <a href={p.url} target="_blank" rel="noopener">
                          {p.title}
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {canFeedback && (
                <div className="rv-sec">
                  <div className="rv-sec-title">
                    <MessageSquareText size={14} /> {t("rv.feedbackTitle")}
                  </div>
                  <div className="rv-card">
                    <div className="muted small">{t("rv.feedbackBody")}</div>
                    <div className="rv-fb-modes" role="radiogroup" style={{ marginTop: 8 }}>
                      {(["auto", "reimplement", "replan", "restart"] as const).map((m) => (
                        <label key={m} className="rv-fb-mode" style={{ display: "block" }}>
                          <input
                            type="radio"
                            name="rv-feedback-mode"
                            value={m}
                            checked={feedbackMode === m}
                            onChange={() => setFeedbackMode(m)}
                          />{" "}
                          <b>{t(`rv.fbMode.${m}`)}</b>
                          <span className="muted small">
                            {" "}
                            —{" "}
                            {t(`rv.fbMode.${m}.d`, {
                              step:
                                m === "replan"
                                  ? (run.graph.replan_step ?? "plan")
                                  : (run.graph.feedback_step ?? t("rv.codingStep")),
                            })}
                          </span>
                        </label>
                      ))}
                    </div>
                    {(() => {
                      const last = (run.inputs?.replans as any[] | undefined)?.at(-1);
                      return last ? (
                        <div
                          className="muted small"
                          style={{ marginTop: 6 }}
                          title={(last.reasons ?? []).join("\n")}
                        >
                          {t("rv.lastReplan", {
                            route: t(`rv.fbMode.${last.route}`),
                            source: t(`rv.replanSource.${last.source}`),
                            targets: (last.targets ?? []).join(", "),
                          })}
                        </div>
                      ) : null;
                    })()}
                    <textarea
                      id="rv-feedback"
                      rows={3}
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder={t("rv.feedbackPh")}
                      style={{ marginTop: 8 }}
                    />
                    <div className="row">
                      <button
                        className="sm"
                        disabled={!feedback.trim()}
                        onClick={async () =>
                          (await act(
                            () =>
                              api(`/api/runs/${id}/feedback`, {
                                message: feedback,
                                mode: feedbackMode,
                              }),
                            t("rv.feedbackSent"),
                          )) && (setFeedback(""), reload())
                        }
                      >
                        <Send size={13} /> {t("rv.sendFeedback")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {/* Result summary + copyable markdown for every finished run (runs without a work item had none). */}
              <RunSummaryCard runs={[run]} />
              <RunTimeline runId={id} activity={activity} />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** READY steps that no worker has picked up yet: say who is holding the workers and for how long. */
function QueueBanner({ run, tick }: { run: any; tick: number }) {
  const { t } = useI18n();
  const waiting = run.steps.filter((s: any) => s.status === "READY" || s.status === "RETRYING");
  const { data, reload } = useApi<any>(
    waiting.length && !["PAUSED", "CANCELED"].includes(run.status) ? "/api/scheduler" : null,
  );
  useEffect(() => void reload(), [tick, waiting.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!waiting.length || !data) return null;
  const others = data.running.filter((j: any) => j.run_id !== run.id);
  if (!others.length) return null;
  const fmt = (s: number) =>
    s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return (
    <div className="rv-banner brand">
      <Hourglass size={15} />
      <span>
        {t("rv.queueWait", {
          steps: waiting.map((s: any) => s.name).join(", "),
          workers: data.workers,
          light: data.light_workers,
        })}{" "}
        {others.map((j: any) => (
          <a key={j.job_id} href={`#/runs/${j.run_id}/${j.step_key}`} style={{ marginRight: 10 }}>
            run #{j.run_id} · {j.step_name} ({fmt(j.running_seconds ?? 0)})
          </a>
        ))}
        <span className="muted small">— {t("rv.queueHint")}</span>
      </span>
    </div>
  );
}

/** Shortcut to the Task Result Report (when this run has one). */
function ReportCard({ run }: { run: any }) {
  const { t } = useI18n();
  const s = run.steps.find((x: any) => x.type === "task_result_report");
  if (!s) return null;
  const report = s.output?.report ?? s.approval?.request?.report;
  const md = s.output?.markdown ?? s.approval?.request?.markdown;
  const waiting = s.status === "WAITING_APPROVAL";
  return (
    <div
      className={waiting ? "rv-attn" : "rv-card"}
      style={waiting ? { padding: "12px 14px" } : undefined}
    >
      <div className="rv-card-head">
        <h4>
          <ClipboardList size={16} /> {t("rv.report")}
        </h4>{" "}
        <Badge s={s.status} label />
      </div>
      {report ? (
        <div className="rv-chipline small">
          <Badge s="COMPLETED">
            <CheckCircle2 size={11} /> {t("rv.verified", { n: report.counts.VERIFIED })}
          </Badge>
          <Badge s="WAITING">
            <AlertTriangle size={11} /> {t("rv.partial", { n: report.counts.PARTIAL })}
          </Badge>
          <Badge s="FAILED">
            <XCircle size={11} /> {t("rv.missing", { n: report.counts.MISSING })}
          </Badge>
          <span className="muted">
            {s.status === "COMPLETED" ? t("rv.approved") : waiting ? t("rv.reviewWait") : ""}
          </span>
        </div>
      ) : (
        <div className="muted small">{t("rv.reportLater")}</div>
      )}
      <div className="row">
        <button
          className={waiting ? "sm" : "sm ghost"}
          onClick={() => navigate(`/runs/${run.id}/${s.key}`)}
        >
          <ClipboardList size={13} /> {t("rv.openReport")}
        </button>
        {md && <Copy text={md} label={t("rv.copyMd")} />}
      </div>
    </div>
  );
}

function ProfileCard({ run }: { run: any }) {
  const { t } = useI18n();
  const d = run.profile_decision;
  const changes: any[] = run.graph?.profile_changes ?? [];
  if (!d) return null;
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Zap size={16} /> {t("rv.profile")}
        </h4>
        <ProfileBadge profile={run.profile} />
      </div>
      <div className="small muted">
        {d.requested === "AUTO"
          ? t("rv.autoPick", { confidence: d.confidence })
          : t("rv.manualPick")}
      </div>
      <ul className="small" style={{ margin: "6px 0", paddingLeft: 18 }}>
        {(d.reasons ?? []).map((r: string) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {(d.warnings ?? []).map((w: string) => (
        <div key={w} className="rv-note" style={{ color: "var(--st-wait)", margin: "4px 0" }}>
          <AlertTriangle size={13} />
          {w}
        </div>
      ))}
      {changes.length > 0 && (
        <details>
          <summary>{t("rv.changesVs", { n: changes.length })}</summary>
          {changes.map((c) => (
            <div key={c.step + c.action} className="small">
              {c.action === "merged_into" ? (
                <GitMerge size={12} style={{ verticalAlign: -2 }} />
              ) : c.action === "removed" ? (
                <Ban size={12} style={{ verticalAlign: -2 }} />
              ) : (
                <PenLine size={12} style={{ verticalAlign: -2 }} />
              )}{" "}
              <span className="mono">{c.step}</span>{" "}
              {c.action === "merged_into" ? `→ ${c.into}` : c.action} —{" "}
              <span className="muted">{c.detail}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

const fmtS = (ms: number) =>
  ms < 1000
    ? `${ms}ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;

/** Latency breakdown: measured queue / machine / human time per step (+ Claude, tools, commands), cost as an estimate. */
function RunTotals({ runId, tick }: { runId: number; tick: number }) {
  const { t, locale } = useI18n();
  const { data, reload } = useApi<any>(`/api/metrics/runs/${runId}`);
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const totals = data.totals;
  const num = (n: number | null | undefined) =>
    n == null ? "—" : n.toLocaleString(locale === "vi" ? "vi-VN" : "en-GB");
  const steps = Object.entries<any>(data.per_step);
  const max = Math.max(1, ...steps.map(([, s]) => s.queue_ms + s.exec_ms + s.human_ms));
  const C = {
    queue: "var(--st-idle)",
    claude: "var(--brand)",
    command: "var(--st-wait)",
    other: "var(--st-ok)",
    human: "color-mix(in srgb, var(--st-wait) 40%, transparent)",
  };
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Timer size={16} /> {t("rv.latency")}
        </h4>
        <span className="muted small">{t("rv.latencyHint")}</span>
      </div>
      <div className="rv-minis" style={{ marginBottom: 10 }}>
        <div className="rv-mini">
          <span>{t("rv.wall")}</span>
          <b>{fmtS(data.wall_ms)}</b>
        </div>
        <div className="rv-mini">
          <span>{t("rv.machine")}</span>
          <b>{fmtS(totals.exec_ms)}</b>
        </div>
        <div className="rv-mini">
          <span>{t("rv.queue")}</span>
          <b>{fmtS(totals.queue_ms)}</b>
        </div>
        <div className="rv-mini">
          <span>{t("rv.humanWait")}</span>
          <b>{fmtS(totals.human_ms)}</b>
        </div>
      </div>
      <div className="rv-kv">
        <span>{t(agentKey(data.agent_provider, true))}</span>
        <span>
          {totals.cost_unknown || totals.cost_usd == null
            ? t("rv.agentLineNoCost", {
                sessions: totals.claude_sessions,
                time: fmtS(totals.claude_ms),
                turns: totals.turns,
              })
            : t("rv.claudeLine", {
                sessions: totals.claude_sessions,
                time: fmtS(totals.claude_ms),
                turns: totals.turns,
                cost: totals.cost_usd.toFixed(3),
              })}
        </span>
        <span>{t("common.tokens")}</span>
        <span>
          {t("rv.tokens", {
            inn: num(totals.input_tokens),
            out: num(totals.output_tokens),
            cache: num(totals.cache_read_tokens),
          })}
        </span>
        <span>{t("common.tools")}</span>
        <span>
          {t("rv.tools", {
            calls: totals.tool_calls,
            tool: fmtS(totals.tool_ms),
            command: fmtS(totals.command_ms),
            integration: totals.integration_calls,
            skills: totals.skills_loaded,
          })}
        </span>
        <span>{t("rv.retries")}</span>
        <span>
          {data.bottleneck
            ? t("rv.retrySlow", {
                retries: totals.retries,
                failed: totals.failed,
                step: data.bottleneck,
              })
            : t("rv.retryLine", {
                retries: totals.retries,
                failed: totals.failed,
              })}
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        {steps.map(([k, s]) => (
          <div
            key={k}
            className="small"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(80px, 120px) 1fr 64px",
              gap: 8,
              alignItems: "center",
              margin: "4px 0",
            }}
          >
            <span
              className="mono"
              title={t("rv.attemptTip", { type: s.type, n: s.attempts })}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {k}
            </span>
            <span
              className="progress"
              style={{ height: 8 }}
              title={`${t("rv.barTip", { queue: fmtS(s.queue_ms), exec: fmtS(s.exec_ms), human: fmtS(s.human_ms) })}${s.claude_ms ? t("rv.barClaude", { time: fmtS(s.claude_ms), turns: s.turns }) : ""}`}
            >
              <span
                style={{
                  width: `${(s.queue_ms / max) * 100}%`,
                  background: C.queue,
                }}
              />
              <span
                style={{
                  width: `${(s.exec_ms / max) * 100}%`,
                  background: s.type === "command" ? C.command : s.claude_ms ? C.claude : C.other,
                }}
              />
              <span
                style={{
                  width: `${(s.human_ms / max) * 100}%`,
                  background: C.human,
                }}
              />
            </span>
            <span className="mono muted" style={{ textAlign: "right" }}>
              {fmtS(s.queue_ms + s.exec_ms + s.human_ms)}
            </span>
          </div>
        ))}
        <div className="rv-chipline muted small" style={{ marginTop: 8, gap: 12 }}>
          {(["queue", "claude", "command", "other", "human"] as const).map((k) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <i
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: C[k],
                  display: "inline-block",
                }}
              />
              {k === "claude" ? "Claude" : t(`rv.legend.${k}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RepoPicker({ run, onDone }: { run: any; onDone: () => void }) {
  const { t } = useI18n();
  const [sel, setSel] = useState<string[]>(run.selected_repositories);
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <FolderGit2 size={16} /> {t("rv.repos")}
        </h4>
      </div>
      <div className="rv-chipline">
        {run.allowed_repositories.map((r: string) => (
          <label
            key={r}
            className="rv-repo-opt"
            style={{
              margin: 0,
              padding: "6px 10px",
              alignItems: "center",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={sel.includes(r)}
              onChange={(e) => setSel(e.target.checked ? [...sel, r] : sel.filter((x) => x !== r))}
              style={{ marginTop: 0 }}
            />{" "}
            {r}
          </label>
        ))}
      </div>
      <div className="row">
        <button
          className="sm ghost"
          onClick={async () =>
            (await act(
              () => api(`/api/runs/${run.id}/repositories`, { repositories: sel }),
              t("wi.saved"),
            )) && onDone()
          }
        >
          {t("kn.save")}
        </button>
      </div>
    </div>
  );
}

/** Run timeline, fetched once and then incrementally (`?after=`) whenever an event arrives. */
function RunTimeline({ runId, activity }: { runId: number; activity: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<any[] | null>(null);
  const last = useRef(0);
  useEffect(() => {
    setData(null);
    last.current = 0;
  }, [runId]);
  useEffect(() => {
    let stop = false;
    api<any[]>(`/api/runs/${runId}/events?after=${last.current}`)
      .then((rows) => {
        if (stop) return;
        if (rows.length) last.current = rows[rows.length - 1].id;
        setData((prev) => [...(prev ?? []), ...rows]);
      })
      .catch(() => !stop && setData((prev) => prev ?? []));
    return () => {
      stop = true;
    };
  }, [runId, activity]);
  if (!data) return null;
  return (
    <div className="rv-sec">
      <div className="rv-sec-title">
        <Activity size={14} /> {t("common.timeline")}
      </div>
      <div className="rv-tl">
        {data
          .slice()
          .reverse()
          .slice(0, 300)
          .map((e) => (
            <div key={e.id} className="rv-tl-row">
              <span className="muted">
                {time(e.created_at)}
                <br />
                <span className="mono">{e.step_key ?? "run"}</span>
              </span>
              <span>
                <b className="muted small">{e.kind}</b>{" "}
                <span
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    color: e.kind === "user" ? "var(--brand-700)" : undefined,
                  }}
                >
                  {e.content}
                </span>
              </span>
            </div>
          ))}
        {!data.length && (
          <div className="muted small" style={{ padding: 12 }}>
            {t("rv.noEvents")}
          </div>
        )}
      </div>
    </div>
  );
}

/** Up to 5 node ids around `key` (or the first 5) for the initial viewport. */
function focusNodes(ids: string[], key?: string) {
  const i = key ? ids.indexOf(key) : -1;
  const from = i < 0 ? 0 : Math.max(0, Math.min(i - 2, ids.length - 5));
  return ids.slice(from, from + 5).map((id) => ({ id }));
}
