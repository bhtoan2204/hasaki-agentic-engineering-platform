import type { ReactNode } from "react";
import { useI18n } from "../../i18n/index.tsx";
import { EmptyState } from "../../ui.tsx";

type Metric = number | null;
export type EvaluationAggregate = {
  evidence_kind: string;
  successes: number;
  graded: number;
  distinct_tasks: number;
  samples: number;
  verified_success_rate: Metric;
  median_ms: Metric;
  p95_ms: Metric;
  reported_cost_usd: Metric;
  cost_samples: number;
  cost_attempts_known: Metric;
  phase_attempts: Metric;
  cost_per_verified_success: Metric;
  input_tokens: Metric;
  output_tokens: Metric;
  token_samples: number;
  output_token_samples: number;
  cache_read_tokens: Metric;
  cache_creation_tokens: Metric;
  reasoning_tokens: Metric;
  active_execution_ms: Metric;
  queue_ms: Metric;
  human_ms: Metric;
  tool_ms: Metric;
  tool_calls: Metric;
  retries: Metric;
  planned_switches: Metric;
  recovery_handoffs: Metric;
  requirement_coverage: Metric;
  retrieval_accuracy: Metric;
  acceptance_pass_rate: Metric;
  build_success_rate: Metric;
  regression_failures: Metric;
  invalid_modifications: number;
  security_violations: number;
  human_interventions: Metric;
};
export type EvaluationCohortRow = EvaluationAggregate & {
  provider_path: string;
  model_path: string;
  category: string;
  context_variant: string;
  constraints_hash: string | null;
  reported_model_sets: Array<Array<{ provider: string; model: string }>> | null;
};
export type EvaluationDifficultyRow = EvaluationAggregate & { difficulty: string };
export type EvaluationDetailRow = {
  case_run_id: number;
  evaluation_id: number;
  workflow_run_id: number;
  task_id: string;
  repetition: number;
  provider_path: string;
  evidence_kind: string;
  result_status: string | null;
  artifact_id: number | null;
};
export type EvaluationProductionRow = {
  provider: string;
  model: string | null;
  category: string;
  attempts: number;
  verified_coverage: number;
  verified_success_rate: Metric;
  reported_cost_usd: Metric;
  cost_known: number;
};
export type EvaluationAnalytics = {
  comparisons: EvaluationCohortRow[];
  context: EvaluationCohortRow[];
  difficulty: EvaluationDifficultyRow[];
  failures: Array<{ category: string; evidence_kind: string; samples: number }>;
  details: EvaluationDetailRow[];
  production: EvaluationProductionRow[];
  pagination: { page: number; page_size: number; total: number };
};
export type EvaluationColumn<R> = { label: string; value: (row: R) => ReactNode };

export function EvaluationTable<R extends object>({
  rows,
  columns,
}: {
  rows?: Array<R & { case_run_id?: number; id?: number }>;
  columns: Array<EvaluationColumn<R>>;
}) {
  const { t } = useI18n();
  if (!rows?.length)
    return (
      <EmptyState title={t("an.eval.noEvidence")} />
    );
  return (
    <div className="table-wrap">
      <table className="ins-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.case_run_id ?? r.id ?? i}>
              {columns.map((c) => (
                <td key={c.label}>{c.value(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
