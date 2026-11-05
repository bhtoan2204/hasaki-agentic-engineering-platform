import { useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, GitPullRequest, KeyRound, LockKeyhole, LogOut, PlugZap, RefreshCw, Search, Send, Server, ShieldAlert, Upload, Waypoints, type LucideIcon } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, Field, PageHeader, time } from "../ui.tsx";
import "./Integrations.css";

type Health = "ok" | "expired" | "off" | "loading";

function StatusPill({ h }: { h: Health }) {
  const label = { ok: "đã kết nối", expired: "hết hạn", off: "chưa kết nối", loading: "…" }[h];
  return <span className={`ig-pill ig-${h}`}><span className="ig-dot" />{label}</span>;
}

/** One integration: a compact row; clicking it reveals the instructions and the inputs. */
function Row({ id, icon: I, title, env, health, summary, open, onToggle, children }: {
  id: string; icon: LucideIcon; title: string; env?: string; health: Health; summary?: ReactNode; open: boolean; onToggle: (id: string) => void; children: ReactNode;
}) {
  return (
    <div className={`ig-row${open ? " is-open" : ""}`}>
      <button className="ig-head" aria-expanded={open} aria-controls={`ig-${id}`} onClick={() => onToggle(id)}>
        <ChevronRight size={16} strokeWidth={2} className="ig-chev" />
        <span className="ig-icon"><I size={16} strokeWidth={2} /></span>
        <span className="ig-title">{title}{env && <span className="ig-env">{env}</span>}</span>
        <span className="ig-summary muted small">{summary}</span>
        <StatusPill h={health} />
      </button>
      {open && <div className="ig-body" id={`ig-${id}`}>{children}</div>}
    </div>
  );
}

