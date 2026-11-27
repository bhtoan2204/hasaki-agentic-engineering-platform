import "./RunView.css";
import { ProviderHandoff } from "../ProviderHandoff.tsx";
import { StepAgentOverride } from "../StepAgentOverride.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { agentKey, asProvider } from "../agentProvider.tsx";
import {
  ArrowRight,
  BookOpen,
  ClipboardList,
  Cpu,
  FileText,
  Hand,
  History,
  Info,
  Layers,
  ListChecks,
  LogIn,
  LogOut,
  MessageCircleQuestion,
  MessagesSquare,
  Paperclip,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  SquareTerminal,
  X,
  XCircle,
  Bot,
} from "lucide-react";
import { api, STATUS_COLORS, useApi } from "../api.ts";
import { dialog } from "../dialog/index.ts";
import {
  act,
  Badge,
  Copy,
  Empty,
  EmptyState,
  ErrorBox,
  JsonBlock,
  Loading,
  Markdown,
  Tabs,
  time,
  navigate,
} from "../ui.tsx";
import { stepTypeIcon } from "../graph.tsx";
import { useI18n } from "../i18n/index.tsx";
import { Transcript } from "./Transcript.tsx";
import { ReportPanel } from "./Report.tsx";
import { CheckpointsCard, DecisionsCard, HarnessCard } from "./ExecutionCards";
import { ApprovalPanel } from "./StepInspector/ApprovalPanel.tsx";
import { Artifacts } from "./StepInspector/Artifacts.tsx";
import { AttemptMetrics } from "./StepInspector/AttemptMetrics.tsx";
import { BaselineSummary } from "./StepInspector/BaselineSummary.tsx";
import { CommandLog } from "./StepInspector/CommandLog.tsx";
import { KnowledgeApplied } from "./StepInspector/KnowledgeApplied.tsx";
import { QuestionsForm } from "./StepInspector/QuestionsForm.tsx";
import { ReexecuteDialog } from "./StepInspector/ReexecuteDialog.tsx";
import { TestFailurePanel } from "./StepInspector/TestFailurePanel.tsx";
import { VerdictCard } from "./StepInspector/VerdictCard.tsx";
import { VerificationCard } from "./StepInspector/VerificationCard.tsx";
import {
  AttemptPayload,
  type FailureInfo,
  type InspectorRun,
  OutputView,
  ReexecuteInfo,
  type StepDetail,
} from "./StepInspector/shared.tsx";
export { OutputView } from "./StepInspector/shared.tsx";
export type { InspectorRun, StepHandoff, StepRow } from "./StepInspector/shared.tsx";
export { QuestionsForm } from "./StepInspector/QuestionsForm.tsx";
export { ApprovalPanel } from "./StepInspector/ApprovalPanel.tsx";
export { Artifacts } from "./StepInspector/Artifacts.tsx";

const AGENT_TYPES = ["agent", "coding_agent"];

type Tab =
  | "report"
  | "overview"
  | "execution"
  | "input"
  | "output"
  | "knowledge"
  | "qa"
  | "artifacts"
  | "history";

const TabLabel = ({ icon: I, children }: { icon: typeof Info; children: ReactNode }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
    <I size={13} strokeWidth={2} />
    {children}
  </span>
);

