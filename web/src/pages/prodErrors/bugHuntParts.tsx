/**
 * Bug Hunter presentation pieces, shared by the incident accordion (Incidents tab) and the Incident Detail page.
 * One data source (GET /api/bug-hunts/:id), one polling rule (only an active hunt, only while mounted and the tab is
 * visible), and the backend's verdicts as-is: bug verification and incident causality are always shown separately.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  LoaderCircle,
  Play,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { api, useApi } from "../../api.ts";
import { AgentProviderField, type AgentProvider } from "../../agentProvider.tsx";
import { Button, ErrorBox, toast } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import type { Row } from "../analytics/shared.tsx";
import "./bug-hunter.css";

/** Hunt statuses that still change. */
export const ACTIVE_HUNT = new Set(["queued", "running", "verifying"]);
export const POLL_MS = 5000;
const SECTIONS = ["CONFIRMED", "SUSPECTED", "BLOCKED", "REJECTED"] as const;

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/** Re-reads `reload` every POLL_MS while `active` and the page is visible; stops when either is false. */
export function usePolling(active: boolean, reload: () => unknown) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => visible() && void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);
}

/** One hunt's detail, polled only while it is active and this component is mounted. */
export function useHuntDetail(id: number | null, onStatus?: (status: string) => void) {
  const r = useApi<Row>(id == null ? null : `/api/bug-hunts/${id}`);
  const status = r.data?.status as string | undefined;
  usePolling(!!status && ACTIVE_HUNT.has(status), r.reload);
  // onStatus is a notification: keep the latest callback without re-running the effect for its identity.
  const notify = useRef(onStatus);
  notify.current = onStatus;
  useEffect(() => {
    if (status) notify.current?.(status);
  }, [status]);
  return r;
}

