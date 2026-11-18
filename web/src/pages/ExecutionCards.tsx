import { Activity, History, Layers, Recycle } from "lucide-react";
import { useI18n } from "../i18n";
import { dur, time } from "../ui";
import {
  bytes,
  COMPATIBILITY_COLORS,
  DECISION_COLORS,
  reuseSummary,
  type CheckpointView,
  type Decision,
  type DecisionAction,
  type HarnessEvidence,
} from "../decisions";

const short = (s?: string | null, n = 10) => (s ? `${s.slice(0, n)}…` : "—");

export function DecisionBadge({ action, outcome }: { action: DecisionAction; outcome?: string }) {
  const { t } = useI18n();
  return (
    <span
      className={`badge ec-decision-badge${outcome === "planned" ? " is-planned" : ""}`}
      style={{ color: DECISION_COLORS[action] ?? "var(--muted)" }}
      title={outcome ? `${action} (${outcome})` : action}
    >
      {t(`dec.action.${action}`)}
      {outcome && outcome !== "applied" ? ` · ${t(`dec.outcome.${outcome}`)}` : ""}
    </span>
  );
}

function CompatibilityBadge({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <span
      className="badge ec-compat"
      style={{ color: COMPATIBILITY_COLORS[value] ?? "var(--muted)" }}
    >
      {t(`ck.compat.${value}`)}
    </span>
  );
}

