import { useEffect, useMemo, useRef, useState } from "react";
import { Bug, CalendarClock, ChevronRight, Eye, EyeOff, GitPullRequest, Link2, PlayCircle, RefreshCw, Siren, TrendingDown, TrendingUp, Unlink } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, ago, Copy, EmptyState, ErrorBox, Field, Loading, PageHeader, SearchInput, Segmented, navigate, toast } from "../ui.tsx";
import { uiLocale, useI18n } from "../i18n/index.tsx";
import { ScanProgressCard, type Progress } from "./ScanProgress.tsx";
import "./ProdErrors.css";

type Sev = "critical" | "high" | "medium" | "low";
interface Group {
  fingerprint: string;
  namespace: string;
  service: string;
  level: string;
  caller: string;
  signature: string;
  sample: string;
  detail: { err?: string; image?: string; request_id?: string; stack?: string; pod?: string };
  today_count: number;
  yesterday_count: number;
  first_at: string | null;
  last_at: string | null;
  severity: Sev;
  reasons: string[];
  status: "open" | "ignored";
  work_item_id: number | null;
  work_item_code: string | null;
  work_item_title: string | null;
  work_item_status: string | null;
  run_id: number | null;
  run_status: string | null;
  pull_requests: Array<{ repo: string; url: string; title: string }>;
}
interface Data {
  day: string;
  today: string;
  scanning: boolean;
  progress: Progress | null;
  lastScan: any;
  lastOk: any;
  ignored: number;
  settings: { schedule: string[]; notify: boolean };
  splunk: { connected: boolean; expired: boolean };
  namespaces: Array<{ namespace: string; project: string }>;
  groups: Group[];
}

const hm = (t: string | null) => (t ? new Date(t).toLocaleTimeString(uiLocale() === "vi" ? "vi-VN" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : "–");
function reasonText(t: (key: string, params?: Record<string, string | number>) => string, reason: string) {
  const [code, a, b] = reason.split("|");
  if (code === "many" || code === "up" || code === "down" || code === "panic" || code === "new" || code === "money") {
    return t(`pe.reason.${code}`, { n: a ?? "", ratio: a ?? "", yesterday: code === "up" ? (b ?? "") : (a ?? "") });
  }
  return reason;
}
const secs = (a?: string, b?: string) => (a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000) : null);

function Trend({ count, yesterday }: { count: number; yesterday: number }) {
  const { t } = useI18n();
  if (yesterday === 0) return <span className="pe-new">{t("pe.new")}</span>;
  const r = count / yesterday;
  const tip = t("pe.sameHour", { n: yesterday });
  if (r >= 1.5) return <span className="pe-up" title={tip}><TrendingUp size={13} /> ×{r >= 10 ? Math.round(r) : r.toFixed(1)}</span>;
  if (r <= 0.5) return <span className="pe-down" title={tip}><TrendingDown size={13} /> {yesterday}</span>;
  return <span className="muted" title={tip}>{yesterday}</span>;
}

