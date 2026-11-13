import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Stethoscope } from "lucide-react";
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
  ids: { runId: number; stepId?: number; attemptId?: number; jobId?: number | null; toolUseId?: string };
  attrs: Record<string, unknown>;
  children: TraceNode[];
}

interface LogRow {
  id: number;
  step_id: number | null;
  attempt_id: number | null;
  level: string;
  content: string;
  data: { trace?: { event?: string; provider?: string | null; duration_ms?: number | null }; details?: unknown } | null;
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
    api<TraceNode>(`/api/runs/${runId}/trace`)
      .then((r) => {
        if (n <= applied.current) return;
        applied.current = n;
        setRoot(r);
        setError(null);
      })
      .catch((e) => n > applied.current && setError(String(e?.message ?? e)));
  }, [runId]);

  const loadLogs = useCallback(async () => {
    if (logsBusy.current) {
      logsAgain.current = true;
      return;
    }
    logsBusy.current = true;
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
    } catch {
      // the next live event retries
    } finally {
      if (mine === epoch.current) logsBusy.current = false;
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
    setDiagnosing(true);
    try {
      const r = await api<{ findings: Finding[] }>(`/api/runs/${runId}/diagnose`, {});
      setFindings(r.findings);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setDiagnosing(false);
    }
  }, [runId]);

  const loadMoreLogs = useCallback(() => {
    budget.current = loaded.current + LOG_BUDGET;
    void loadLogs();
  }, [loadLogs]);

  const rows = useMemo(() => (root ? flatten(root) : []), [root]);
  const logs = useMemo(() => logPages.flat(), [logPages]);
  const origin = root ? (startOf(root) ?? Math.min(...rows.map((r) => startOf(r.node) ?? Infinity))) : 0;
  const span = Math.max(
    1,
    ...rows.map((r) => (startOf(r.node) ?? origin) - origin + (r.node.durationMs ?? 0)),
  );
  const node = rows.find((r) => r.node.id === selected)?.node ?? null;
  const shownLogs = logs.filter(
    (l) =>
      (!level || l.level === level) &&
      (!node ||
        node.type === "run" ||
        (node.ids.attemptId ? l.attempt_id === node.ids.attemptId : node.ids.stepId ? l.step_id === node.ids.stepId : true)),
  );

  return (
    <div className="rv-pane">
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4 style={{ fontSize: "var(--fs-lg)" }}>
          <Activity size={18} /> {t("trace.title")}
        </h4>
        <button className="sm" onClick={diagnose} disabled={diagnosing || !root}>
          <Stethoscope size={14} /> {t("trace.diagnose")}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {findings && (
        <div className="rv-sec">
          {findings.length === 0 && <div className="muted small">{t("trace.noFindings")}</div>}
          {findings.map((f, i) => (
            <div key={i} className="rv-tl-row">
              <span>
                <Badge s={f.source}>{f.source}</Badge> <b>{f.kind}</b>
                {f.category ? <span className="muted small"> · {f.category}</span> : null}
                <div>{f.summary}</div>
                <div className="muted small">{f.suggestion}</div>
                <div className="mono small">{f.evidence.join(", ")}</div>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="rv-sec" role="tree" aria-label={t("trace.title")}>
        {rows.map(({ node: n, depth }) => {
          const left = (((startOf(n) ?? origin) - origin) / span) * 100;
          const width = Math.max(0.5, ((n.durationMs ?? 0) / span) * 100);
          return (
            <div
              key={n.id}
              role="treeitem"
              aria-selected={n.id === selected}
              tabIndex={0}
              className="rv-tl-row"
              style={{ cursor: "pointer", background: n.id === selected ? "var(--bg-hover, #0001)" : undefined }}
              onClick={() => setSelected(n.id === selected ? null : n.id)}
              onKeyDown={(e) => e.key === "Enter" && setSelected(n.id === selected ? null : n.id)}
            >
              <span style={{ paddingLeft: depth * 14 }}>
                <b className="muted small">{n.type}</b> {n.label}{" "}
                {n.status && <Badge s={n.status}>{n.status}</Badge>}{" "}
                <span className="muted small">{n.durationMs != null ? dur(n.durationMs) : ""}</span>
                <div style={{ position: "relative", height: 6, background: "#0001", marginTop: 2 }}>
                  <div
                    style={{
                      position: "absolute",
                      left: `${left}%`,
                      width: `${Math.min(width, 100 - left)}%`,
                      height: 6,
                      background: n.status === "FAILED" ? "#d33" : "#39f",
                    }}
                  />
                </div>
              </span>
            </div>
          );
        })}
      </div>
      {node && (
        <div className="rv-sec">
          <div className="rv-sec-title">{node.label}</div>
          <pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify({ ids: node.ids, status: node.status, startedAt: node.startedAt, attrs: node.attrs }, null, 2)}
          </pre>
        </div>
      )}
      <div className="rv-sec">
        <div className="rv-sec-title">
          {t("trace.logs")}{" "}
          <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="level">
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || "ALL"}
              </option>
            ))}
          </select>
        </div>
        {shownLogs.map((l) => (
          <div key={l.id} className="rv-tl-row">
            <span className="muted">
              {time(l.created_at)}
              <br />
              <b className="small">{l.level}</b>
            </span>
            <span>
              <span className="mono small">{l.data?.trace?.event}</span> {l.content}
            </span>
          </div>
        ))}
        {moreLogs && (
          <button className="sm" onClick={loadMoreLogs}>
            {t("trace.loadMore")}
          </button>
        )}
      </div>
    </div>
  );
}
