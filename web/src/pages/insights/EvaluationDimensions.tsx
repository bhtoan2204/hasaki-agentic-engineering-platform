import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";
import {
  EvaluationTable,
  type EvaluationAnalytics,
  type EvaluationCohortRow,
  type EvaluationColumn,
} from "./EvaluationTable.tsx";
export function EvaluationDimensions({
  data,
  common,
}: {
  data: EvaluationAnalytics;
  common: Array<EvaluationColumn<EvaluationCohortRow>>;
}) {
  const { t } = useI18n();
  return (
    <>
      {" "}
      <Panel
        title={t("an.eval.contextEffectiveness")}
        hint={t("an.eval.contextEffectivenessHint")}
      >
        <EvaluationTable
          rows={data.context}
          columns={[
            ...common.slice(0, 6),
            {
              label: t("an.eval.reqCoverage"),
              value: (r) => fmt(r.requirement_coverage, "pct"),
            },
            {
              label: t("an.eval.retrievalAccuracy"),
              value: (r) => fmt(r.retrieval_accuracy, "pct"),
            },
            {
              label: t("an.eval.toolsRetries"),
              value: (r) => `${fmt(r.tool_calls)} / ${fmt(r.retries)}`,
            },
          ]}
        />
      </Panel>
      <Panel
        title={t("an.eval.taskDifficultyTitle")}
      >
        <EvaluationTable
          rows={data.difficulty}
          columns={[
            { label: t("an.eval.difficulty"), value: (r) => r.difficulty },
            {
              label: t("an.eval.evidence"),
              value: (r) => r.evidence_kind,
            },
            {
              label: t("an.eval.acceptanceTests"),
              value: (r) => fmt(r.acceptance_pass_rate, "pct"),
            },
            {
              label: t("an.eval.buildChecks"),
              value: (r) => fmt(r.build_success_rate, "pct"),
            },
            {
              label: t("an.eval.regressionFailures"),
              value: (r) => fmt(r.regression_failures),
            },
            {
              label: t("an.eval.invalidChangesSecurity"),
              value: (r) => `${fmt(r.invalid_modifications)} / ${fmt(r.security_violations)}`,
            },
            {
              label: t("an.eval.humanInterventions"),
              value: (r) => fmt(r.human_interventions),
            },
          ]}
        />
        <p className="muted small">
          {t("an.eval.unnecessaryModHint")}
        </p>
      </Panel>
      <Panel
        title={t("an.eval.handoffRuntimeTitle")}
      >
        <EvaluationTable
          rows={data.comparisons}
          columns={[
            common[0],
            common[2],
            {
              label: t("an.eval.plannedSwitches"),
              value: (r) => fmt(r.planned_switches),
            },
            {
              label: t("an.eval.recoveryHandoffs"),
              value: (r) => fmt(r.recovery_handoffs),
            },
            {
              label: t("an.eval.providerExecution"),
              value: (r) => fmt(r.active_execution_ms, "ms"),
            },
            {
              label: t("an.eval.queueHumanTool"),
              value: (r) =>
                `${fmt(r.queue_ms, "ms")} / ${fmt(r.human_ms, "ms")} / ${fmt(r.tool_ms, "ms")}`,
            },
            {
              label: t("an.eval.cacheReasoning"),
              value: (r) =>
                `${fmt(r.cache_read_tokens)} / ${fmt(r.cache_creation_tokens)} / ${fmt(r.reasoning_tokens)}`,
            },
          ]}
        />
      </Panel>
    </>
  );
}
