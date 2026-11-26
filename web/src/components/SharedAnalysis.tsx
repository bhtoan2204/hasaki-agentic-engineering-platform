import { Share2 } from "lucide-react";
import { Button, JsonBlock, ago, time } from "../ui.tsx";
import { dialog } from "../dialog/index.ts";
import { useI18n } from "../i18n/index.tsx";
import {
  age,
  canForce,
  newerNote,
  resultCount,
  runner,
  sharedState,
  sharedTone,
  staleReasons,
  type SharedView,
} from "../sharedAnalysis.ts";
import "./SharedAnalysis.css";

/**
 * One shared analysis (step 7): that it is reused, who ran it and when, how old it is, its state, how often it was reused;
 * a stale result is shown with a warning (never hidden); a running one says someone else is running it; a production error
 * shows its occurrences now next to when it was analysed. "Re-run" asks first and calls `onForce` (the step 4 force).
 */
export function SharedAnalysisCard({
  view,
  onForce,
  busy = false,
}: {
  view: SharedView;
  onForce?: () => void | Promise<void>;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const state = sharedState(view);
  const who = runner(view);
  const old = age(view.freshness.age_seconds);
  const reasons = staleReasons(view);
  const occ = view.occurrences;
  const count = resultCount(view.result);
  const force = async () => {
    const ok = await dialog.confirm({
      title: t("sr.forceTitle"),
      description: t("sr.forceBody"),
      confirmLabel: t("sr.forceConfirm"),
      variant: "warning",
    });
    if (ok) await onForce?.();
  };
  return (
    <section
      className={`shared-card tone-${sharedTone(state)}`}
      data-testid="shared-analysis"
      data-state={state}
      aria-label={`${t("sr.title")}: ${t(`sr.kind.${view.kind}`)}`}
    >
      <div className="shared-head">
        <Share2 size={14} aria-hidden="true" />
        <b className="small">{t(`sr.kind.${view.kind}`)}</b>
        <span className="pill shared-badge">{t("sr.badge")}</span>
        <span className="pill shared-state" data-testid="shared-state">
          {t(`sr.state.${state}`)}
        </span>
        <span className="muted small">{t("sr.version", { v: view.version })}</span>
      </div>
      <p className="small shared-meta" data-testid="shared-meta">
        <span data-testid="shared-runner">
          {t(who.key, who.name ? { name: who.name } : undefined)}
        </span>
        {view.freshness.analysed_at && (
          <>
            {" "}
            <span title={time(view.freshness.analysed_at)}>
              {old
                ? t(`sr.age.${old.unit}`, { n: old.n })
                : t("sr.analysedAt", { at: time(view.freshness.analysed_at) })}
            </span>
          </>
        )}
        {view.reuse.count > 0 && (
          <span className="muted"> · {t("sr.reused", { n: view.reuse.count })}</span>
        )}
        {state === "valid" && view.freshness.valid_until && (
          <span className="muted">
            {" "}
            · {t("sr.validUntil", { at: time(view.freshness.valid_until) })}
          </span>
        )}
      </p>
      {newerNote(view) && (
        <p className="small muted" data-testid="shared-newer">
          {t(newerNote(view)!)}
        </p>
      )}
      {state === "stale" && (
        <p className="small shared-warn" role="status" data-testid="shared-stale">
          {t("sr.staleWarning")}
          {reasons.length > 0 && (
            <>
              {" "}
              ({reasons.map((r) => t(r.key, r.repos ? { repos: r.repos } : undefined)).join("; ")})
            </>
          )}
        </p>
      )}
      {state === "running_other" && (
        <p className="small" role="status" data-testid="shared-running">
          {t("sr.runningOther")}
        </p>
      )}
      {state === "running_you" && <p className="small muted">{t("sr.runningYou")}</p>}
      {view.failure && (
        <p className="small shared-err" data-testid="shared-failure">
          {view.status === "failed" && t("sr.failedReason", { reason: view.failure.reason ?? "—" })}{" "}
          {view.failure.exhausted
            ? t("sr.exhausted")
            : view.failure.retry_at && t("sr.retryAt", { at: time(view.failure.retry_at) })}
        </p>
      )}
      {occ?.now && (
        <p className="small" data-testid="shared-occurrences">
          {t("sr.occurrences", {
            then: occ.at_analysis?.today_count ?? "—",
            now: occ.now.today_count,
          })}
          {occ.new_since_analysis ? (
            <b> · {t("sr.occurrencesNew", { n: occ.new_since_analysis })}</b>
          ) : null}
          {occ.now.last_at && (
            <span className="muted"> · {t("sr.lastSeen", { at: ago(occ.now.last_at) })}</span>
          )}
        </p>
      )}
      {view.result !== undefined && (
        <details className="shared-result">
          <summary className="small">
            {t("sr.result")}
            {count != null && <span className="muted"> · {t("sr.resultCount", { n: count })}</span>}
          </summary>
          <JsonBlock value={view.result} />
        </details>
      )}
      {onForce && canForce(view) && (
        <div className="shared-actions">
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={force}
            data-testid="shared-force"
          >
            {t("sr.force")}
          </Button>
        </div>
      )}
    </section>
  );
}