/** Recoverable checkpoints as milestones; progress notes stay visibly secondary. */
export function CheckpointsCard({
  views,
  latest,
  recovery,
}: {
  views: CheckpointView[];
  latest: CheckpointView | null;
  recovery: { action: DecisionAction; reason: string; source_attempt_id?: number } | null;
}) {
  const { t } = useI18n();
  const milestones = views.filter((v) => v.kind === "recoverable");
  const notes = views.filter((v) => v.kind === "note");
  if (!views.length) return null;
  const e = latest?.evidence;
  return (
    <div className="rv-card ec-checkpoints">
      <div className="rv-card-head">
        <h4>
          <History size={16} /> {t("ck.title", { n: milestones.length })}
        </h4>
        {recovery && (
          <span className="small ec-recovery" title={recovery.reason}>
            {t("ck.recovery")}: <DecisionBadge action={recovery.action} />
          </span>
        )}
      </div>
      {latest ? (
        <div className="ec-latest small">
          <div>
            <b>{t("ck.latest")}</b> · {time(latest.created_at)} · {t(`ck.reason.${latest.reason}`)}{" "}
            <CompatibilityBadge value={latest.compatibility ?? "unknown"} />
          </div>
          {e && (
            <ul className="ec-evidence">
              <li>
                {t("ck.workspace")}:{" "}
                {e.workspace?.unavailable ? (
                  <span className="pe-warn">{t("ck.workspaceUnavailable")}</span>
                ) : (
                  <span className="mono">{short(e.workspace?.fingerprint)}</span>
                )}
                {e.workspace?.artifact_id != null &&
                  ` · ${t("ck.archive")} ${bytes(e.workspace.bytes)}`}
              </li>
              <li>
                {t("ck.context")}:{" "}
                {e.context ? (
                  <span className="mono">
                    #{e.context.snapshot_id ?? "—"} {short(e.context.context_hash, 8)}
                  </span>
                ) : (
                  "—"
                )}
              </li>
              <li>
                {t("ck.verification")}:{" "}
                {e.verification
                  ? `${e.verification.passed === true ? t("ck.passed") : e.verification.passed === false ? t("ck.failed") : t("ck.recorded")} · ${short(e.verification.digest, 8)}`
                  : t("ck.none")}
              </li>
            </ul>
          )}
          {recovery && <div className="muted">{recovery.reason}</div>}
        </div>
      ) : (
        <div className="muted small">{t("ck.noRecoverable")}</div>
      )}
      {milestones.length > 0 && (
        <ol className="ec-milestones small">
          {milestones.map((m) => (
            <li key={m.id} className="ec-milestone">
              <span className="muted">{time(m.created_at)}</span> {t(`ck.reason.${m.reason}`)}{" "}
              <CompatibilityBadge value={m.compatibility ?? "unknown"} />
            </li>
          ))}
        </ol>
      )}
      {notes.length > 0 && (
        <details className="ec-notes small">
          <summary className="muted">{t("ck.notes", { n: notes.length })}</summary>
          {notes.map((n) => (
            <div key={n.id} className="ec-note muted">
              {time(n.created_at)} · {n.reason}
              {n.note ? `: ${n.note}` : ""}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** The harness lifecycle of one attempt, from its harness_evidence artifact. */
export function HarnessCard({ evidence }: { evidence: HarnessEvidence | null }) {
  const { t } = useI18n();
  if (!evidence) return null;
  const stages: Array<{ stage: string; ms: number; outcome: string }> = evidence.stages ?? [];
  const missing = [...(evidence.guarantees?.unmet ?? []), ...(evidence.guarantees?.degraded ?? [])];
  return (
    <div className="rv-card ec-harness">
      <div className="rv-card-head">
        <h4>
          <Layers size={16} /> {t("hx.title")}
        </h4>
        <span className="small muted">
          {[
            evidence.failure_code,
            evidence.checkpoint?.source ? t(`hx.source.${evidence.checkpoint.source}`) : null,
            evidence.tool_calls
              ? `${evidence.tool_calls.used}/${evidence.tool_calls.limit} ${t("hx.tools")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="table-wrap">
        <table className="small">
          <tbody>
            {stages.map((s, i) => (
              <tr key={i} className="ec-harness-stage">
                <td>{t(`hx.stage.${s.stage}`)}</td>
                <td
                  style={{
                    color:
                      s.outcome === "continue"
                        ? "var(--muted)"
                        : s.outcome === "completed"
                          ? "var(--st-ok)"
                          : "var(--st-wait)",
                  }}
                >
                  {s.outcome === "continue" ? "✓" : s.outcome}
                </td>
                <td className="mono">{dur(s.ms) || "0ms"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {missing.length > 0 && (
        <div className="small pe-warn">
          {t("hx.guarantees")}: {missing.join(", ")}
        </div>
      )}
    </div>
  );
}

export function DecisionsCard({ decisions }: { decisions: Decision[] }) {
  const { t } = useI18n();
  const shown = decisions.filter((d) => d.kind !== "checkpoint");
  if (!shown.length) return null;
  return (
    <div className="rv-card ec-decisions">
      <div className="rv-card-head">
        <h4>
          <Activity size={16} /> {t("dec.title")}
        </h4>
      </div>
      <div className="table-wrap">
        <table className="small">
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="ec-decision">
                <td className="muted">{time(d.created_at)}</td>
                <td>{t(`dec.kind.${d.kind}`)}</td>
                <td>
                  <DecisionBadge action={d.action} outcome={d.outcome} />
                </td>
                <td>{d.reason}</td>
                <td className="mono muted">
                  {[
                    d.source_attempt_id ? `#${d.source_attempt_id}` : null,
                    d.latency_ms != null ? dur(Math.round(d.latency_ms)) : null,
                    d.saved_tokens != null
                      ? t("dec.savedTokens", { n: Math.round(d.saved_tokens) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Run overview: what reuse and recovery did for this run (estimates are labelled). */
export function ReuseCard({ decisions }: { decisions: Decision[] | undefined }) {
  const { t } = useI18n();
  const s = reuseSummary(decisions);
  if (!decisions?.some((d) => d.kind !== "checkpoint")) return null;
  return (
    <div className="rv-card ec-reuse">
      <div className="rv-card-head">
        <h4>
          <Recycle size={16} /> {t("reuse.title")}
        </h4>
      </div>
      <div className="rv-minis">
        <div className="rv-mini">
          <span>{t("reuse.reused")}</span>
          <b>{s.reused}</b>
        </div>
        <div className="rv-mini">
          <span>{t("reuse.resumed")}</span>
          <b>{s.resumed}</b>
        </div>
        <div className="rv-mini">
          <span>{t("reuse.restored")}</span>
          <b>{s.restored}</b>
        </div>
        <div className="rv-mini">
          <span>{t("reuse.recovered")}</span>
          <b>{s.recovered}</b>
        </div>
        <div className="rv-mini" title={t("reuse.estimated")}>
          <span>{t("reuse.avoidedCalls")}</span>
          <b>{s.savedInvocations == null ? "—" : `~${Math.round(s.savedInvocations)}`}</b>
        </div>
        <div className="rv-mini" title={t("reuse.estimated")}>
          <span>{t("reuse.avoidedTokens")}</span>
          <b>{s.savedTokens == null ? "—" : `~${Math.round(s.savedTokens).toLocaleString()}`}</b>
        </div>
      </div>
    </div>
  );
}
