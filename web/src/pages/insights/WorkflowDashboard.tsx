import { useState } from "react";
import { useI18n } from "../../i18n/index.tsx";
import { Segmented, Tabs } from "../../ui.tsx";
import {
  BreakdownBars,
  DataTable,
  Metric,
  Panel,
  Trend,
  dateCell,
  fmt,
  number,
  runLink,
  type Row,
} from "../analytics/shared.tsx";

export type WorkflowView = "overview" | "workflows" | "bottlenecks" | "details";
type Hotspot = "retries" | "blocked" | "approvals";
type Chart = "completed_runs" | "failures";

export function WorkflowDashboard({
  data,
  page,
  onPage,
  view,
  onView,
  onSelectWorkflow,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
  view: WorkflowView;
  onView: (view: WorkflowView) => void;
  onSelectWorkflow: (workflow: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="an-subtabs">
        <Tabs<WorkflowView>
          value={view}
          onChange={onView}
          tabs={[
            ["overview", t("an.wfOverview")],
            ["workflows", t("an.wfSectionWorkflows")],
            ["bottlenecks", t("an.wfBottlenecks")],
            ["details", t("an.wfDetails")],
          ]}
        />
      </div>
      {view === "overview" && (
        <Overview data={data} onView={onView} onSelectWorkflow={onSelectWorkflow} />
      )}
      {view === "workflows" && (
        <WorkflowTable data={data} page={page} onPage={onPage} onSelectWorkflow={onSelectWorkflow} />
      )}
      {view === "bottlenecks" && (
        <Bottlenecks data={data} page={page} onPage={onPage} onSelectWorkflow={onSelectWorkflow} />
      )}
      {view === "details" && <RunDetails data={data} page={page} onPage={onPage} />}
    </>
  );
}

function Overview({
  data,
  onView,
  onSelectWorkflow,
}: {
  data: Row;
  onView: (view: WorkflowView) => void;
  onSelectWorkflow: (workflow: string) => void;
}) {
  const { t } = useI18n();
  const [chart, setChart] = useState<Chart>("completed_runs");
  const e = data.evidence ?? {};
  const failures = (data.verification_trend ?? []).reduce(
    (sum: number, row: Row) => sum + Number(row.failures ?? 0),
    0,
  );
  const slowest = slowestWorkflow(data.workflows ?? [], Number(e.workflows ?? 0));
  const slowStep = (data.steps ?? []).find((row: Row) => number(row.execution_ms) != null) as
    | Row
    | undefined;
  const retry = data.hotspots?.retries?.[0] as Row | undefined;
  const blocked = data.hotspots?.blocked?.[0] as Row | undefined;
  const notes = [
    failures > 0
      ? {
          key: "verify",
          title: t("an.verificationFailures"),
          detail: fmt(failures),
          tone: "bad" as const,
          onClick: () => setChart("failures"),
        }
      : null,
    retry?.retries
      ? {
          key: "retry",
          title: t("an.mostRetries"),
          detail: `${retry.dimension} · ${fmt(retry.retries)}`,
          tone: "bad" as const,
          onClick: () => onView("bottlenecks"),
        }
      : null,
    slowStep
      ? {
          key: "step",
          title: t("an.slowestStep"),
          detail: `${slowStep.workflow} / ${slowStep.step_key} · ${fmt(slowStep.execution_ms, "ms")}`,
          tone: "" as const,
          onClick: () => onView("bottlenecks"),
        }
      : null,
    slowest
      ? {
          key: "workflow",
          title: t(slowest.partial ? "an.slowestBusyWorkflow" : "an.slowestWorkflow"),
          detail: `${slowest.row.workflow} · ${fmt(slowest.row.workflow_ms, "ms")}`,
          tone: "" as const,
          onClick: () => onSelectWorkflow(String(slowest.row.workflow)),
        }
      : null,
    blocked?.blocked
      ? {
          key: "blocked",
          title: t("an.mostBlocked"),
          detail: `${blocked.dimension} · ${fmt(blocked.blocked)}`,
          tone: "" as const,
          onClick: () => onView("bottlenecks"),
        }
      : null,
  ].filter((item) => item != null).slice(0, 4);
  return (
    <>
      <div className="ins-stats an-kpis">
        <Metric label="runs" value={e.runs} />
        <Metric
          label="repositoryAccuracy"
          value={e.repository_accuracy}
          style="pct"
          hint={t("an.labeled", { n: e.labeled_repositories ?? 0 })}
        />
        <Metric label="switching" value={e.agent_switches} tone={Number(e.agent_switches) > 0 ? "wait" : "brand"} />
        <Metric label="missing" value={e.missing_context} tone={Number(e.missing_context) > 0 ? "err" : "ok"} hint={t("an.contextHint")} />
      </div>
      <div className="an-overview">
        <div className="an-overview-chart">
          <Panel title={t(chart === "failures" ? "an.verificationTrend" : "an.throughput")}>
          <Segmented<Chart>
            label={t("an.throughput")}
            value={chart}
            onChange={setChart}
            options={[
              ["completed_runs", t("an.showThroughput")],
              ["failures", t("an.showFailures")],
            ]}
          />
          <Trend
            timezone={data.filters?.timezone}
            rows={chart === "failures" ? (data.verification_trend ?? []) : (data.trend ?? [])}
            field={chart}
            label={t(chart === "failures" ? "an.verificationTrend" : "an.throughput")}
          />
        </Panel>
        </div>
        <div className="an-overview-attn">
        <Panel title={t("an.attention")}>
          {notes.length ? (
            <div className="an-attn-list">
              {notes.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`an-attn${item.tone ? ` ${item.tone}` : ""}`}
                  onClick={item.onClick}
                >
                  <span>{item.title}</span>
                  <strong>{item.detail}</strong>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">{t("an.noAttention")}</p>
          )}
        </Panel>
        </div>
      </div>
    </>
  );
}

function WorkflowTable({
  data,
  page,
  onPage,
  onSelectWorkflow,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
  onSelectWorkflow: (workflow: string) => void;
}) {
  const { t } = useI18n();
  const rows = data.workflows ?? [];
  const known = Number(data.evidence?.workflows ?? rows.length);
  const slowest = slowestWorkflow(rows, known);
  return (
    <Panel title={t("an.workflowRuns")}>
      <DataTable
        rows={rows}
        total={known}
        page={page}
        onPage={onPage}
        columns={[
          {
            key: "workflow",
            label: "workflow",
            render: (r) => (
              <button type="button" className="an-drill" onClick={() => onSelectWorkflow(String(r.workflow))}>
                {String(r.workflow)}
                {slowest && !slowest.partial && r.workflow === slowest.row.workflow ? (
                  <em className="an-slow-badge">{t("an.slowBadge")}</em>
                ) : null}
              </button>
            ),
          },
          { key: "runs", label: "runs", style: "number" },
          { key: "completed_runs", label: "completed", style: "number" },
          { key: "verified_runs", label: "verification", style: "number" },
          { key: "workflow_ms", label: "wall", style: "ms" },
        ]}
      />
    </Panel>
  );
}

function Bottlenecks({
  data,
  page,
  onPage,
  onSelectWorkflow,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
  onSelectWorkflow: (workflow: string) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Hotspot>("retries");
  const hotspotRows =
    mode === "retries"
      ? (data.hotspots?.retries ?? [])
      : mode === "blocked"
        ? (data.hotspots?.blocked ?? [])
        : (data.hotspots?.approvals ?? []);
  return (
    <>
      <div className="ins-stats an-kpis an-kpis-2">
        <Metric label="switching" value={data.evidence?.agent_switches} tone="wait" />
        <Metric label="missing" value={data.evidence?.missing_context} hint={t("an.contextHint")} />
      </div>
      <Panel title={t("an.attention")}>
        <Segmented<Hotspot>
          label={t("an.attention")}
          value={mode}
          onChange={setMode}
          options={[
            ["retries", t("an.hotspotRetries")],
            ["blocked", t("an.hotspotBlocked")],
            ["approvals", t("an.hotspotApprovals")],
          ]}
        />
        {mode === "approvals" ? (
          <DataTable
            rows={hotspotRows}
            columns={[
              { key: "dimension", label: "run" },
              { key: "approval_ms", label: "approval", style: "ms" },
            ]}
          />
        ) : (
          <BreakdownBars rows={hotspotRows} field={mode} />
        )}
      </Panel>
      <Panel title={t("an.slowSteps")} hint={t("an.contextHint")}>
        <DataTable
          rows={data.steps ?? []}
          total={data.evidence?.step_groups}
          page={page}
          onPage={onPage}
          columns={[
            {
              key: "workflow",
              label: "workflow",
              render: (r) => (
                <button type="button" className="an-drill" onClick={() => onSelectWorkflow(String(r.workflow))}>
                  {String(r.workflow)}
                </button>
              ),
            },
            { key: "step_key", label: "run" },
            { key: "attempts", label: "attempts", style: "number" },
            { key: "execution_ms", label: "execution", style: "ms" },
            { key: "retries", label: "retry", style: "number" },
            { key: "blocked", label: "blocked", style: "number", responsivePriority: "secondary" },
            { key: "context_preparation_ms", label: "context", style: "ms", responsivePriority: "secondary" },
            { key: "approval_wait_ms", label: "approval", style: "ms", responsivePriority: "secondary" },
          ]}
        />
      </Panel>
    </>
  );
}

function RunDetails({
  data,
  page,
  onPage,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
}) {
  const { t, status } = useI18n();
  return (
    <Panel title={t("an.runDetails")}>
      <DataTable
        rows={data.details ?? []}
        total={data.evidence?.runs}
        page={page}
        onPage={onPage}
        columns={[
          { key: "run_id", label: "run", render: runLink },
          { key: "workflow", label: "workflow" },
          { key: "status", label: "status", render: (r) => status(r.status) },
          {
            key: "verified",
            label: "verification",
            responsivePriority: "secondary",
            render: (r) => (r.verified == null ? "—" : t(r.verified ? "an.passed" : "an.notPassed")),
          },
          {
            key: "created_at",
            label: "firstSeen",
            responsivePriority: "secondary",
            render: (r) => dateCell(r.created_at),
          },
        ]}
      />
    </Panel>
  );
}

function slowestWorkflow(rows: Row[], total: number) {
  const ranked = rows.filter((row) => number(row.workflow_ms) != null);
  if (!ranked.length) return null;
  const row = ranked.reduce((best, item) =>
    Number(item.workflow_ms) > Number(best.workflow_ms) ? item : best,
  );
  return { row, partial: total > rows.length };
}
