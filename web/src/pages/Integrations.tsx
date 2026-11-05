import { useState } from "react";
import { Clock, ExternalLink, KeyRound, LogOut, PlugZap, RefreshCw, Server, ShieldAlert, Waypoints } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, Badge, Field, PageHeader, time } from "../ui.tsx";
import "./WorkItems.css";

interface ArgoStatus {
  baseUrl: string;
  loggedIn: boolean;
  user: string | null;
  expiresAt: string | null;
  expired: boolean;
}

function ArgoCdCard() {
  const { data: st, reload } = useApi<ArgoStatus>("/api/integrations/argocd");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api("/api/integrations/argocd/token", { token }), "Đã kết nối Argo CD");
    setBusy(false);
    if (r) (setToken(""), reload());
  };
  return (
    <section className="card">
      <div className="card-head">
        <span className="wi-hicon"><Server size={16} strokeWidth={2} /></span>
        <h4>Argo CD · QC</h4>
        {st && (st.loggedIn ? <Badge s="COMPLETED">đã kết nối</Badge> : st.expired ? <Badge s="FAILED">token hết hạn</Badge> : <Badge s="PENDING">chưa kết nối</Badge>)}
      </div>
      <p className="muted small">
        Agent đọc log pod trên QC khi điều tra bug (tool <span className="mono">argocd.list_apps</span>, <span className="mono">argocd.app_pods</span>,{" "}
        <span className="mono">argocd.pod_logs</span>, chỉ đọc).
      </p>
      {st?.loggedIn && (
        <div className="stack">
          <div className="small">Đăng nhập là <b>{st.user || "?"}</b></div>
          {st.expiresAt && <div className="muted small wi-hexp"><Clock size={12} strokeWidth={2} /> token hết hạn {time(st.expiresAt)}</div>}
        </div>
      )}
      <div className="stack wi-hlogin">
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Mở{" "}
            <a href={st?.baseUrl ?? "https://argocd-qc-v2.hasaki.dev"} target="_blank" rel="noreferrer">
              {st?.baseUrl ?? "Argo CD"} <ExternalLink size={11} />
            </a>{" "}
            bằng trình duyệt của bạn và đăng nhập (Keycloak).
          </li>
          <li>DevTools (F12) → Application → Cookies → copy giá trị <span className="mono">argocd.token</span>. Nếu có thêm <span className="mono">argocd.token-1</span>…, copy cả header Cookie ở tab Network.</li>
          <li>Dán vào ô dưới và bấm Lưu. Platform kiểm tra token với Argo CD trước khi lưu.</li>
        </ol>
        <Field label={st?.loggedIn ? "Thay token" : "Token"}>
          <textarea rows={3} className="mono" placeholder="eyJhbGciOi…  hoặc  argocd.token=eyJ…; argocd.token-1=…" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <div className="wi-inline">
          <button className="sm" disabled={!token.trim() || busy} onClick={save}><KeyRound size={14} strokeWidth={2} />{busy ? "Đang kiểm tra…" : "Lưu"}</button>
          {(st?.loggedIn || st?.expired) && (
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/argocd/logout", {}), "Đã xoá token")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>
          )}
        </div>
      </div>
    </section>
  );
}

interface SplunkStatus {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  roles: string[];
  checkedAt: string | null;
  limits: { maxMinutes: number; maxResults: number; allowedIndexes: string[] };
}

function SplunkCard() {
  const { data: st, reload } = useApi<SplunkStatus>("/api/integrations/splunk");
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api("/api/integrations/splunk/cookie", { cookie }), "Đã kết nối Splunk");
    setBusy(false);
    if (r) (setCookie(""), reload());
  };
  const check = async () => (await act(() => api("/api/integrations/splunk?check=1"))) && reload();
  return (
    <section className="card">
      <div className="card-head">
        <span className="wi-hicon"><ShieldAlert size={16} strokeWidth={2} /></span>
        <h4>Splunk · Production</h4>
        {st && (st.connected ? <Badge s="COMPLETED">đã kết nối</Badge> : st.expired ? <Badge s="FAILED">phiên hết hạn</Badge> : <Badge s="PENDING">chưa kết nối</Badge>)}
      </div>
      <p className="muted small">
        Agent tìm log production bằng <span className="mono">splunk.search</span> (chỉ đọc). Lệnh SPL ghi dữ liệu bị chặn; mỗi lần tìm tối đa{" "}
        {st ? Math.round(st.limits.maxMinutes / 60) : "…"} giờ và {st?.limits.maxResults ?? "…"} dòng; e-mail, số điện thoại, số thẻ và credential được che.
        {st?.limits.allowedIndexes.length ? <> Index được phép: <span className="mono">{st.limits.allowedIndexes.join(", ")}</span>.</> : null}
      </p>
      {st?.user && (
        <div className="stack">
          <div className="small">Phiên của <b>{st.user}</b>{st.roles.length ? <span className="muted"> · roles {st.roles.join(", ")}</span> : null}</div>
          {st.checkedAt && <div className="muted small wi-hexp"><Clock size={12} strokeWidth={2} /> kiểm tra lần cuối {time(st.checkedAt)} · phiên Splunk Web hết hạn khi không dùng một thời gian</div>}
        </div>
      )}
      <div className="stack wi-hlogin">
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Mở{" "}
            <a href={st?.baseUrl ?? "https://siem.hasaki.work"} target="_blank" rel="noreferrer">
              {st?.baseUrl ?? "Splunk"} <ExternalLink size={11} />
            </a>{" "}
            và đăng nhập Google như bình thường.
          </li>
          <li>F12 → Network → bấm một request bất kỳ tới <span className="mono">siem.hasaki.work</span> → Request Headers → copy toàn bộ giá trị <span className="mono">Cookie</span> (cần có <span className="mono">splunkd_…</span> và <span className="mono">splunkweb_csrf_token_…</span>). Hoặc chuột phải request → Copy as cURL rồi dán cả lệnh.</li>
          <li>Dán vào ô dưới và bấm Lưu. Platform kiểm tra phiên với Splunk trước khi lưu.</li>
        </ol>
        <Field label={st?.connected ? "Thay cookie" : "Cookie"}>
          <textarea rows={3} className="mono" placeholder="splunkd_8000=…; splunkweb_csrf_token_8000=…; …" value={cookie} onChange={(e) => setCookie(e.target.value)} />
        </Field>
        <div className="wi-inline">
          <button className="sm" disabled={!cookie.trim() || busy} onClick={save}><KeyRound size={14} strokeWidth={2} />{busy ? "Đang kiểm tra…" : "Lưu"}</button>
          {st?.user && <button className="sm ghost" onClick={check}><RefreshCw size={14} strokeWidth={2} />Kiểm tra phiên</button>}
          {st?.user && (
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/splunk/logout", {}), "Đã xoá cookie")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>
          )}
        </div>
      </div>
    </section>
  );
}

