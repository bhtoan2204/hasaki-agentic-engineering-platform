import { useMemo, useState } from "react";
import {
  Activity,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  GitBranch,
  Hourglass,
  Play,
  PlayCircle,
  Workflow,
} from "lucide-react";
import { useApi, useLive, STATUS_COLORS } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import {
  ago,
  Badge,
  EmptyState,
  ErrorBox,
  navigate,
  PageHeader,
  SearchInput,
  Segmented,
  SkeletonRows,
  StatCard,
  dur,
} from "../ui.tsx";
import "./Runs.css";

const DONE_STEP = new Set(["COMPLETED", "SKIPPED"]);

/** Segmented progress bar: one segment per step, coloured by its status (pending steps stay on the track). */
function StepProgress({
  steps,
}: {
  steps: Array<{ key: string; status: string }> | null;
}) {
  const { status, t } = useI18n();
  const list = steps ?? [];
  if (!list.length) return <span className="muted small">—</span>;
  const done = list.filter((s) => DONE_STEP.has(s.status)).length;
  return (
    <div className="runs-progress">
      <div
        className="runs-bar"
        role="img"
        aria-label={t("runs.progressAria", { done, total: list.length })}
      >
        {list.map((s) => (
          <span
            key={s.key}
            title={`${s.key}: ${status(s.status)}`}
            style={{
              background:
                s.status === "PENDING" ? undefined : STATUS_COLORS[s.status],
            }}
          />
        ))}
      </div>
      <span className="runs-progress-n">
        {done}/{list.length}
      </span>
    </div>
  );
}

const runDuration = (r: any) =>
  r.finished_at && r.created_at
    ? dur(new Date(r.finished_at).getTime() - new Date(r.created_at).getTime())
    : "";

