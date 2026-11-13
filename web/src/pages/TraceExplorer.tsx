import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  GitBranch,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  Stethoscope,
  Terminal,
  X,
} from "lucide-react";
import "./TraceExplorer.css";
import { api } from "../api.ts";
import { Badge, dur, time } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

interface TraceNode {
  id: string;
  type: "run" | "step" | "attempt" | "tool" | "handoff";
  label: string;
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  ids: {
    runId: number;
    stepId?: number;
    attemptId?: number;
    jobId?: number | null;
    toolUseId?: string;
  };
  attrs: Record<string, unknown>;
  children: TraceNode[];
}

interface LogRow {
  id: number;
  step_id: number | null;
  attempt_id: number | null;
  level: string;
  content: string;
  data: {
    trace?: { event?: string; provider?: string | null; duration_ms?: number | null };
    details?: unknown;
  } | null;
  created_at: string;
}

interface Finding {
  kind: string;
  source: string;
  category: string | null;
  summary: string;
  evidence: string[];
  suggestion: string;
}

const LEVELS = ["", "DEBUG", "INFO", "WARN", "ERROR"];
const LOG_PAGE = 500;
const LOG_BUDGET = 4 * LOG_PAGE;
const REFRESH_MS = 1500;

function flatten(n: TraceNode, depth = 0, out: Array<{ node: TraceNode; depth: number }> = []) {
  out.push({ node: n, depth });
  n.children.forEach((c) => flatten(c, depth + 1, out));
  return out;
}

const startOf = (n: TraceNode) => (n.startedAt ? new Date(n.startedAt).getTime() : null);

