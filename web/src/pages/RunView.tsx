import "./RunView.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rolesOfSteps } from "../office/StepChibi.tsx";
import { RunSummaryCard } from "./WorkItems.tsx";
import { InvestigationRunCard } from "./Investigations.tsx";
import { agentKey } from "../agentProvider.tsx";
import {
  Background,
  ControlButton,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  Activity,
  CalendarClock,
  ChevronRight,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Hand,
  LayoutGrid,
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
  Workflow,
  Pencil,
} from "lucide-react";
import { api, isStateChange, STATUS_COLORS, useApi, useLive } from "../api.ts";
import { dialog } from "../dialog/index.ts";
import { useI18n } from "../i18n/index.tsx";
import { CostPanel } from "../components/Cost.tsx";
import { act, Badge, EmptyState, ErrorBox, Loading, navigate, time } from "../ui.tsx";
import {
  autoLayout,
  nodeTypes,
  placeSteps,
  toEdges,
  useStableById,
  type StepNodeData,
} from "../graph.tsx";
import { StepInspector, type StepHandoff, type StepRow } from "./StepInspector.tsx";
import { ProfileBadge } from "./ProfilePreview.tsx";
import { Changes } from "./Changes.tsx";
import { TraceExplorer } from "./TraceExplorer.tsx";
import { latestStepDecisions } from "../decisions";
import { ReuseCard } from "./ExecutionCards";
import { childActive, childGraph, childNodeTypes, childSummary } from "./childWorkflows.tsx";
import { DeliveryCard } from "./RunView/DeliveryCard.tsx";
import { ProfileCard } from "./RunView/ProfileCard.tsx";
import { PullRequestControls } from "./RunView/PullRequestControls.tsx";
import { RunTimeline } from "./RunView/RunTimeline.tsx";
import { RunTotals } from "./RunView/RunTotals.tsx";
import {
  AutonomyCard,
  QueueBanner,
  RecoveryCard,
  RepoPicker,
  ReportCard,
  type RunDetail,
  STATUS_ORDER,
  type WorkerHealth,
} from "./RunView/shared.tsx";
import { useInspectorWidth } from "./RunView/useInspectorWidth.tsx";

/** Step nodes plus the child-workflow cards and their lane (stable object: React Flow warns on a new one per render). */
const allNodeTypes = { ...nodeTypes, ...childNodeTypes } as typeof nodeTypes;

const byOrder = (a: string, b: string) =>
  (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99);

const ARRANGE_KEY = "rv.autoLayout";

