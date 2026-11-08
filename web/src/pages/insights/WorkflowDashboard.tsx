import { useI18n } from "../../i18n/index.tsx";
import { BreakdownBars, DataTable, Metric, Notice, Panel, Trend, dateCell, runLink, type Row } from "./shared.tsx";
export function WorkflowDashboard({ data, page, onPage }: { data: Row; page: number; onPage: (n: number) => void }) {
  const { t, status } = useI18n();
  const e = data.evidence ?? {};
  return (
    <>
      <div className="ins-stats">
        <Metric
          label="repositoryAccuracy"
          value={e.repository_accuracy}
          style="pct"
          hint={t("an.labeled", { n: e.labeled_repositories ?? 0 })}
        />
        <Metric label="switching" value={e.agent_switches} />
        <Metric label="missing" value={e.missing_context} hint={t("an.contextHint")} />
      </div>
      <div className="ins-grid">
        <Panel title={t("an.throughput")}>
          <Trend
            timezone={data.filters?.timezone}
            rows={data.trend ?? []}
            field="completed_runs"
            label={t("an.throughput")}
          />
        </Panel>
        <Panel title={t("an.verificationTrend")}>
          <Trend
            timezone={data.filters?.timezone}
            rows={data.verification_trend ?? []}
            field="failures"
            label={t("an.verificationTrend")}
          />
        </Panel>
      </div>
      <Panel title={t("an.workflowRuns")}>
        <DataTable
          rows={data.workflows ?? []}
          total={e.workflows}
          page={page}
          onPage={onPage}
          columns={[
            { key: "workflow", label: "workflow" },
            { key: "runs", label: "runs", style: "number" },
            { key: "completed_runs", label: "completed", style: "number" },
            { key: "verified_runs", label: "verification", style: "number" },
            { key: "workflow_ms", label: "wall", style: "ms" },
          ]}
        />
      </Panel>
      <Panel title={t("an.slowSteps")} hint={t("an.contextHint")}>
        <Notice>{t("an.contextHint")}</Notice>
        <DataTable
          rows={data.steps ?? []}
          total={e.step_groups}
          page={page}
          onPage={onPage}
          columns={[
            { key: "workflow", label: "workflow" },
            { key: "step_key", label: "run" },
            { key: "attempts", label: "attempts", style: "number" },
            { key: "execution_ms", label: "execution", style: "ms" },
            { key: "retries", label: "retry", style: "number" },
            { key: "blocked", label: "blocked", style: "number" },
            { key: "context_preparation_ms", label: "context", style: "ms" },
            { key: "approval_wait_ms", label: "approval", style: "ms" },
          ]}
        />
      </Panel>
      <div className="ins-grid">
        <Panel title={t("an.retryHotspots")}>
          <BreakdownBars rows={data.hotspots?.retries ?? []} field="retries" />
        </Panel>
        <Panel title={t("an.blockedHotspots")}>
          <BreakdownBars rows={data.hotspots?.blocked ?? []} field="blocked" />
        </Panel>
        <Panel title={t("an.approval")}>
          <DataTable
            rows={data.hotspots?.approvals ?? []}
            columns={[
              { key: "dimension", label: "run" },
              { key: "approval_ms", label: "approval", style: "ms" },
            ]}
          />
        </Panel>
      </div>
      <Panel title={t("an.runDetails")}>
        <DataTable
          rows={data.details ?? []}
          total={e.runs}
          page={page}
          onPage={onPage}
          columns={[
            { key: "run_id", label: "run", render: runLink },
            { key: "workflow", label: "workflow" },
            { key: "status", label: "status", render: (r) => status(r.status) },
            {
              key: "verified",
              label: "verification",
              render: (r) => (r.verified == null ? "—" : t(r.verified ? "an.passed" : "an.notPassed")),
            },
            { key: "created_at", label: "firstSeen", render: (r) => dateCell(r.created_at) },
          ]}
        />
      </Panel>
    </>
  );
}
