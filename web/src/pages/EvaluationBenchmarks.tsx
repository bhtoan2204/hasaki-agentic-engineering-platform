import { useState } from "react";
import { api, useApi } from "../api.ts";
import { act, EmptyState, ErrorBox, Loading, navigate } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

type BenchmarkSuite = {
  id: number;
  title: string;
  version: string;
  cases: number;
  categories: string[];
};
type EvaluationRunRow = {
  id: number;
  status: string;
  configuration: { adapter: string; code_intelligence: boolean; prompt_version: string };
  finished: number;
  tasks: number;
  successes: number;
  average_score: number | null;
};
type ComparedCase = {
  status: string;
  quality_score: number | null;
  data: { evidence: { duration_ms: number } };
};
type EvaluationComparison = {
  report: {
    verdict: string;
    sample_note: string;
    warnings: string[];
    pairs: Array<{
      task: string;
      repetition: number;
      baseline: ComparedCase | null;
      candidate: ComparedCase;
    }>;
    baseline: unknown;
    candidate: unknown;
  };
};
type EvaluationRunDetail = {
  id: number;
  status: string;
  workflow_run_id: number;
  summary: {
    successes: number;
    graded: number;
    median_duration_ms: number | null;
    p95_duration_ms: number | null;
    cost_per_success: number | null;
  };
  cases: Array<{
    task_id: string;
    repetition: number;
    status: string | null;
    step_status: string;
    quality_score: number | null;
    base_commit: string;
    origin: unknown;
    failure_class: string | null;
    definition: { description: string; expected_behavior: unknown };
    data: { scoring?: unknown; evidence?: unknown } | null;
  }>;
};

