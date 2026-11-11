import { useState } from "react";
import { api, useApi } from "../api.ts";
import { act, ErrorBox, Loading, navigate } from "../ui.tsx";

const number = (v: any, digits = 1) => (v == null ? "Unknown" : Number(v).toFixed(digits));
export function EvaluationBenchmarks() {
  const suites = useApi<any[]>("/api/benchmark-suites");
  const runs = useApi<any>("/api/evaluation-runs");
  const [adapter, setAdapter] = useState("reference"),
    [ci, setCi] = useState(true),
    [repetitions, setRepetitions] = useState(2);
  const [selected, setSelected] = useState<number | null>(null),
    [baseline, setBaseline] = useState(""),
    [candidate, setCandidate] = useState(""),
    [comparison, setComparison] = useState<any>(null),
    [detail, setDetail] = useState<any>(null);
  const create = async () => {
    const suite = suites.data?.[0];
    if (!suite) return;
    await act(async () => {
      const run: any = await api("/api/evaluation-runs", {
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
      setDetail(await api(`/api/evaluation-runs/${run.id}`));
    }, "Fixture evaluation queued");
  };
  const inspect = async (id: number) => {
    setSelected(id);
    setDetail(await api(`/api/evaluation-runs/${id}`));
  };
  if (suites.error || runs.error)
    return (
      <ErrorBox
        error={suites.error ?? runs.error ?? "Unknown error"}
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
        <h4>Versioned benchmark evaluations</h4>
        <span className="sub">Synthetic fixtures · no live model execution</span>
      </div>
      <p className="muted small">
        Hard gates precede quality scores. Token usage is unknown unless a real provider reports it.
        Fixture controls do not measure model quality.
      </p>
      <div className="toolbar">
        <button
          className="ghost sm"
          disabled={!runs.data.enabled}
          onClick={() =>
            act(async () => {
              await api("/api/benchmark-suites/publish", {});
              suites.reload();
            }, "Suite published")
          }
        >
          Publish bundled suite (admin)
        </button>
        <button
          className="ghost sm"
          onClick={() => {
            runs.reload();
            if (selected) void inspect(selected);
          }}
        >
          Refresh
        </button>
        {!runs.data.enabled && (
          <span className="muted small">Disabled locally: evaluation.enabled</span>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Suite</th>
              <th>Version</th>
              <th>Cases</th>
              <th>Categories</th>
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
          Adapter{" "}
          <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            <option value="reference">Reference fixture control</option>
            <option value="baseline">Unchanged fixture control</option>
            <option value="agent_fixture">Actual executor / CLI fixture</option>
          </select>
        </label>
        <label className="ins-bench-toggle">
          <input type="checkbox" checked={ci} onChange={(e) => setCi(e.target.checked)} /> P1 code
          intelligence
        </label>
        <label>
          Repetitions{" "}
          <input
            type="number"
            min={1}
            max={3}
            value={repetitions}
            onChange={(e) => setRepetitions(Number(e.target.value))}
          />
        </label>
        <button disabled={!runs.data.enabled || !suites.data.length} onClick={create}>
          Run safe fixtures
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Configuration</th>
              <th>Progress</th>
              <th>Success</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((r: any) => (
              <tr key={r.id}>
                <td>
                  <button className="ghost sm" onClick={() => inspect(r.id)}>
                    #{r.id}
                  </button>
                </td>
                <td>{r.status}</td>
                <td>
                  {r.configuration.adapter} · P1 {r.configuration.code_intelligence ? "ON" : "OFF"}{" "}
                  · {r.configuration.prompt_version}
                </td>
                <td>
                  {r.finished}/{r.tasks}
                </td>
                <td>
                  {r.successes}/{r.finished}
                </td>
                <td>{number(r.average_score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ins-bench-form ins-bench-compare">
        <label>
          Baseline{" "}
          <select value={baseline} onChange={(e) => setBaseline(e.target.value)}>
            <option value="">Choose run</option>
            {runs.data.runs.map((r: any) => (
              <option key={r.id} value={r.id}>
                #{r.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Candidate{" "}
          <select value={candidate} onChange={(e) => setCandidate(e.target.value)}>
            <option value="">Choose run</option>
            {runs.data.runs.map((r: any) => (
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
              const c: any = await api("/api/evaluation-comparisons", {
                baseline_id: Number(baseline),
                candidate_id: Number(candidate),
              });
              setComparison(await api(`/api/evaluation-comparisons/${c.id}`));
            }, "Comparison loaded")
          }
        >
          Compare paired results
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
                  <th>Task / repetition</th>
                  <th>Baseline</th>
                  <th>Candidate</th>
                  <th>Score Δ</th>
                  <th>Duration Δ</th>
                </tr>
              </thead>
              <tbody>
                {comparison.report.pairs.map((p: any) => (
                  <tr key={`${p.task}-${p.repetition}`}>
                    <td>
                      {p.task} / {p.repetition}
                    </td>
                    <td>{p.baseline?.status ?? "Missing"}</td>
                    <td>{p.candidate.status}</td>
                    <td>
                      {p.baseline
                        ? number(
                            Number(p.candidate.quality_score) - Number(p.baseline.quality_score),
                          )
                        : "Unknown"}
                    </td>
                    <td>
                      {p.baseline
                        ? `${number(p.candidate.data.evidence.duration_ms - p.baseline.data.evidence.duration_ms)} ms`
                        : "Unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Aggregate evidence, costs and variability</summary>
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
              Evaluation #{detail.id} · {detail.status}
            </h4>
            <button
              className="ghost sm"
              onClick={() => navigate(`/runs/${detail.workflow_run_id}`)}
            >
              Open existing workflow / questions / artifacts
            </button>
            <button
              className="ghost sm"
              onClick={() =>
                act(async () => {
                  await api(`/api/evaluation-runs/${detail.id}/cancel`, {});
                  await inspect(detail.id);
                  runs.reload();
                }, "Evaluation canceled")
              }
            >
              Cancel
            </button>
          </div>
          <p className="muted small">
            Success {detail.summary.successes}/{detail.summary.graded} · Median{" "}
            {number(detail.summary.median_duration_ms)} ms · p95{" "}
            {number(detail.summary.p95_duration_ms)} ms · Cost per success{" "}
            {number(detail.summary.cost_per_success, 4)}
          </p>
          {detail.cases.map((c: any) => (
            <details key={`${c.task_id}-${c.repetition}`}>
              <summary>
                {c.task_id} / {c.repetition} · {c.status ?? c.step_status} · score{" "}
                {number(c.quality_score)}
              </summary>
              <p>{c.definition.description}</p>
              <p className="mono">Pinned commit: {c.base_commit}</p>
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