export function StepInspector({
  run,
  stepKey,
  tick,
  activity = tick,
  onChanged,
  onReplayPreview,
}: {
  run: InspectorRun;
  stepKey: string;
  /** Bumped when step state may have changed (reloads the step). */
  tick: number;
  /** Bumped on every event of the run (incremental transcript fetches). */
  activity?: number;
  onChanged: () => void;
  /** Planned replay decision per step key while the re-execute dialog shows a preview; null when it closes. */
  onReplayPreview?: (plan: Record<string, string> | null) => void;
}) {
  const { t } = useI18n();
  const { data, error, loading, reload, reloadFresh } = useApi<StepDetail>(
    `/api/runs/${run.id}/steps/${stepKey}`,
  );
  const [tab, setTab] = useState<Tab>(stepKey === "task_result_report" ? "report" : "overview");
  const [attemptId, setAttemptId] = useState<number | null>(null);
  useEffect(() => void reload(), [reload, tick]);
  useEffect(() => setAttemptId(null), [stepKey]);
  if (loading && !data)
    return (
      <div className="rv-pane">
        <Loading />
      </div>
    );
  if (error)
    return (
      <div className="rv-pane">
        <ErrorBox error={error} onRetry={reload} />
      </div>
    );
  if (!data)
    return (
      <div className="rv-pane">
        <EmptyState title={t("common.notFound")} />
      </div>
    );
  const { step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs } = data;
  const isAgent = AGENT_TYPES.includes(step.type);
  const attempt =
    attempts.find((a) => a.id === attemptId) ??
    attempts.find((a) => a.id === step.current_attempt_id) ??
    attempts[attempts.length - 1];
  const effectiveProvider = attempt
    ? (attempt.agent_provider ?? attempt.metrics?.provider ?? run.agent_provider)
    : (step.agent_override?.provider ?? step.config?.agent?.provider ?? run.agent_provider);
  const effectiveModel =
    attempt?.metrics?.model ||
    attempt?.agent_model ||
    (attempt ? null : (step.agent_override?.model ?? step.config?.agent?.model));
  const snapshot = snapshots.find((s) => s.id === attempt?.context_snapshot_id);
  const open = questions.filter((q) => q.status === "open");
  const live = step.status === "RUNNING" && attempt?.id === step.current_attempt_id;
  const runActive = run.status !== "CANCELED";
  const refresh = () => Promise.all([reloadFresh(), Promise.resolve(onChanged())]);
  const action = async (path: string, body: unknown = {}, ok?: string) =>
    act(async () => {
      const result = await api(`/api/runs/${run.id}/steps/${step.key}/${path}`, body);
      await refresh();
      return result;
    }, ok);
  const canRun =
    run.worker?.local && run.status === "PAUSED" && ["READY", "RETRYING"].includes(step.status);
  const canRetry = run.worker?.local && runActive && ["FAILED", "CANCELED"].includes(step.status);
  const canReexec =
    run.worker?.local &&
    runActive &&
    ["COMPLETED", "SKIPPED", "WAITING_INPUT", "WAITING_APPROVAL", "FAILED"].includes(step.status);
  const canSkip =
    runActive &&
    ["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(step.status);
  const verification = attempt
    ? (attempt.output?.verification ??
      attempt.metrics?.verification ??
      attempt.error?.details?.verification ??
      (attempt.id === step.current_attempt_id ? step.output?.verification : undefined))
    : step.output?.verification;
  const verdict = attempt?.output?.verdict
    ? attempt.output
    : attempt?.error?.details?.verdict
      ? attempt.error.details
      : null;
  const TypeIcon = stepTypeIcon(step.type);

  const tabs: Array<[Tab, React.ReactNode]> = [
    ...(step.type === "task_result_report"
      ? ([["report", <TabLabel icon={ClipboardList}>{t("si.tab.report")}</TabLabel>]] as Array<
          [Tab, React.ReactNode]
        >)
      : []),
    ["overview", <TabLabel icon={Info}>{t("si.tab.overview")}</TabLabel>],
    ...(isAgent
      ? ([
          [
            "execution",
            <TabLabel icon={Bot}>
              {t(agentKey(effectiveProvider, true))} {live && <span className="spinner" />}
            </TabLabel>,
          ],
        ] as Array<[Tab, React.ReactNode]>)
      : []),
    ...(step.type === "command"
      ? ([
          [
            "execution",
            <TabLabel icon={SquareTerminal}>
              {t("si.tab.live")} {live && <span className="spinner" />}
            </TabLabel>,
          ],
        ] as Array<[Tab, React.ReactNode]>)
      : []),
    ["input", <TabLabel icon={LogIn}>{t("si.tab.input")}</TabLabel>],
    ["output", <TabLabel icon={LogOut}>{t("si.tab.output")}</TabLabel>],
    [
      "knowledge",
      <TabLabel
        icon={BookOpen}
      >{`${t("si.tab.knowledge")}${snapshot ? ` (${snapshot.knowledge_count})` : ""}`}</TabLabel>,
    ],
    [
      "qa",
      <TabLabel
        icon={MessagesSquare}
      >{`${t("si.tab.qa")}${questions.length ? ` (${questions.length})` : ""}`}</TabLabel>,
    ],
    [
      "artifacts",
      <TabLabel
        icon={Paperclip}
      >{`${t("si.tab.artifacts")}${artifacts.length ? ` (${artifacts.length})` : ""}`}</TabLabel>,
    ],
    [
      "history",
      <TabLabel icon={History}>{`${t("si.tab.history")} (${attempts.length})`}</TabLabel>,
    ],
  ];

  return (
    <div>
      <div className="si-head">
        <div className="si-top">
          <span
            className="si-icon"
            style={
              {
                "--si-c": STATUS_COLORS[step.status] ?? "var(--brand)",
              } as React.CSSProperties
            }
          >
            <TypeIcon size={20} strokeWidth={2} />
          </span>
          <div className="si-title">
            <h2>{step.name}</h2>
            <div className="si-meta">
              <Badge s={step.status} label />
              <span className="mono">{step.key}</span>
              <span>{step.type}</span>
              <span>
                {t("cl.gen")} {step.generation}
              </span>
              <span>
                {attempt ? t("si.attemptN", { n: attempt.number }) : t("si.notRun")}
                {attempts.length > 1 ? ` / ${attempts.length}` : ""}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="quiet icon"
            aria-label={t("si.closeInspector")}
            title={t("common.close")}
            onClick={() => navigate(`/runs/${run.id}`)}
          >
            <X size={18} />
          </button>
        </div>
        {(canRun ||
          canRetry ||
          canSkip ||
          ["RUNNING", "RETRYING"].includes(step.status) ||
          attempts.length > 1) && (
          <div className="si-actions">
            {canRun && (
              <button
                type="button"
                className="sm"
                onClick={() => action("run", {}, t("si.queued"))}
              >
                <Play size={13} /> {t("si.runStep")}
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                className="sm warn"
                onClick={() => action("retry", {}, t("si.retrying"))}
              >
                <RotateCcw size={13} /> {t("si.retry")}
              </button>
            )}
            {canRetry && step.type === "command" && step.config?.baseline_compare !== "go" && (
              <button
                type="button"
                className="sm ghost"
                title={t("si.retryBaselineTip")}
                onClick={() =>
                  action(
                    "retry",
                    {
                      input: { config_overrides: { baseline_compare: "go" } },
                    },
                    t("si.retryingBaseline"),
                  )
                }
              >
                <Layers size={13} /> {t("si.retryBaseline")}
              </button>
            )}
            {canSkip && (
              <button
                type="button"
                className="sm ghost"
                onClick={async () => {
                  const ok = await dialog.confirm({
                    title: t("si.skip.title"),
                    description: t("si.skipAsk"),
                    confirmLabel: t("si.skip.confirm"),
                    cancelLabel: t("common.cancel"),
                    variant: "warning",
                  });
                  if (ok) void action("skip");
                }}
              >
                <SkipForward size={13} /> {t("si.skip")}
              </button>
            )}
            {["RUNNING", "RETRYING"].includes(step.status) && (
              <button
                type="button"
                className="sm danger"
                onClick={async () => {
                  const ok = await dialog.confirm({
                    title: t("si.stop.title"),
                    description: t("si.stopAsk"),
                    confirmLabel: t("si.stop.confirm"),
                    cancelLabel: t("common.cancel"),
                    variant: "destructive",
                  });
                  if (ok) void action("stop", {}, t("si.stopped"));
                }}
              >
                <Square size={12} /> {t("si.stop")}
              </button>
            )}
            {attempts.length > 1 && (
              <select
                aria-label={t("si.pickAttempt")}
                value={attempt?.id}
                onChange={(e) => setAttemptId(Number(e.target.value))}
              >
                {attempts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {t("si.attemptN", { n: a.number })} ({t("cl.gen")} {a.generation},{" "}
                    {t("status." + a.status)}
                    {a.invalidated_at ? `, ${t("si.invalidated")}` : ""})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      <div className="si-body">
        {isAgent && (attempts.length > 0 || !!data.handoffs?.length) && (
          <ProviderHandoff
            active={runActive}
            key={step.id}
            runId={run.id}
            step={step}
            attempts={attempts}
            handoffs={data.handoffs}
            action={action}
          />
        )}
        {step.config.optimization_decision && (
          <details className="card si-opt-details">
            <summary>{t("optimization.provenance")}</summary>
            <pre className="small si-opt-pre">
              {JSON.stringify(step.config.optimization_decision, null, 2)}
            </pre>
            <a
              href={`/api/agent-recommendations/${step.config.optimization_decision.recommendation_id}`}
            >
              {t("optimization.evidence")}
            </a>
          </details>
        )}
        {isAgent && (
          <div className="small muted si-effective rv-inline-meta">
            <span>
              {t("agent.effective")}: {effectiveProvider}
            </span>
            <span>{effectiveModel || t("agent.modelDefault")}</span>
          </div>
        )}
        {isAgent &&
          !step.pending_input?.provider_handoff &&
          runActive &&
          ["PENDING", "READY", "RETRYING", "FAILED", "CANCELED", "WAITING_INPUT"].includes(
            step.status,
          ) && (
            <StepAgentOverride
              key={`${step.id}:${JSON.stringify(step.agent_override)}`}
              value={step.agent_override}
              save={(agent) => action("agent", { agent })}
            />
          )}

        {step.status === "WAITING_INPUT" && (
          <QuestionsForm
            questions={open}
            onDone={refresh}
            provider={asProvider(effectiveProvider)}
          />
        )}
        {step.status === "WAITING_APPROVAL" && step.type !== "task_result_report" && (
          <ApprovalPanel run={run} step={step} onDone={refresh} />
        )}
        {step.type === "task_result_report" &&
          step.status === "WAITING_APPROVAL" &&
          tab !== "report" && (
            <div className="rv-attn si-attn-compact">
              <div className="rv-attn-head si-attn-head-center">
                <span className="rv-attn-icon">
                  <Hand size={18} />
                </span>
                <div className="rv-title-wrap">
                  <b>{t("si.reportWaiting")}</b>
                </div>
                <button type="button" className="sm" onClick={() => setTab("report")}>
                  {t("si.openReport")} <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}
        {step.error && (
          <div className="errorbox">
            <div className="row tight">
              <XCircle size={15} color="var(--st-err)" />
              <b className="grow">{t("common.error")}</b>
              <Copy text={step.error} />
            </div>
            <div className="mono si-step-err">{step.error}</div>
          </div>
        )}
        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === "report" && (
          <ReportPanel
            run={run}
            step={step}
            artifacts={artifacts}
            attempts={attempts}
            onChanged={refresh}
          />
        )}
        {tab === "overview" && (
          <div>
            {verification && <VerificationCard v={verification} />}
            {verdict && <VerdictCard v={verdict} />}
            {attempt?.error?.failure && <FailureCard f={attempt.error.failure} />}
            {step.type === "command" && (
              <TestFailurePanel
                attempts={attempts}
                questions={questions}
                current={attempt}
                step={step}
              />
            )}
            {step.type === "command" && (
              <BaselineSummary results={(attempt?.output ?? attempt?.error?.details)?.results} />
            )}
            {attempt?.metrics && <AttemptMetrics m={attempt.metrics} />}
            <div className="rv-card">
              <div className="rv-card-head">
                <h4>
                  <ListChecks size={15} /> {t("si.details")}
                </h4>
              </div>
              <div className="rv-kv">
                <span>{t("wi.status")}</span>
                <span>
                  <Badge s={step.status} />
                </span>
                <span>{t("si.depends")}</span>
                <span className="mono">{step.depends_on.join(", ") || "—"}</span>
                <span>{t("si.maxAttempts")}</span>
                <span>
                  {step.max_attempts} ({t("si.backoff", { n: step.retry_backoff_s })})
                </span>
                <span>{t("si.gate")}</span>
                <span>{step.requires_approval ? t("si.yes") : t("si.no")}</span>
                {step.run_if && (
                  <>
                    <span>{t("si.runIf")}</span>
                    <span className="mono">{JSON.stringify(step.run_if)}</span>
                  </>
                )}
                <span>{t("si.started")}</span>
                <span>{time(step.started_at) || "—"}</span>
                <span>{t("si.finished")}</span>
                <span>{time(step.finished_at) || "—"}</span>
                {sessions.length > 0 && (
                  <>
                    <span>{t("si.session")}</span>
                    <span className="mono small">
                      {sessions[sessions.length - 1].session_id}{" "}
                      {sessions[sessions.length - 1].model &&
                        `(${sessions[sessions.length - 1].model})`}
                    </span>
                  </>
                )}
              </div>
            </div>
            {step.config?.instructions && (
              <div className="rv-card">
                <div className="rv-card-head">
                  <h4>
                    <FileText size={15} /> {t("si.instructions")}
                  </h4>
                  <Copy text={step.config.instructions} />
                </div>
                <Markdown text={step.config.instructions} />
              </div>
            )}
            <JsonBlock value={step.config} title={t("si.config")} />
            {attempt?.input?.pending?.reexecute && (
              <ReexecuteInfo
                rx={attempt.input.pending.reexecute}
                prev={attempt.input.previous_attempt?.number}
              />
            )}
            {canReexec && (
              <ReexecuteDialog
                run={run}
                step={step}
                onSubmit={(body) => action("reexecute", body, t("si.reopened"))}
                onPreview={onReplayPreview}
              />
            )}
            <HarnessCard
              evidence={
                artifacts
                  .filter(
                    (a: { kind: string; attempt_id: number | null }) =>
                      a.kind === "harness_evidence" && a.attempt_id === attempt?.id,
                  )
                  .at(-1)?.data ?? null
              }
            />
            {checkpoints.length > 0 && (
              <CheckpointsCard
                views={data.checkpoint_view ?? []}
                latest={data.latest_recoverable ?? null}
                recovery={data.recovery_action ?? null}
              />
            )}
            <DecisionsCard decisions={data.decisions ?? []} />
          </div>
        )}
        {tab === "execution" &&
          (!attempt ? (
            <Empty>{t("si.notStarted")}</Empty>
          ) : isAgent ? (
            <Transcript
              attemptId={attempt.id}
              live={live}
              tick={activity}
              provider={asProvider(effectiveProvider)}
            />
          ) : (
            <CommandLog
              attemptId={attempt.id}
              live={live}
              tick={activity}
              startedAt={attempt.started_at}
            />
          ))}
        {tab === "input" &&
          (attempt ? (
            <AttemptPayload
              key={attempt.id}
              attempt={attempt}
              field="input"
              render={(v) => (
                <JsonBlock value={v} title={t("si.resolvedInput", { n: attempt.number })} />
              )}
            />
          ) : (
            <Empty>{t("si.inputLater")}</Empty>
          ))}
        {tab === "output" && (
          <div>
            {attempt && attempt.id !== step.current_attempt_id ? (
              <AttemptPayload
                key={attempt.id}
                attempt={attempt}
                field="output"
                render={(v) => <OutputView locale={run.output_locale} value={v} />}
              />
            ) : (
              <OutputView locale={run.output_locale} value={step.output} />
            )}
            {attempt?.error && <JsonBlock value={attempt.error} title={t("si.attemptError")} />}
          </div>
        )}
        {tab === "knowledge" && <KnowledgeApplied snapshotId={snapshot?.id ?? null} />}
        {tab === "qa" &&
          (questions.length ? (
            questions.map((q) => (
              <div
                key={q.id}
                className={`rv-card si-qa-card${q.status === "open" ? " is-open" : q.status === "answered" ? " is-answered" : ""}`}
              >
                <div className="row tight si-qa-row">
                  <MessageCircleQuestion size={15} color="var(--st-wait)" className="si-qa-icon" />
                  <b className="grow">{q.question}</b>
                  <Badge
                    s={
                      q.status === "answered"
                        ? "COMPLETED"
                        : q.status === "open"
                          ? "WAITING_INPUT"
                          : "CANCELED"
                    }
                  >
                    {q.status}
                  </Badge>
                </div>
                {q.context && <div className="muted small si-qa-ctx">{q.context}</div>}
                {q.answer && (
                  <div className="si-qa-answer">
                    <ArrowRight size={13} className="si-inline-icon" /> {q.answer}{" "}
                    <span className="muted small">
                      {q.answered_by} {time(q.answered_at)}
                    </span>
                  </div>
                )}
                <div className="muted small si-qa-meta rv-inline-meta">
                  <span>
                    {t("si.attemptOf", {
                      n: attempts.find((a) => a.id === q.attempt_id)?.number ?? "?",
                    })}
                  </span>
                  <span>{time(q.created_at)}</span>
                </div>
              </div>
            ))
          ) : (
            <Empty>{t("si.noQuestions")}</Empty>
          ))}
        {tab === "artifacts" && <Artifacts artifacts={artifacts} />}
        {tab === "history" && (
          <div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t("cl.gen")}</th>
                    <th>{t("wi.status")}</th>
                    <th>{t("si.started")}</th>
                    <th>{t("si.finished")}</th>
                    <th>{t("si.worker")}</th>
                    <th>{t("common.error")}</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr
                      key={a.id}
                      className={`click si-hist-row${a.invalidated_at ? " is-invalid" : ""}${a.id === attempt?.id ? " is-selected" : ""}`}
                      onClick={() => (setAttemptId(a.id), setTab(isAgent ? "execution" : "output"))}
                    >
                      <td>
                        <b>{a.number}</b>
                      </td>
                      <td>{a.generation}</td>
                      <td>
                        <Badge s={a.status} />
                        {a.invalidated_at && (
                          <div className="muted small">{t("si.invalidated")}</div>
                        )}
                        {a.reused_from_attempt_id && (
                          <div className="muted small">
                            {t("si.replaySource", { id: a.reused_from_attempt_id })}
                          </div>
                        )}
                        {a.input?.pending?.reexecute && (
                          <div className="small si-reexec-note">
                            <RotateCcw size={11} className="si-inline-icon" />
                            {a.input.pending.reexecute.instructions
                              ? `“${String(a.input.pending.reexecute.instructions).slice(0, 80)}”`
                              : t("si.reexecuteWord")}
                            {!!a.input.pending.reexecute.skills?.length && (
                              <span className="muted">
                                {" "}
                                (
                                {a.input.pending.reexecute.skills
                                  .map((s) => `${s.key}@v${s.version}`)
                                  .join(", ")}
                                )
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small">{time(a.started_at)}</td>
                      <td className="small">{time(a.finished_at)}</td>
                      <td className="mono small">{(a.worker ?? "").split(":").slice(-1)[0]}</td>
                      <td className="err small">
                        {a.error?.failure && (
                          <span className="rv-meta-chip" title={a.error.failure.reason}>
                            {a.error.failure.class} → {a.error.failure.action}
                          </span>
                        )}{" "}
                        {a.error?.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rv-sec">
              <div className="rv-sec-title">
                <Cpu size={14} /> {t("si.jobs")}
              </div>
              {jobs.length ? (
                jobs.map((j) => (
                  <div key={j.id} className="small mono si-job-row">
                    #{j.id} {j.status} gen{j.generation} claims={j.claims}
                    {j.force ? " force" : ""} {j.lease_owner ?? ""} {j.last_error ?? ""}
                  </div>
                ))
              ) : (
                <div className="muted small">—</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Failure classification and the recovery decision the engine took. */
function FailureCard({ f }: { f: FailureInfo }) {
  const { t } = useI18n();
  return (
    <div className="card tight si-failure-card">
      <div className="row tight">
        <b className="small">{t("si.failure", { class: f.class })}</b>
        <span className="rv-meta-chip">
          {f.action === "retry"
            ? t("si.retryIn", { n: f.delay_s })
            : f.action === "human"
              ? t("si.pausedHuman")
              : t("si.stoppedAction")}
        </span>
      </div>
      <div className="small muted">{f.reason}</div>
    </div>
  );
}