/** The work item fixing this error: link to it, its latest run and PRs; or create one / attach an existing one. */
function FixRef({ g, busy, onInvestigate, reload }: { g: Group; busy: boolean; onInvestigate: () => void; reload: () => void }) {
  const { t, status } = useI18n();
  const [ref, setRef] = useState("");
  const link = async (work_item: string) => (await act(() => api(`/api/prod-errors/${g.fingerprint}/link`, { work_item }), work_item ? t("pe.linked", { code: work_item }) : t("pe.unlinked"))) && (setRef(""), reload());
  const runName = (s: string | null) => (s ? (status(s).startsWith("status.") ? s : status(s)) : "");
  if (g.work_item_id)
    return (
      <div className="pe-fix is-linked">
        <div className="pe-fix-label small muted">{t("pe.fixing")}</div>
        <div className="pe-fix-main">
          <a className="pe-fix-code mono" href={`#/work-items/${g.work_item_id}`}><Bug size={14} strokeWidth={2} />{g.work_item_code}</a>
          <a className="pe-fix-title" href={`#/work-items/${g.work_item_id}`} title={g.work_item_title ?? ""}>{g.work_item_title}</a>
        </div>
        <div className="pe-fix-links small">
          {g.run_id ? <a href={`#/runs/${g.run_id}`}><PlayCircle size={13} />Run #{g.run_id} · <b className={`pe-run-${(g.run_status ?? "").toLowerCase()}`}>{runName(g.run_status)}</b></a> : <span className="muted">{t("pe.noRun")}</span>}
          {g.pull_requests.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noopener"><GitPullRequest size={13} />{p.repo}: {p.title}</a>)}
          <button className="xs ghost" onClick={() => link("")} title={t("pe.unlinkTip")}><Unlink size={12} />{t("pe.unlink")}</button>
        </div>
      </div>
    );
  return (
    <div className="pe-fix">
      <div className="pe-fix-label small muted">{t("pe.noItem")}</div>
      <div className="row tight">
        <button className="sm" disabled={busy} onClick={onInvestigate} title={t("pe.investigateTip")}>
          <Bug size={14} strokeWidth={2} />{busy ? t("pe.creating") : t("pe.investigate")}
        </button>
        <span className="muted small">{t("pe.or")}</span>
        <input className="pe-fix-input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={t("pe.codePh")} onKeyDown={(e) => e.key === "Enter" && ref.trim() && link(ref.trim())} />
        <button className="sm ghost" disabled={!ref.trim()} onClick={() => link(ref.trim())}><Link2 size={14} strokeWidth={2} />{t("pe.attach")}</button>
      </div>
    </div>
  );
}

function GroupRow({ g, open, onToggle, reload }: { g: Group; open: boolean; onToggle: () => void; reload: () => void }) {
  const { t, status } = useI18n();
  const [busy, setBusy] = useState(false);
  const spl = `index=k8s_prod kubernetes.namespace_name="${g.namespace}" kubernetes.container_name="${g.service}"${g.caller ? ` "${g.caller}"` : ""}`;
  const investigate = async () => {
    setBusy(true);
    const r = await act(() => api<any>(`/api/prod-errors/${g.fingerprint}/investigate`, {}));
    setBusy(false);
    if (r) {
      toast(r.created ? t("pe.created", { code: r.code }) : t("pe.exists", { code: r.code }), "ok");
      reload();
    }
  };
  const ignore = async (ignored: boolean) => (await act(() => api(`/api/prod-errors/${g.fingerprint}/ignore`, { ignored }), ignored ? t("pe.ignoredGroup") : t("pe.watching"))) && reload();
  const runName = (s: string | null) => (s ? (status(s).startsWith("status.") ? s : status(s)) : "");
  return (
    <div id={`pe-${g.fingerprint}`} className={`pe-row${open ? " is-open" : ""}${g.status === "ignored" ? " is-ignored" : ""}`}>
      <button className="pe-head" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={16} strokeWidth={2} className="pe-chev" />
        <span className={`pe-sev pe-${g.severity}`}>{t(`pe.sev.${g.severity}`)}</span>
        <span className="pe-svc" title={g.namespace}>{g.service}</span>
        <span className="pe-sig mono" title={g.signature}>{g.signature}</span>
        <span className="pe-num" title={t("pe.todayCount")}>{g.today_count.toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB")}</span>
        <span className="pe-trend"><Trend count={g.today_count} yesterday={g.yesterday_count} /></span>
        <span className="pe-time muted small" title={t("pe.latestTip")}>{hm(g.last_at)}</span>
        <span className="pe-state small">
          {g.work_item_code ? (
            <span className="pill chip-brand pe-wi" role="link" tabIndex={0} title={t("pe.openItem", { code: g.work_item_code, title: g.work_item_title ?? "" })}
              onClick={(e) => (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))}
              onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))}>
              <Bug size={11} />{g.work_item_code}{g.run_status ? ` · ${runName(g.run_status)}` : ""}
            </span>
          ) : g.status === "ignored" ? <span className="muted">{t("pe.ignored")}</span> : null}
        </span>
      </button>
      {open && (
        <div className="pe-body">
          {g.reasons.length > 0 && <div>{g.reasons.map((r) => <span key={r} className="pill">{reasonText(t, r)}</span>)}</div>}
          <FixRef g={g} busy={busy} onInvestigate={investigate} reload={reload} />
          <dl className="pe-meta small">
            <dt>Service</dt><dd className="mono">{g.namespace} / {g.service}</dd>
            {g.caller && <><dt>{t("pe.logSite")}</dt><dd className="mono">{g.caller}</dd></>}
            <dt>{t("pe.col.today")}</dt><dd>{t("pe.todayLine", { count: g.today_count, first: hm(g.first_at), last: hm(g.last_at), yesterday: g.yesterday_count })}</dd>
            {g.detail.image && <><dt>Image</dt><dd className="mono">{g.detail.image}</dd></>}
            {g.detail.request_id && <><dt>request_id</dt><dd className="mono">{g.detail.request_id} <Copy text={`index=k8s_prod "${g.detail.request_id}"`} label={t("pe.copyRequest")} /></dd></>}
          </dl>
          <div>
            <div className="muted small">{t("pe.sample")}</div>
            <pre className="pe-pre">{g.sample}{g.detail.err ? `\n\nerror: ${g.detail.err}` : ""}</pre>
          </div>
          {g.detail.stack && (
            <details>
              <summary className="small">Stacktrace</summary>
              <pre className="pe-pre">{g.detail.stack}</pre>
            </details>
          )}
          <div className="row tight pe-actions">
            {g.status === "ignored" ? (
              <button className="sm ghost" onClick={() => ignore(false)}><Eye size={14} strokeWidth={2} />{t("pe.watchAgain")}</button>
            ) : (
              <button className="sm ghost" onClick={() => ignore(true)} title={t("pe.ignoreTip")}><EyeOff size={14} strokeWidth={2} />{t("pe.ignore")}</button>
            )}
            <Copy text={spl} label={t("pe.copySpl")} />
          </div>
        </div>
      )}
    </div>
  );
}