export function RunsTable({ runs }: { runs: any[] }) {
  const { t } = useI18n();
  if (!runs.length)
    return (
      <EmptyState icon={PlayCircle} title={t("runs.emptyTitle")}>
        {t("runs.emptyBody")}
      </EmptyState>
    );
  return (
    <div className="table-wrap runs-table">
      <table>
        <thead>
          <tr>
            <th>{t("runs.col.run")}</th>
            <th>{t("runs.col.workflow")}</th>
            <th>{t("runs.col.status")}</th>
            <th>{t("runs.col.progress")}</th>
            <th>{t("runs.col.waiting")}</th>
            <th>{t("runs.col.duration")}</th>
            <th>{t("runs.col.updated")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              className="click"
              tabIndex={0}
              onClick={() => navigate(`/runs/${r.id}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/runs/${r.id}`)}
            >
              <td className="runs-main">
                <div className="runs-title">
                  <span className="runs-id">#{r.id}</span>
                  <span className="runs-name">{r.title}</span>
                </div>
                {(r.branch || r.work_item_code) && (
                  <div className="runs-meta">
                    {r.work_item_code && (
                      <span className="mono">{r.work_item_code}</span>
                    )}
                    {r.branch && (
                      <span className="runs-branch mono" title={r.branch}>
                        <GitBranch size={12} strokeWidth={2} />
                        {r.branch}
                      </span>
                    )}
                  </div>
                )}
              </td>
              <td>
                <span className="runs-wf">
                  <Workflow size={13} strokeWidth={1.9} />
                  {r.definition_key}
                </span>{" "}
                <span className="muted small">v{r.definition_version}</span>
              </td>
              <td>
                <Badge s={r.status} label />
              </td>
              <td>
                <StepProgress steps={r.steps} />
              </td>
              <td>
                {r.open_questions > 0 ? (
                  <Badge s="WAITING_INPUT">
                    <CircleHelp size={12} strokeWidth={2.2} />{" "}
                    {t("runs.questions", { n: r.open_questions })}
                  </Badge>
                ) : (
                  <span className="muted small">—</span>
                )}
              </td>
              <td className="muted small">{runDuration(r) || "—"}</td>
              <td className="muted small runs-ago" title={r.updated_at}>
                <Clock size={12} strokeWidth={2} />
                {t("common.ago", { when: ago(r.updated_at) })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_FILTERS = [
  "RUNNING",
  "WAITING",
  "PAUSED",
  "PENDING",
  "FAILED",
  "COMPLETED",
  "CANCELED",
];

export function RunsPage() {
  const { t, status: statusName } = useI18n();
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useApi<any[]>(
    `/api/runs${status ? `?status=${status}` : ""}`,
    [status],
  );
  // Stat cards always describe the unfiltered list; when a status filter is active fetch it separately.
  const { data: allRuns, reload: reloadAll } = useApi<any[]>(
    status ? "/api/runs" : null,
    [status],
  );
  const { data: wfs } = useApi<any[]>("/api/workflows");
  useLive(
    null,
    (p) => (!p || p.kind === "status") && (reload(), status && reloadAll()),
  );
  const [wf, setWf] = useState("");
  const [q, setQ] = useState("");

  const base = status ? allRuns : data;
  const counts = useMemo(() => {
    const c = { running: 0, waiting: 0, paused: 0, completed: 0, failed: 0 };
    for (const r of base ?? []) {
      if (r.status === "RUNNING" || r.status === "RETRYING") c.running++;
      else if (String(r.status).startsWith("WAITING")) c.waiting++;
      else if (r.status === "PAUSED") c.paused++;
      else if (r.status === "COMPLETED") c.completed++;
      else if (r.status === "FAILED" || r.status === "STALE") c.failed++;
    }
    return c;
  }, [base]);
  const openQs = (base ?? []).reduce((n, r) => n + (r.open_questions ?? 0), 0);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return data ?? [];
    return (data ?? []).filter((r) =>
      [r.id, r.title, r.branch, r.definition_key, r.work_item_code].some(
        (v) => v != null && String(v).toLowerCase().includes(s),
      ),
    );
  }, [data, q]);

  const toggle = (s: string) => setStatus(status === s ? "" : s);
  return (
    <div className="runs-page">
      <PageHeader
        icon={Activity}
        title={t("runs.title")}
        subtitle={t("runs.subtitle")}
        crumbs={[[t("nav.overview"), "#/overview"], [t("runs.title")]]}
        actions={
          <div className="runs-launch">
            <select
              aria-label={t("runs.pickWf")}
              value={wf}
              onChange={(e) => setWf(e.target.value)}
            >
              <option value="">{t("runs.pickWfPh")}</option>
              {(wfs ?? [])
                .filter((w) => w.latest_version > 0)
                .map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.name} (v{w.latest_version})
                  </option>
                ))}
            </select>
            <button disabled={!wf} onClick={() => navigate(`/workflows/${wf}`)}>
              <Play size={15} strokeWidth={2} />
              {t("runs.openRun")}
            </button>
          </div>
        }
      />

      <div className="grid4 runs-stats">
        <StatCard
          icon={Activity}
          tone="run"
          label={t("status.RUNNING")}
          value={base ? counts.running : "—"}
          hint={base ? t("runs.runningHint", { n: base.length }) : undefined}
          onClick={() => toggle("RUNNING")}
        />
        <StatCard
          icon={Hourglass}
          tone="wait"
          label={t("ov.waitingYou")}
          value={base ? counts.waiting : "—"}
          hint={
            base
              ? t("runs.waitHint", { q: openQs, p: counts.paused })
              : undefined
          }
          onClick={() => toggle("WAITING")}
        />
        <StatCard
          icon={CircleCheck}
          tone="ok"
          label={t("status.COMPLETED")}
          value={base ? counts.completed : "—"}
          onClick={() => toggle("COMPLETED")}
        />
        <StatCard
          icon={CircleX}
          tone="err"
          label={t("status.FAILED")}
          value={base ? counts.failed : "—"}
          onClick={() => toggle("FAILED")}
        />
      </div>

      <div className="runs-toolbar">
        <div className="runs-seg">
          <Segmented<string>
            label={t("runs.filter")}
            value={status}
            onChange={setStatus}
            options={[
              ["", t("common.all")],
              ...STATUS_FILTERS.map(
                (s) => [s, statusName(s)] as [string, string],
              ),
            ]}
          />
        </div>
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder={t("runs.search")}
          width="min(300px, 100%)"
        />
      </div>

      {loading && !data ? (
        <SkeletonRows rows={6} />
      ) : error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : q && !shown.length && data?.length ? (
        <EmptyState icon={PlayCircle} title={t("runs.noMatch")}>
          {t("runs.noMatchBody")}
        </EmptyState>
      ) : (
        <RunsTable runs={shown} />
      )}
      <div className="muted small runs-foot">
        {t("runs.orPrefix")} <a href="#/work-items">{t("nav.workItems")}</a>{" "}
        {t("runs.orSuffix")}
      </div>
    </div>
  );
}