export function RunView({ id, stepKey }: { id: number; stepKey?: string }) {
  const pane = useInspectorWidth();
  const { t, status } = useI18n();
  const {
    data: run,
    error,
    loading,
    refreshing,
    reload,
    reloadFresh,
  } = useApi<RunDetail>(`/api/runs/${id}`);
  const { data: health, reload: reloadHealth } = useApi<WorkerHealth>(`/api/runs/${id}/worker`);
  // Child runs publish events on their own run: while any is active, the parent page refreshes itself.
  const reloadRef = useRef(() => {});
  reloadRef.current = reload;
  const childrenLive = !!run?.delegation?.children.some(childActive);
  useEffect(() => {
    if (!childrenLive) return;
    const timer = setInterval(() => document.visibilityState === "visible" && reload(), 5000);
    return () => clearInterval(timer);
  }, [childrenLive, reload]);
  // Worker heartbeats are not workflow events: poll them, but only for a run that can still execute and a visible tab.
  const finished = !!run && ["COMPLETED", "FAILED", "CANCELED"].includes(run.status);
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
  const [replayPreview, setReplayPreview] = useState<Record<string, string> | null>(null);
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
  // Node drag (and a pane pan that starts on a block) cancels the click when the pointer moves at all.
  // Record the press so the mouseup that lands on the pane does not immediately close the step.
  const pickedAt = useRef(0);
  const pickStep = useCallback(
    (key: string) => {
      pickedAt.current = performance.now();
      navigate(`/runs/${id}/${key}`);
    },
    [id],
  );

  const [arranged, setArranged] = useState(() => {
    try {
      return localStorage.getItem(ARRANGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleArranged = () => {
    const next = !arranged;
    setArranged(next);
    try {
      localStorage.setItem(ARRANGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore: storage unavailable */
    }
  };
  const hasSavedLayout = !!run?.graph.steps?.some((s) => s.ui);
  // Graph built from the run alone (no selection): a step switch does not rebuild it, and a reload keeps the objects of
  // nodes and edges whose content did not change (React Flow then re-renders only the steps that changed).
  const stableNodes = useStableById<Node<StepNodeData>>();
  const stableEdges = useStableById<Edge>();
  const graph = useMemo(() => {
    if (!run)
      return { nodes: [] as Node<StepNodeData>[], childNodes: [] as Node[], edges: [] as Edge[] };
    const specSteps = run.graph.steps;
    const placed = arranged && hasSavedLayout ? autoLayout(specSteps) : placeSteps(specSteps);
    const st = new Map(run.steps.map((s) => [s.key, s] as const));
    const openQ: Record<string, number> = {};
    for (const q of run.questions)
      if (q.status === "open") openQ[q.step_key] = (openQ[q.step_key] ?? 0) + 1;
    // One pass over the attempts (ordered by id): count and latest per step.
    const attempts: Record<string, number> = {};
    const latest = new Map<string, RunDetail["attempts"][number]>();
    for (const a of run.attempts) {
      attempts[a.step_key] = (attempts[a.step_key] ?? 0) + 1;
      latest.set(a.step_key, a);
    }
    const lastReplan = run.inputs?.replans?.at(-1);
    const decided = latestStepDecisions(run.decisions, run.steps);
    const rerun = new Set<string>(lastReplan?.invalidated ?? []);
    const roles = rolesOfSteps(specSteps);
    const children = childSummary(run.delegation?.children ?? []);
    const nodes: Node<StepNodeData>[] = specSteps.map((s) => {
      const row = st.get(s.key);
      const latestAttempt = latest.get(s.key);
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
        className: "nopan",
        position: placed[s.key],
        selected: false,
        data: {
          step: {
            ...s,
            handoff:
              row?.status === "WAITING_INPUT" ? row?.pending_input?.provider_handoff : undefined,
            effective_agent: effectiveAgent,
            name: row?.name ?? s.name,
            requires_approval: row?.requires_approval ?? s.requires_approval,
          },
          transition: s.type === "coding_agent" ? run.graph?.transitions?.at(-1) : undefined,
          status: row?.status,
          role: roles[s.key],
          attempts: attempts[s.key],
          openQuestions: openQ[s.key],
          selected: false,
          generation: row?.generation,
          replan: lastReplan
            ? rerun.has(s.key)
              ? "rerun"
              : row?.status === "COMPLETED" || row?.status === "SKIPPED"
                ? "reused"
                : undefined
            : undefined,
          decision: decided[s.key]
            ? {
                action: decided[s.key].action,
                outcome: decided[s.key].outcome,
                reason: decided[s.key].reason,
              }
            : undefined,
          preview: replayPreview?.[s.key],
          childWorkflows: children[s.key],
          waitingChildren: row?.status === "WAITING_INPUT" && !!row?.pending_input?.child_workflows,
          onPick: pickStep,
        },
      };
    });
    // Child workflows (delegation): a lane under the steps, each card linked to the step that started it.
    const kids = childGraph(run.delegation?.children ?? [], placed, run.id, () =>
      reloadRef.current(),
    );
    return {
      nodes: stableNodes(nodes),
      childNodes: kids.nodes,
      edges: [...stableEdges(toEdges(specSteps, (k) => st.get(k)?.status, placed)), ...kids.edges],
    };
  }, [run, pickStep, arranged, hasSavedLayout, replayPreview, stableNodes, stableEdges]);
  const edges = graph.edges;
  const nodes = useMemo(
    () => [
      ...(stepKey
        ? graph.nodes.map((n) =>
            n.id === stepKey ? { ...n, selected: true, data: { ...n.data, selected: true } } : n,
          )
        : graph.nodes),
      ...(graph.childNodes as Node<StepNodeData>[]),
    ],
    [graph.nodes, graph.childNodes, stepKey],
  );
  const fitViewOptions = useMemo(
    () => ({
      padding: 0.25,
      maxZoom: 1,
      minZoom: 0.7,
      nodes: focusNodes(
        [
          ...graph.nodes.map((n) => n.id),
          ...graph.childNodes.filter((n) => n.type === "child").map((n) => n.id),
        ],
        stepKey,
      ),
    }),
    [graph.nodes, graph.childNodes, stepKey],
  );
  const flowLabels = useMemo(
    () => ({
      "controls.ariaLabel": t("flow.controls"),
      "controls.zoomIn.ariaLabel": t("flow.zoomIn"),
      "controls.zoomOut.ariaLabel": t("flow.zoomOut"),
      "controls.fitView.ariaLabel": t("flow.fit"),
      "controls.interactive.ariaLabel": t("flow.interactive"),
    }),
    [t],
  );

  // Deep link (#/runs/:id/:stepKey, e.g. from Telegram) to a step that is not in this run any more: open the run itself.
  useEffect(() => {
    if (
      run &&
      stepKey &&
      stepKey !== "~changes" &&
      stepKey !== "~trace" &&
      !run.steps.some((s) => s.key === stepKey)
    )
      navigate(`/runs/${id}`);
  }, [run, stepKey, id]);
  if (loading && !run) return <Loading />;
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} onRetry={reload} />
      </div>
    );
  if (!run)
    return (
      <div className="page">
        <EmptyState title={t("common.notFound")} />
      </div>
    );

  const runAction = async (a: string, body: unknown = {}) => {
    if (a === "cancel") {
      const ok = await dialog.confirm({
        title: t("rv.cancel.title"),
        description: t("rv.cancelConfirm"),
        confirmLabel: t("rv.cancel.action"),
        cancelLabel: t("common.cancel"),
        variant: "destructive",
      });
      if (!ok) return;
    }
    await act(async () => {
      await api(`/api/runs/${id}/${a}`, body);
      await reloadFresh();
    });
  };
  // A step waiting for its child workflows waits for them, not for the user.
  const blocked = run.steps.filter(
    (s) =>
      (s.status === "WAITING_INPUT" && !s.pending_input?.child_workflows) ||
      s.status === "WAITING_APPROVAL",
  );
  const counts: Record<string, number> = {};
  for (const s of run.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const countEntries = Object.entries(counts).sort(([a], [b]) => byOrder(a, b));
  const total = run.steps.length;
  const done = (counts.COMPLETED ?? 0) + (counts.SKIPPED ?? 0);
  const hasWorkspaces = run.workspaces.length > 0;
  const canFeedback =
    run.status !== "CANCELED" &&
    (run.graph.feedback_step || run.steps.some((s) => s.type === "coding_agent"));
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
          <nav className="rv-crumbs" aria-label={t("common.breadcrumb")}>
            <a href="#/runs">
              <Activity size={13} /> {t("nav.runs")}
            </a>
            <ChevronRight size={13} aria-hidden />
            <span className={stepKey ? undefined : "rv-cur"}>
              {stepKey ? (
                <a href={`#/runs/${id}`}>{t("common.runN", { id: run.id })}</a>
              ) : (
                t("common.runN", { id: run.id })
              )}
            </span>
            {stepKey && (
              <>
                <ChevronRight size={13} aria-hidden />
                <span className="rv-cur">
                  {stepKey === "~changes"
                    ? t("ch.title")
                    : stepKey === "~trace"
                      ? t("trace.title")
                      : (run.steps.find((s) => s.key === stepKey)?.name ?? stepKey)}
                </span>
              </>
            )}
          </nav>
          <span
            className={`rv-live is-${live}${refreshing ? " is-refreshing" : ""}`}
            title={t("rv.channel")}
            role="status"
          >
            <i />
            {refreshing
              ? t("rv.updating")
              : live === "sse"
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
            <div className="rv-title-wrap">
              <h1 className="rv-title">
                <span className="rv-id">#{run.id}</span>
                <span className="rv-name">{run.title || run.definition_key}</span>
                <Badge s={run.status} label />
                <ProfileBadge
                  profile={run.profile}
                  title={(run.profile_decision?.reasons ?? []).join("\n")}
                />
                <span className="rv-meta-chip" title={t("run.agentHint")}>
                  {t("run.agent")}: {t(agentKey(run.agent_provider))}
                </span>
                <span
                  className="rv-meta-chip"
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
                      className="rv-meta-chip is-brand"
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
                          className="quiet icon xs"
                          aria-label={t("rv.editBranch")}
                          title={t("rv.editBranch")}
                          onClick={async () => {
                            const next = await dialog.prompt({
                              title: t("rv.editBranch.title"),
                              description: t("rv.editBranchPrompt", {
                                repo: repo === "*" ? t("rv.allRepos") : repo,
                              }),
                              label: t("rv.editBranch.label"),
                              defaultValue: b,
                              required: false,
                              confirmLabel: t("rv.editBranch.action"),
                              cancelLabel: t("common.cancel"),
                            });
                            if (next !== null && next.trim() !== b)
                              void runAction("branches", {
                                branches: { ...(run.inputs?.branches ?? {}), [repo]: next.trim() },
                              });
                          }}
                        >
                          <Pencil size={12} />
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
                <button type="button" className="sm" onClick={() => runAction("start")}>
                  <Play size={14} /> {t("rv.start")}
                </button>
                <button
                  type="button"
                  className="sm ghost"
                  title={t("rv.stepModeTip")}
                  onClick={() => runAction("start", { step_mode: true })}
                >
                  <StepForward size={14} /> {t("rv.stepMode")}
                </button>
              </>
            )}
            {["RUNNING", "WAITING", "FAILED"].includes(run.status) && (
              <button type="button" className="sm ghost" onClick={() => runAction("pause")}>
                <Pause size={14} /> {t("rv.pause")}
              </button>
            )}
            {run.status === "PAUSED" && run.worker?.local && (
              <button type="button" className="sm" onClick={() => runAction("resume")}>
                <Play size={14} /> {t("rv.resume")}
              </button>
            )}
            {canFeedback && (
              <button
                type="button"
                className="sm ghost"
                onClick={openFeedback}
                title={t("rv.feedbackTip")}
              >
                <MessageSquareText size={14} /> {t("rv.feedback")}
              </button>
            )}
            <button
              type="button"
              className="sm ghost"
              aria-current={stepKey === "~changes" ? "page" : undefined}
              disabled={!hasWorkspaces}
              aria-describedby={hasWorkspaces ? undefined : "rv-no-changes"}
              onClick={() => navigate(`/runs/${id}/~changes`)}
            >
              <FileDiff size={14} /> {t("ch.title")}
            </button>
            {!hasWorkspaces && (
              <span id="rv-no-changes" className="muted small">
                {t("rv.noChanges")}
              </span>
            )}
            <button
              type="button"
              className="sm ghost"
              aria-current={stepKey === "~trace" ? "page" : undefined}
              onClick={() => navigate(`/runs/${id}/~trace`)}
            >
              <Activity size={14} /> {t("trace.title")}
            </button>
            {!["CANCELED", "COMPLETED"].includes(run.status) && (
              <button type="button" className="sm danger" onClick={() => runAction("cancel")}>
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
                  {status(s)} {n}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </header>

      {run.steps
        .filter(
          (s): s is StepRow & { pending_input: { provider_handoff: StepHandoff } } =>
            s.status === "WAITING_INPUT" && !!s.pending_input?.provider_handoff,
        )
        .map((s) => (
          <div key={s.id} className="rv-banner wait">
            <b>
              {s.pending_input.provider_handoff.status === "BLOCKED"
                ? t("handoff.blocked")
                : t("handoff.paused")}
              : {s.name}
              {s.pending_input.provider_handoff.status === "BLOCKED"
                ? ""
                : ` · ${s.pending_input.provider_handoff.failure_category ?? ""}`}
            </b>{" "}
            {s.pending_input.provider_handoff.status === "BLOCKED" && (
              <span>
                {s.pending_input.provider_handoff.blocked_reason || t("handoff.blockedHint")}{" "}
              </span>
            )}
            <button
              type="button"
              className="ghost xs"
              onClick={() => navigate(`/runs/${id}/${s.key}`)}
            >
              {t("handoff.review")}
            </button>
          </div>
        ))}
      {blocked.length > 0 && (
        <div className="rv-banner wait" role="status">
          <Hand size={16} />
          <b>{t("rv.waitingYou")}</b>
          {blocked.map((s) => (
            <button
              type="button"
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
          <span className="rv-inline-meta">
            <span>
              {t("rv.assignedInstance")}: {health?.instance_id ?? run.worker.instance_id ?? "UNKNOWN"}
            </span>
            <span>{health?.health ?? run.worker.health}</span>
            <span>
              {t("rv.lastSeen")}:{" "}
              {(health?.last_seen_at ?? run.worker.last_seen_at)
                ? time(health?.last_seen_at ?? run.worker.last_seen_at)
                : "UNKNOWN"}
            </span>
            <span>
              {t("rv.workerAvailable")}:{" "}
              {(health?.available ?? run.worker.available) ? "ONLINE" : "WAITING_FOR_WORKER"}
            </span>
            {run.worker.recovery && <span>{run.worker.recovery}</span>}
            {(!run.worker.local || !(health?.available ?? run.worker.available)) && (
              <span>({t("rv.ownerOnly")})</span>
            )}
            {run.worker.recovery === "NEEDS_ATTENTION" && <span>({t("rv.reconcile")})</span>}
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
      {run.delegation?.parent && (
        <div className="rv-banner idle rv-delegation" data-testid="run-delegation">
          <Info size={15} />
          <span className="rv-inline-meta">
            <span>
              {t("rv.childOf")}{" "}
              <a href={`#/runs/${run.delegation.parent.run_id}`}>
                #{run.delegation.parent.run_id} {run.delegation.parent.title}
              </a>
            </span>
            <span>{t(`child.mode.${run.delegation.parent.mode}`)}</span>
          </span>
        </div>
      )}
      <div className="split">
        <div className="canvas">
          <ReactFlow
            key={arranged && hasSavedLayout ? "arranged" : "saved"}
            nodes={nodes}
            edges={edges}
            nodeTypes={allNodeTypes}
            // Child-workflow cards handle their own clicks (open, start, cancel); only steps open the inspector.
            onNodeClick={(_, n) => n.type === "step" && pickStep(n.id)}
            onPaneClick={() => {
              if (performance.now() - pickedAt.current < 500) return;
              if (stepKey) navigate(`/runs/${id}`);
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            elevateEdgesOnSelect={false}
            autoPanOnNodeFocus={false}
            nodeClickDistance={8}
            nodeDragThreshold={8}
            fitView
            // Long workflows: fit around the selected step (or the start) at a readable zoom instead of shrinking everything.
            fitViewOptions={fitViewOptions}
            minZoom={0.2}
            ariaLabelConfig={flowLabels}
          >
            <Background gap={18} />
            <Controls showInteractive={false}>
              {hasSavedLayout && (
                <ControlButton
                  onClick={toggleArranged}
                  title={t("rv.autoLayout")}
                  aria-label={t("rv.autoLayout")}
                  aria-pressed={arranged}
                  className={arranged ? "on" : undefined}
                >
                  <LayoutGrid size={14} />
                </ControlButton>
              )}
            </Controls>
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
                  "--rv-pane-w": `${pane.width}px`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {stepKey === "~trace" ? (
            <TraceExplorer runId={id} activity={activity} />
          ) : stepKey === "~changes" ? (
            <div className="rv-pane">
              <Changes run={run} tick={tick} activity={activity} onChanged={reloadFresh} />
            </div>
          ) : stepKey ? (
            <StepInspector
              key={stepKey}
              run={run}
              stepKey={stepKey}
              tick={tick}
              activity={activity}
              onChanged={reloadFresh}
              onReplayPreview={setReplayPreview}
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
              <AutonomyCard run={run} onDone={reload} />
              <RecoveryCard run={run} />
              <DeliveryCard runId={run.id} />
              <RunTotals runId={id} tick={tick} />
              <ReuseCard decisions={run.decisions} />
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
                  {run.pull_requests.map((p) => (
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
                        {p.state ? ` · ${p.state}` : ""}
                      </div>
                      {p.provider === "gitlab" && (!p.state || p.state === "OPEN") && (
                        <PullRequestControls id={p.id} onDone={reload} />
                      )}
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
                      const last = run.inputs?.replans?.at(-1);
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
                        type="button"
                        className="sm"
                        disabled={!feedback.trim()}
                        onClick={async () => {
                          const r = await act(async () => {
                            const result = await api(`/api/runs/${id}/feedback`, {
                              message: feedback,
                              mode: feedbackMode,
                            });
                            await reloadFresh();
                            return result;
                          }, t("rv.feedbackSent"));
                          if (r) setFeedback("");
                        }}
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

/** Up to 5 node ids around `key` (or the first 5) for the initial viewport. */
function focusNodes(ids: string[], key?: string) {
  const i = key ? ids.indexOf(key) : -1;
  const from = i < 0 ? 0 : Math.max(0, Math.min(i - 2, ids.length - 5));
  return ids.slice(from, from + 5).map((id) => ({ id }));
}
