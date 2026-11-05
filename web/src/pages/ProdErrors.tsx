import { useEffect, useMemo, useRef, useState } from "react";
import { Bug, CalendarClock, ChevronRight, Eye, EyeOff, GitPullRequest, Link2, PlayCircle, RefreshCw, Siren, TrendingDown, TrendingUp, Unlink } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, ago, Copy, EmptyState, ErrorBox, Field, Loading, PageHeader, SearchInput, Segmented, navigate, toast } from "../ui.tsx";
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

const SEV_LABEL: Record<Sev, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const hm = (t: string | null) => (t ? new Date(t).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "–");
const secs = (a?: string, b?: string) => (a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000) : null);

function Trend({ t, y }: { t: number; y: number }) {
  if (y === 0) return <span className="pe-new">mới</span>;
  const r = t / y;
  if (r >= 1.5) return <span className="pe-up" title={`hôm qua cùng giờ ${y}`}><TrendingUp size={13} /> ×{r >= 10 ? Math.round(r) : r.toFixed(1)}</span>;
  if (r <= 0.5) return <span className="pe-down" title={`hôm qua cùng giờ ${y}`}><TrendingDown size={13} /> {y}</span>;
  return <span className="muted" title="hôm qua cùng giờ">{y}</span>;
}

const RUN_LABEL: Record<string, string> = {
  PENDING: "chưa chạy", QUEUED: "đang chờ", RUNNING: "đang chạy", WAITING: "chờ bạn", WAITING_INPUT: "chờ trả lời", WAITING_APPROVAL: "chờ duyệt",
  PAUSED: "tạm dừng", COMPLETED: "xong", FAILED: "lỗi", CANCELED: "đã huỷ",
};
const runLabel = (s: string | null) => (s ? RUN_LABEL[s] ?? s.toLowerCase() : "");

