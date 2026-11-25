import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  CalendarClock,
  ChevronRight,
  Eye,
  EyeOff,
  GitPullRequest,
  Link2,
  PlayCircle,
  RefreshCw,
  Siren,
  TrendingDown,
  TrendingUp,
  Unlink,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import {
  act,
  ago,
  Copy,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  SearchInput,
  Segmented,
  FilterToolbar,
  FilterField,
  navigate,
  toast,
} from "../ui.tsx";
import { uiLocale, useI18n } from "../i18n/index.tsx";
import { ScanProgressCard, type Progress } from "./ScanProgress.tsx";
import { BugHunterInline } from "./prodErrors/BugHunter.tsx";
import { IncidentWorkbench } from "./prodErrors/IncidentWorkbench.tsx";
import { ACTIVE_HUNT, usePolling } from "./prodErrors/bugHuntParts.tsx";
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
  detail: {
    err?: string;
    image?: string;
    request_id?: string;
    trace_id?: string;
    stack?: string;
    has_stack?: boolean;
    no_baseline?: boolean;
    pod?: string;
    sources?: Array<"splunk" | "signoz">;
  };
  today_count: number;
  yesterday_count: number;
  first_at: string | null;
  last_at: string | null;
  severity: Sev;
  reasons: string[];
  status: "open" | "ignored";
  lifecycle_status?: string;
  work_item_id: number | null;
  work_item_code: string | null;
  work_item_title: string | null;
  work_item_status: string | null;
  run_id: number | null;
  run_status: string | null;
  pull_requests: Array<{ repo: string; url: string; title: string }>;
}
interface ScanRun {
  ok: boolean;
  trigger: string;
  groups: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
interface Data {
  day: string;
  today: string;
  scanning: boolean;
  progress: Progress | null;
  lastScan: ScanRun | null;
  lastOk: ScanRun | null;
  ignored: number;
  settings: { schedule: string[]; notify: boolean };
  splunk: { connected: boolean; expired: boolean };
  signoz?: { connected: boolean };
  namespaces: Array<{ namespace: string; project: string; index: string }>;
  /** The scan whose groups are listed (null for scans from before scan options). */
  shown: {
    preset: string;
    namespaces: string[];
    window_start: string;
    window_end: string;
    baseline_start: string;
    baseline_end: string;
  } | null;
  maxCustomHours: number;
  groups: Group[];
}

type Preset = "1h" | "4h" | "12h" | "24h" | "today" | "yesterday" | "custom";
const PRESETS: Preset[] = ["1h", "4h", "12h", "24h", "today", "yesterday", "custom"];
/** datetime-local value (local time, minutes) for a Date. */
const localInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const PREF_KEY = "pe.scanPrefs";
function loadPrefs(): { preset: Preset; namespaces: string[] | null } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
    if (v && PRESETS.includes(v.preset))
      return {
        preset: v.preset,
        namespaces: Array.isArray(v.namespaces) ? v.namespaces : null,
      };
  } catch {
    /* ignore: unreadable prefs fall back to the defaults */
  }
  return { preset: "today", namespaces: null };
}
const dt = (iso: string) =>
  new Date(iso).toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hour12: false,
  });

