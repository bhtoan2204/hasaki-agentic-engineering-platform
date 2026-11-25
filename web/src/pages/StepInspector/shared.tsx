import { ProviderHandoff } from "../../ProviderHandoff.tsx";
import { EvidenceSummary, hasEvidence } from "../../EvidenceGate.tsx";
import { type ComponentProps, type ReactNode } from "react";
import { FileText, RotateCcw } from "lucide-react";
import { useApi } from "../../api.ts";
import { Copy, Empty, ErrorBox, JsonBlock, Markdown, SkeletonRows, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type ReportArtifact, type ReportSpec, type TaskReport } from "../Report.tsx";
import { InvestigationOutput } from "../Investigations.tsx";
import { CheckpointsCard } from "../ExecutionCards";
import type { CheckpointView, Decision, DecisionAction, HarnessEvidence } from "../../decisions";

/** The run fields the inspector reads; the run page passes its full run detail. */
export interface InspectorRun {
  id: number;
  status: string;
  agent_provider: string;
  output_locale?: string | null;
  selected_repositories: string[];
  allowed_repositories: string[];
  worker?: { local?: boolean } | null;
}

interface RepoCandidate {
  repo: string;
  score: number;
  reasons?: string[];
}

interface ApprovalRequest {
  message?: string;
  recommended?: string[];
  allowed?: string[];
  branch?: string;
  branches?: Record<string, string>;
  candidates?: RepoCandidate[];
  select_repositories?: boolean;
  ask_branch?: boolean;
  ambiguous?: boolean;
  requires_risk_acknowledgement?: boolean;
  recheck_reasons?: string[];
  autonomy?: {
    reasons?: string[];
    shadow?: boolean;
    result?: string;
    required_evidence?: string[];
    subject?: { hash?: string };
  };
  scope?: ComponentProps<typeof EvidenceSummary>["scope"];
  outputs?: Record<string, unknown>;
  report?: TaskReport;
  markdown?: string;
}

export interface BaselineGroup {
  package?: string;
  tests?: string[];
  build_errors?: string[];
}

interface VerificationRepo {
  repo?: string;
  passed?: boolean;
  timed_out?: boolean;
  exit_code?: number | null;
  artifact_id?: number | null;
  regressions?: BaselineGroup[];
  weakened?: string[];
  pre_existing?: number;
  note?: string;
  slop?: {
    mode?: string;
    status?: string;
    counts?: { new?: number; worsened?: number; existing?: number; resolved?: number };
    blocking?: unknown[];
    detector_ms?: number;
  };
}

export interface Verification {
  outcome?: string;
  passed?: boolean;
  rounds?: number;
  repairs?: number;
  max_repairs?: number;
  duration_ms?: number;
  reason?: string;
  failure_signatures?: unknown[];
  last?: VerificationRepo[];
}

interface StepOutput {
  status?: string;
  business_summary?: string;
  verification?: Verification;
  accepted_exception?: { failures: unknown[] };
  test_status?: string;
  report?: TaskReport;
  markdown?: string;
}

interface StepConfig {
  action?: string;
  agent?: { provider?: string; model?: string | null };
  baseline_compare?: string;
  instructions?: string;
  on_reject?: { reexecute?: string };
  optimization_decision?: { recommendation_id: number | string };
  ai_suggest?: ReportSpec;
}

export interface StepHandoff {
  status?: string;
  failure_category?: string;
  blocked_reason?: string | null;
}

/** A workflow step row as the run and step detail APIs return it. */
export interface StepRow {
  id: number;
  key: string;
  name: string;
  type: string;
  status: string;
  generation: number;
  current_attempt_id: number | null;
  config: StepConfig;
  agent_override?: { provider?: string; model?: string | null; [key: string]: unknown } | null;
  pending_input?: { provider_handoff?: StepHandoff; child_workflows?: number[] } | null;
  approval?: { request?: ApprovalRequest; gate?: boolean; granted?: boolean } | null;
  output?: StepOutput | null;
  error: string | null;
  depends_on: string[];
  max_attempts: number;
  retry_backoff_s: number;
  requires_approval: boolean;
  run_if?: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
}

interface TestFailure {
  category: string;
  repo: string;
  package?: string;
  test?: string;
  build_error?: string;
  reason: string;
  env_signal?: boolean;
  log: string;
}

interface VerdictFinding {
  severity: string;
  file: string;
  line?: number;
  explanation: string;
  evidence: string;
}