/** The work item fixing this error: link to it, its latest run and PRs; or create one / attach an existing one. */
function FixRef({ g, busy, onInvestigate, reload }: { g: Group; busy: boolean; onInvestigate: () => void; reload: () => void }) {
  const [ref, setRef] = useState("");
  const link = async (work_item: string) => (await act(() => api(`/api/prod-errors/${g.fingerprint}/link`, { work_item }), work_item ? `Đã gắn ${work_item}` : "Đã bỏ liên kết")) && (setRef(""), reload());
  if (g.work_item_id)
    return (
      <div className="pe-fix is-linked">
        <div className="pe-fix-label small muted">Work item đang fix lỗi này</div>
        <div className="pe-fix-main">
          <a className="pe-fix-code mono" href={`#/work-items/${g.work_item_id}`}><Bug size={14} strokeWidth={2} />{g.work_item_code}</a>
          <a className="pe-fix-title" href={`#/work-items/${g.work_item_id}`} title={g.work_item_title ?? ""}>{g.work_item_title}</a>
        </div>
        <div className="pe-fix-links small">
          {g.run_id ? <a href={`#/runs/${g.run_id}`}><PlayCircle size={13} />Run #{g.run_id} · <b className={`pe-run-${(g.run_status ?? "").toLowerCase()}`}>{runLabel(g.run_status)}</b></a> : <span className="muted">chưa có run</span>}
          {g.pull_requests.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noopener"><GitPullRequest size={13} />{p.repo}: {p.title}</a>)}
          <button className="xs ghost" onClick={() => link("")} title="Gỡ work item khỏi nhóm lỗi (không xoá work item)"><Unlink size={12} />Bỏ liên kết</button>
        </div>
      </div>
    );
  return (
    <div className="pe-fix">
      <div className="pe-fix-label small muted">Chưa có work item fix lỗi này</div>
      <div className="row tight">
        <button className="sm" disabled={busy} onClick={onInvestigate} title="Tạo work item Bug Investigation; workflow dừng chờ bạn duyệt trước khi sửa code">
          <Bug size={14} strokeWidth={2} />{busy ? "Đang tạo…" : "Điều tra (tạo work item)"}
        </button>
        <span className="muted small">hoặc</span>
        <input className="pe-fix-input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Mã work item có sẵn, vd HSK-123" onKeyDown={(e) => e.key === "Enter" && ref.trim() && link(ref.trim())} />
        <button className="sm ghost" disabled={!ref.trim()} onClick={() => link(ref.trim())}><Link2 size={14} strokeWidth={2} />Gắn</button>
      </div>
    </div>
  );
}

function GroupRow({ g, open, onToggle, reload }: { g: Group; open: boolean; onToggle: () => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const spl = `index=k8s_prod kubernetes.namespace_name="${g.namespace}" kubernetes.container_name="${g.service}"${g.caller ? ` "${g.caller}"` : ""}`;
  const investigate = async () => {
    setBusy(true);
    const r = await act(() => api<any>(`/api/prod-errors/${g.fingerprint}/investigate`, {}));
    setBusy(false);
    if (r) {
      toast(r.created ? `Đã tạo ${r.code} và chạy Bug Investigation` : `Đã có ${r.code}`, "ok");
      reload();
    }
  };
  const ignore = async (ignored: boolean) => (await act(() => api(`/api/prod-errors/${g.fingerprint}/ignore`, { ignored }), ignored ? "Đã bỏ qua nhóm lỗi này" : "Đã theo dõi lại")) && reload();
  return (
    <div id={`pe-${g.fingerprint}`} className={`pe-row${open ? " is-open" : ""}${g.status === "ignored" ? " is-ignored" : ""}`}>
      <button className="pe-head" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={16} strokeWidth={2} className="pe-chev" />
        <span className={`pe-sev pe-${g.severity}`}>{SEV_LABEL[g.severity]}</span>
        <span className="pe-svc" title={g.namespace}>{g.service}</span>
        <span className="pe-sig mono" title={g.signature}>{g.signature}</span>
        <span className="pe-num" title="số lần hôm nay">{g.today_count.toLocaleString("vi-VN")}</span>
        <span className="pe-trend"><Trend t={g.today_count} y={g.yesterday_count} /></span>
        <span className="pe-time muted small" title="lần gần nhất">{hm(g.last_at)}</span>
        <span className="pe-state small">
          {g.work_item_code ? (
            <span className="pill chip-brand pe-wi" role="link" tabIndex={0} title={`Mở ${g.work_item_code}: ${g.work_item_title ?? ""}`}
              onClick={(e) => (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))}
              onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), navigate(`/work-items/${g.work_item_id}`))}>
              <Bug size={11} />{g.work_item_code}{g.run_status ? ` · ${runLabel(g.run_status)}` : ""}
            </span>
          ) : g.status === "ignored" ? <span className="muted">đã bỏ qua</span> : null}
        </span>
      </button>
      {open && (
        <div className="pe-body">
          {g.reasons.length > 0 && <div>{g.reasons.map((r) => <span key={r} className="pill">{r}</span>)}</div>}
          <FixRef g={g} busy={busy} onInvestigate={investigate} reload={reload} />
          <dl className="pe-meta small">
            <dt>Service</dt><dd className="mono">{g.namespace} / {g.service}</dd>
            {g.caller && <><dt>Vị trí log</dt><dd className="mono">{g.caller}</dd></>}
            <dt>Hôm nay</dt><dd>{g.today_count} lần · lần đầu {hm(g.first_at)} · gần nhất {hm(g.last_at)} · hôm qua cùng khung giờ {g.yesterday_count}</dd>
            {g.detail.image && <><dt>Image</dt><dd className="mono">{g.detail.image}</dd></>}
            {g.detail.request_id && <><dt>request_id</dt><dd className="mono">{g.detail.request_id} <Copy text={`index=k8s_prod "${g.detail.request_id}"`} label="Copy SPL theo request" /></dd></>}
          </dl>
          <div>
            <div className="muted small">Log mẫu (đã che PII)</div>
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
              <button className="sm ghost" onClick={() => ignore(false)}><Eye size={14} strokeWidth={2} />Theo dõi lại</button>
            ) : (
              <button className="sm ghost" onClick={() => ignore(true)} title="Ẩn nhóm lỗi này ở các lần quét sau và không báo Telegram"><EyeOff size={14} strokeWidth={2} />Bỏ qua</button>
            )}
            <Copy text={spl} label="Copy SPL" />
          </div>
        </div>
      )}
    </div>
  );
}