/** Which projects and which time window to scan; remembered per browser. */
export function ScanPanel({
  data,
  onStarted,
  onClose,
}: {
  data: Data;
  onStarted: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const prefs = useMemo(loadPrefs, []);
  const all = data.namespaces.map((n) => n.namespace);
  const [chosen, setChosen] = useState<string[]>(() =>
    (prefs.namespaces ?? all).filter((n) => all.includes(n)).length
      ? (prefs.namespaces ?? all).filter((n) => all.includes(n))
      : all,
  );
  const [preset, setPreset] = useState<Preset>(prefs.preset);
  const [from, setFrom] = useState(() => localInput(new Date(Date.now() - 6 * 3600_000)));
  const [to, setTo] = useState(() => localInput(new Date()));
  const [busy, setBusy] = useState(false);
  const toggle = (n: string) =>
    setChosen((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]));
  const customHours = (new Date(to).getTime() - new Date(from).getTime()) / 3600_000;
  const customError =
    preset !== "custom"
      ? ""
      : !(customHours > 0)
        ? t("pe.opt.badRange")
        : customHours > data.maxCustomHours
          ? t("pe.opt.tooLong", { h: data.maxCustomHours })
          : "";
  const long = preset === "custom" && customHours > 24;
  const start = async () => {
    setBusy(true);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ preset, namespaces: chosen }));
    } catch {
      /* ignore: prefs are a convenience when storage is unavailable */
    }
    const body: Record<string, unknown> = {
      preset,
      namespaces: chosen.length === all.length ? [] : chosen,
    };
    if (preset === "custom")
      Object.assign(body, {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      });
    const ok = await act(() => api("/api/prod-errors/scan", body));
    setBusy(false);
    if (ok) {
      onStarted();
      onClose();
    }
  };
  return (
    <section className="card pe-scanpanel">
      <div className="pe-opt">
        <div className="pe-opt-label">{t("pe.opt.projects")}</div>
        <div className="pe-opt-chips">
          {data.namespaces.map((n) => (
            <label
              key={n.namespace}
              className={`pe-chip${chosen.includes(n.namespace) ? " on" : ""}`}
            >
              <input
                type="checkbox"
                checked={chosen.includes(n.namespace)}
                onChange={() => toggle(n.namespace)}
              />
              {n.project} <span className="muted mono">{n.namespace}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="pe-opt">
        <div className="pe-opt-label">{t("pe.opt.window")}</div>
        <Segmented
          label={t("pe.opt.window")}
          value={preset}
          onChange={setPreset}
          options={PRESETS.map((p) => [p, t(`pe.preset.${p}`)] as [Preset, string])}
        />
      </div>
      {preset === "custom" && (
        <div className="pe-opt">
          <div className="pe-opt-label" />
          <div className="pe-opt-range">
            <label>
              {t("pe.opt.from")}{" "}
              <input
                type="datetime-local"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              {t("pe.opt.to")}{" "}
              <input
                type="datetime-local"
                value={to}
                max={localInput(new Date())}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
        </div>
      )}
      <div className="pe-opt">
        <div className="pe-opt-label" />
        <div className="pe-opt-foot">
          <span className={customError ? "pe-warn small" : "muted small"}>
            {customError || (long ? t("pe.opt.comparePrev") : t("pe.opt.compareYesterday"))}
          </span>
          <span className="grow" />
          <button className="ghost sm" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="sm" disabled={busy || !chosen.length || !!customError} onClick={start}>
            <RefreshCw size={14} strokeWidth={2} />
            {t("pe.opt.scan")}
          </button>
        </div>
      </div>
    </section>
  );
}

const hm = (t: string | null) =>
  t
    ? new Date(t).toLocaleTimeString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "–";
const dmy = (t: string) =>
  new Date(t).toLocaleDateString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
const dmyHm = (t: string | null) => (t ? `${dmy(t)} ${hm(t)}` : "–");
function reasonText(
  t: (key: string, params?: Record<string, string | number>) => string,
  reason: string,
) {
  const [code, a, b] = reason.split("|");
  if (
    code === "many" ||
    code === "up" ||
    code === "down" ||
    code === "panic" ||
    code === "new" ||
    code === "money"
  ) {
    return t(`pe.reason.${code}`, {
      n: a ?? "",
      ratio: a ?? "",
      yesterday: code === "up" ? (b ?? "") : (a ?? ""),
    });
  }
  return reason;
}
const secs = (a?: string | null, b?: string | null) =>
  a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000) : null;

function Trend({
  count,
  yesterday,
  noBaseline,
}: {
  count: number;
  yesterday: number;
  noBaseline?: boolean;
}) {
  const { t } = useI18n();
  if (noBaseline)
    return (
      <span className="muted" title={t("pe.noBaselineLong")}>
        –
      </span>
    );
  if (yesterday === 0) return <span className="pe-new">{t("pe.new")}</span>;
  const r = count / yesterday;
  const tip = t("pe.sameHour", { n: yesterday });
  if (r >= 1.5)
    return (
      <span className="pe-up" title={tip}>
        <TrendingUp size={13} /> ×{r >= 10 ? Math.round(r) : r.toFixed(1)}
      </span>
    );
  if (r <= 0.5)
    return (
      <span className="pe-down" title={tip}>
        <TrendingDown size={13} /> {yesterday}
      </span>
    );
  return (
    <span className="muted" title={tip}>
      {yesterday}
    </span>
  );
}

/** The work item fixing this error: link to it, its latest run and PRs; or create one / attach an existing one. */
function FixRef({
  g,
  busy,
  onInvestigate,
  reload,
}: {
  g: Group;
  busy: boolean;
  onInvestigate: () => void;
  reload: () => void;
}) {
  const { t, status } = useI18n();
  const [ref, setRef] = useState("");
  const link = async (work_item: string) =>
    (await act(
      () => api(`/api/prod-errors/${g.fingerprint}/link`, { work_item }),
      work_item ? t("pe.linked", { code: work_item }) : t("pe.unlinked"),
    )) && (setRef(""), reload());
  const runName = (s: string | null) =>
    s ? (status(s).startsWith("status.") ? s : status(s)) : "";
  if (g.work_item_id)
    return (
      <div className="pe-fix is-linked">
        <div className="pe-fix-label small muted">{t("pe.fixing")}</div>
        <div className="pe-fix-main">
          <a className="pe-fix-code mono" href={`#/work-items/${g.work_item_id}`}>
            <Bug size={14} strokeWidth={2} />
            {g.work_item_code}
          </a>
          <a
            className="pe-fix-title"
            href={`#/work-items/${g.work_item_id}`}
            title={g.work_item_title ?? ""}
          >
            {g.work_item_title}
          </a>
        </div>
        <div className="pe-fix-links small">
          {g.run_id ? (
            <a href={`#/runs/${g.run_id}`}>
              <PlayCircle size={13} />
              Run #{g.run_id} ·{" "}
              <b className={`pe-run-${(g.run_status ?? "").toLowerCase()}`}>
                {runName(g.run_status)}
              </b>
            </a>
          ) : (
            <span className="muted">{t("pe.noRun")}</span>
          )}
          {g.pull_requests.map((p) => (
            <a key={p.url} href={p.url} target="_blank" rel="noopener">
              <GitPullRequest size={13} />
              {p.repo}: {p.title}
            </a>
          ))}
          <button className="xs ghost" onClick={() => link("")} title={t("pe.unlinkTip")}>
            <Unlink size={12} />
            {t("pe.unlink")}
          </button>
        </div>
      </div>
    );
  return (
    <div className="pe-fix">
      <div className="pe-fix-label small muted">{t("pe.noItem")}</div>
      <div className="row tight">
        <button
          className="sm"
          disabled={busy}
          onClick={onInvestigate}
          title={t("pe.investigateTip")}
        >
          <Bug size={14} strokeWidth={2} />
          {busy ? t("pe.creating") : t("pe.investigate")}
        </button>
        <span className="muted small">{t("pe.or")}</span>
        <input
          className="pe-fix-input"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={t("pe.codePh")}
          onKeyDown={(e) => e.key === "Enter" && ref.trim() && link(ref.trim())}
        />
        <button className="sm ghost" disabled={!ref.trim()} onClick={() => link(ref.trim())}>
          <Link2 size={14} strokeWidth={2} />
          {t("pe.attach")}
        </button>
      </div>
    </div>
  );
}

/** The stack trace is not in the list payload: it is fetched with the incident the first time the trace is opened. */
function StackTrace({ g }: { g: Group }) {
  const { t } = useI18n();
  const [stack, setStack] = useState<string | null>(g.detail.stack ?? null);
  if (!g.detail.stack && !g.detail.has_stack) return null;
  const load = async () => {
    if (stack !== null) return;
    try {
      const r = await api<{ group: { detail: { stack?: string } } }>(
        `/api/prod-errors/${g.fingerprint}`,
      );
      setStack(r.group.detail.stack ?? "");
    } catch (e) {
      setStack((e as Error).message);
    }
  };
  return (
    <details onToggle={(e) => e.currentTarget.open && void load()}>
      <summary className="small">{t("an.stackTrace")}</summary>
      {stack === null ? <Loading /> : <pre className="pe-pre">{stack}</pre>}
    </details>
  );
}

type Source = "logs" | "traces";
/** Trace groups come from SigNoz error spans; log groups from Splunk (groups saved before sources existed are logs). */
const inSource = (g: Group, source: Source) =>
  source === "traces"
    ? !!g.detail.sources?.includes("signoz")
    : !g.detail.sources?.length || g.detail.sources.includes("splunk");

interface HuntSummary {
  id: number;
  run_id: number;
  status: string;
  confirmed: number;
}

/** Compact Bug Hunter state for a collapsed row header (from the batched summary or the expanded row's polling). */
function HuntBadge({ status, confirmed }: { status?: string; confirmed?: number }) {
  const { t } = useI18n();
  if (!status) return null;
  const active = ACTIVE_HUNT.has(status);
  return (
    <span className={`pill pe-hunt bh-${status}`} title={t("an.bh.title")}>
      <Bug size={11} aria-hidden="true" />
      {active || !confirmed
        ? t(`an.bh.status.${status}`)
        : t("an.bh.confirmedBadge", { n: confirmed })}
    </span>
  );
}

function GroupRow({
  g,
  index,
  open,
  onToggle,
  reload,
  hunt,
  huntId,
  huntStatus,
  onHunt,
}: {
  g: Group;
  index: string;
  open: boolean;
  onToggle: () => void;
  reload: () => void;
  hunt?: HuntSummary;
  huntId: number | null;
  huntStatus?: string;
  onHunt: (huntId: number, status?: string) => void;
}) {
  const { t, status } = useI18n();
  const [busy, setBusy] = useState(false);
  const spl = `index=${index} kubernetes.namespace_name="${g.namespace}" kubernetes.container_name="${g.service}"${g.caller ? ` "${g.caller}"` : ""}`;
  const traceOnly = inSource(g, "traces") && !inSource(g, "logs");
  const investigate = async () => {
    setBusy(true);
    const r = await act(() =>
      api<{ created: boolean; code: string }>(`/api/prod-errors/${g.fingerprint}/investigate`, {}),
    );
    setBusy(false);
    if (r) {
      toast(r.created ? t("pe.created", { code: r.code }) : t("pe.exists", { code: r.code }), "ok");
      reload();
    }
  };
  const ignore = async (ignored: boolean) =>
    (await act(
      () => api(`/api/prod-errors/${g.fingerprint}/ignore`, { ignored }),
      ignored ? t("pe.ignoredGroup") : t("pe.watching"),
    )) && reload();
  const runName = (s: string | null) =>
    s ? (status(s).startsWith("status.") ? s : status(s)) : "";
  return (
    <div
      id={`pe-${g.fingerprint}`}
      className={`pe-row${open ? " is-open" : ""}${g.status === "ignored" ? " is-ignored" : ""}`}
    >
      <button className="pe-head" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={16} strokeWidth={2} className="pe-chev" />
        <span className={`pe-sev pe-${g.severity}`}>{t(`pe.sev.${g.severity}`)}</span>
        <span className="pe-svc" title={`${g.namespace} / ${g.service}`}>
          {g.service}
        </span>
        <span className="pe-sig mono" title={g.signature}>
          {g.level === "SLOW" && <span className="pe-slow">{t("pe.slow")}</span>}
          {g.signature}
        </span>
        <span className="pe-num" title={t("pe.todayCount")}>
          {g.today_count.toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB")}
        </span>
        <span className="pe-trend">
          <Trend
            count={g.today_count}
            yesterday={g.yesterday_count}
            noBaseline={g.detail.no_baseline}
          />
        </span>
        <span className="pe-time muted small" title={`${t("pe.latestTip")}: ${dmyHm(g.last_at)}`}>
          {g.last_at ? (
            <>
              <span>{dmy(g.last_at)}</span>
              <span>{hm(g.last_at)}</span>
            </>
          ) : (
            "–"
          )}
        </span>
        <span className="pe-state small">
          {g.work_item_code ? (
            <span
              className="pill chip-brand pe-wi"
              role="link"
              tabIndex={0}
              title={t("pe.openItem", {
                code: g.work_item_code,
                title: g.work_item_title ?? "",
              })}
              onClick={(e) => (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))}
              onKeyDown={(e) =>
                e.key === "Enter" &&
                (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))
              }
            >
              <Bug size={11} />
              {g.work_item_code}
              {g.run_status ? ` · ${runName(g.run_status)}` : ""}
            </span>
          ) : g.status === "ignored" ? (
            <span className="muted">{t("pe.ignored")}</span>
          ) : null}
          <HuntBadge
            status={huntStatus}
            confirmed={huntId == null || huntId === hunt?.id ? hunt?.confirmed : undefined}
          />
        </span>
      </button>
      {open && (
        <div className="pe-body">
          <IncidentWorkbench fingerprint={g.fingerprint} onHunt={onHunt} />
          {g.reasons.length > 0 && (
            <div>
              {g.reasons.map((r) => (
                <span key={r} className="pill">
                  {reasonText(t, r)}
                </span>
              ))}
            </div>
          )}
          <a
            className="btn ghost sm"
            href={`#/prod-errors/incident/${g.fingerprint}?return_to=${encodeURIComponent(location.hash.slice(1))}`}
          >
            {t("an.openIncident")}
          </a>
          <FixRef g={g} busy={busy} onInvestigate={investigate} reload={reload} />
          <dl className="pe-meta small">
            <dt>{t("pe.col.service")}</dt>
            <dd className="mono">
              {g.namespace} / {g.service}
            </dd>
            {g.caller && (
              <>
                <dt>{traceOnly ? t("pe.spanSite") : t("pe.logSite")}</dt>
                <dd className="mono">{g.caller}</dd>
              </>
            )}
            <dt>{t("pe.col.today")}</dt>
            <dd>
              {t("pe.todayLine", {
                count: g.today_count,
                first: dmyHm(g.first_at),
                last: dmyHm(g.last_at),
                yesterday: g.detail.no_baseline ? t("pe.noBaselineLong") : g.yesterday_count,
              })}
            </dd>
            {g.detail.image && (
              <>
                <dt>Image</dt>
                <dd className="mono">{g.detail.image}</dd>
              </>
            )}
            {g.detail.request_id && (
              <>
                <dt>request_id</dt>
                <dd className="mono">
                  {g.detail.request_id}{" "}
                  <Copy
                    text={`index=${index} "${g.detail.request_id}"`}
                    label={t("pe.copyRequest")}
                  />
                </dd>
              </>
            )}
            {g.detail.trace_id && (
              <>
                <dt>trace_id</dt>
                <dd className="mono">
                  {g.detail.trace_id} <Copy text={g.detail.trace_id} label={t("pe.copyTrace")} />
                </dd>
              </>
            )}
          </dl>
          <div>
            <div className="muted small">{traceOnly ? t("pe.traceSample") : t("pe.sample")}</div>
            <pre className="pe-pre">
              {g.sample}
              {g.detail.err ? `\n\nerror: ${g.detail.err}` : ""}
            </pre>
          </div>
          <StackTrace g={g} />
          <BugHunterInline
            fingerprint={g.fingerprint}
            huntId={huntId}
            onHunt={onHunt}
            detailHref={`#/prod-errors/incident/${g.fingerprint}?return_to=${encodeURIComponent(location.hash.slice(1))}`}
          />
          <div className="row tight pe-actions">
            {g.status === "ignored" ? (
              <button className="sm ghost" onClick={() => ignore(false)}>
                <Eye size={14} strokeWidth={2} />
                {t("pe.watchAgain")}
              </button>
            ) : (
              <button className="sm ghost" onClick={() => ignore(true)} title={t("pe.ignoreTip")}>
                <EyeOff size={14} strokeWidth={2} />
                {t("pe.ignore")}
              </button>
            )}
            {!traceOnly && <Copy text={spl} label={t("pe.copySpl")} />}
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
  const scheduleText = s.schedule.join(", ");
  useEffect(() => {
    setTimes(scheduleText);
    setNotify(s.notify);
  }, [scheduleText, s.notify]);
  return (
    <details className="pe-schedule">
      <summary className="small">
        <CalendarClock size={14} />{" "}
        {t("pe.schedule", {
          times: s.schedule.length ? s.schedule.join(", ") : t("pe.scheduleOff"),
        })}
        {s.notify ? ` · ${t("pe.telegram")}` : ""}
      </summary>
      <div className="pe-schedule-body">
        <Field label={t("pe.hours")}>
          <input
            value={times}
            onChange={(e) => setTimes(e.target.value)}
            placeholder="09:00, 14:00, 17:00"
          />
        </Field>
        <label className="row tight small">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />{" "}
          {t("pe.notify")}
        </label>
        <div className="row tight">
          <button
            className="sm"
            onClick={async () =>
              (await act(
                () => api("/api/prod-errors/settings", { schedule: times, notify }),
                t("pe.saved"),
              )) && reload()
            }
          >
            {t("ig.save")}
          </button>
          <span className="muted small">{t("pe.scheduleHint")}</span>
        </div>
      </div>
    </details>
  );
}

/** `focus`: a group fingerprint from the URL (#/prod-errors/<fingerprint>) to open and scroll to. */
export function ProdErrorsPage({
  focus,
  settings = false,
  query: appliedQuery = "",
}: {
  focus?: string;
  settings?: boolean;
  query?: string;
}) {
  const { t } = useI18n();
  const url = new URLSearchParams(appliedQuery);
  const setFilter = useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(appliedQuery);
      if (value) p.set(key, value);
      else p.delete(key);
      if (key === "list_namespace") p.delete("list_service");
      // Severity and service lists differ per tab: a new tab starts from its own defaults.
      if (key === "list_source") {
        p.delete("list_service");
        p.delete("list_severity");
      }
      navigate(`/prod-errors/incidents?${p}`);
    },
    [appliedQuery],
  );
  const all = url.get("list_ignored") === "1";
  const setAll = useCallback((v: boolean) => setFilter("list_ignored", v ? "1" : ""), [setFilter]);
  const { data, error, loading, reload } = useApi<Data>(`/api/prod-errors${all ? "?all=1" : ""}`);
  const ns = url.get("list_namespace") || "all";
  const setNs = (v: string) => setFilter("list_namespace", v);
  const source: Source = url.get("list_source") === "traces" ? "traces" : "logs";
  // Trace groups are rarely critical/high (no day-over-day baseline yet), so that tab lists every severity.
  const sev = url.get("list_severity") || (source === "traces" ? "all" : "attention");
  const setSev = useCallback((v: string) => setFilter("list_severity", v), [setFilter]);
  const service = url.get("list_service") || "";
  const incidentStatus = url.get("list_status") || "";
  const query = url.get("list_search") || "";
  const setQuery = (v: string) => setFilter("list_search", v);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  // a deep link may point at an ignored or medium/low group: widen the filters so it is visible, then scroll to it
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || !data || focused.current) return;
    const g = data.groups.find((x) => x.fingerprint === focus);
    if (!g && !all) return setAll(true);
    if (g && !inSource(g, source))
      return setFilter("list_source", source === "logs" ? "traces" : "");
    focused.current = true;
    if (g && !(g.severity === "critical" || g.severity === "high" || g.work_item_id)) setSev("all");
    setOpen(focus);
    setTimeout(
      () =>
        document
          .getElementById(`pe-${focus}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      50,
    );
  }, [focus, data, all, source, setAll, setFilter, setSev]);

  useEffect(() => {
    if (!data?.scanning) return;
    // Scan progress is in-memory server state, not a workflow event: poll only while a scan runs and the tab is seen.
    const t = setInterval(() => document.visibilityState === "visible" && reload(), 1500);
    return () => clearInterval(t);
  }, [data?.scanning, reload]);

  // announce the end of a scan that was seen running
  const wasScanning = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (wasScanning.current && !data.scanning) {
      const l = data.lastScan;
      if (l?.ok)
        toast(
          t("pe.scanDone", {
            groups: l.groups,
            attention: data.groups.filter((g) => g.severity === "critical" || g.severity === "high")
              .length,
          }),
          "ok",
        );
      else if (l) toast(t("pe.scanFail", { error: l.error ?? "" }));
    }
    wasScanning.current = data.scanning;
  }, [data, t]);

  const tabGroups = useMemo(
    () => (data?.groups ?? []).filter((g) => inSource(g, source)),
    [data, source],
  );
  const groups = useMemo(() => {
    const qq = query.trim().toLowerCase();
    return tabGroups.filter(
      (g) =>
        (ns === "all" || g.namespace === ns) &&
        (sev === "all" ||
          (sev === "attention"
            ? g.severity === "critical" || g.severity === "high" || g.work_item_id
            : g.severity === sev)) &&
        (!service || g.service === service) &&
        (!incidentStatus || g.lifecycle_status === incidentStatus) &&
        (!qq || `${g.service} ${g.signature} ${g.caller} ${g.sample}`.toLowerCase().includes(qq)),
    );
  }, [tabGroups, ns, sev, query, service, incidentStatus]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const g of tabGroups) if (ns === "all" || g.namespace === ns) c[g.severity]++;
    return c;
  }, [tabGroups, ns]);

  // Bug Hunter: one batched summary for the whole list (row headers), never one request per row. Detailed hunt data is
  // fetched by the expanded row only.
  const fingerprints = useMemo(
    () =>
      (data?.groups ?? [])
        .map((g) => g.fingerprint)
        .sort()
        .join(","),
    [data?.groups],
  );
  const huntSummary = useApi<{ hunts: Record<string, HuntSummary> }>(
    fingerprints ? `/api/bug-hunts/summary?fingerprints=${fingerprints}` : null,
  );
  // The hunt each row shows, remembered across collapse/reopen and list refreshes (a hunt started here wins).
  const [huntSel, setHuntSel] = useState<Record<string, number>>({});
  const [huntLive, setHuntLive] = useState<Record<string, string>>({});
  const summaries = huntSummary.data?.hunts ?? {};
  // The expanded row's hunt polls itself; the batched summary only polls for active hunts in collapsed rows.
  usePolling(
    Object.entries(summaries).some(([fp, h]) => ACTIVE_HUNT.has(h.status) && fp !== open),
    huntSummary.reload,
  );
  const onHunt = (fp: string, id: number, status?: string) => {
    setHuntSel((m) => (m[fp] === id ? m : { ...m, [fp]: id }));
    if (!status || huntLive[fp] === status) return;
    setHuntLive((m) => ({ ...m, [fp]: status }));
    // A started or finished hunt: refresh the batched summary once (row header counts), not on every poll.
    if (huntLive[fp] !== undefined || !ACTIVE_HUNT.has(status)) void huntSummary.reload();
  };

  const [panel, setPanel] = useState(false);
  const last = data?.lastScan;
  const lastOk = data?.lastOk;

  return (
    <>
      {settings && (
        <div className="pe-scan-actions">
          <button
            disabled={!data || data.scanning || !(data.splunk.connected || data.signoz?.connected)}
            onClick={() => setPanel((v) => !v)}
            aria-expanded={panel}
          >
            <RefreshCw size={15} className={data?.scanning ? "spin" : ""} />
            {data?.scanning ? t("pe.scanning") : t("pe.scanNow")}
          </button>
        </div>
      )}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {!data && !loading && !error && <EmptyState icon={Siren} title={t("pe.noData")} />}
      {data && (
        <>
          {settings && panel && !data.scanning && (
            <ScanPanel data={data} onStarted={reload} onClose={() => setPanel(false)} />
          )}
          {data.scanning && (
            <ScanProgressCard
              progress={data.progress}
              startedAt={last?.started_at}
              typicalSeconds={secs(lastOk?.started_at, lastOk?.finished_at)}
            />
          )}
          <div className="pe-status small">
            {!data.splunk.connected && !data.signoz?.connected ? (
              <span className="pe-warn">
                {data.splunk.expired ? t("pe.sessionExpired") : t("pe.noSource")} —{" "}
                <a href="#/integrations">
                  {data.splunk.expired ? t("pe.pasteCookie") : t("pe.connectSource")}
                </a>
              </span>
            ) : !data.splunk.connected ? (
              <span className="pe-warn">
                {data.splunk.expired ? t("pe.sessionExpired") : t("pe.notConnected")} (
                {t("pe.signozOnly")}) — <a href="#/integrations">{t("pe.pasteCookie")}</a>
              </span>
            ) : data.signoz?.connected ? (
              <span>{t("pe.sources", { sources: "Splunk · SigNoz" })}</span>
            ) : null}
            {data.scanning ? null : last ? (
              last.ok ? (
                <span>
                  {t("pe.lastOk", {
                    ago: ago(last.finished_at),
                    secs: secs(last.started_at, last.finished_at) ?? "–",
                    groups: last.groups,
                    extra: last.trigger === "schedule" ? t("pe.scheduled") : "",
                  })}
                  {last.error && <span className="pe-warn"> · {last.error}</span>}
                </span>
              ) : (
                <span className="pe-warn">
                  {t("pe.lastFail", {
                    ago: ago(last.started_at),
                    error: last.error ?? "",
                  })}
                  {lastOk && (
                    <span className="muted">
                      {" "}
                      · {t("pe.staleData", { ago: ago(lastOk.finished_at) })}
                    </span>
                  )}
                </span>
              )
            ) : (
              <span>{t("pe.never")}</span>
            )}
            {data.shown ? (
              <span className="pe-shown">
                {t("pe.shown", {
                  window: t(`pe.preset.${data.shown.preset || "custom"}`),
                  range: `${dt(data.shown.window_start)} – ${dt(data.shown.window_end)}`,
                  projects:
                    data.namespaces
                      .filter((n) => (data.shown!.namespaces ?? []).includes(n.namespace))
                      .map((n) => n.project)
                      .join(", ") || "—",
                })}
              </span>
            ) : (
              data.day !== data.today &&
              last && <span className="pe-warn">{t("pe.oldDay", { day: data.day })}</span>
            )}
          </div>
          {settings && <Schedule s={data.settings} reload={reload} />}

          {!settings && (
            <>
              <div className="pe-source">
                <Segmented<Source>
                  label={t("pe.sourceLabel")}
                  options={[
                    [
                      "logs",
                      t("pe.tab.logs", {
                        n: data.groups.filter((g) => inSource(g, "logs")).length,
                      }),
                    ],
                    [
                      "traces",
                      t("pe.tab.traces", {
                        n: data.groups.filter((g) => inSource(g, "traces")).length,
                      }),
                    ],
                  ]}
                  value={source}
                  onChange={(v) => setFilter("list_source", v === "logs" ? "" : v)}
                />
              </div>
              <FilterToolbar
                className="pe-filters"
                secondary={
                  <>
                    <SearchInput
                      value={query}
                      onChange={setQuery}
                      placeholder={t("pe.search")}
                      width="100%"
                    />
                    <label className="row tight small muted">
                      <input
                        type="checkbox"
                        checked={all}
                        onChange={(e) => setAll(e.target.checked)}
                      />{" "}
                      {t("pe.showIgnored", { n: data.ignored })}
                    </label>
                  </>
                }
              >
                <FilterField label={t("pe.system")}>
                  <select
                    aria-label={t("pe.system")}
                    value={ns}
                    onChange={(e) => setNs(e.target.value)}
                  >
                    <option value="all">{t("pe.all")}</option>
                    {data.namespaces.map((n) => (
                      <option key={n.namespace} value={n.namespace}>
                        {n.project}
                      </option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label={t("an.severity")}>
                  <select
                    aria-label={t("an.severity")}
                    value={sev}
                    onChange={(e) => setSev(e.target.value)}
                  >
                    <option value="attention">
                      {t("pe.attention", { n: counts.critical + counts.high })}
                    </option>
                    <option value="all">{t("an.all")}</option>
                    {(["critical", "high", "medium", "low"] as const).map((k) => (
                      <option key={k} value={k}>
                        {t(`pe.sev.${k}`)}
                      </option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label={t("an.service")}>
                  <select
                    aria-label={t("an.service")}
                    value={service}
                    onChange={(e) => setFilter("list_service", e.target.value)}
                  >
                    <option value="">{t("an.all")}</option>
                    {[
                      ...new Set(
                        tabGroups
                          .filter((g) => ns === "all" || g.namespace === ns)
                          .map((g) => g.service),
                      ),
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label={t("an.incident_status")}>
                  <select
                    aria-label={t("an.incident_status")}
                    value={incidentStatus}
                    onChange={(e) => setFilter("list_status", e.target.value)}
                  >
                    <option value="">{t("an.all")}</option>
                    {["open", "acknowledged", "resolved"].map((v) => (
                      <option key={v} value={v}>
                        {t(`an.${v}`)}
                      </option>
                    ))}
                  </select>
                </FilterField>
              </FilterToolbar>

              {groups.length === 0 ? (
                <EmptyState
                  icon={Siren}
                  title={
                    tabGroups.length
                      ? t("pe.noMatch")
                      : source === "traces"
                        ? t("pe.noTraces")
                        : last
                          ? t("pe.none")
                          : t("pe.noData")
                  }
                >
                  {sev === "attention" && tabGroups.length
                    ? t("pe.widen")
                    : source === "traces" && !tabGroups.length && !data.signoz?.connected
                      ? t("pe.connectSignoz")
                      : null}
                </EmptyState>
              ) : (
                <div className="pe-list">
                  <div className="pe-cols small muted" aria-hidden>
                    <span />
                    <span>{t("pe.col.level")}</span>
                    <span>{t("pe.col.service")}</span>
                    <span>{t("pe.col.error")}</span>
                    <span className="pe-num">
                      {!data.shown || data.shown.preset === "today"
                        ? t("pe.col.today")
                        : t("pe.col.window")}
                    </span>
                    <span>
                      {!data.shown || data.shown.preset === "today"
                        ? t("pe.col.yesterday")
                        : t("pe.col.baseline")}
                    </span>
                    <span>{t("pe.col.latest")}</span>
                    <span />
                  </div>
                  {groups.map((g) => (
                    <GroupRow
                      key={g.fingerprint}
                      g={g}
                      index={
                        data.namespaces.find((n) => n.namespace === g.namespace)?.index ??
                        "k8s_prod"
                      }
                      open={open === g.fingerprint}
                      onToggle={() => setOpen(open === g.fingerprint ? null : g.fingerprint)}
                      reload={reload}
                      hunt={summaries[g.fingerprint]}
                      huntId={huntSel[g.fingerprint] ?? summaries[g.fingerprint]?.id ?? null}
                      huntStatus={
                        open === g.fingerprint ||
                        huntSel[g.fingerprint] !== summaries[g.fingerprint]?.id
                          ? (huntLive[g.fingerprint] ?? summaries[g.fingerprint]?.status)
                          : summaries[g.fingerprint]?.status
                      }
                      onHunt={(id, status) => onHunt(g.fingerprint, id, status)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
