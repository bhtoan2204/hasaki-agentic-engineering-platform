import { useEffect, useState, type ComponentProps } from "react";
import {
  AlertTriangle,
  ClipboardList,
  FolderGit2,
  Hourglass,
  ShieldCheck,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { api, useApi } from "../../api.ts";
import { useI18n } from "../../i18n/index.tsx";
import { act, Badge, Copy, navigate, time } from "../../ui.tsx";
import { type StepLike } from "../../graph.tsx";
import { type InspectorRun, type StepRow } from "../StepInspector.tsx";
import { AutonomySummary } from "../ProfilePreview.tsx";
import { type Decision } from "../../decisions";
import { type ChildWorkflow } from "../childWorkflows.tsx";

interface ReplanRecord {
  invalidated?: string[];
  reasons?: string[];
  route: string;
  source: string;
  targets?: string[];
}

interface RunPullRequest {
  id: number;
  repo: string;
  url: string;
  title: string;
  state?: string | null;
  provider: string;
}

interface RecoveryEpisode {
  id: number;
  step_key: string;
  category: string;
  status: string;
  occurrences: number;
  auto_recoveries: number;
  last_strategy?: { strategy?: string } | null;
  next_eligible_at?: string | null;
  reason?: string | null;
}

interface ProfileChange {
  step: string;
  action: string;
  into?: string;
  detail: string;
}

export interface WorkerHealth {
  instance_id?: string | null;
  health?: string;
  last_seen_at?: string | null;
  available?: boolean;
}

/** Run page view (GET /api/runs/:id). */
export interface RunDetail extends InspectorRun {
  title: string;
  definition_key: string;
  definition_version: number;
  branch: string;
  profile?: string;
  profile_decision?: {
    reasons?: string[];
    warnings?: string[];
    requested?: string;
    confidence: number;
  } | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  inputs?: {
    branches?: Record<string, string>;
    branches_source?: string;
    replans?: ReplanRecord[];
  } | null;
  work_item: { id: number; code: string } | null;
  /** Workflow-to-workflow delegation: the run that started this one, and the runs this one started. */
  delegation?: {
    parent: { run_id: number; title: string; status: string; mode: string } | null;
    children: ChildWorkflow[];
  };
  worker: (WorkerHealth & { local: boolean; available: boolean; recovery: string | null }) | null;
  graph: {
    steps: StepLike[];
    feedback_step?: string;
    replan_step?: string;
    transitions?: Array<{ from: string; to: string; reason: string; revision: number }>;
    profile_changes?: ProfileChange[];
  };
  steps: StepRow[];
  questions: Array<{ status: string; step_key: string }>;
  attempts: Array<{
    step_key: string;
    agent_provider?: string | null;
    agent_model?: string | null;
    metrics?: { provider?: string } | null;
  }>;
  decisions?: Decision[];
  workspaces: unknown[];
  pull_requests: RunPullRequest[];
  recovery_episodes?: RecoveryEpisode[];
  autonomy?: ComponentProps<typeof AutonomySummary>["a"];
  agent_configuration?: { version: number; capture_source: string; captured_at: string } | null;
}

interface SchedulerState {
  workers: number;
  light_workers: number;
  running: Array<{
    job_id: number;
    run_id: number;
    step_key: string;
    step_name: string;
    running_seconds?: number | null;
  }>;
}

export interface DeliveryState {
  mode: string;
  aggregate: string;
  pull_requests?: Array<{
    id: number;
    url: string;
    repo: string;
    lifecycle: string;
    lifecycle_paused: boolean;
    published_sha?: string | null;
    remote_head_sha?: string | null;
    observation?: {
      pipeline?: { status: string } | null;
      repair_plan?: { reason?: string } | null;
    } | null;
    repair_count: number;
    synced_at?: string | null;
    lifecycle_reasons?: string[];
  }>;
}

export interface RunMetrics {
  wall_ms: number;
  agent_provider: string;
  bottleneck?: string | null;
  totals: {
    exec_ms: number;
    queue_ms: number;
    human_ms: number;
    cost_unknown?: boolean;
    cost_usd: number | null;
    agent_sessions?: number;
    agent_ms?: number;
    /** Legacy names of agent_sessions / agent_ms. */
    claude_sessions?: number;
    claude_ms?: number;
    turns: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    tool_calls: number;
    tool_ms: number;
    command_ms: number;
    integration_calls: number;
    skills_loaded: number;
    retries: number;
    failed: number;
  };
  per_step: Record<
    string,
    {
      type: string;
      attempts: number;
      queue_ms: number;
      exec_ms: number;
      human_ms: number;
      agent_ms?: number;
      claude_ms?: number;
      turns: number;
    }
  >;
}

export interface TimelineEvent {
  id: number;
  created_at: string;
  step_key: string | null;
  kind: string;
  content: string;
}

/** Display order of statuses in the run summary strip. */
export const STATUS_ORDER = [
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

/** Live execution graph of one run + inspector. Route: #/runs/:id[/:stepKey | /~changes]. */
export const PANE_KEY = "rv.inspectorWidth";

export const PANE_MIN = 360;

export const paneMax = () => Math.round(window.innerWidth * 0.85);

/** READY steps that no worker has picked up yet: say who is holding the workers and for how long. */
export function QueueBanner({ run, tick }: { run: RunDetail; tick: number }) {
  const { t } = useI18n();
  const waiting = run.steps.filter((s) => s.status === "READY" || s.status === "RETRYING");
  const { data, reload } = useApi<SchedulerState>(
    waiting.length && !["PAUSED", "CANCELED"].includes(run.status) ? "/api/scheduler" : null,
  );
  useEffect(() => void reload(), [reload, tick, waiting.length]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!waiting.length || !data) return null;
  const others = data.running.filter((j) => j.run_id !== run.id);
  if (!others.length) return null;
  const fmt = (s: number) =>
    s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return (
    <div className="rv-banner brand">
      <Hourglass size={15} />
      <span>
        {t("rv.queueWait", {
          steps: waiting.map((s) => s.name).join(", "),
          workers: data.workers,
          light: data.light_workers,
        })}{" "}
        {others.map((j) => (
          <a key={j.job_id} href={`#/runs/${j.run_id}/${j.step_key}`} style={{ marginRight: 10 }}>
            {t("common.runN", { id: j.run_id })} · {j.step_name} ({fmt(j.running_seconds ?? 0)})
          </a>
        ))}
        <span className="muted small">— {t("rv.queueHint")}</span>
      </span>
    </div>
  );
}

/** Shortcut to the Task Result Report (when this run has one). */
export function ReportCard({ run }: { run: RunDetail }) {
  const { t } = useI18n();
  const s = run.steps.find((x) => x.type === "task_result_report");
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
          type="button"
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

export function RecoveryCard({ run }: { run: RunDetail }) {
  const { t } = useI18n();
  const episodes = run.recovery_episodes ?? [];
  if (!episodes.length) return null;
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Hourglass size={16} /> {t("rc.title")}
        </h4>
      </div>
      {episodes.slice(0, 10).map((e) => (
        <div key={e.id} className="small" style={{ margin: "4px 0" }}>
          <span className="mono">{e.step_key}</span> · <b>{e.category}</b> ·{" "}
          {t(`rc.status.${e.status}`)} ·{" "}
          {t("rc.counts", { n: e.occurrences, auto: e.auto_recoveries })}
          {e.last_strategy?.strategy && <> · {e.last_strategy.strategy}</>}
          {e.status === "open" && e.next_eligible_at && (
            <span className="muted"> · {t("rc.next", { at: time(e.next_eligible_at) })}</span>
          )}
          {e.reason && <div className="muted">{e.reason}</div>}
        </div>
      ))}
    </div>
  );
}

export function AutonomyCard({ run, onDone }: { run: RunDetail; onDone: () => void }) {
  const { t } = useI18n();
  if (!run.autonomy) return null;
  const decided = (run.decisions ?? []).filter((d) => d.kind === "autonomy");
  const paused = !!run.autonomy.paused;
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <ShieldCheck size={16} /> {t("au.title")}
        </h4>
        <button
          type="button"
          className="ghost sm"
          onClick={async () =>
            (await act(() => api(`/api/runs/${run.id}/autonomy`, { paused: !paused }))) && onDone()
          }
        >
          {paused ? t("au.resume") : t("au.pause")}
        </button>
      </div>
      <AutonomySummary a={run.autonomy} />
      <div className="small muted" style={{ marginTop: 6 }}>
        {t("au.decisions")}
      </div>
      {decided.length === 0 && <div className="small muted">{t("au.none")}</div>}
      {decided.slice(-20).map((d) => (
        <div key={d.id} className="small">
          <span className="mono">{d.step_key}</span> · <b>{d.action}</b>
          {d.outcome === "planned" && <span className="muted"> · {t("au.planned")}</span>} ·{" "}
          {d.details?.actor_type === "human" ? t("au.human") : t("au.machine")}
          {d.reason && <span className="muted"> — {d.reason}</span>}
        </div>
      ))}
    </div>
  );
}

export const fmtS = (ms: number) =>
  ms < 1000
    ? `${ms}ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;

export function RepoPicker({ run, onDone }: { run: RunDetail; onDone: () => void }) {
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
          type="button"
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

type PipelineView = { id: number; status: string; url: string | null };

export type PullRequestStatus = {
  provider: string;
  readiness: {
    mergeable: boolean;
    reasons: string[];
    approvals: { required: number; given: number; enforced: boolean } | null;
    pipeline: PipelineView | null;
  } | null;
  pipelines: PipelineView[] | null;
};