interface KafkaStatus {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  checkedAt: string | null;
  clusters?: Array<{ name: string; status: string; brokers: number; topics: number }>;
}

function KafkaCard() {
  const { data: st, reload } = useApi<KafkaStatus>("/api/integrations/kafka?check=1");
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api("/api/integrations/kafka/cookie", { cookie }), "Đã kết nối Kafka UI");
    setBusy(false);
    if (r) (setCookie(""), reload());
  };
  return (
    <section className="card">
      <div className="card-head">
        <span className="wi-hicon"><Waypoints size={16} strokeWidth={2} /></span>
        <h4>Kafka UI · QC</h4>
        {st && (st.connected ? <Badge s="COMPLETED">đã kết nối</Badge> : st.expired ? <Badge s="FAILED">phiên hết hạn</Badge> : <Badge s="PENDING">chưa kết nối</Badge>)}
      </div>
      <p className="muted small">
        Agent xem topic, consumer group (lag) và tìm message trên QC (<span className="mono">kafka.list_topics</span>, <span className="mono">kafka.consumer_groups</span>,{" "}
        <span className="mono">kafka.read_messages</span>). Platform chỉ gửi request GET: không produce, không xoá topic, không reset offset.
      </p>
      {st?.connected && (
        <div className="stack">
          {st.user && <div className="small">Phiên của <b>{st.user}</b></div>}
          {st.clusters?.map((c) => (
            <div key={c.name} className="small"><span className="mono">{c.name}</span> <span className="muted">· {c.status} · {c.brokers} broker · {c.topics} topic</span></div>
          ))}
          {st.checkedAt && <div className="muted small wi-hexp"><Clock size={12} strokeWidth={2} /> kiểm tra lần cuối {time(st.checkedAt)}</div>}
        </div>
      )}
      <div className="stack wi-hlogin">
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Mở{" "}
            <a href={st?.baseUrl ?? "https://kafka-ui-qc-v2.hasaki.dev"} target="_blank" rel="noreferrer">
              {st?.baseUrl ?? "Kafka UI"} <ExternalLink size={11} />
            </a>{" "}
            và đăng nhập Google.
          </li>
          <li>F12 → Network → bấm một request tới <span className="mono">/api/…</span> → copy giá trị header <span className="mono">Cookie</span> (cần có <span className="mono">SESSION</span>), hoặc Copy as cURL.</li>
          <li>Dán vào ô dưới và bấm Lưu.</li>
        </ol>
        <Field label={st?.connected ? "Thay cookie" : "Cookie"}>
          <textarea rows={3} className="mono" placeholder="SESSION=…" value={cookie} onChange={(e) => setCookie(e.target.value)} />
        </Field>
        <div className="wi-inline">
          <button className="sm" disabled={!cookie.trim() || busy} onClick={save}><KeyRound size={14} strokeWidth={2} />{busy ? "Đang kiểm tra…" : "Lưu"}</button>
          {(st?.connected || st?.expired) && <button className="sm ghost" onClick={reload}><RefreshCw size={14} strokeWidth={2} />Kiểm tra phiên</button>}
          {(st?.connected || st?.expired) && (
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/kafka/logout", {}), "Đã xoá cookie")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>
          )}
        </div>
      </div>
    </section>
  );
}

export function IntegrationsPage() {
  return (
    <>
      <PageHeader icon={PlugZap} title="Integrations" subtitle="Kết nối hệ thống ngoài mà agent dùng để điều tra (chỉ đọc)." />
      <div className="grid" style={{ display: "grid", gap: "var(--sp-4)", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))" }}>
        <ArgoCdCard />
        <KafkaCard />
        <SplunkCard />
      </div>
    </>
  );
}
