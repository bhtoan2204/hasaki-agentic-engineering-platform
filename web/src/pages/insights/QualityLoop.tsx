import { Repeat } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { useI18n } from "../../i18n/index.tsx";
import { act } from "../../ui.tsx";
import "../../components/Cost.css";

/**
 * The feedback loop in one card: verified outcome levels → repeated failure categories → suggested improvement →
 * human review (proposals page) → policy versions compared. Reads /api/quality/patterns; proposals are created only on
 * an explicit admin click and always land in the review queue.
 */
export function QualityLoop() {
  const { t } = useI18n();
  const { data, reload } = useApi<any>("/api/quality/patterns?days=30");
  const { data: perf } = useApi<any>("/api/quality/providers?days=30");
  if (!data) return null;
  const levels = Object.entries<number>(data.verified_levels ?? {}).filter(([, n]) => n > 0);
  return (
    <div className="cost-card">
      <div className="cost-card-head">
        <h4>
          <Repeat size={16} /> {t("ql.title")}
        </h4>
        <span className="muted small">
          {t("ql.sub", { runs: data.runs, days: data.window_days })}
        </span>
        <button
          className="ghost"
          onClick={() =>
            void act(async () => {
              const r = await api<any>("/api/quality/proposals", { days: data.window_days });
              reload();
              return r;
            }, t("ql.proposed"))
          }
        >
          {t("ql.propose")}
        </button>
        <a className="small" href="#/knowledge/~proposals">
          {t("ql.review")}
        </a>
      </div>
      <div className="cost-section">
        <div className="cost-h">{t("ql.levels")}</div>
        <p className="small">
          {levels.length ? levels.map(([k, n]) => `${t(`ql.level.${k}`)}: ${n}`).join(" · ") : "—"}
        </p>
        {data.cost_per_verified_task != null && (
          <p className="small muted">
            {t("ql.costVerified", { usd: data.cost_per_verified_task })}
          </p>
        )}
      </div>
      <div className="cost-section">
        <div className="cost-h">{t("ql.patterns")}</div>
        {data.patterns.length ? (
          <table className="cost-table">
            <thead>
              <tr>
                <th>{t("ql.category")}</th>
                <th>{t("ql.runs")}</th>
                <th>{t("ql.tasks")}</th>
                <th>{t("ql.suggested")}</th>
              </tr>
            </thead>
            <tbody>
              {data.patterns.map((p: any) => (
                <tr key={p.category} title={p.examples.join("\n")}>
                  <td>{t(`ql.cat.${p.category}`)}</td>
                  <td>
                    {p.runs} ({p.rate}%)
                  </td>
                  <td>{p.distinct_tasks}</td>
                  <td className="muted">{p.suggested?.title ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">{t("ql.none")}</p>
        )}
      </div>
      {perf?.groups?.length > 0 && (
        <div className="cost-section">
          <div className="cost-h">{t("ql.providers")}</div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>{t("ql.provider")}</th>
                <th>{t("ql.stepType")}</th>
                <th>{t("ql.attempts")}</th>
                <th>{t("ql.success")}</th>
                <th>p50 / p95</th>
                <th>{t("ql.costSuccess")}</th>
                <th>{t("ql.unknownCost")}</th>
                <th>{t("ql.verifyPass")}</th>
              </tr>
            </thead>
            <tbody>
              {perf.groups.map((g: any) => (
                <tr key={`${g.provider}|${g.step_type}`} className={g.sample_ok ? "" : "muted"}>
                  <td>{g.provider}</td>
                  <td>{g.step_type}</td>
                  <td>
                    {g.attempts}
                    {g.sample_ok ? "" : " *"}
                  </td>
                  <td>{g.success_rate ?? "—"}%</td>
                  <td>
                    {g.p50_ms != null
                      ? `${Math.round(g.p50_ms / 1000)}s / ${Math.round(g.p95_ms / 1000)}s`
                      : "—"}
                  </td>
                  <td>
                    {g.cost_per_successful_completion != null
                      ? `$${g.cost_per_successful_completion}`
                      : "—"}
                  </td>
                  <td>{g.unknown_cost_rate ?? "—"}%</td>
                  <td>
                    {g.verification_pass_rate ?? g.review_pass_rate ?? "—"}
                    {g.verification_pass_rate != null || g.review_pass_rate != null ? "%" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">{t("ql.providersNote", { n: perf.min_samples })}</p>
        </div>
      )}
      {data.by_policy_version.length > 1 && (
        <div className="cost-section">
          <div className="cost-h">{t("ql.versions")}</div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>{t("ql.version")}</th>
                <th>{t("ql.runs")}</th>
                <th>{t("ql.testsRate")}</th>
                <th>{t("ql.reviewRate")}</th>
                <th>{t("ql.failureRate")}</th>
                <th>{t("ql.repairs")}</th>
              </tr>
            </thead>
            <tbody>
              {data.by_policy_version.map((v: any) => (
                <tr key={v.policy_key} title={JSON.stringify(v.versions)}>
                  <td className="mono small">{v.policy_key}</td>
                  <td>{v.runs}</td>
                  <td>{v.tests_passed_rate}%</td>
                  <td>{v.review_passed_rate}%</td>
                  <td>{v.failure_rate}%</td>
                  <td>{v.avg_repairs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">{t("ql.observational")}</p>
        </div>
      )}
    </div>
  );
}
