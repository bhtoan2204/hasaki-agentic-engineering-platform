import { useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Ban, Check, Coins, Cpu, Gauge, Hand, LineChart, Plug, Repeat, ShieldCheck, Sparkles, Timer, Users, Workflow, Wrench, type LucideIcon,
} from "lucide-react";
import { useApi, useLive } from "../api.ts";
import { Badge, EmptyState, ErrorBox, JsonBlock, Loading, navigate, PageHeader, Segmented, StatCard, Tabs, time } from "../ui.tsx";
import "./Insights.css";

// ---------------------------------------------------------------- number helpers (pg numeric/bigint arrive as strings)

const num = (x: unknown): number | null => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
const sum = (rows: any[] | undefined, k: string) => (rows ?? []).reduce((a, r) => a + (num(r[k]) ?? 0), 0);
const fmtInt = (x: number | null) => (x == null ? "—" : x.toLocaleString("vi-VN"));
const fmtNum = (x: number | null, d = 1) => (x == null ? "—" : x.toLocaleString("vi-VN", { maximumFractionDigits: d }));
const fmtCompact = (x: number | null) => (x == null ? "—" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(x));
const fmtUsd = (x: number | null) => (x == null ? "—" : `$${x.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: x < 1 ? 4 : 2 })}`);
const fmtPct = (x: number | null) => (x == null ? "—" : `${fmtNum(x, 1)}%`);
const fmtSec = (x: number | null) => (x == null ? "—" : x >= 60 ? `${Math.floor(x / 60)}m${Math.round(x % 60)}s` : `${fmtNum(x, 1)}s`);
const pct = (a: number, b: number) => (b ? (a / b) * 100 : null);

// ---------------------------------------------------------------- chart primitives (plain SVG / CSS)

type Seg = { value: number; color: string; label: string };
type BarRow = { key: string; label: ReactNode; value: number | null; display?: ReactNode; hint?: ReactNode; segments?: Seg[]; title?: string };