export interface AttemptPayload {
  verification?: Verification;
  verdict?: string;
  findings?: VerdictFinding[];
  verified_heads?: Record<string, string>;
  summary?: string;
  blocked_reason?: string;
  diagnosis?: {
    summary: string;
    command: string;
    results: Array<{ repo: string; timed_out?: boolean; exit_code: number }>;
    baseline_available: boolean;
    base_sha?: string | null;
    explanation?: { by: string; text: string; suggestion: string } | null;
    failures: TestFailure[];
  };
  decision?: { kind: string; target?: string; instructions?: string };
  results?: CommandResult[];
}

export interface CommandBaseline {
  regressions?: Required<BaselineGroup>[];
  pre_existing?: Required<BaselineGroup>[];
  note?: string;
  base_sha?: string;
}

export interface CommandResult {
  repo: string;
  baseline?: CommandBaseline;
}

export interface FailureInfo {
  class: string;
  action: string;
  reason: string;
  delay_s: number;
}

interface ReexecuteRequest {
  instructions?: string | null;
  skills?: Array<{ key: string; version: number; title?: string }>;
  requested_by?: string | null;
  at?: string | null;
}

export interface AttemptMetricsData {
  provider?: string;
  model?: string;
  model_source?: string;
  reasoning_effort?: string;
  cost_usd?: number | null;
  turns?: number;
  duration_ms?: number;
  sessions?: number;
  verification?: Verification;
  tokens?: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    reasoning_output?: number;
  };
  disclosure: { inline: number; index: number; search: number };
  upstream: { full: number; summary: number };
  tool_calls?: Record<string, number>;
  tool_errors?: number;
  skills_loaded?: string[];
  knowledge_searches?: string[];
  skills?: Array<{
    key: string;
    version: number;
    tier: string;
    tokens: number;
    states: string[];
    evidence: string[];
    loaded_unused: boolean;
    provider_limited: boolean;
  }>;
  integration_calls?: Array<{ name: string; ok: boolean; ms: number }>;
  subagents?: Array<{ type: string }>;
  denied?: Array<{ tool: string; subagent?: string; reason: string }>;
}

export interface AttemptRow {
  id: number;
  number: number;
  generation: number;
  status: string;
  invalidated_at: string | null;
  reused_from_attempt_id: number | null;
  agent_provider?: string | null;
  agent_model?: string | null;
  metrics?: AttemptMetricsData | null;
  output?: AttemptPayload | null;
  error?: { message?: string; details?: AttemptPayload; failure?: FailureInfo } | null;
  input?: {
    pending?: { reexecute?: ReexecuteRequest };
    previous_attempt?: { number: number };
  } | null;
  /** True when `input`/`output` are summaries; the full payload is at /api/attempts/:id/input|output. */
  input_partial?: boolean;
  output_partial?: boolean;
  context_snapshot_id?: number | null;
  started_at: string;
  finished_at: string | null;
  worker: string | null;
}

export interface QuestionRow {
  id: number;
  attempt_id: number | null;
  question: string;
  context?: string | null;
  options?: string[] | null;
  suggested_answer?: string | null;
  status: string;
  answer?: string | null;
  answered_by?: string | null;
  answered_at?: string | null;
  created_at: string;
}

export interface ArtifactRow {
  id: number;
  attempt_id: number | null;
  kind: string;
  name: string;
  size: number;
  created_at: string;
  data?:
    (HarnessEvidence & { exit_code?: number | null } & NonNullable<ReportArtifact["data"]>) | null;
}

export interface KnowledgeItem {
  key: string;
  title: string;
  version: number;
  category: string;
  reason: string;
  content: string;
}

export interface ContextSnapshot {
  id: number;
  hash: string;
  created_at: string;
  content: {
    project?: string | null;
    repositories: string[];
    knowledge: KnowledgeItem[];
    prompt_plan?: {
      knowledge?: Array<{ key: string; disclosure: string; score: number; why: string }>;
      upstream?: Record<
        string,
        { direct?: boolean; mode: string; tokens: number; full_tokens: number }
      >;
    };
    overridden?: Array<{
      key: string;
      version: number;
      reason: string;
      by: string;
      conflict_key: string;
    }>;
    missing_explicit?: string[];
  };
}

export interface ArtifactContent {
  id: number;
  name: string;
  content: string;
  data?: Record<string, unknown> | null;
}

export interface TranscriptEvent {
  id: number;
  kind: string;
  content: string;
  created_at: string;
}

export interface SkillCatalogEntry {
  key: string;
  title: string;
  current_version: number;
  enabled: boolean;
}

export interface ReexecuteBody {
  feedback?: string;
  persist?: boolean;
  skills?: string[];
  force?: boolean;
}