function Schedule({ s, reload }: { s: Data["settings"]; reload: () => void }) {
  const { t } = useI18n();
  const [times, setTimes] = useState(s.schedule.join(", "));
  const [notify, setNotify] = useState(s.notify);
  useEffect(() => (setTimes(s.schedule.join(", ")), setNotify(s.notify)), [s.schedule.join(), s.notify]);
  return (
    <details className="pe-schedule">
      <summary className="small"><CalendarClock size={14} /> {t("pe.schedule", { times: s.schedule.length ? s.schedule.join(", ") : t("pe.scheduleOff") })}{s.notify ? ` · ${t("pe.telegram")}` : ""}</summary>
      <div className="pe-schedule-body">
        <Field label={t("pe.hours")}>
          <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="09:00, 14:00, 17:00" />
        </Field>
        <label className="row tight small"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> {t("pe.notify")}</label>
        <div className="row tight">
          <button className="sm" onClick={async () => (await act(() => api("/api/prod-errors/settings", { schedule: times, notify }), t("pe.saved"))) && reload()}>{t("ig.save")}</button>
          <span className="muted small">{t("pe.scheduleHint")}</span>
        </div>
      </div>
    </details>
  );
}

/** `focus`: a group fingerprint from the URL (#/prod-errors/<fingerprint>) to open and scroll to. */
export function ProdErrorsPage({ focus }: { focus?: string }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useApi<Data>(`/api/prod-errors${all ? "?all=1" : ""}`);
  const [ns, setNs] = useState("all");
  const [sev, setSev] = useState<"attention" | "all">("attention");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  // a deep link may point at an ignored or medium/low group: widen the filters so it is visible, then scroll to it
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || !data || focused.current) return;
    const g = data.groups.find((x) => x.fingerprint === focus);
    if (!g && !all) return setAll(true);
    focused.current = true;
    if (g && !(g.severity === "critical" || g.severity === "high" || g.work_item_id)) setSev("all");
    setOpen(focus);
    setTimeout(() => document.getElementById(`pe-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
  }, [focus, data, all]);

  useEffect(() => {
    if (!data?.scanning) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [data?.scanning, reload]);

  // announce the end of a scan that was seen running
  const wasScanning = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (wasScanning.current && !data.scanning) {
      const l = data.lastScan;
      if (l?.ok) toast(t("pe.scanDone", { groups: l.groups, attention: data.groups.filter((g) => g.severity === "critical" || g.severity === "high").length }), "ok");
      else if (l) toast(t("pe.scanFail", { error: l.error }));
    }
    wasScanning.current = data.scanning;
  }, [data]);

  const groups = useMemo(() => {
    const qq = query.trim().toLowerCase();
    return (data?.groups ?? []).filter(
      (g) =>
        (ns === "all" || g.namespace === ns) &&
        (sev === "all" || g.severity === "critical" || g.severity === "high" || g.work_item_id) &&
        (!qq || `${g.service} ${g.signature} ${g.caller} ${g.sample}`.toLowerCase().includes(qq)),
    );
  }, [data, ns, sev, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const g of data?.groups ?? []) if (ns === "all" || g.namespace === ns) c[g.severity]++;
    return c;
  }, [data, ns]);

  const scan = async () => (await act(() => api("/api/prod-errors/scan", {}))) && reload();
  const last = data?.lastScan;
  const lastOk = data?.lastOk;

  return (
    <>
      <PageHeader
        icon={Siren}
        title={t("pe.title")}
        subtitle={t("pe.subtitle", { projects: data?.namespaces.length ? new Intl.ListFormat(uiLocale() === "vi" ? "vi" : "en", { type: "conjunction" }).format(data.namespaces.map((n) => n.project)) : t("pe.projectsFallback") })}
        actions={
          <button disabled={!data || data.scanning || !data.splunk.connected} onClick={scan} title={data && !data.splunk.connected ? t("pe.connectFirst") : undefined}>
            <RefreshCw size={15} strokeWidth={2} className={data?.scanning ? "spin" : ""} />{data?.scanning ? t("pe.scanning") : t("pe.scanNow")}
          </button>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          {data.scanning && <ScanProgressCard progress={data.progress} startedAt={last?.started_at} typicalSeconds={secs(lastOk?.started_at, lastOk?.finished_at)} />}
          <div className="pe-status small">
            {!data.splunk.connected && (
              <span className="pe-warn">
                {data.splunk.expired ? t("pe.sessionExpired") : t("pe.notConnected")} — <a href="#/integrations">{t("pe.pasteCookie")}</a>
              </span>
            )}
            {data.scanning ? null : last ? (
              last.ok ? (
                <span>{t("pe.lastOk", { ago: ago(last.finished_at), secs: secs(last.started_at, last.finished_at) ?? "–", groups: last.groups, extra: last.trigger === "schedule" ? t("pe.scheduled") : "" })}{last.error && <span className="pe-warn"> · {last.error}</span>}</span>
              ) : (
                <span className="pe-warn">{t("pe.lastFail", { ago: ago(last.started_at), error: last.error })}{lastOk && <span className="muted"> · {t("pe.staleData", { ago: ago(lastOk.finished_at) })}</span>}</span>
              )
            ) : (
              <span>{t("pe.never")}</span>
            )}
            {data.day !== data.today && last && <span className="pe-warn">{t("pe.oldDay", { day: data.day })}</span>}
          </div>
          <Schedule s={data.settings} reload={reload} />

          <div className="row pe-filters">
            <Segmented label={t("pe.system")} value={ns} onChange={setNs} options={[["all", t("pe.all")], ...data.namespaces.map((n) => [n.namespace, n.project] as [string, string])]} />
            <Segmented label={t("pe.level")} value={sev} onChange={setSev} options={[["attention", t("pe.attention", { n: counts.critical + counts.high })], ["all", t("pe.allCount", { n: counts.critical + counts.high + counts.medium + counts.low })]]} />
            <SearchInput value={query} onChange={setQuery} placeholder={t("pe.search")} />
            <label className="row tight small muted"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t("pe.showIgnored", { n: data.ignored })}</label>
          </div>

          {groups.length === 0 ? (
            <EmptyState icon={Siren} title={data.groups.length ? t("pe.noMatch") : last ? t("pe.none") : t("pe.noData")}>
              {sev === "attention" && data.groups.length ? t("pe.widen") : null}
            </EmptyState>
          ) : (
            <div className="pe-list">
              <div className="pe-cols small muted" aria-hidden>
                <span /><span>{t("pe.col.level")}</span><span>{t("pe.col.service")}</span><span>{t("pe.col.error")}</span><span className="pe-num">{t("pe.col.today")}</span><span>{t("pe.col.yesterday")}</span><span>{t("pe.col.latest")}</span><span />
              </div>
              {groups.map((g) => (
                <GroupRow key={g.fingerprint} g={g} open={open === g.fingerprint} onToggle={() => setOpen(open === g.fingerprint ? null : g.fingerprint)} reload={reload} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
