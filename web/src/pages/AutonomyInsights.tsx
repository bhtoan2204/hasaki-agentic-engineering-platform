import { useState } from "react";
import { Gauge } from "lucide-react";
import { useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { ErrorBox, Loading } from "../ui.tsx";

type Rate = { numerator: number; denominator: number; value: number | null };
type View = {
  days: number;
  metrics: {
    sample: {
      episodes: number;
      started: number;
      eligible_autonomous: number;
      cohorts: Record<string, number>;
    };
    human_free_completion: Rate;
    policy_compliance: Rate;
    interventions: {
      total: number;
      avoidable: number;
      mandatory: number;
      operator_safety: number;
      per_started_episode: number | null;
    };
    first_pass_pr_acceptance: Rate & { pending_or_unknown: number };
    false_completion: Rate;
    regression_escape: Rate & { censored: number };
    efficiency: {
      wall_ms_p50: number | null;
      wall_ms_p95: number | null;
      tokens_total: number | null;
      cost_usd_known: number | null;
      cost_coverage: number | null;
      runs_per_episode: number | null;
    };
  };
};

const rate = (r: Rate) =>
  r.value == null ? "—" : `${(r.value * 100).toFixed(0)}% (${r.numerator}/${r.denominator})`;

/** Autonomy from production records: every rate with its denominator; unknowns are shown, never folded into success. */
export function AutonomyInsights() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<View>(`/api/eval/autonomy?days=${days}`, [days]);
  const m = data?.metrics;
  return (
    <div className="ins">
      <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Gauge size={20} /> {t("ae.title")}
      </h2>
      <p className="small muted">{t("ae.hint")}</p>
      <select
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        aria-label={t("ae.window")}
      >
        {[7, 30, 90, 180].map((d) => (
          <option key={d} value={d}>
            {t("ae.days", { n: d })}
          </option>
        ))}
      </select>
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {m && m.sample.episodes === 0 && <p className="small muted">{t("ae.empty")}</p>}
      {m && m.sample.episodes > 0 && (
        <section className="card small">
          <div>
            {t("ae.sample", { n: m.sample.episodes, eligible: m.sample.eligible_autonomous })}
          </div>
          <div>
            {t("ae.cohorts")}:{" "}
            {Object.entries(m.sample.cohorts)
              .filter(([, n]) => n)
              .map(([k, n]) => `${k} ${n}`)
              .join(", ")}
          </div>
          <div>
            {t("ae.humanFree")}: <b>{rate(m.human_free_completion)}</b>
          </div>
          <div>
            {t("ae.interventions")}: {m.interventions.total} (
            {t("ae.avoidable", { n: m.interventions.avoidable })},{" "}
            {t("ae.mandatory", { n: m.interventions.mandatory })}) ·{" "}
            {m.interventions.per_started_episode?.toFixed(2) ?? "—"}/{t("ae.episode")}
          </div>
          <div>
            {t("ae.firstPass")}: {rate(m.first_pass_pr_acceptance)} ·{" "}
            {t("ae.pending", { n: m.first_pass_pr_acceptance.pending_or_unknown })}
          </div>
          <div>
            {t("ae.falseCompletion")}: {rate(m.false_completion)}
          </div>
          <div>
            {t("ae.regression")}: {rate(m.regression_escape)} ·{" "}
            {t("ae.censored", { n: m.regression_escape.censored })}
          </div>
          <div>
            {t("ae.efficiency")}: p50{" "}
            {m.efficiency.wall_ms_p50 != null ? Math.round(m.efficiency.wall_ms_p50 / 60000) : "—"}{" "}
            min · p95{" "}
            {m.efficiency.wall_ms_p95 != null ? Math.round(m.efficiency.wall_ms_p95 / 60000) : "—"}{" "}
            min · tokens {m.efficiency.tokens_total ?? "—"} · {t("ae.cost")}{" "}
            {m.efficiency.cost_usd_known != null
              ? `$${m.efficiency.cost_usd_known.toFixed(2)}`
              : t("ae.unknown")}{" "}
            ({t("ae.coverage", { n: Math.round((m.efficiency.cost_coverage ?? 0) * 100) })})
          </div>
          <p className="muted">{t("ae.small")}</p>
        </section>
      )}
    </div>
  );
}