const number = (v: unknown, digits = 1) => (v == null ? "—" : Number(v).toFixed(digits));
export function EvaluationBenchmarks() {
  const { t, status: statusText } = useI18n();
  const suites = useApi<BenchmarkSuite[]>("/api/benchmark-suites");
  const runs = useApi<{ enabled: boolean; runs: EvaluationRunRow[] }>("/api/evaluation-runs");
  const [adapter, setAdapter] = useState("reference"),
    [ci, setCi] = useState(true),
    [repetitions, setRepetitions] = useState(2);
  const [selected, setSelected] = useState<number | null>(null),
    [baseline, setBaseline] = useState(""),
    [candidate, setCandidate] = useState(""),
    [comparison, setComparison] = useState<EvaluationComparison | null>(null),
    [detail, setDetail] = useState<EvaluationRunDetail | null>(null);
  const create = async () => {
    const suite = suites.data?.[0];
    if (!suite) return;
    await act(async () => {
      const run = await api<{ id: number }>("/api/evaluation-runs", {
        suite_id: suite.id,
        request_key: crypto.randomUUID(),
        configuration: {
          adapter,
          code_intelligence: ci,
          context_strategy: ci ? "symbols" : "none",
          repetitions,
        },
      });
      await api(`/api/evaluation-runs/${run.id}/start`, {});
      runs.reload();
      setSelected(run.id);
      setDetail(await api<EvaluationRunDetail>(`/api/evaluation-runs/${run.id}`));
    }, t("bench.toast.queued"));
  };
  const inspect = async (id: number) => {
    setSelected(id);
    setDetail(await api<EvaluationRunDetail>(`/api/evaluation-runs/${id}`));
  };
  if (suites.error || runs.error)
    return (
      <ErrorBox
        error={suites.error ?? runs.error ?? t("common.none")}
        onRetry={() => {
          suites.reload();
          runs.reload();
        }}
      />
    );
  if (!suites.data || !runs.data) return <Loading />;
  return (
    <section className="card ins-bench">
      <div className="card-head">
        <h4>{t("bench.title")}</h4>
        <span className="sub">{t("bench.subtitle")}</span>
      </div>
      <p className="muted small">{t("bench.lead")}</p>
      <div className="toolbar">
        <button
          className="ghost sm"
          disabled={!runs.data.enabled}
          onClick={() =>
            act(async () => {
              await api("/api/benchmark-suites/publish", {});
              suites.reload();
            }, t("bench.toast.published"))
          }
        >
          {t("bench.publishBundled")}
        </button>
        <button
          className="ghost sm"
          onClick={() => {
            runs.reload();
            if (selected) void inspect(selected);
          }}
        >
          {t("repo.ci.refresh")}
        </button>
        {!runs.data.enabled && <span className="muted small">{t("bench.disabledLocally")}</span>}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("bench.col.suite")}</th>
              <th>{t("bench.col.version")}</th>
              <th>{t("bench.col.cases")}</th>
              <th>{t("bench.col.categories")}</th>
            </tr>
          </thead>
          <tbody>
            {suites.data.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.version}</td>
                <td>{s.cases}</td>
                <td>{s.categories.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ins-bench-form">
        <label>
          {t("bench.adapter")}{" "}
          <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            <option value="reference">{t("bench.adapter.reference")}</option>
            <option value="baseline">{t("bench.adapter.baseline")}</option>
            <option value="agent_fixture">{t("bench.adapter.agent_fixture")}</option>
          </select>
        </label>
        <label className="ins-bench-toggle">
          <input type="checkbox" checked={ci} onChange={(e) => setCi(e.target.checked)} />{" "}
          {t("bench.codeIntelligence")}
        </label>
        <label>
          {t("bench.repetitions")}{" "}
          <input
            type="number"
            min={1}
            max={3}
            value={repetitions}
            onChange={(e) => setRepetitions(Number(e.target.value))}
          />
        </label>
        <button disabled={!runs.data.enabled || !suites.data.length} onClick={create}>
          {t("bench.runSafe")}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("bench.col.run")}</th>
              <th>{t("bench.col.status")}</th>
              <th>{t("bench.col.configuration")}</th>
              <th>{t("bench.col.progress")}</th>
              <th>{t("bench.col.success")}</th>
              <th>{t("bench.col.score")}</th>
            </tr>
          </thead>
          <tbody>
            {!runs.data.runs?.length ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="No benchmark evaluations yet" />
                </td>
              </tr>
            ) : (
              runs.data.runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button className="ghost sm" onClick={() => inspect(r.id)}>
                      #{r.id}
                    </button>
                  </td>
                  <td>{statusText(r.status) || r.status}</td>
                  <td>
                    {r.configuration.adapter} · P1{" "}
                    {r.configuration.code_intelligence ? "ON" : "OFF"} ·{" "}
                    {r.configuration.prompt_version}
                  </td>
                  <td>
                    {r.finished}/{r.tasks}
                  </td>
                  <td>
                    {r.successes}/{r.finished}
                  </td>
                  <td>{number(r.average_score)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="ins-bench-form ins-bench-compare">
        <label>
          {t("bench.baseline")}{" "}
          <select value={baseline} onChange={(e) => setBaseline(e.target.value)}>
            <option value="">{t("bench.chooseRun")}</option>
            {runs.data.runs.map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("bench.candidate")}{" "}
          <select value={candidate} onChange={(e) => setCandidate(e.target.value)}>
            <option value="">{t("bench.chooseRun")}</option>
            {runs.data.runs.map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!baseline || !candidate || baseline === candidate}
          onClick={() =>
            act(async () => {
              const c = await api<{ id: number }>("/api/evaluation-comparisons", {
                baseline_id: Number(baseline),
                candidate_id: Number(candidate),
              });
              setComparison(await api<EvaluationComparison>(`/api/evaluation-comparisons/${c.id}`));
            }, t("bench.toast.compared"))
          }
        >
          {t("bench.compareResults")}
        </button>
      </div>
      {comparison && (
        <>
          <h4>{comparison.report.verdict}</h4>
          <p className="muted small">{comparison.report.sample_note}</p>
          {comparison.report.warnings.map((w: string) => (
            <p key={w}>{w}</p>
          ))}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("bench.col.taskRepetition")}</th>
                  <th>{t("bench.baseline")}</th>
                  <th>{t("bench.candidate")}</th>
                  <th>{t("bench.col.scoreDelta")}</th>
                  <th>{t("bench.col.durationDelta")}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.report.pairs.map((p) => (
                  <tr key={`${p.task}-${p.repetition}`}>
                    <td>
                      {p.task} / {p.repetition}
                    </td>
                    <td>
                      {p.baseline?.status
                        ? statusText(p.baseline.status) || p.baseline.status
                        : t("common.none")}
                    </td>
                    <td>{statusText(p.candidate.status) || p.candidate.status}</td>
                    <td>
                      {p.baseline
                        ? number(
                            Number(p.candidate.quality_score) - Number(p.baseline.quality_score),
                          )
                        : "—"}
                    </td>
                    <td>
                      {p.baseline
                        ? `${number(p.candidate.data.evidence.duration_ms - p.baseline.data.evidence.duration_ms)} ms`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>{t("bench.aggregateEvidence")}</summary>
            <pre>
              {JSON.stringify(
                {
                  baseline: comparison.report.baseline,
                  candidate: comparison.report.candidate,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      {detail && (
        <>
          <div className="toolbar">
            <h4>
              {t("bench.evalDetail", {
                id: detail.id,
                status: statusText(detail.status) || detail.status,
              })}
            </h4>
            <button
              className="ghost sm"
              onClick={() => navigate(`/runs/${detail.workflow_run_id}`)}
            >
              {t("bench.openWorkflow")}
            </button>
            <button
              className="ghost sm"
              onClick={() =>
                act(async () => {
                  await api(`/api/evaluation-runs/${detail.id}/cancel`, {});
                  await inspect(detail.id);
                  runs.reload();
                }, t("bench.toast.canceled"))
              }
            >
              {t("bench.cancel")}
            </button>
          </div>
          <p className="muted small">
            {t("bench.summaryLine", {
              successes: detail.summary.successes,
              graded: detail.summary.graded,
              median: number(detail.summary.median_duration_ms),
              p95: number(detail.summary.p95_duration_ms),
              cost: number(detail.summary.cost_per_success, 4),
            })}
          </p>
          {detail.cases.map((c) => (
            <details key={`${c.task_id}-${c.repetition}`}>
              <summary>
                {c.task_id} / {c.repetition} ·{" "}
                {c.status ? statusText(c.status) || c.status : c.step_status} ·{" "}
                {t("cl.score", { n: number(c.quality_score) })}
              </summary>
              <p>{c.definition.description}</p>
              <p className="mono">{t("bench.pinnedCommit", { commit: c.base_commit })}</p>
              <pre>
                {JSON.stringify(
                  {
                    origin: c.origin,
                    expected_behavior: c.definition.expected_behavior,
                    failure_class: c.failure_class,
                    scoring: c.data?.scoring,
                    evidence: c.data?.evidence,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
