import { useEffect, useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { api, useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { act } from "../ui.tsx";
import "./Cost.css";

/** USD with precision that suits agent costs: cents above $1, 3 decimals below. */
export const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n >= 1 ? n.toFixed(2) : n.toFixed(3)}`;

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

/** List cell: total cost, with wasted share and availability in the tooltip. */
export function CostCell({ cost }: { cost?: any }) {
  const { t } = useI18n();
  if (!cost || cost.cost_usd == null) return <span className="muted small">—</span>;
  const tip = [
    t("cost.wasted") + ": " + usd(cost.wasted_usd),
    cost.availability === "partial" ? t("cost.partial") : "",
    cost.run_count != null ? t("cost.runs", { n: cost.run_count }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <span className="cost-cell" title={tip}>
      {usd(cost.cost_usd)}
      {cost.availability === "partial" && "+"}
      {cost.wasted_usd > 0 && <span className="cost-cell-waste"> ({usd(cost.wasted_usd)})</span>}
    </span>
  );
}

function BudgetBar({ line }: { line: any }) {
  const { t } = useI18n();
  if (!line || line.status === "none") return <span className="muted small">{t("cost.noBudget")}</span>;
  const pct = Math.min(100, line.pct ?? 0);
  return (
    <div className={`cost-budget cost-budget-${line.status}`}>
      <div className="cost-budget-track">
        <div className="cost-budget-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="small">
        {usd(line.used_usd)} / {usd(line.limit_usd)} ({line.pct}%)
        {line.source === "default" && <span className="muted"> · {t("cost.defaultBudget")}</span>}
      </span>
    </div>
  );
}

function BudgetEditor({ path, current, onSaved }: { path: string; current: number | null; onSaved: (d: any) => void }) {
  const { t } = useI18n();
  const [v, setV] = useState(current == null ? "" : String(current));
  useEffect(() => setV(current == null ? "" : String(current)), [current]);
  const save = (value: string | null) =>
    act(async () => onSaved(await api(path, { budget_usd: value })), t("cost.budgetSaved"));
  return (
    <form
      className="cost-budget-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void save(v.trim() || null);
      }}
    >
      <input type="number" min="0.01" step="0.01" inputMode="decimal" placeholder={t("cost.budgetPlaceholder")} value={v} onChange={(e) => setV(e.target.value)} aria-label={t("cost.budget")} />
      <button type="submit" className="ghost">{t("cost.setBudget")}</button>
      {current != null && (
        <button type="button" className="quiet" onClick={() => void save(null)}>
          {t("cost.clearBudget")}
        </button>
      )}
    </form>
  );
}

const REASONS = ["failed", "canceled", "stale", "superseded", "failed_run"];

/**
 * Cost panel for one run (`kind="run"`) or one work item across all its runs (`kind="work_item"`):
 * totals and tokens, wasted cost, budget (editable), breakdown by step or by run, and by model.
 */
export function CostPanel({ kind, id, tick }: { kind: "run" | "work_item"; id: number; tick?: unknown }) {
  const { t } = useI18n();
  const base = kind === "run" ? `/api/runs/${id}` : `/api/work-items/${id}`;
  const { data: fetched, reload } = useApi<any>(`${base}/cost`, [id]);
  const [data, setData] = useState<any>(null);
  useEffect(() => setData(fetched), [fetched]);
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const budget = kind === "run" ? data.budget?.run : data.budget;
  const ownBudget = budget?.source === "own" ? budget.limit_usd : null;
  const tk = data.total.tokens;
  const none = data.availability === "none";
  return (
    <div className="cost-card">
      <div className="cost-card-head">
        <h4>
          <CircleDollarSign size={16} /> {t(kind === "run" ? "cost.titleRun" : "cost.titleWorkItem")}
        </h4>
        {data.availability === "partial" && <span className="cost-flag">{t("cost.partial")}</span>}
        {data.availability === "unavailable" && <span className="cost-flag">{t("cost.unavailable")}</span>}
      </div>
      {none ? (
        <p className="muted small">{t("cost.none")}</p>
      ) : (
        <>
          <div className="cost-minis">
            <div className="cost-mini">
              <span>{t("cost.total")}</span>
              <b>{usd(data.total.cost_usd)}</b>
            </div>
            {kind === "work_item" && (
              <div className="cost-mini">
                <span>{t("cost.avgPerRun")}</span>
                <b>{usd(data.avg_per_run_usd)}</b>
                <small className="muted">{t("cost.runs", { n: data.run_count })}</small>
              </div>
            )}
            <div className="cost-mini">
              <span>{t("cost.wasted")}</span>
              <b className={data.wasted.cost_usd > 0 ? "cost-waste" : ""}>{usd(data.wasted.cost_usd)}</b>
              {data.wasted.pct != null && <small className="muted">{data.wasted.pct}%</small>}
            </div>
            <div className="cost-mini">
              <span>{t("cost.tokensIn")}</span>
              <b>{compact(tk.input)}</b>
              {tk.cache_read + tk.cache_creation > 0 && (
                <small className="muted">{t("cost.cache", { read: compact(tk.cache_read), write: compact(tk.cache_creation) })}</small>
              )}
            </div>
            <div className="cost-mini">
              <span>{t("cost.tokensOut")}</span>
              <b>{compact(tk.output)}</b>
              {tk.reasoning > 0 && <small className="muted">{t("cost.reasoning", { n: compact(tk.reasoning) })}</small>}
            </div>
          </div>
          {data.wasted.cost_usd > 0 && (
            <p className="small muted cost-reasons">
              {REASONS.filter((r) => data.wasted.by_reason[r]).map((r) => `${t(`cost.reason.${r}`)} ${usd(data.wasted.by_reason[r])}`).join(" · ")}
            </p>
          )}
        </>
      )}

      <div className="cost-section">
        <div className="cost-h">{t("cost.budget")}</div>
        <BudgetBar line={budget} />
        {kind === "run" && data.budget?.work_item && data.budget.work_item.status !== "none" && (
          <div className="cost-wi-budget">
            <span className="muted small">{t("cost.workItemBudget")}</span>
            <BudgetBar line={data.budget.work_item} />
          </div>
        )}
        <BudgetEditor path={`${base}/budget`} current={ownBudget} onSaved={setData} />
      </div>

      {!none && kind === "run" && data.by_step.length > 0 && (
        <div className="cost-section">
          <div className="cost-h">{t("cost.byStep")}</div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>{t("cost.step")}</th>
                <th>{t("cost.attempts")}</th>
                <th>{t("cost.cost")}</th>
                <th>{t("cost.wasted")}</th>
                <th>{t("cost.tokens")}</th>
              </tr>
            </thead>
            <tbody>
              {data.by_step.filter((s: any) => s.cost_usd != null || s.attempts_without_cost > 0).map((s: any) => (
                <tr key={s.step_key}>
                  <td>{s.step_name}</td>
                  <td>{s.attempts}</td>
                  <td>{usd(s.cost_usd)}</td>
                  <td className={s.wasted_usd > 0 ? "cost-waste" : "muted"}>{s.wasted_usd > 0 ? usd(s.wasted_usd) : "—"}</td>
                  <td className="muted">{compact(s.tokens.input + s.tokens.output)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {kind === "work_item" && data.runs.length > 0 && (
        <div className="cost-section">
          <div className="cost-h">{t("cost.byRun")}</div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>{t("cost.run")}</th>
                <th>{t("cost.status")}</th>
                <th>{t("cost.cost")}</th>
                <th>{t("cost.wasted")}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r: any) => (
                <tr key={r.run_id}>
                  <td>
                    <a href={`#/runs/${r.run_id}`}>#{r.run_id}</a> <span className="muted small">{r.workflow}</span>
                  </td>
                  <td className="small">{r.status}</td>
                  <td>{usd(r.cost_usd)}</td>
                  <td className={r.status === "FAILED" || r.status === "CANCELED" || r.wasted_usd > 0 ? "cost-waste" : "muted"}>
                    {r.status === "FAILED" || r.status === "CANCELED" ? usd(r.cost_usd) : r.wasted_usd > 0 ? usd(r.wasted_usd) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!none && data.by_model.length > 0 && (
        <div className="cost-section">
          <div className="cost-h">{t("cost.byModel")}</div>
          <table className="cost-table">
            <thead>
              <tr>
                <th>{t("cost.model")}</th>
                <th>{t("cost.attempts")}</th>
                <th>{t("cost.cost")}</th>
                <th>{t("cost.tokens")}</th>
              </tr>
            </thead>
            <tbody>
              {data.by_model.map((m: any) => (
                <tr key={`${m.provider}|${m.model}`}>
                  <td>
                    {m.model} <span className="muted small">{m.provider}</span>
                  </td>
                  <td>{m.attempts}</td>
                  <td>{usd(m.cost_usd)}</td>
                  <td className="muted">{compact(m.tokens.input + m.tokens.output)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