/** Horizontal bars, scaled to the largest value; optional stacked segments. */
function Bars({ rows, color = "var(--brand)", empty = "Chưa có dữ liệu." }: { rows: BarRow[]; color?: string; empty?: string }) {
  if (!rows.length) return <div className="ins-empty">{empty}</div>;
  const max = Math.max(...rows.map((r) => r.value ?? 0), 0);
  return (
    <ul className="ins-bars">
      {rows.map((r) => {
        const w = max > 0 && r.value != null ? Math.max(1.5, (r.value / max) * 100) : 0;
        const segTotal = r.segments?.reduce((a, s) => a + s.value, 0) ?? 0;
        return (
          <li key={r.key} className="ins-bar" title={r.title}>
            <div className="ins-bar-label">
              <span className="ins-bar-name">{r.label}</span>
              {r.hint && <span className="ins-bar-hint">{r.hint}</span>}
            </div>
            <div className="ins-bar-track" aria-hidden>
              <div className="ins-bar-fill" style={{ width: `${w}%`, background: r.segments ? "transparent" : color }}>
                {r.segments && segTotal > 0 && r.segments.map((s) => s.value > 0 && <span key={s.label} style={{ width: `${(s.value / segTotal) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />)}
              </div>
            </div>
            <div className="ins-bar-value">{r.display ?? fmtNum(r.value)}</div>
          </li>
        );
      })}
    </ul>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="ins-legend">
      {items.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
    </div>
  );
}

/** Progress ring for a percentage; grey ring + "—" when unknown. */
function Ring({ value, label, sub, color = "var(--brand)" }: { value: number | null; label: string; sub?: ReactNode; color?: string }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="ins-ring">
      <svg viewBox="0 0 96 96" width="104" height="104" role="img" aria-label={`${label}: ${fmtPct(value)}`}>
        <circle cx="48" cy="48" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="9" />
        {value != null && (
          <circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 48 48)" />
        )}
        <text x="48" y="53" textAnchor="middle" className="ins-ring-text">{value == null ? "—" : `${Math.round(v)}%`}</text>
      </svg>
      <div className="ins-ring-label">{label}</div>
      {sub && <div className="ins-ring-sub">{sub}</div>}
    </div>
  );
}

function Panel({ icon: I, title, sub, actions, children, className = "" }: { icon: LucideIcon; title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ins-panel ${className}`}>
      <div className="ins-panel-head">
        <span className="ins-panel-icon"><I size={16} strokeWidth={2} /></span>
        <div className="ins-panel-titles">
          <h4>{title}</h4>
          {sub && <div className="ins-panel-sub">{sub}</div>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, tone, title }: { label: string; value: ReactNode; tone?: "ok" | "err" | "wait" | "run"; title?: string }) {
  return (
    <div className={`ins-metric${tone ? ` tone-${tone}` : ""}`} title={title}>
      <div className="ins-metric-label">{label}</div>
      <div className="ins-metric-value">{value}</div>
    </div>
  );
}

/** Plain data table inside a scroll wrapper. */
function Table({ rows, cols }: { rows: any[]; cols: Array<[string, string, ((r: any) => any)?]> }) {
  if (!rows?.length) return <div className="ins-empty">Chưa có dữ liệu.</div>;
  return (
    <div className="table-wrap">
      <table className="ins-table">
        <thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([k, h, f]) => <td key={h} className={num(r[k]) != null && typeof r[k] !== "boolean" && !f ? "mono ins-num" : ""}>{f ? f(r) : String(r[k] ?? "")}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- page

/** Observability: cost/tokens per workflow, step-type durations & failures, tool / integration / skill usage. */
type InsightsTab = "overview" | "quality" | "tools" | "failures" | "registry";
const TAB_KEYS: InsightsTab[] = ["overview", "quality", "tools", "failures", "registry"];

/** `tab` comes from the URL (#/insights/<tab>) so a tab can be linked and survives reloads. */
export function InsightsPage({ tab: tabParam }: { tab?: string }) {
  const tab: InsightsTab = TAB_KEYS.includes(tabParam as InsightsTab) ? (tabParam as InsightsTab) : "overview";
  const setTab = (t: InsightsTab) => navigate(t === "overview" ? "/insights" : `/insights/${t}`);
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<any>(`/api/metrics/summary?days=${days}`, [days]);
  const { data: tools } = useApi<any[]>("/api/tools");
  const [wfMetric, setWfMetric] = useState<"cost" | "tokens" | "runs">("cost");
  const [stMetric, setStMetric] = useState<"avg" | "fail" | "cost">("avg");
  useLive(null, (p) => p?.kind === "status" && reload());

  const header = (
    <PageHeader
      icon={LineChart}
      title="Insights"
      subtitle="Chi phí, token, thời gian, lỗi và mức dùng tool/skill — lấy từ metrics của từng attempt trong PostgreSQL."
      actions={<Segmented label="Khoảng thời gian" options={[1, 7, 30, 90].map((d) => [String(d), `${d} ngày`] as [string, string])} value={String(days)} onChange={(v) => setDays(Number(v))} />}
    />
  );
  if (loading && !data) return <div className="ins">{header}<Loading /></div>;
  if (error && !data) return <div className="ins">{header}<ErrorBox error={error} onRetry={reload} /></div>;

  const wf: any[] = data.by_workflow ?? [];
  const runs = sum(wf, "runs");
  const completed = sum(wf, "completed");
  const failed = sum(wf, "failed");
  const cost = sum(wf, "cost_usd");
  const tokens = sum(wf, "tokens");
  const ev = data.evaluation;
  const v = ev?.verification ?? {};
  const h = ev?.human_intervention ?? {};

  const wfRows: BarRow[] = wf.map((r) => {
    const rr = num(r.runs) ?? 0, c = num(r.completed) ?? 0, f = num(r.failed) ?? 0;
    const hint = `${fmtInt(rr)} runs · ${fmtInt(c)} xong · ${fmtInt(f)} lỗi`;
    const base = { key: r.definition_key ?? "—", label: <span className="mono">{r.definition_key ?? "—"}</span>, hint, title: `${r.definition_key}: ${fmtUsd(num(r.cost_usd))} · ${fmtInt(num(r.tokens))} tokens` };
    if (wfMetric === "cost") return { ...base, value: num(r.cost_usd), display: fmtUsd(num(r.cost_usd)) };
    if (wfMetric === "tokens") return { ...base, value: num(r.tokens), display: fmtCompact(num(r.tokens)) };
    return {
      ...base,
      value: rr,
      display: fmtInt(rr),
      segments: [
        { value: c, color: "var(--st-ok)", label: "Hoàn thành" },
        { value: f, color: "var(--st-err)", label: "Lỗi" },
        { value: Math.max(0, rr - c - f), color: "var(--st-idle)", label: "Khác" },
      ],
    };
  });
  const wfSorted = [...wfRows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const stRows: BarRow[] = (data.by_step_type ?? []).map((r: any) => {
    const att = num(r.attempts) ?? 0, f = num(r.failed) ?? 0;
    const base = { key: r.type ?? "—", label: <span className="mono">{r.type ?? "—"}</span>, hint: `${fmtInt(att)} attempts · ${fmtInt(f)} lỗi · ${fmtUsd(num(r.cost_usd))}` };
    if (stMetric === "avg") return { ...base, value: num(r.avg_seconds), display: fmtSec(num(r.avg_seconds)) };
    if (stMetric === "fail") return { ...base, value: pct(f, att), display: fmtPct(pct(f, att)) };
    return { ...base, value: num(r.cost_usd), display: fmtUsd(num(r.cost_usd)) };
  });
  const stSorted = [...stRows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return (
    <div className="ins">
      {header}
      {error && <ErrorBox error={error} onRetry={reload} />}

      <div className="ins-stats">
        <StatCard icon={Activity} label="Runs" value={fmtInt(runs)} hint={`trong ${days} ngày`} tone="run" />
        <StatCard icon={Check} label="Hoàn thành" value={fmtPct(pct(completed, runs))} hint={`${fmtInt(completed)} xong · ${fmtInt(failed)} lỗi`} tone="ok" />
        <StatCard icon={Coins} label="Chi phí ≈" value={fmtUsd(runs ? cost : null)} hint="ước tính từ SDK" tone="brand" />
        <StatCard icon={Cpu} label="Tokens (in+out)" value={fmtCompact(runs ? tokens : null)} hint={runs ? `${fmtInt(tokens)} tokens` : undefined} tone="wait" />
        <StatCard icon={ShieldCheck} label="Verification pass" value={fmtPct(num(v.pass_rate_pct))} hint={ev ? `${fmtInt(num(v.passed))}/${fmtInt(num(v.verified))} attempts` : undefined} tone="ok" />
        <StatCard icon={Hand} label="Run cần người" value={fmtPct(num(h.rate_pct))} hint={ev ? `${fmtInt(num(h.with_human))}/${fmtInt(num(h.runs))} runs` : undefined} tone="wait" />
      </div>

      <Tabs<InsightsTab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["overview", "Tổng quan"],
          ["quality", "Chất lượng"],
          ["tools", "Tool & skill"],
          ["failures", <>Lỗi gần đây{data.failures?.length ? <span className="ins-tab-count">{data.failures.length}</span> : null}</>],
          ["registry", "Tool registry"],
        ]}
      />

      {tab === "overview" && (
        <>
          <div className="ins-grid">
            <Panel
              icon={Workflow}
              title="Theo workflow"
              sub={wfMetric === "runs" ? <Legend items={[["Hoàn thành", "var(--st-ok)"], ["Lỗi", "var(--st-err)"], ["Khác", "var(--st-idle)"]]} /> : wfMetric === "cost" ? "Chi phí ước tính ($)" : "Tokens (input + output)"}
              actions={<Segmented label="Chỉ số workflow" options={[["cost", "Cost"], ["tokens", "Tokens"], ["runs", "Runs"]]} value={wfMetric} onChange={setWfMetric} />}
            >
              <Bars rows={wfSorted} color={wfMetric === "tokens" ? "var(--st-wait)" : "var(--brand)"} />
            </Panel>
            <Panel
              icon={Timer}
              title="Theo loại bước"
              sub={stMetric === "avg" ? "Thời gian trung bình mỗi attempt" : stMetric === "fail" ? "Tỉ lệ attempt lỗi" : "Chi phí ước tính ($)"}
              actions={<Segmented label="Chỉ số loại bước" options={[["avg", "Thời gian"], ["fail", "Lỗi"], ["cost", "Cost"]]} value={stMetric} onChange={setStMetric} />}
            >
              <Bars rows={stSorted} color={stMetric === "fail" ? "var(--st-err)" : stMetric === "avg" ? "var(--st-run)" : "var(--brand)"} />
            </Panel>
          </div>

          <Panel icon={Users} title="So sánh theo profile" sub="Thời gian, số bước Claude, turns và chi phí trung bình mỗi run">
            <Table
              rows={data.by_profile}
              cols={[["profile", "Profile"], ["runs", "Runs"], ["completed", "Completed"], ["avg_wall_min", "Avg wall (min)"], ["claude_attempts_per_run", "Claude steps/run"], ["turns_per_run", "Turns/run"], ["cost_per_run", "≈ Cost/run ($)"]]}
            />
          </Panel>
        </>
      )}
      {tab === "quality" && (
        <>
          {ev && <HarnessEvaluation e={ev} />}
          <EvalComparison />
        </>
      )}
      {tab === "tools" && (
        <>
          <div className="ins-grid">
            <Panel icon={Wrench} title="Tool (Claude Code + platform)" sub="Số lần gọi">
              <Bars
                rows={(data.tools ?? []).map((r: any) => ({ key: r.tool, label: <span className="mono">{r.tool}</span>, value: num(r.calls), display: fmtInt(num(r.calls)), hint: `${fmtInt(num(r.attempts))} attempts` }))}
                color="var(--st-run)"
              />
            </Panel>
            <Panel icon={Plug} title="Integration tools" sub={<Legend items={[["OK", "var(--st-ok)"], ["Lỗi", "var(--st-err)"]]} />}>
              <Bars
                rows={(data.integrations ?? []).map((r: any) => {
                  const calls = num(r.calls) ?? 0, f = num(r.failed) ?? 0;
                  return {
                    key: r.name, label: <span className="mono">{r.name}</span>, value: calls, display: fmtInt(calls), hint: `${fmtInt(f)} lỗi · TB ${r.avg_ms != null ? `${fmtInt(num(r.avg_ms))}ms` : "—"}`,
                    segments: [{ value: Math.max(0, calls - f), color: "var(--st-ok)", label: "OK" }, { value: f, color: "var(--st-err)", label: "Lỗi" }],
                  };
                })}
              />
            </Panel>
            <Panel icon={Sparkles} title="Skills / knowledge đã nạp" sub="Số lần nạp vào bước">
              <Bars rows={(data.skills ?? []).map((r: any) => ({ key: r.key, label: <a className="mono" href={`#/knowledge/${r.key}`}>{r.key}</a>, value: num(r.loads), display: fmtInt(num(r.loads)) }))} color="var(--rose-ink)" />
            </Panel>
            <Panel icon={Ban} title="Tool bị policy chặn" sub="Theo tool + lý do">
              {!(data.denied ?? []).length ? <div className="ins-empty">Không có tool nào bị chặn.</div> : (
                <ul className="ins-denied">
                  {data.denied.map((r: any, i: number) => (
                    <li key={i}>
                      <span className="ins-denied-times">{fmtInt(num(r.times))}×</span>
                      <div className="ins-denied-body"><b className="mono">{r.tool}</b><div className="muted small">{r.reason}</div></div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
      {tab === "failures" && (
        <>
          <Panel icon={AlertTriangle} title="Lỗi gần đây" sub="25 attempt lỗi mới nhất">
            <Table
              rows={data.failures}
              cols={[
                ["run_id", "Run", (r) => <a onClick={() => navigate(`/runs/${r.run_id}/${r.step_key}`)} style={{ cursor: "pointer" }} className="mono">#{r.run_id} · {r.step_key}</a>],
                ["type", "Type", (r) => <span className="pill">{r.type}</span>],
                ["finished_at", "At", (r) => <span className="muted nowrap">{time(r.finished_at)}</span>],
                ["error", "Error", (r) => <span className="ins-error">{r.error}</span>],
              ]}
            />
          </Panel>
        </>
      )}
      {tab === "registry" && (
        <>
          <Panel icon={Plug} title="Integration tool registry" sub="Agent khám phá qua list_tools → describe_tool → call_tool (không nạp schema từ đầu).">
            <Table
              rows={tools ?? []}
              cols={[
                ["name", "Name", (r) => <b className="mono">{r.name}</b>],
                ["summary", "Summary"],
                ["read_only", "Mode", (r) => (r.read_only ? <Badge s="COMPLETED">read-only</Badge> : <Badge s="WAITING">write</Badge>)],
                ["available", "Available", (r) => (r.available === true ? <span className="okc ins-avail"><Check size={15} strokeWidth={2.4} aria-label="available" /></span> : <span className="muted small">{String(r.available)}</span>)],
                ["input_schema", "Schema", (r) => <details><summary>schema</summary><JsonBlock value={r.input_schema} /></details>],
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- harness evaluation

const KNOWN_V = new Set(["coding_attempts", "verified", "passed", "passed_first_try", "avg_repairs", "stopped_no_progress", "repair_budget_exhausted", "avg_verify_s", "pass_rate_pct", "first_try_pass_rate_pct"]);
const KNOWN_H = new Set(["runs", "with_human", "answers", "reexecutions", "rate_pct"]);
const humanize = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Fields the API may add later: scalars become metric tiles, structures are shown as JSON. */
function Extras({ obj, known }: { obj: Record<string, any>; known: Set<string> }) {
  const extra = Object.entries(obj ?? {}).filter(([k]) => !known.has(k));
  if (!extra.length) return null;
  const scalars = extra.filter(([, x]) => x == null || typeof x !== "object");
  const complex = extra.filter(([, x]) => x != null && typeof x === "object");
  return (
    <>
      {scalars.length > 0 && <div className="ins-metrics">{scalars.map(([k, x]) => <Metric key={k} label={humanize(k)} value={x == null ? "—" : num(x) != null ? fmtNum(num(x), 2) : String(x)} />)}</div>}
      {complex.map(([k, x]) => <JsonBlock key={k} title={humanize(k)} value={x} />)}
    </>
  );
}

/** Harness evaluation — whether coding steps passed the platform's own verification; separate from run status. */
function HarnessEvaluation({ e }: { e: any }) {
  const v = e.verification ?? {};
  const h = e.human_intervention ?? {};
  const verified = num(v.verified) ?? 0;
  const passed = num(v.passed) ?? 0;
  const exhausted = num(v.repair_budget_exhausted) ?? 0;
  const noProgress = num(v.stopped_no_progress) ?? 0;
  const other = Math.max(0, verified - passed - exhausted - noProgress);
  const outcome: Seg[] = [
    { value: passed, color: "var(--st-ok)", label: "Pass" },
    { value: exhausted, color: "var(--st-err)", label: "Hết lượt sửa" },
    { value: noProgress, color: "var(--st-wait)", label: "Không tiến triển" },
    { value: other, color: "var(--st-idle)", label: "Khác" },
  ];
  return (
    <>
      <div className="ins-eval">
        <Panel
          icon={ShieldCheck}
          className="ins-eval-main"
          title="Harness evaluation"
          sub="Tách biệt với trạng thái run: coding step có qua verification của platform không, mất bao nhiêu lần sửa, lỗi nào lặp lại."
        >
          <div className="ins-eval-body">
            <div className="ins-rings">
              <Ring value={num(v.pass_rate_pct)} label="Verification pass" sub={`${fmtInt(num(v.passed))}/${fmtInt(num(v.verified))} đã kiểm`} color="var(--st-ok)" />
              <Ring value={num(v.first_try_pass_rate_pct)} label="Pass lần đầu" sub={`${fmtInt(num(v.passed_first_try))} attempts`} color="var(--brand)" />
            </div>
            <div className="ins-eval-side">
              <div className="ins-metrics">
                <Metric label="Coding attempts" value={fmtInt(num(v.coding_attempts))} />
                <Metric label="Repairs / attempt" value={fmtNum(num(v.avg_repairs), 2)} tone="run" />
                <Metric label="Verify TB" value={fmtSec(num(v.avg_verify_s))} />
                <Metric label="Hết lượt sửa" value={fmtInt(num(v.repair_budget_exhausted))} tone="err" title="repair budget exhausted" />
                <Metric label="Không tiến triển" value={fmtInt(num(v.stopped_no_progress))} tone="wait" title="stopped: no progress" />
              </div>
              {verified > 0 ? (
                <div className="ins-outcome">
                  <div className="ins-outcome-bar" role="img" aria-label="Phân bố kết quả verification">
                    {outcome.map((s) => s.value > 0 && <span key={s.label} style={{ width: `${(s.value / verified) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />)}
                  </div>
                  <Legend items={outcome.filter((s) => s.value > 0).map((s) => [`${s.label} · ${s.value}`, s.color] as [string, string])} />
                </div>
              ) : <div className="ins-empty">Chưa có coding attempt nào được verify.</div>}
            </div>
          </div>
          <Extras obj={v} known={KNOWN_V} />
        </Panel>
        <Panel icon={Hand} className="ins-eval-human" title="Can thiệp của người" sub="Run có câu trả lời, duyệt thủ công hoặc re-execute">
          <div className="ins-human">
            <Ring value={num(h.rate_pct)} label="Run cần người" sub={`${fmtInt(num(h.with_human))}/${fmtInt(num(h.runs))} runs`} color="var(--st-wait)" />
            <div className="ins-metrics ins-metrics-col">
              <Metric label="Câu trả lời" value={fmtInt(num(h.answers))} />
              <Metric label="Re-execute" value={fmtInt(num(h.reexecutions))} />
            </div>
          </div>
          <Extras obj={h} known={KNOWN_H} />
        </Panel>
      </div>
      <Panel icon={Repeat} title="Lỗi verification lặp lại" sub="Failure signature xuất hiện nhiều hơn một lần">
        {e.repeated_failures?.length > 0 ? <RepeatedFailures rows={e.repeated_failures} /> : <EmptyState icon={Gauge} title="Không có lỗi lặp lại">Chưa có failure signature nào lặp lại trong khoảng thời gian này.</EmptyState>}
      </Panel>
    </>
  );
}

function RepeatedFailures({ rows }: { rows: any[] }) {
  const max = Math.max(...rows.map((r) => num(r.times) ?? 0), 1);
  return (
    <div className="table-wrap">
      <table className="ins-table">
        <thead><tr><th>Failure signature</th><th>Times</th><th>Runs</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><code className="ins-sig">{r.signature}</code></td>
              <td className="ins-times">
                <span className="ins-mini-track"><span style={{ width: `${((num(r.times) ?? 0) / max) * 100}%` }} /></span>
                <span className="mono">{fmtInt(num(r.times))}</span>
              </td>
              <td className="mono ins-num">{fmtInt(num(r.runs))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Benchmark results (eval_results): candidates × profiles, graded by hidden acceptance tests. */
function EvalComparison() {
  const { data } = useApi<any>("/api/evals");
  const groups = (data?.summary ?? []) as any[];
  const v = (x: any, suffix = "") => (x == null ? "—" : `${x}${suffix}`);
  return (
    <section className="card">
      <div className="card-head"><h4>Benchmark comparison</h4><span className="sub">npm run bench -- --live · hidden acceptance tests · candidates and profiles</span></div>
      {!groups.length ? (
        <div className="muted small">Chưa có kết quả benchmark. Chạy <span className="kbd">npm run bench -- --live --profiles=FAST,STANDARD,DEEP</span> (và <span className="kbd">--candidate=claude-cli</span>) để so sánh.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Candidate / profile</th><th>Runs</th><th>Success</th><th>Regression</th><th>Verifier accuracy</th><th>False pass / alarm</th><th>Repair success</th><th>Human</th><th>Avg time</th><th>Avg cost</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group}>
                  <td><b>{g.group}</b></td>
                  <td className="mono">{g.runs}</td>
                  <td className="mono">{v(g.success_rate_pct, "%")} <span className="muted small">({g.graded} graded)</span></td>
                  <td className="mono">{v(g.regression_rate_pct, "%")}</td>
                  <td className="mono">{g.verifier ? `${g.verifier.accuracy_pct}% of ${g.verifier.judged}` : "—"}</td>
                  <td className="mono">{g.verifier ? `${g.verifier.false_pass} / ${g.verifier.false_alarm}` : "—"}</td>
                  <td className="mono">{v(g.repair_success_pct, "%")}</td>
                  <td className="mono">{v(g.human_intervention_pct, "%")}</td>
                  <td className="mono">{v(g.avg_wall_s, "s")}</td>
                  <td className="mono">{g.avg_cost_usd == null ? "—" : `$${g.avg_cost_usd}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
