import { useI18n } from "../../i18n/index.tsx";
import {
  BreakdownBars,
  DataTable,
  Metric,
  Notice,
  Panel,
  ratio,
  runLink,
  type Row,
} from "../analytics/shared.tsx";
export function PerformanceDashboard({
  data,
  page,
  onPage,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
}) {
  const { t, status } = useI18n();
  const s = data.summary ?? {};
  return (
    <>
      <Notice>{t("an.timingHint")}</Notice>
      <div className="ins-stats">
        <Metric label="runs" value={s.runs} />
        <Metric label="attempts" value={s.attempts} />
        <Metric
          label="completion"
          value={ratio(s.completed_runs, s.runs)}
          style="pct"
        />
        <Metric
          label="verified"
          value={ratio(s.verified_runs, s.evaluated_runs)}
          style="pct"
          hint={t("an.verifiedHint")}
        />
        <Metric label="verifiedTasks" value={s.verified_tasks} />
        <Metric
          label="retry"
          value={ratio(s.retried_attempts, s.attempts)}
          style="pct"
        />
        <Metric label="executionP50" value={s.execution_p50_ms} style="ms" />
        <Metric label="executionP95" value={s.execution_p95_ms} style="ms" />
        <Metric label="workflowP95" value={s.workflow_p95_ms} style="ms" />
        <Metric label="queue" value={s.queue_ms} style="ms" />
        <Metric label="human" value={s.human_wait_ms} style="ms" />
        <Metric label="tools" value={s.tool_ms} style="ms" />
        <Metric
          label="toolError"
          value={ratio(s.tool_failures, s.tool_calls)}
          style="pct"
        />
      </div>
      <div className="ins-grid">
        <Panel title={t("an.failures")}>
          <BreakdownBars
            rows={data.failures ?? []}
            field="attempts"
            labelKey="category"
          />
        </Panel>
        <Panel title={t("an.coverage")}>
          <DataTable
            rows={[
              ["execution", s.missing_execution],
              ["queue", s.missing_queue],
              ["human", s.missing_human],
              ["tools", s.missing_tools],
            ].map(([label, missing]) => ({ label: t(`an.${label}`), missing }))}
            columns={[
              { key: "label", label: "metric" },
              { key: "missing", label: "missingCount", style: "number" },
            ]}
          />
        </Panel>
      </div>
      <Panel title={t("an.compare")}>
        <DataTable
          rows={data.comparison ?? []}
          total={s.comparison_total}
          page={page}
          onPage={onPage}
          columns={[
            { key: "provider", label: "provider" },
            { key: "model", label: "model" },
            { key: "invocations", label: "invocations", style: "number" },
            { key: "runs", label: "runs", style: "number" },
            { key: "completed_runs", label: "completed", style: "number" },
            { key: "verified_runs", label: "verifiedRuns", style: "number" },
            { key: "execution_p50_ms", label: "executionP50", style: "ms" },
            { key: "execution_p95_ms", label: "executionP95", style: "ms" },
          ]}
        />
      </Panel>
      <Panel title={t("an.attemptDetails")}>
        <DataTable
          rows={data.details ?? []}
          total={s.attempts}
          page={page}
          onPage={onPage}
          columns={[
            { key: "run_id", label: "run", render: runLink },
            { key: "provider", label: "provider" },
            { key: "model", label: "model" },
            { key: "status", label: "status", render: (r) => status(r.status) },
            { key: "provider_execution_ms", label: "execution", style: "ms" },
            { key: "wall_duration_ms", label: "wall", style: "ms" },
            { key: "queue_duration_ms", label: "queue", style: "ms" },
            { key: "human_wait_ms", label: "human", style: "ms" },
            { key: "tool_execution_ms", label: "tools", style: "ms" },
            { key: "normalized_failure_category", label: "failures" },
          ]}
        />
      </Panel>
    </>
  );
}
