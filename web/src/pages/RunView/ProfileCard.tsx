import { AlertTriangle, Zap, GitMerge, Ban, PenLine } from "lucide-react";
import { useI18n } from "../../i18n/index.tsx";
import { ProfileBadge } from "../ProfilePreview.tsx";
import { type RunDetail } from "./shared.tsx";

export function ProfileCard({ run }: { run: RunDetail }) {
  const { t } = useI18n();
  const d = run.profile_decision;
  const changes = run.graph?.profile_changes ?? [];
  if (!d) return null;
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Zap size={16} /> {t("rv.profile")}
        </h4>
        <ProfileBadge profile={run.profile} />
      </div>
      {run.agent_configuration && (
        <p className="small muted">
          Agent configuration version {run.agent_configuration.version} ·{" "}
          {run.agent_configuration.capture_source} · {run.agent_configuration.captured_at}
        </p>
      )}
      {(run.graph?.transitions ?? []).map(
        (transition: { from: string; to: string; reason: string; revision: number }) => (
          <div className="small" key={transition.revision}>
            {transition.from} → {transition.to} · revision {transition.revision}:{" "}
            {transition.reason}
          </div>
        ),
      )}
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