function Schedule({ s, reload }: { s: Data["settings"]; reload: () => void }) {
  const [times, setTimes] = useState(s.schedule.join(", "));
  const [notify, setNotify] = useState(s.notify);
  useEffect(() => (setTimes(s.schedule.join(", ")), setNotify(s.notify)), [s.schedule.join(), s.notify]);
  return (
    <details className="pe-schedule">
      <summary className="small"><CalendarClock size={14} /> Tự quét lúc {s.schedule.length ? s.schedule.join(", ") : "(tắt)"}{s.notify ? " · báo Telegram" : ""}</summary>
      <div className="pe-schedule-body">
        <Field label="Giờ quét (giờ VN, cách nhau dấu phẩy; để trống để tắt)">
          <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="09:00, 14:00, 17:00" />
        </Field>
        <label className="row tight small"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Gửi Telegram khi có nhóm lỗi critical/high mới (mỗi nhóm một lần/ngày), và khi phiên Splunk hết hạn</label>
        <div className="row tight">
          <button className="sm" onClick={async () => (await act(() => api("/api/prod-errors/settings", { schedule: times, notify }), "Đã lưu lịch quét")) && reload()}>Lưu</button>
          <span className="muted small">Platform phải đang chạy vào giờ quét; phiên Splunk hết hạn thì lượt quét báo lỗi.</span>
        </div>
      </div>
    </details>
  );
}

/** `focus`: a group fingerprint from the URL (#/prod-errors/<fingerprint>) to open and scroll to. */
export function ProdErrorsPage({ focus }: { focus?: string }) {
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
      if (l?.ok) toast(`Quét xong: ${l.groups} nhóm lỗi, ${data.groups.filter((g) => g.severity === "critical" || g.severity === "high").length} cần xem`, "ok");
      else if (l) toast(`Quét lỗi: ${l.error}`);
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
        title="Lỗi production"
        subtitle={<>Log ERROR/panic của {data?.namespaces.map((n) => n.project).join(" và ") ?? "OMS và payment"} trên Splunk từ 0h hôm nay, so với cùng khung giờ hôm qua. Quét bằng SPL cố định (không tốn token); chỉ khi bấm <b>Điều tra</b> agent mới chạy.</>}
        actions={
          <button disabled={!data || data.scanning || !data.splunk.connected} onClick={scan} title={data && !data.splunk.connected ? "Kết nối Splunk ở trang Integrations trước" : undefined}>
            <RefreshCw size={15} strokeWidth={2} className={data?.scanning ? "spin" : ""} />{data?.scanning ? "Đang quét…" : "Quét ngay"}
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
                {data.splunk.expired ? "Phiên Splunk đã hết hạn" : "Chưa kết nối Splunk"} — <a href="#/integrations">dán cookie ở Integrations</a>
              </span>
            )}
            {data.scanning ? null : last ? (
              last.ok ? (
                <span>Quét lần cuối {ago(last.finished_at)} ({secs(last.started_at, last.finished_at)}s, {last.groups} nhóm{last.trigger === "schedule" ? ", theo lịch" : ""}){last.error && <span className="pe-warn"> · {last.error}</span>}</span>
              ) : (
                <span className="pe-warn">Lần quét {ago(last.started_at)} lỗi: {last.error}{lastOk && <span className="muted"> · dữ liệu bên dưới từ lần quét {ago(lastOk.finished_at)}</span>}</span>
              )
            ) : (
              <span>Chưa quét lần nào — bấm <b>Quét ngay</b>.</span>
            )}
            {data.day !== data.today && last && <span className="pe-warn">Dữ liệu của ngày {data.day}, hôm nay chưa quét.</span>}
          </div>
          <Schedule s={data.settings} reload={reload} />

          <div className="row pe-filters">
            <Segmented label="Hệ thống" value={ns} onChange={setNs} options={[["all", "Tất cả"], ...data.namespaces.map((n) => [n.namespace, n.project] as [string, string])]} />
            <Segmented label="Mức" value={sev} onChange={setSev} options={[["attention", `Cần xem (${counts.critical + counts.high})`], ["all", `Tất cả (${counts.critical + counts.high + counts.medium + counts.low})`]]} />
            <SearchInput value={query} onChange={setQuery} placeholder="Tìm service, message…" />
            <label className="row tight small muted"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Hiện nhóm đã bỏ qua ({data.ignored})</label>
          </div>

          {groups.length === 0 ? (
            <EmptyState icon={Siren} title={data.groups.length ? "Không có nhóm lỗi nào khớp bộ lọc" : last ? "Không có lỗi nào" : "Chưa có dữ liệu"}>
              {sev === "attention" && data.groups.length ? <>Không có nhóm critical/high. Chọn <b>Tất cả</b> để xem nhóm medium/low.</> : null}
            </EmptyState>
          ) : (
            <div className="pe-list">
              <div className="pe-cols small muted" aria-hidden>
                <span /><span>Mức</span><span>Service</span><span>Lỗi</span><span className="pe-num">Hôm nay</span><span>Hôm qua</span><span>Gần nhất</span><span />
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