const Link = ({ href }: { href: string }) => (
  <a href={href} target="_blank" rel="noreferrer">{href.replace(/^https?:\/\//, "")} <ExternalLink size={11} /></a>
);
const Steps = ({ children }: { children: ReactNode }) => <ol className="ig-steps small">{children}</ol>;
const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

/** Paste-a-secret form shared by Argo CD, Kafka UI and Splunk. */
function PasteForm({ label, placeholder, busyLabel = "Đang kiểm tra…", onSave, extra }: { label: string; placeholder: string; busyLabel?: string; onSave: (v: string) => Promise<unknown>; extra?: ReactNode }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Field label={label}>
        <textarea rows={3} className="mono" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="ig-actions">
        <button className="sm" disabled={!value.trim() || busy} onClick={async () => {
          setBusy(true);
          const ok = await onSave(value);
          setBusy(false);
          if (ok) setValue("");
        }}><KeyRound size={14} strokeWidth={2} />{busy ? busyLabel : "Lưu"}</button>
        {extra}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- investigation sources (agent tools, read-only)

function ArgoCd(p: { open: boolean; onToggle: (id: string) => void }) {
  const { data: st, reload } = useApi<any>("/api/integrations/argocd");
  const health: Health = !st ? "loading" : st.loggedIn ? "ok" : st.expired ? "expired" : "off";
  return (
    <Row id="argocd" icon={Server} title="Argo CD" env="QC" health={health} {...p}
      summary={st?.loggedIn ? <>{st.user}{st.expiresAt && <> · hết hạn {time(st.expiresAt)}</>}</> : "Log pod trên QC"}>
      <p className="muted small">Agent đọc log pod trên QC khi điều tra bug: <Mono>argocd.list_apps</Mono>, <Mono>argocd.app_pods</Mono>, <Mono>argocd.pod_logs</Mono> (chỉ đọc).</p>
      <Steps>
        <li>Mở <Link href={st?.baseUrl ?? "https://argocd-qc-v2.hasaki.dev"} /> và đăng nhập (Keycloak).</li>
        <li>F12 → Application → Cookies → copy giá trị <Mono>argocd.token</Mono>. Có thêm <Mono>argocd.token-1</Mono>… thì copy cả header Cookie (hoặc Copy as cURL) ở tab Network.</li>
        <li>Dán vào ô dưới và bấm Lưu. Platform kiểm tra token với Argo CD trước khi lưu.</li>
      </Steps>
      <PasteForm label={st?.loggedIn ? "Thay token" : "Token"} placeholder="eyJhbGciOi…  hoặc  argocd.token=eyJ…; argocd.token-1=…"
        onSave={async (token) => (await act(() => api("/api/integrations/argocd/token", { token }), "Đã kết nối Argo CD")) && (reload(), true)}
        extra={(st?.loggedIn || st?.expired) && <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/argocd/logout", {}), "Đã xoá token")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>} />
    </Row>
  );
}

function Kafka(p: { open: boolean; onToggle: (id: string) => void }) {
  const { data: st, reload } = useApi<any>("/api/integrations/kafka?check=1");
  const health: Health = !st ? "loading" : st.connected ? "ok" : st.expired ? "expired" : "off";
  return (
    <Row id="kafka" icon={Waypoints} title="Kafka UI" env="QC" health={health} {...p}
      summary={st?.connected ? <>{st.user ?? "đã đăng nhập"}{st.clusters?.map((c: any) => <span key={c.name}> · {c.name} ({c.topics} topic)</span>)}</> : "Topic, consumer lag, message"}>
      <p className="muted small">Agent xem topic, consumer group (lag) và tìm message: <Mono>kafka.list_topics</Mono>, <Mono>kafka.consumer_groups</Mono>, <Mono>kafka.read_messages</Mono>. Platform chỉ gửi GET: không produce, không xoá topic, không reset offset.</p>
      <Steps>
        <li>Mở <Link href={st?.baseUrl ?? "https://kafka-ui-qc-v2.hasaki.dev"} /> và đăng nhập Google.</li>
        <li>F12 → Network → chuột phải một request tới <Mono>/api/…</Mono> → Copy as cURL (cmd hoặc bash), hoặc copy header <Mono>Cookie</Mono> (cần <Mono>SESSION</Mono>).</li>
        <li>Dán vào ô dưới và bấm Lưu.</li>
      </Steps>
      <PasteForm label={st?.connected ? "Thay cookie" : "Cookie / cURL"} placeholder="curl … hoặc SESSION=…"
        onSave={async (cookie) => (await act(() => api("/api/integrations/kafka/cookie", { cookie }), "Đã kết nối Kafka UI")) && (reload(), true)}
        extra={(st?.connected || st?.expired) && (
          <>
            <button className="sm ghost" onClick={reload}><RefreshCw size={14} strokeWidth={2} />Kiểm tra phiên</button>
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/kafka/logout", {}), "Đã xoá cookie")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>
          </>
        )} />
    </Row>
  );
}

function Splunk(p: { open: boolean; onToggle: (id: string) => void }) {
  const { data: st, reload } = useApi<any>("/api/integrations/splunk");
  const health: Health = !st ? "loading" : st.connected ? "ok" : st.expired ? "expired" : "off";
  const check = async () => (await act(() => api("/api/integrations/splunk?check=1"))) && reload();
  return (
    <Row id="splunk" icon={ShieldAlert} title="Splunk" env="Production" health={health} {...p}
      summary={st?.user ? <>{st.user}{st.roles?.length ? ` · ${st.roles.join(", ")}` : ""}</> : "Log production (SIEM)"}>
      <p className="muted small">
        Agent tìm log production bằng <Mono>splunk.search</Mono> (chỉ đọc). Lệnh SPL ghi dữ liệu bị chặn; mỗi lần tìm tối đa {st ? Math.round(st.limits.maxMinutes / 60) : "…"} giờ và {st?.limits.maxResults ?? "…"} dòng; e-mail, số điện thoại, số thẻ và credential được che.
        {st?.limits.allowedIndexes.length ? <> Index được phép: <Mono>{st.limits.allowedIndexes.join(", ")}</Mono>.</> : null}
        {st?.checkedAt && <> Kiểm tra lần cuối {time(st.checkedAt)}; phiên Splunk Web hết hạn khi không dùng một thời gian.</>}
      </p>
      <Steps>
        <li>Mở <Link href={st?.baseUrl ?? "https://siem.hasaki.work"} /> và đăng nhập Google.</li>
        <li>F12 → Network → chuột phải một request tới <Mono>siem.hasaki.work</Mono> → Copy as cURL (cmd hoặc bash), hoặc copy header <Mono>Cookie</Mono> (cần <Mono>splunkd_…</Mono> và <Mono>splunkweb_csrf_token_…</Mono>).</li>
        <li>Dán vào ô dưới và bấm Lưu. Platform kiểm tra phiên với Splunk trước khi lưu.</li>
      </Steps>
      <PasteForm label={st?.connected ? "Thay cookie" : "Cookie / cURL"} placeholder="curl … hoặc splunkd_8080=…; splunkweb_csrf_token_8080=…"
        onSave={async (cookie) => (await act(() => api("/api/integrations/splunk/cookie", { cookie }), "Đã kết nối Splunk")) && (reload(), true)}
        extra={st?.user && (
          <>
            <button className="sm ghost" onClick={check}><RefreshCw size={14} strokeWidth={2} />Kiểm tra phiên</button>
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/splunk/logout", {}), "Đã xoá cookie")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>
          </>
        )} />
    </Row>
  );
}

function Vault(p: { open: boolean; onToggle: (id: string) => void }) {
  const { data: st, reload } = useApi<any>("/api/integrations/vault?check=1");
  const health: Health = !st ? "loading" : st.connected ? "ok" : st.expired ? "expired" : "off";
  return (
    <Row id="vault" icon={LockKeyhole} title="Vault" env="QC" health={health} {...p}
      summary={st?.connected ? <>{st.user}{st.expiresAt && <> · hết hạn {time(st.expiresAt)}</>}{st.renewable && " · tự gia hạn"}</> : "Kiểm tra secret/env của service (không lộ giá trị)"}>
      <p className="muted small">
        Agent xem service trên QC có khai báo key nào (<Mono>vault.list</Mono>, <Mono>vault.keys</Mono>): chỉ tên key, đã đặt/rỗng và độ dài.
        <b> Không bao giờ trả giá trị secret</b>; chỉ số/boolean ngắn dưới tên key không nhạy cảm (vd timeout = 15) được hiện. Platform chỉ đọc, ngoài việc tự gia hạn chính token này.
      </p>
      {st?.connected && st.policies?.length > 0 && <div className="small">Policies: <Mono>{st.policies.join(", ")}</Mono></div>}
      <Steps>
        <li>Mở <Link href={st?.baseUrl ?? "https://vault-qc-v2.hasaki.dev"} />, chọn method <b>OIDC</b> và đăng nhập.</li>
        <li>Bấm avatar/menu user ở góc trên phải → <b>Copy token</b>.</li>
        <li>Dán vào ô dưới và bấm Lưu. Platform kiểm tra token với Vault trước khi lưu.</li>
      </Steps>
      <PasteForm label={st?.connected ? "Thay token" : "Token"} placeholder="hvs.…"
        onSave={async (token) => (await act(() => api("/api/integrations/vault/token", { token }), "Đã kết nối Vault")) && (reload(), true)}
        extra={(st?.connected || st?.expired) && <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/vault/logout", {}), "Đã xoá token")) && reload()}><LogOut size={14} strokeWidth={2} />Ngắt kết nối</button>} />
    </Row>
  );
}

// ---------------------------------------------------------------- platform accounts

const SOURCE: Record<string, string> = { platform: "lưu trên platform", env: "từ .env", none: "" };

function EnvNote({ st, which, reload }: { st: any; which: string; reload: () => void }) {
  if (st?.source === "env")
    return (
      <div className="ig-note small">
        Đang dùng giá trị từ <Mono>.env</Mono>. Chuyển vào platform để quản lý ở đây, rồi xoá các biến đó khỏi <Mono>.env</Mono>.
        <button className="sm ghost" onClick={async () => (await act(() => api(`/api/integrations/${which}/adopt-env`, {}), "Đã chuyển vào platform")) && reload()}><Upload size={14} strokeWidth={2} />Chuyển từ .env vào platform</button>
      </div>
    );
  if (st?.source === "platform" && st?.envAvailable)
    return <div className="ig-note small">Đã lưu trên platform (ưu tiên hơn <Mono>.env</Mono>). Có thể xoá các biến tương ứng khỏi <Mono>.env</Mono>.</div>;
  return null;
}

function Bitbucket(p: { open: boolean; onToggle: (id: string) => void }) {
  const { data: st, reload } = useApi<any>("/api/integrations/bitbucket");
  const [f, setF] = useState<{ user?: string; token: string; workspace?: string; reviewers?: string }>({ token: "" });
  const [busy, setBusy] = useState(false);
  const v = { user: f.user ?? st?.user ?? "", workspace: f.workspace ?? st?.workspace ?? "", reviewers: f.reviewers ?? (st?.reviewers ?? []).join("\n") };
  const save = async () => {
    setBusy(true);
    const r = await act(() => api<any>("/api/integrations/bitbucket", { ...v, token: f.token }), "Đã lưu Bitbucket");
    setBusy(false);
    if (r) (setF({ token: "" }), reload());
  };
  return (
    <Row id="bitbucket" icon={GitPullRequest} title="Bitbucket" health={!st ? "loading" : st.configured ? "ok" : "off"} {...p}
      summary={st?.configured ? <>{st.user} · {st.workspace} · {SOURCE[st.source]}</> : "Push + mở PR (không có thì PR step chỉ trả link)"}>
      <p className="muted small">Bước PR dùng để mở/cập nhật pull request; agent dùng <Mono>bitbucket.list_pull_requests</Mono>. Không có credential thì bước PR chỉ trả link "create PR".</p>
      <EnvNote st={st} which="bitbucket" reload={reload} />
      <Steps>
        <li>Tạo API token tại <Link href="https://id.atlassian.com/manage-profile/security/api-tokens" /> (Create API token with scopes → Bitbucket: đọc repository, đọc/ghi pull request). User là email Atlassian. Nếu dùng app password cũ thì user là username Bitbucket.</li>
        <li>Điền vào form và bấm Lưu. Platform thử đọc workspace trước khi lưu. Để trống token để giữ token hiện tại.</li>
      </Steps>
      <div className="ig-grid">
        <Field label="User"><input value={v.user} placeholder="you@hasaki.vn" onChange={(e) => setF({ ...f, user: e.target.value })} /></Field>
        <Field label="Workspace"><input value={v.workspace} placeholder="hasaki-tech" onChange={(e) => setF({ ...f, workspace: e.target.value })} /></Field>
        <Field label={st?.configured ? `Token (hiện tại ${st.token})` : "Token"}><input type="password" autoComplete="off" value={f.token} placeholder={st?.configured ? "để trống = giữ nguyên" : "API token"} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>
        <Field label="Reviewers (UUID, mỗi dòng một người)" hint="Tuỳ chọn. Dạng {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"><textarea rows={2} className="mono" value={v.reviewers} onChange={(e) => setF({ ...f, reviewers: e.target.value })} /></Field>
      </div>
      <div className="ig-actions">
        <button className="sm" disabled={busy || !v.user || (!f.token && !st?.configured)} onClick={save}><KeyRound size={14} strokeWidth={2} />{busy ? "Đang kiểm tra…" : "Lưu"}</button>
        {st?.source === "platform" && (
          <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/bitbucket/clear", {}), st.envAvailable ? "Đã xoá, quay về .env" : "Đã xoá")) && (setF({ token: "" }), reload())}><LogOut size={14} strokeWidth={2} />Xoá khỏi platform</button>
        )}
      </div>
    </Row>
  );
}

function Telegram(p: { open: boolean; onToggle: (id: string) => void }) {
  const { data: st, reload } = useApi<any>("/api/integrations/telegram");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState<string | undefined>();
  const [chats, setChats] = useState<Array<{ id: string; name: string; type: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const chat = chatId ?? st?.chatId ?? "";
  const save = async () => {
    setBusy(true);
    const r = await act(() => api<any>("/api/integrations/telegram", { botToken: token, chatId: chat }), "Đã lưu Telegram");
    setBusy(false);
    if (r) (setToken(""), setChatId(undefined), reload());
  };
  const findChats = async () => {
    const r = await act(() => api<any[]>("/api/integrations/telegram/chats", { botToken: token }));
    if (r) setChats(r);
  };
  return (
    <Row id="telegram" icon={Send} title="Telegram" health={!st ? "loading" : st.configured ? "ok" : "off"} {...p}
      summary={st?.configured ? <>chat {st.chatId} · {SOURCE[st.source]}</> : "Báo khi bước cần trả lời / duyệt"}>
      <p className="muted small">Gửi một tin khi một bước chờ bạn (câu hỏi, duyệt), kèm link mở đúng bước. Chỉ gửi một chiều; trả lời/duyệt vẫn làm trên platform.</p>
      <EnvNote st={st} which="telegram" reload={reload} />
      <Steps>
        <li>Tạo bot với <Link href="https://t.me/BotFather" /> (<Mono>/newbot</Mono>) và copy bot token.</li>
        <li>Nhắn <Mono>/start</Mono> cho bot (hoặc thêm bot vào group), dán token rồi bấm <b>Tìm chat id</b> và chọn chat.</li>
        <li>Bấm Lưu (platform kiểm tra token với Telegram), rồi <b>Gửi thử</b>.</li>
      </Steps>
      <div className="ig-grid">
        <Field label={st?.configured ? `Bot token (hiện tại ${st.botToken})` : "Bot token"}><input type="password" autoComplete="off" value={token} placeholder={st?.configured ? "để trống = giữ nguyên" : "123456789:AA…"} onChange={(e) => setToken(e.target.value)} /></Field>
        <Field label="Chat id"><input value={chat} placeholder="123456789" onChange={(e) => setChatId(e.target.value)} /></Field>
      </div>
      {chats && (
        <div className="ig-chats small">
          {chats.length ? chats.map((c) => (
            <button key={c.id} className={`sm ghost${c.id === chat ? " is-sel" : ""}`} onClick={() => setChatId(c.id)}>{c.name || c.id} <span className="muted">· {c.type} · {c.id}</span></button>
          )) : <span className="muted">Chưa thấy chat nào. Nhắn /start cho bot rồi bấm tìm lại.</span>}
        </div>
      )}
      <div className="ig-actions">
        <button className="sm" disabled={busy || !chat || (!token && !st?.configured)} onClick={save}><KeyRound size={14} strokeWidth={2} />{busy ? "Đang kiểm tra…" : "Lưu"}</button>
        <button className="sm ghost" disabled={!token && !st?.configured} onClick={findChats}><Search size={14} strokeWidth={2} />Tìm chat id</button>
        {st?.configured && <button className="sm ghost" onClick={() => act(() => api("/api/integrations/telegram/test", {}), "Đã gửi tin thử")}><Send size={14} strokeWidth={2} />Gửi thử</button>}
        {st?.source === "platform" && (
          <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/telegram/clear", {}), st.envAvailable ? "Đã xoá, quay về .env" : "Đã xoá")) && reload()}><LogOut size={14} strokeWidth={2} />Xoá khỏi platform</button>
        )}
      </div>
    </Row>
  );
}

export function IntegrationsPage() {
  const [open, setOpen] = useState<string | null>(null);
  const row = (id: string) => ({ open: open === id, onToggle: (x: string) => setOpen(open === x ? null : x) });
  return (
    <>
      <PageHeader icon={PlugZap} title="Integrations" subtitle="Kết nối hệ thống ngoài. Bấm vào một dòng để xem hướng dẫn và nhập thông tin." />
      <section className="ig-group">
        <h3 className="ig-group-title">Nguồn điều tra <span className="muted small">· agent dùng, chỉ đọc</span></h3>
        <div className="ig-list">
          <ArgoCd {...row("argocd")} />
          <Kafka {...row("kafka")} />
          <Vault {...row("vault")} />
          <Splunk {...row("splunk")} />
        </div>
      </section>
      <section className="ig-group">
        <h3 className="ig-group-title">Tài khoản platform</h3>
        <div className="ig-list">
          <Bitbucket {...row("bitbucket")} />
          <Telegram {...row("telegram")} />
        </div>
      </section>
    </>
  );
}