/** Logs load LOG_BUDGET rows at a time; "load more" raises the budget instead of paging without bound. */
export function TraceExplorer({ runId, activity }: { runId: number; activity: number }) {
  const { t } = useI18n();
  const [root, setRoot] = useState<TraceNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logPages, setLogPages] = useState<LogRow[][]>([]);
  const [moreLogs, setMoreLogs] = useState(false);
  const [level, setLevel] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const last = useRef(0);
  const requested = useRef(0);
  const applied = useRef(0);
  const epoch = useRef(0);
  const logsBusy = useRef(false);
  const logsAgain = useRef(false);
  const lastLoad = useRef(0);
  const loaded = useRef(0);
  const budget = useRef(LOG_BUDGET);

  useEffect(() => {
    setRoot(null);
    setSelected(null);
    setQuery("");
    setLevel("");
    setToggled(new Set());
    setLoading(true);
    setDiagnosing(false);
    setLogsLoading(false);
    setError(null);
    setLogError(null);
    setLogPages([]);
    setMoreLogs(false);
    loaded.current = 0;
    budget.current = LOG_BUDGET;
    setFindings(null);
    last.current = 0;
    applied.current = ++requested.current;
    epoch.current++;
    logsBusy.current = false;
    logsAgain.current = false;
    lastLoad.current = 0;
  }, [runId]);

  // A slower, older response never replaces a newer one; responses for a previous run are dropped.
  const loadTrace = useCallback(() => {
    const n = ++requested.current;
    setLoading(true);
    api<TraceNode>(`/api/runs/${runId}/trace`)
      .then((r) => {
        if (n <= applied.current) return;
        applied.current = n;
        setRoot(r);
        setError(null);
      })
      .catch((e) => n > applied.current && setError(String(e?.message ?? e)))
      .finally(() => {
        if (n === requested.current) setLoading(false);
      });
  }, [runId]);

  const loadLogs = useCallback(async () => {
    if (logsBusy.current) {
      logsAgain.current = true;
      return;
    }
    logsBusy.current = true;
    setLogsLoading(true);
    const mine = epoch.current;
    try {
      do {
        logsAgain.current = false;
        for (;;) {
          if (loaded.current >= budget.current) {
            setMoreLogs(true);
            break;
          }
          const rows = await api<LogRow[]>(
            `/api/runs/${runId}/logs?after=${last.current}&limit=${LOG_PAGE}`,
          );
          if (mine !== epoch.current) return;
          if (rows.length < LOG_PAGE) setMoreLogs(false);
          if (!rows.length) break;
          last.current = rows[rows.length - 1].id;
          loaded.current += rows.length;
          setLogPages((prev) => [...prev, rows]);
          if (rows.length < LOG_PAGE) break;
        }
      } while (logsAgain.current);
      if (mine === epoch.current) setLogError(null);
    } catch (e) {
      if (mine === epoch.current) setLogError(String((e as Error)?.message ?? e));
    } finally {
      if (mine === epoch.current) {
        logsBusy.current = false;
        setLogsLoading(false);
      }
    }
  }, [runId]);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        lastLoad.current = Date.now();
        loadTrace();
        void loadLogs();
      },
      Math.max(0, lastLoad.current + REFRESH_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [activity, loadTrace, loadLogs]);

  const diagnose = useCallback(async () => {
    const mine = epoch.current;
    setDiagnosing(true);
    try {
      const r = await api<{ findings: Finding[] }>(`/api/runs/${runId}/diagnose`, {});
      if (mine === epoch.current) setFindings(r.findings);
    } catch (e) {
      if (mine === epoch.current) setError(String((e as Error)?.message ?? e));
    } finally {
      if (mine === epoch.current) setDiagnosing(false);
    }
  }, [runId]);

  const loadMoreLogs = useCallback(() => {
    budget.current = loaded.current + LOG_BUDGET;
    void loadLogs();
  }, [loadLogs]);

  const rows = useMemo(() => (root ? flatten(root) : []), [root]);
  const logs = useMemo(() => logPages.flat(), [logPages]);
  const starts = rows.map(({ node }) => startOf(node)).filter((v): v is number => v != null);
  const origin = starts.length ? Math.min(...starts) : 0;
  const span = Math.max(
    1,
    ...rows.map(({ node }) => (startOf(node) ?? origin) - origin + (node.durationMs ?? 0)),
  );
  const node = rows.find((r) => r.node.id === selected)?.node ?? null;
  const steps = rows.filter((r) => r.node.type === "step");
  const attempts = rows.filter((r) => r.node.type === "attempt");
  const failed = attempts.filter((r) => r.node.status === "FAILED");
  const needle = query.trim().toLowerCase();
  const shownLogs = logs
    .filter(
      (l) =>
        (!level || l.level === level) &&
        (!node ||
          node.type === "run" ||
          (node.ids.attemptId
            ? l.attempt_id === node.ids.attemptId
            : node.ids.stepId
              ? l.step_id === node.ids.stepId
              : true)) &&
        (!needle ||
          `${l.content} ${l.data?.trace?.event ?? ""} ${l.data?.trace?.provider ?? ""} ${l.attempt_id ?? ""}`
            .toLowerCase()
            .includes(needle)),
    )
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const byId = new Map(rows.map(({ node }) => [node.id, node]));
  const startsById = new Map<string, number>();
  for (const { node: n } of rows.slice().reverse()) {
    startsById.set(
      n.id,
      startOf(n) ??
        Math.min(Infinity, ...n.children.map((child) => startsById.get(child.id) ?? Infinity)),
    );
  }
  const logsByNode = new Map<string, LogRow[]>();
  for (const log of shownLogs) {
    const owner =
      log.attempt_id != null && byId.has(`attempt:${log.attempt_id}`)
        ? `attempt:${log.attempt_id}`
        : log.step_id != null && byId.has(`step:${log.step_id}`)
          ? `step:${log.step_id}`
          : root?.id;
    if (owner) {
      const bucket = logsByNode.get(owner) ?? [];
      bucket.push(log);
      logsByNode.set(owner, bucket);
    }
  }
  type Entry =
    { kind: "node"; node: TraceNode; depth: number } | { kind: "log"; log: LogRow; depth: number };
  const entries: Entry[] = [];
  const visit = (n: TraceNode, depth: number) => {
    entries.push({ kind: "node", node: n, depth });
    if ((n.type !== "tool") === toggled.has(n.id)) return;
    const children: Array<{ at: number; order: number; entry: Entry }> = [
      ...n.children.map((child, i) => ({
        at: startsById.get(child.id) ?? Infinity,
        order: i,
        entry: { kind: "node" as const, node: child, depth: depth + 1 },
      })),
      ...(logsByNode.get(n.id) ?? []).map((log) => ({
        at: Date.parse(log.created_at),
        order: log.id + n.children.length,
        entry: { kind: "log" as const, log, depth: depth + 1 },
      })),
    ];
    children.sort((a, b) => a.at - b.at || a.order - b.order);
    for (const { entry } of children) {
      if (entry.kind === "node") visit(entry.node, entry.depth);
      else entries.push(entry);
    }
  };
  if (root) visit(root, 0);
  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focusNode = (id: string) => {
    const index = rows.findIndex((r) => r.node.id === id);
    if (index < 0) return;
    setSelected(id);
    setToggled((prev) => {
      const next = new Set(prev);
      if (rows[index].node.type !== "tool") next.delete(id);
      let depth = rows[index].depth;
      for (let i = index - 1; i >= 0 && depth > 0; i--) {
        const parent = rows[i];
        if (parent.depth < depth) {
          if (parent.node.type !== "tool") next.delete(parent.node.id);
          else next.add(parent.node.id);
          depth = parent.depth;
        }
      }
      return next;
    });
  };
  const typeIcon = (type: TraceNode["type"]) =>
    type === "tool"
      ? Terminal
      : type === "handoff"
        ? GitBranch
        : type === "attempt"
          ? Activity
          : Layers;
  const errorText =
    node?.attrs.error == null
      ? ""
      : typeof node.attrs.error === "string"
        ? node.attrs.error
        : typeof node.attrs.error === "object" && "message" in node.attrs.error
          ? String(node.attrs.error.message)
          : JSON.stringify(node.attrs.error, null, 2);
  const detailFields: Array<[string, unknown]> = node
    ? [
        [t("trace.started"), time(node.startedAt) || "—"],
        [t("trace.duration"), node.durationMs == null ? "—" : dur(node.durationMs)],
        ["Provider", node.attrs.provider],
        ["Model", node.attrs.model],
        [t("trace.attemptId"), node.ids.attemptId],
        ["Job", node.ids.jobId],
      ]
    : [];

  return (
    <section className="trace-explorer" aria-label={t("trace.title")}>
      <header className="tx-header">
        <div>
          <span className="tx-eyebrow">RUN #{runId}</span>
          <h2>
            <Activity size={20} />
            {t("trace.title")}
          </h2>
          <p>{t("trace.intro")}</p>
        </div>
        <div className="tx-actions">
          <button
            className="ghost sm"
            onClick={() => {
              loadTrace();
              void loadLogs();
            }}
            disabled={loading || logsLoading}
            aria-label={t("trace.refresh")}
            title={t("trace.refresh")}
          >
            <RefreshCw size={15} className={loading ? "tx-spin" : undefined} />
          </button>
          <button className="sm" onClick={diagnose} disabled={diagnosing || !root}>
            {diagnosing ? (
              <LoaderCircle size={15} className="tx-spin" />
            ) : (
              <Stethoscope size={15} />
            )}
            {diagnosing ? t("trace.diagnosing") : t("trace.diagnose")}
          </button>
        </div>
      </header>
      {error && (
        <div className="tx-error" role="alert">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
      {!root && (
        <div className="tx-empty" role="status">
          {loading ? <LoaderCircle size={24} className="tx-spin" /> : <Activity size={24} />}
          <b>{loading ? t("trace.loading") : t("trace.unavailable")}</b>
        </div>
      )}
      {root && (
        <>
          <div className="tx-overview">
            <div>
              <Clock3 size={16} />
              <span>{t("trace.duration")}</span>
              <strong>{root.durationMs == null ? "—" : dur(root.durationMs)}</strong>
            </div>
            <div>
              <Layers size={16} />
              <span>{t("trace.steps")}</span>
              <strong>
                {
                  steps.filter((r) => r.node.status === "COMPLETED" || r.node.status === "SKIPPED")
                    .length
                }
                <small> / {steps.length}</small>
              </strong>
            </div>
            <div>
              <Activity size={16} />
              <span>{t("trace.attempts")}</span>
              <strong>{attempts.length}</strong>
            </div>
            <button
              className={failed.length ? "tx-problems" : ""}
              onClick={() => failed[0] && focusNode(failed[0].node.id)}
              disabled={!failed.length}
            >
              <AlertCircle size={16} />
              <span>{t("trace.failedAttempts")}</span>
              <strong>{failed.length}</strong>
            </button>
          </div>
          {findings && (
            <section
              className={`tx-findings ${findings.length ? "has-findings" : ""}`}
              aria-live="polite"
            >
              <div className="tx-section-title">
                <Stethoscope size={16} />
                <h3>{t("trace.diagnosis")}</h3>
                <span className="tx-count">{findings.length}</span>
                <button
                  className="ghost xs"
                  onClick={() => setFindings(null)}
                  aria-label={t("trace.close")}
                >
                  <X size={14} />
                </button>
              </div>
              {!findings.length && <p>{t("trace.noFindings")}</p>}
              {findings.map((f, i) => {
                const evidence = f.evidence.find((id) => rows.some((r) => r.node.id === id));
                return (
                  <article key={i}>
                    <div className="tx-finding-top">
                      <span className="tx-tag">{f.source}</span>
                      {f.category && <span className="mono small">{f.category}</span>}
                    </div>
                    <b>{f.summary}</b>
                    <p>{f.suggestion}</p>
                    {evidence && (
                      <button className="ghost xs" onClick={() => focusNode(evidence)}>
                        {t("trace.viewEvidence")}
                        <ChevronRight size={13} />
                      </button>
                    )}
                  </article>
                );
              })}
            </section>
          )}
          <section className="tx-panel tx-timeline" aria-label={t("trace.timeline")}>
            <div className="tx-section-title">
              <GitBranch size={16} />
              <h3>{t("trace.timeline")}</h3>
              <span className="tx-count">
                {shownLogs.length} {t("trace.events")}
              </span>
              {logsLoading && <LoaderCircle size={14} className="tx-spin" />}
            </div>
            <div className="tx-log-toolbar">
              <label className="tx-search">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setToggled(new Set());
                  }}
                  placeholder={t("trace.searchPlaceholder")}
                  aria-label={t("trace.searchPlaceholder")}
                />
                {query && (
                  <button
                    className="ghost xs"
                    onClick={() => setQuery("")}
                    aria-label={t("trace.clearSearch")}
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
              <select
                value={level}
                onChange={(e) => {
                  setLevel(e.target.value);
                  setToggled(new Set());
                }}
                aria-label={t("trace.level")}
              >
                <option value="">{t("trace.allLevels")}</option>
                {LEVELS.filter(Boolean).map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
              {node && node.type !== "run" && (
                <button
                  className="tx-scope"
                  onClick={() => setSelected(null)}
                  title={t("trace.clearSelection")}
                >
                  <span>{node.label}</span>
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="tx-order">
              <Clock3 size={12} />
              {t("trace.oldestFirst")}
              <span>{t("trace.treeHint")}</span>
            </div>
            {logError && (
              <div className="tx-error" role="alert">
                <AlertCircle size={15} />
                <span>{logError}</span>
                <button className="ghost xs" onClick={() => void loadLogs()}>
                  {t("trace.retry")}
                </button>
              </div>
            )}
            <div className="tx-timeline-scroll">
              <div className="tx-nodes" aria-label={t("trace.execution")}>
                {entries.map((entry) => {
                  const { depth } = entry;
                  if (entry.kind === "log") {
                    const l = entry.log;
                    return (
                      <div
                        key={`log:${l.id}`}
                        className="tx-tree-log"
                        style={{ paddingLeft: 12 + Math.min(depth, 5) * 12 }}
                      >
                        <details
                          className={`tx-log-entry level-${l.level || "INFO"}`}
                          data-log-id={l.id}
                        >
                          <summary>
                            <span className="tx-log-heading">
                              <ChevronRight size={12} className="tx-log-chevron" />
                              <span className={`tx-level level-${l.level || "INFO"}`}>
                                {l.level || "INFO"}
                              </span>
                              <span className="tx-event-name">
                                {l.data?.trace?.event || t("trace.event")}
                              </span>
                              <time
                                className="tx-log-time"
                                dateTime={l.created_at}
                                title={time(l.created_at)}
                              >
                                {new Date(l.created_at).toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                  hour12: false,
                                })}
                              </time>
                            </span>
                            <span className="tx-log-message">{l.content}</span>
                          </summary>
                          <div className="tx-log-expanded">
                            <span className="muted small">
                              #{l.id}
                              {l.attempt_id != null
                                ? ` · ${t("trace.attemptId")} #${l.attempt_id}`
                                : ""}
                            </span>
                            <pre>{JSON.stringify(l.data ?? { content: l.content }, null, 2)}</pre>
                          </div>
                        </details>
                      </div>
                    );
                  }
                  const n = entry.node;
                  const Icon = typeIcon(n.type);
                  const childCount = n.children.length + (logsByNode.get(n.id)?.length ?? 0);
                  const expanded = (n.type !== "tool") !== toggled.has(n.id);
                  const start = startsById.get(n.id);
                  const left =
                    start == null || !Number.isFinite(start)
                      ? 0
                      : Math.max(0, Math.min(100, ((start - origin) / span) * 100));
                  const width = Math.min(
                    100 - left,
                    Math.max(0.7, ((n.durationMs ?? 0) / span) * 100),
                  );
                  const tone =
                    n.status === "FAILED"
                      ? "error"
                      : n.status === "RUNNING"
                        ? "running"
                        : n.status?.startsWith("WAITING")
                          ? "waiting"
                          : "normal";
                  return (
                    <div key={n.id} className={`tx-node ${selected === n.id ? "is-selected" : ""}`}>
                      <div
                        className="tx-node-name"
                        style={{ paddingLeft: 8 + Math.min(depth, 5) * 12 }}
                      >
                        {childCount ? (
                          <button
                            className="tx-disclosure"
                            aria-label={`${expanded ? t("trace.collapse") : t("trace.expand")} ${n.label}`}
                            aria-expanded={expanded}
                            onClick={() => toggle(n.id)}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        ) : (
                          <span className="tx-disclosure" />
                        )}
                        <button
                          className="tx-node-pick"
                          onClick={() => setSelected(selected === n.id ? null : n.id)}
                          aria-pressed={selected === n.id}
                          aria-expanded={selected === n.id}
                          aria-controls={
                            selected === n.id ? `trace-detail-${runId}-${n.id}` : undefined
                          }
                          title={n.label}
                        >
                          <Icon size={15} />
                          <span>
                            <b>{n.label}</b>
                            <small>
                              {t(`trace.type.${n.type}`)}
                              {n.attrs.provider ? ` · ${n.attrs.provider}` : ""}
                            </small>
                          </span>
                          {n.status && <Badge s={n.status} label />}
                        </button>
                      </div>
                      <span className="tx-node-duration">
                        {n.durationMs == null ? "—" : dur(n.durationMs)}
                      </span>
                      {n.durationMs != null && (
                        <div
                          className="tx-waterfall"
                          title={`${t("trace.duration")}: ${dur(n.durationMs)}`}
                        >
                          <span
                            className={`tx-bar ${tone}`}
                            style={{ left: `${left}%`, width: `${width}%` }}
                          />
                        </div>
                      )}
                      {selected === n.id && node && (
                        <section
                          className="tx-details tx-inline-details"
                          id={`trace-detail-${runId}-${n.id}`}
                          style={{ marginLeft: 12 + Math.min(depth, 5) * 12 }}
                          aria-label={t("trace.details")}
                        >
                          <div className="tx-section-title">
                            <FileText size={16} />
                            <h3>{t("trace.details")}</h3>
                            <button
                              className="ghost xs"
                              onClick={() => setSelected(null)}
                              aria-label={t("trace.clearSelection")}
                            >
                              <X size={14} />
                            </button>
                          </div>
                          <div className="tx-detail-content">
                            <span className="tx-eyebrow">{t(`trace.type.${node.type}`)}</span>
                            <h3>{node.label}</h3>
                            {node.status && <Badge s={node.status} label />}
                            <dl>
                              {detailFields
                                .filter(([, value]) => value != null && value !== "")
                                .map(([label, value]) => (
                                  <div key={label}>
                                    <dt>{label}</dt>
                                    <dd>{String(value)}</dd>
                                  </div>
                                ))}
                            </dl>
                            {errorText && (
                              <div className="tx-detail-error">
                                <b>{t("trace.errorLabel")}</b>
                                <pre>{errorText}</pre>
                              </div>
                            )}
                            <details>
                              <summary>{t("trace.rawData")}</summary>
                              <pre>
                                {JSON.stringify({ ids: node.ids, attrs: node.attrs }, null, 2)}
                              </pre>
                            </details>
                          </div>
                        </section>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {!shownLogs.length && (
              <div className="tx-empty tx-log-empty" role="status">
                {logsLoading ? (
                  <LoaderCircle className="tx-spin" size={20} />
                ) : (
                  <Terminal size={20} />
                )}
                <b>
                  {logsLoading
                    ? t("trace.loadingLogs")
                    : logs.length
                      ? t("trace.noMatches")
                      : t("trace.noLogs")}
                </b>
                <p>{logs.length ? t("trace.adjustFilters") : t("trace.noLogsHint")}</p>
                {(query || level || node) && (
                  <button
                    className="ghost sm"
                    onClick={() => {
                      setQuery("");
                      setLevel("");
                      setSelected(null);
                      setToggled(new Set());
                    }}
                  >
                    {t("trace.resetFilters")}
                  </button>
                )}
              </div>
            )}
            <div className="tx-panel-footer">
              <span>{t("trace.logHint")}</span>
              {moreLogs && (
                <button className="ghost sm" onClick={loadMoreLogs} disabled={logsLoading}>
                  {logsLoading && <LoaderCircle size={13} className="tx-spin" />}
                  {t("trace.loadMore")}
                </button>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