export function StatusPill({ status }: { status: string }) {
  const { t } = useI18n();
  return (
    <span className={`pill bh-status bh-${status}`} data-status={status}>
      {ACTIVE_HUNT.has(status) && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
      {t(`an.bh.status.${status}`)}
    </span>
  );
}

const ms = (a?: string | null, b?: string | null) =>
  a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : null;
export function elapsed(v: number | null) {
  if (v == null) return null;
  const s = Math.round(v / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const ICON: Record<string, ReactNode> = {
  COMPLETED: <Check size={14} aria-hidden="true" />,
  RUNNING: <LoaderCircle size={14} className="spin" aria-hidden="true" />,
  FAILED: <X size={14} aria-hidden="true" />,
  SKIPPED: <CircleSlash size={14} aria-hidden="true" />,
  CANCELED: <CircleSlash size={14} aria-hidden="true" />,
  WAITING_INPUT: <AlertTriangle size={14} aria-hidden="true" />,
};
const tone = (s: string) =>
  s === "COMPLETED"
    ? "done"
    : s === "RUNNING"
      ? "active"
      : s === "FAILED"
        ? "failed"
        : s === "WAITING_INPUT" || s === "WAITING_APPROVAL"
          ? "blocked"
          : s === "SKIPPED" || s === "CANCELED"
            ? "skipped"
            : "pending";

/** Known stages have localized names; any other step keeps the workflow's own name. */
function useStageName() {
  const { t } = useI18n();
  return (s: Row) => {
    const k = `an.bh.stageName.${s.key}`;
    const v = t(k);
    return v === k ? String(s.name) : v;
  };
}

/**
 * Vertical timeline from the workflow's own step rows. A stage links to its step in the run only when it has run (so
 * the run view has its transcript/logs); pending and skipped stages are plain status indicators.
 */
export function HuntTimeline({ hunt }: { hunt: Row }) {
  const { t } = useI18n();
  const stageName = useStageName();
  const now = hunt.server_time as string | undefined;
  const stages = (hunt.stages ?? []) as Row[];
  return (
    <ol className="bh-timeline" aria-label={t("an.bh.stages")}>
      {stages.map((s) => {
        const state = tone(s.status);
        const took = elapsed(
          ms(s.started_at, s.finished_at ?? (s.status === "RUNNING" ? now : null)),
        );
        const ran = !["PENDING", "READY", "SKIPPED"].includes(s.status) || !!s.started_at;
        const activity = hunt.activity?.stage === s.key ? (hunt.activity as Row) : null;
        const label = (
          <>
            <span className="bh-tl-name">{stageName(s)}</span>
            <span className="bh-tl-state">{t(`an.bh.stage.${state}`)}</span>
          </>
        );
        return (
          <li
            key={s.key}
            className={`bh-tl-item is-${state}`}
            data-stage={s.key}
            data-status={s.status}
          >
            <span className="bh-tl-dot">
              {ICON[s.status] ?? <CircleDashed size={14} aria-hidden="true" />}
            </span>
            <div className="bh-tl-body">
              <div className="bh-tl-head">
                {ran ? (
                  <a href={`#/runs/${hunt.run_id}/${s.key}`} title={t("an.bh.openStep")}>
                    {label}
                  </a>
                ) : (
                  <span>{label}</span>
                )}
                {took && (
                  <span className="bh-tl-time muted small">
                    {s.status === "RUNNING" ? t("an.bh.runningFor", { d: took }) : took}
                  </span>
                )}
                {s.attempt > 1 && (
                  <span className="muted small">
                    {t("an.bh.attempt", { n: s.attempt, max: s.max_attempts ?? s.attempt })}
                  </span>
                )}
              </div>
              {(state === "active" || state === "pending") && (
                <p className="bh-tl-desc muted small">{t(`an.bh.stageDesc.${s.key}`)}</p>
              )}
              {activity && (
                <p className="bh-tl-activity small">
                  {t(activity.kind === "tool" ? "an.bh.lastTool" : "an.bh.lastLog", {
                    text: activity.text,
                  })}
                </p>
              )}
              {s.error && <p className="bh-tl-error small">{s.error}</p>}
              {s.status === "SKIPPED" && s.skipped_reason && (
                <p className="muted small">{t("an.bh.skipped", { reason: s.skipped_reason })}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function FixTaskButton({
  huntId,
  findingId,
  onDone,
}: {
  huntId: number;
  findingId: number;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const task = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: boolean; run_id: number }>(
        `/api/bug-hunts/${huntId}/findings/${findingId}/fix-task`,
        {},
      );
      setDone(r.run_id);
      toast(t(r.created ? "an.bh.taskCreated" : "an.bh.taskExists", { run: r.run_id }), "ok");
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return done ? (
    <a className="btn ghost sm" href={`#/runs/${done}`}>
      {t("an.bh.run", { id: done })} <ExternalLink size={12} />
    </a>
  ) : (
    <Button size="sm" variant="secondary" icon={<Wrench size={14} />} loading={busy} onClick={task}>
      {t("an.bh.fixTask")}
    </Button>
  );
}

function Finding({ f, hunt, onTask }: { f: Row; hunt: Row; onTask: () => void }) {
  const { t } = useI18n();
  const repro = f.reproduction as Row | null;
  const v = f.verification as Row | null;
  const list = (k: string) => (f[k] ?? v?.[k] ?? []) as string[];
  return (
    <article className="bh-finding" data-status={f.bug_verification_status}>
      <header>
        <b className="bh-fn">{f.function}</b>
        <code className="bh-loc">
          {f.file_path}:{f.line_start}-{f.line_end}
        </code>
        <span className="pill">{f.category}</span>
      </header>
      <div className="bh-verdicts">
        <span className={`pill bh-v-${f.bug_verification_status}`}>
          {t("an.bh.bug")}: {f.bug_verification_status}
        </span>
        <span className={`pill bh-c-${f.incident_causality_status}`}>
          {t("an.bh.cause")}: {f.incident_causality_status}
        </span>
      </div>
      <p>{f.hypothesis}</p>
      <dl>
        {f.trigger && (
          <>
            <dt>{t("an.bh.trigger")}</dt>
            <dd>{f.trigger}</dd>
          </>
        )}
        {(f.expected || f.actual) && (
          <>
            <dt>{t("an.bh.expectedActual")}</dt>
            <dd>
              {f.expected || "—"} → {f.actual || "—"}
            </dd>
          </>
        )}
        <dt>{t("an.bh.basis")}</dt>
        <dd>{f.basis}</dd>
        {repro && (
          <>
            <dt>{t("an.bh.reproduction")}</dt>
            <dd>
              <span className={`pill bh-repro-${repro.outcome}`}>{repro.outcome}</span>{" "}
              {repro.detail}
              {repro.artifact_id && (
                <>
                  {" "}
                  <a href={`#/runs/${hunt.run_id}/reproduce`}>
                    {t("an.bh.artifact", { id: repro.artifact_id })} <ExternalLink size={12} />
                  </a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      <details className="bh-more">
        <summary>{t("an.bh.moreEvidence")}</summary>
        <dl>
          <dt>{t("an.bh.revision")}</dt>
          <dd>
            <code>
              {f.repository}@{String(f.commit ?? "").slice(0, 12)}
            </code>
          </dd>
          {!!list("causality_basis").length && (
            <>
              <dt>{t("an.bh.causeBasis")}</dt>
              <dd>{list("causality_basis").join("; ")}</dd>
            </>
          )}
          {repro?.command && (
            <>
              <dt>{t("an.bh.command")}</dt>
              <dd>
                <code className="bh-cmd">{repro.command}</code>
              </dd>
            </>
          )}
          {!!(v?.execution_path as string[] | undefined)?.length && (
            <>
              <dt>{t("an.bh.executionPath")}</dt>
              <dd>{(v!.execution_path as string[]).join(" → ")}</dd>
            </>
          )}
          {!!list("alternative_explanations").length && (
            <>
              <dt>{t("an.bh.alternatives")}</dt>
              <dd>{list("alternative_explanations").join("; ")}</dd>
            </>
          )}
          {!!list("missing_proof").length && (
            <>
              <dt>{t("an.bh.missingProof")}</dt>
              <dd>{list("missing_proof").join("; ")}</dd>
            </>
          )}
          {!!list("supporting_evidence").length && (
            <>
              <dt>{t("an.bh.evidence")}</dt>
              <dd>{list("supporting_evidence").join("; ")}</dd>
            </>
          )}
        </dl>
      </details>
      {["CONFIRMED", "SUSPECTED"].includes(f.bug_verification_status) && (
        <FixTaskButton huntId={hunt.id} findingId={f.finding_id} onDone={onTask} />
      )}
    </article>
  );
}

/**
 * Results by phase. While the hunt runs nothing reads as a conclusion: candidates are hypotheses, claims under
 * verification are labelled so, and "no confirmed bug" is only said once the hunt has finished.
 */
export function HuntResults({ hunt, onChange }: { hunt: Row; onChange: () => void }) {
  const { t } = useI18n();
  const stageName = useStageName();
  const report = hunt.report as Row | null;
  const findings = (hunt.findings ?? []) as Row[];
  const active = ACTIVE_HUNT.has(hunt.status);
  const candidates = (hunt.unverified_candidates ?? []) as Row[];
  const verifying = hunt.verifying as Row | null;
  const failedStages = ((hunt.stages ?? []) as Row[]).filter((s) => s.status === "FAILED");
  if (!report) {
    return (
      <div className="bh-results" data-phase={hunt.status}>
        {hunt.status === "failed" && (
          <div className="bh-callout is-failed" role="status">
            <b>{t("an.bh.phase.failed")}</b>
            {failedStages.map((s) => (
              <p key={s.key}>
                {stageName(s)}: {s.error ?? t("an.bh.noReason")}{" "}
                <a href={`#/runs/${hunt.run_id}/${s.key}`}>
                  {t("an.bh.openStep")} <ExternalLink size={12} />
                </a>
              </p>
            ))}
          </div>
        )}
        {hunt.status === "canceled" && (
          <div className="bh-callout" role="status">
            {t("an.bh.phase.canceled")}
          </div>
        )}
        {verifying && active && (
          <section className="bh-callout is-verifying">
            <b>{t("an.bh.phase.verifying", { n: verifying.claims.length })}</b>
            <ul>
              {(verifying.claims as Row[]).map((c) => (
                <li key={c.id}>
                  <code>
                    {c.file_path}:{c.line_start}
                  </code>{" "}
                  {c.function} — {c.claim}
                </li>
              ))}
            </ul>
            {(verifying.deferred > 0 || verifying.rejected > 0) && (
              <p className="muted small">
                {t("an.bh.triageNote", { d: verifying.deferred, r: verifying.rejected })}
              </p>
            )}
          </section>
        )}
        {!verifying && candidates.length > 0 && (
          <section className="bh-callout is-candidates">
            <b>{t("an.bh.phase.candidates", { n: candidates.length })}</b>
            <ul>
              {candidates.map((c, i) => (
                <li key={i}>
                  <span className="pill bh-unverified">{t("an.bh.unverifiedTag")}</span>{" "}
                  <code>
                    {c.file_path}:{c.line_start}
                  </code>{" "}
                  {c.function} — {c.hypothesis}
                </li>
              ))}
            </ul>
          </section>
        )}
        {active && !verifying && !candidates.length && (
          <p className="bh-callout muted" role="status">
            {t("an.bh.phase.searching")}
          </p>
        )}
      </div>
    );
  }
  const rejectedByPlatform = ((report.rejected ?? []) as Row[]).filter((r) =>
    String(r.basis ?? "").startsWith("platform check"),
  );
  const confirmed = findings.filter((f) => f.bug_verification_status === "CONFIRMED");
  const coverage = (report.coverage ?? {}) as Row;
  const exec = (report.execution ?? {}) as Row;
  return (
    <div className="bh-results" data-phase={hunt.status}>
      <div className={`bh-callout ${confirmed.length ? "is-confirmed" : "is-none"}`} role="status">
        <b>
          {confirmed.length
            ? t("an.bh.phase.confirmed", { n: confirmed.length })
            : t("an.bh.phase.noneConfirmed")}
        </b>
        {hunt.status === "partial" && <p className="small">{t("an.bh.phase.partial")}</p>}
      </div>
      {SECTIONS.map((s) => {
        const list = findings.filter((f) => f.bug_verification_status === s);
        const extra = s === "REJECTED" ? rejectedByPlatform : [];
        if (!list.length && !extra.length) return null;
        const body = (
          <>
            {list.map((f) => (
              <Finding key={f.finding_id} f={f} hunt={hunt} onTask={onChange} />
            ))}
            {extra.map((r, i) => (
              <p key={`r${i}`} className="bh-rejected small">
                <code>
                  {r.file_path}:{r.line_start}
                </code>{" "}
                {r.function} — {r.basis}
              </p>
            ))}
          </>
        );
        const title = `${t(`an.bh.section.${s}`)} (${list.length + extra.length})`;
        // Confirmed and suspected first and open; blocked and rejected behind disclosure.
        return s === "CONFIRMED" || s === "SUSPECTED" ? (
          <section key={s} className="bh-section">
            <h4>{title}</h4>
            {body}
          </section>
        ) : (
          <details key={s} className="bh-section">
            <summary>{title}</summary>
            {body}
          </details>
        );
      })}
      <details className="bh-coverage">
        <summary>{t("an.bh.coverage")}</summary>
        <dl>
          <dt>{t("an.bh.scope")}</dt>
          <dd>{((coverage.functions_in_scope ?? []) as string[]).join(", ") || "—"}</dd>
          <dt>{t("an.bh.inspected")}</dt>
          <dd>{((coverage.files_inspected ?? []) as string[]).join(", ") || "—"}</dd>
          <dt>{t("an.bh.tools")}</dt>
          <dd>
            {Object.entries(coverage.tools ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join("; ") || "—"}
          </dd>
          <dt>{t("an.bh.unavailable")}</dt>
          <dd>{((coverage.sources_unavailable ?? []) as string[]).join("; ") || "—"}</dd>
          <dt>{t("an.bh.limitations")}</dt>
          <dd>{((coverage.scope_limitations ?? []) as string[]).join("; ") || "—"}</dd>
          <dt>{t("an.bh.execution")}</dt>
          <dd>
            {t("an.bh.executionLine", {
              providers: ((exec.providers ?? []) as string[]).join(", ") || "—",
              models: ((exec.models ?? []) as string[]).join(", ") || "—",
              tools: exec.tool_calls ?? "—",
              tokensIn: exec.tokens?.input ?? "—",
              tokensOut: exec.tokens?.output ?? "—",
              cost:
                exec.cost_usd == null
                  ? t("an.bh.notReported")
                  : `$${Number(exec.cost_usd).toFixed(4)}`,
              perBug:
                exec.cost_per_confirmed_bug == null
                  ? "—"
                  : `$${Number(exec.cost_per_confirmed_bug).toFixed(4)}`,
            })}
          </dd>
        </dl>
      </details>
    </div>
  );
}

/** One hunt: status, run link, cancel, polling notice, timeline and results. */
export function HuntView({
  id,
  onChange,
  compact = false,
}: {
  id: number;
  onChange?: (status?: string) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { data, error, reload } = useHuntDetail(id, onChange);
  const [canceling, setCanceling] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <p className="muted small">{t("an.bh.loading")}</p>;
  const active = ACTIVE_HUNT.has(data.status);
  const cancel = async () => {
    setCanceling(true);
    try {
      await api(`/api/runs/${data.run_id}/cancel`, {
        reason: "bug hunt canceled from the incident",
      });
      await reload();
      onChange?.("canceled");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setCanceling(false);
    }
  };
  const timeline = <HuntTimeline hunt={data} />;
  return (
    <div className="bh-detail" data-hunt={data.id}>
      <div className="bh-detail-head">
        <StatusPill status={data.status} />
        <span className="muted small">#{data.id}</span>
        <a className="btn ghost sm" href={`#/runs/${data.run_id}`}>
          {t("an.bh.viewRun", { id: data.run_id })} <ExternalLink size={12} />
        </a>
        {active && (
          <Button
            size="sm"
            variant="danger"
            icon={<Square size={13} />}
            loading={canceling}
            onClick={cancel}
          >
            {t("an.bh.cancel")}
          </Button>
        )}
        {active && <span className="muted small">{t("an.bh.polling", { s: POLL_MS / 1000 })}</span>}
      </div>
      {compact && !active ? (
        <details className="bh-progress">
          <summary>{t("an.bh.viewProgress")}</summary>
          {timeline}
        </details>
      ) : (
        timeline
      )}
      <HuntResults hunt={data} onChange={reload} />
      {!!(data.follow_ups as Row[] | undefined)?.length && (
        <p className="bh-followups small">
          {(data.follow_ups as Row[]).map((u) => (
            <a key={u.run_id} href={`#/runs/${u.run_id}`}>
              {u.code ?? `#${u.work_item_id}`} · {t("an.bh.run", { id: u.run_id })} · {u.status}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

/** Repository + provider selection, then start. One submission at a time; the backend returns an active hunt. */
export function StartHuntForm({
  fingerprint,
  onStarted,
  onClose,
}: {
  fingerprint: string;
  onStarted: (huntId: number) => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const repos =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean }>>("/api/repositories");
  const [chosen, setChosen] = useState<string[]>([]);
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const available = (repos.data ?? []).filter((r) => r.enabled && !r.self);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ created: boolean; hunt_id: number }>(
        `/api/prod-errors/${fingerprint}/bug-hunts`,
        { repositories: chosen, provider },
      );
      toast(t(r.created ? "an.bh.started" : "an.bh.alreadyRunning"), "ok");
      onStarted(r.hunt_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bh-form">
      <fieldset>
        <legend>{t("an.bh.repositories")}</legend>
        {repos.loading && !repos.data && <span className="muted small">{t("an.bh.loading")}</span>}
        {repos.data && !available.length && (
          <span className="muted">{t("an.bh.noRepositories")}</span>
        )}
        {available.map((r) => (
          <label key={r.name}>
            <input
              type="checkbox"
              checked={chosen.includes(r.name)}
              disabled={busy || (!chosen.includes(r.name) && chosen.length >= 3)}
              onChange={(e) =>
                setChosen((c) =>
                  e.target.checked ? [...c, r.name] : c.filter((x) => x !== r.name),
                )
              }
            />{" "}
            {r.name}
          </label>
        ))}
        <small className="muted">{t("an.bh.repositoriesHint")}</small>
      </fieldset>
      <AgentProviderField value={provider} onChange={setProvider} healthyOnly />
      {err && (
        <p className="bh-tl-error small" role="alert">
          {err}
        </p>
      )}
      <div className="bh-form-actions">
        <Button
          size="sm"
          icon={<Play size={14} />}
          loading={busy}
          disabled={!chosen.length}
          onClick={start}
        >
          {t("an.bh.startConfirm")}
        </Button>
        {onClose && (
          <Button size="sm" variant="quiet" disabled={busy} onClick={onClose}>
            {t("an.bh.close")}
          </Button>
        )}
      </div>
    </div>
  );
}