export interface StepDetail {
  step: StepRow;
  attempts: AttemptRow[];
  questions: QuestionRow[];
  checkpoints: unknown[];
  artifacts: ArtifactRow[];
  sessions: Array<{ session_id: string; model?: string | null }>;
  /** Snapshot content is loaded on demand (GET /api/snapshots/:id) by the Knowledge tab. */
  snapshots: Array<
    Pick<ContextSnapshot, "id" | "hash" | "created_at"> & { knowledge_count: number }
  >;
  jobs: Array<{
    id: number;
    status: string;
    generation: number;
    claims: number;
    force: boolean;
    lease_owner: string | null;
    last_error: string | null;
  }>;
  handoffs?: ComponentProps<typeof ProviderHandoff>["handoffs"];
  checkpoint_view?: CheckpointView[];
  latest_recoverable?: CheckpointView | null;
  recovery_action?: ComponentProps<typeof CheckpointsCard>["recovery"];
  decisions?: Decision[];
}

/** Render a step output: Markdown for summary-like strings, then the full structure. */
export function OutputView({ value, locale }: { value: unknown; locale?: string | null }) {
  const { t } = useI18n();
  if (value == null) return <Empty>{t("si.noOutput")}</Empty>;
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object"
        ? (("summary" in value ? value.summary : undefined) ??
          ("report" in value ? value.report : undefined) ??
          null)
        : null;
  return (
    <div>
      {hasEvidence(value) && <EvidenceSummary output={value} />}
      <InvestigationOutput value={value} locale={locale} />
      {typeof text === "string" && (
        <div className="rv-card">
          <div className="rv-card-head">
            <h4>
              <FileText size={15} /> {t("si.summary")}
            </h4>
            <Copy text={text} />
          </div>
          <Markdown text={text} />
        </div>
      )}
      <JsonBlock value={value} title={t("si.output")} />
    </div>
  );
}

// ---------------------------------------------------------------- verification (coding steps)

export const VF_TONE: Record<string, "ok" | "err" | "wait" | "idle"> = {
  passed: "ok",
  failed: "err",
  no_progress: "err",
  error: "err",
  canceled: "idle",
  stopped: "wait",
  skipped: "idle",
  accepted_with_preexisting: "wait",
};

export const TONE_STATUS = {
  ok: "COMPLETED",
  err: "FAILED",
  wait: "WAITING",
  idle: "SKIPPED",
} as const;

export const arr = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

export const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

// ---------------------------------------------------------------- command steps

export const CAT_STATUS: Record<string, string> = {
  new: "FAILED",
  pre_existing: "WAITING",
  environment: "PAUSED",
  insufficient: "PENDING",
};

/** Instructions and skills this attempt was re-executed with (stored with the attempt's input). */
export function ReexecuteInfo({ rx, prev }: { rx: ReexecuteRequest; prev?: number }) {
  const { t } = useI18n();
  return (
    <div className="rv-card" style={{ borderLeft: "3px solid var(--brand)" }}>
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4>
          <RotateCcw size={15} /> {t("si.thisRerun")}
        </h4>
        <span className="muted small">
          {rx.requested_by ? `${t("si.by", { name: rx.requested_by })} · ` : ""}
          {time(rx.at)}
          {prev ? ` · ${t("si.fromAttempt", { n: prev })}` : ""}
        </span>
      </div>
      {rx.instructions ? (
        <div style={{ whiteSpace: "pre-wrap" }}>{rx.instructions}</div>
      ) : (
        <div className="muted small">{t("si.noGuidance")}</div>
      )}
      {!!rx.skills?.length && (
        <div className="small" style={{ marginTop: 6 }}>
          {t("kn.cat.agent_skill")}:{" "}
          {rx.skills.map((s) => (
            <span key={s.key} className="pill">
              {s.title ?? s.key} <span className="muted mono">v{s.version}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-execute this step with optional instructions + skills; shows which dependants will rerun / re-ask approval. */
export type ReplayPreviewStep = {
  key: string;
  action: DecisionAction;
  reason: string;
  conditional?: boolean;
  estimate?: { invocations: number | null; tokens: number | null } | null;
};

/** Step detail carries a summary of each attempt's input/output; the raw payload loads when its tab opens. */
export function AttemptPayload({
  attempt,
  field,
  render,
}: {
  attempt: AttemptRow;
  field: "input" | "output";
  render: (value: unknown) => ReactNode;
}) {
  const partial = field === "input" ? attempt.input_partial : attempt.output_partial;
  const { data, error } = useApi<unknown>(partial ? `/api/attempts/${attempt.id}/${field}` : null, [
    attempt.id,
    field,
  ]);
  if (!partial) return render(attempt[field]);
  if (error) return <ErrorBox error={error} />;
  return data === null ? <SkeletonRows rows={4} /> : render(data);
}
