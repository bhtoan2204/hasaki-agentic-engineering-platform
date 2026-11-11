/**
 * Evaluation summary over eval_results rows (pure). Correctness comes from hidden acceptance tests; the independent
 * verifier's verdict is scored against it:
 *   PASS  & correct   → true pass         FAIL/BLOCKED & !correct → true catch
 *   PASS  & !correct  → false pass (missed defect — the costly error)
 *   FAIL  & correct   → false alarm (blocked/repaired good work)
 * Verdict-level only: finding-level precision would need labelled findings, which the fixtures do not provide.
 */
export interface EvalRow {
  candidate: string;
  profile: string | null;
  status: string;
  correct: boolean | null;
  regression: boolean | null;
  verdict: string | null;
  repairs: number;
  human_gates: number;
  wall_s: number | null;
  cost_usd: number | string | null;
  tokens: number | string | null;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avg = (xs: number[]) =>
  xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null;

export function summarizeEval(rows: EvalRow[]) {
  const groups = new Map<string, EvalRow[]>();
  for (const r of rows) {
    const k = `${r.candidate}${r.profile ? `/${r.profile}` : ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([group, rs]) => {
    const graded = rs.filter((r) => r.correct !== null);
    const judged = graded.filter((r) => r.verdict);
    const truePass = judged.filter((r) => r.verdict === "PASS" && r.correct).length;
    const falsePass = judged.filter((r) => r.verdict === "PASS" && !r.correct).length;
    const trueCatch = judged.filter((r) => r.verdict !== "PASS" && !r.correct).length;
    const falseAlarm = judged.filter((r) => r.verdict !== "PASS" && r.correct).length;
    const repaired = rs.filter((r) => r.repairs > 0);
    const regChecked = rs.filter((r) => r.regression !== null);
    return {
      group,
      runs: rs.length,
      completed: rs.filter((r) => r.status === "COMPLETED").length,
      success_rate_pct: pct(graded.filter((r) => r.correct).length, graded.length),
      graded: graded.length,
      regression_rate_pct: pct(regChecked.filter((r) => r.regression).length, regChecked.length),
      verifier: judged.length
        ? {
            judged: judged.length,
            accuracy_pct: pct(truePass + trueCatch, judged.length),
            false_pass: falsePass,
            false_alarm: falseAlarm,
            true_pass: truePass,
            true_catch: trueCatch,
          }
        : null,
      repair_success_pct: pct(
        repaired.filter((r) => r.correct).length,
        repaired.filter((r) => r.correct !== null).length,
      ),
      human_intervention_pct: pct(rs.filter((r) => r.human_gates > 0).length, rs.length),
      avg_wall_s: avg(rs.map((r) => r.wall_s).filter((x): x is number => x != null)),
      avg_cost_usd: avg(
        rs.map((r) => Number(r.cost_usd)).filter((x) => Number.isFinite(x) && x > 0),
      ),
      avg_tokens: avg(rs.map((r) => Number(r.tokens)).filter((x) => Number.isFinite(x) && x > 0)),
    };
  });
}
