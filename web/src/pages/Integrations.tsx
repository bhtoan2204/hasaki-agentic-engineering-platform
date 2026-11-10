import { useState, type ReactNode } from "react";
import {
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  LogOut,
  PlugZap,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, Field, PageHeader, time } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Integrations.css";

/** One translated sentence with a {name} slot rendered as a node (a link), not string concatenation. */
function slot(text: string, parts: Record<string, ReactNode>) {
  return text
    .split(/\{(\w+)\}/g)
    .map((part, i) => (i % 2 ? (parts[part] ?? `{${part}}`) : part));
}

type Health = "ok" | "expired" | "off" | "loading";

function StatusPill({ h }: { h: Health }) {
  const { t } = useI18n();
  const label = {
    ok: t("ig.connected"),
    expired: t("ig.expired"),
    off: t("ig.off"),
    loading: "…",
  }[h];
  return (
    <span className={`ig-pill ig-${h}`}>
      <span className="ig-dot" />
      {label}
    </span>
  );
}

/** One integration: a compact row; clicking it reveals the instructions and the inputs. */
function Row({
  id,
  icon: I,
  title,
  env,
  health,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  env?: string;
  health: Health;
  summary?: ReactNode;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`ig-row${open ? " is-open" : ""}`}>
      <button
        className="ig-head"
        aria-expanded={open}
        aria-controls={`ig-${id}`}
        onClick={() => onToggle(id)}
      >
        <ChevronRight size={16} strokeWidth={2} className="ig-chev" />
        <span className="ig-icon">
          <I size={16} strokeWidth={2} />
        </span>
        <span className="ig-title">
          {title}
          {env && <span className="ig-env">{env}</span>}
        </span>
        <span className="ig-summary muted small">{summary}</span>
        <StatusPill h={health} />
      </button>
      {open && (
        <div className="ig-body" id={`ig-${id}`}>
          {children}
        </div>
      )}
    </div>
  );
}

const Link = ({ href }: { href: string }) => (
  <a href={href} target="_blank" rel="noreferrer">
    {href.replace(/^https?:\/\//, "")} <ExternalLink size={11} />
  </a>
);
const Steps = ({ children }: { children: ReactNode }) => (
  <ol className="ig-steps small">{children}</ol>
);

/** Paste-a-secret form shared by Argo CD, Kafka UI and Splunk. */
function PasteForm({
  label,
  placeholder,
  busyLabel,
  onSave,
  extra,
}: {
  label: string;
  placeholder: string;
  busyLabel?: string;
  onSave: (v: string) => Promise<unknown>;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Field label={label}>
        <textarea
          rows={3}
          className="mono"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <div className="ig-actions">
        <button
          className="sm"
          disabled={!value.trim() || busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onSave(value);
            setBusy(false);
            if (ok) setValue("");
          }}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? (busyLabel ?? t("ig.checking")) : t("ig.save")}
        </button>
        {extra}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- investigation sources (agent tools, read-only)

function ArgoCd(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<any>("/api/integrations/argocd");
  const health: Health = !st
    ? "loading"
    : st.loggedIn
      ? "ok"
      : st.expired
        ? "expired"
        : "off";
  const href = st?.baseUrl ?? "https://argocd-qc-v2.hasaki.dev";
  return (
    <Row
      id="argocd"
      icon={Server}
      title="Argo CD"
      env="QC"
      health={health}
      {...p}
      summary={
        st?.loggedIn ? (
          <>
            {st.user}
            {st.expiresAt && (
              <> · {t("ig.expires", { time: time(st.expiresAt) })}</>
            )}
          </>
        ) : (
          t("ig.argo.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.argo.body")}</p>
      <Steps>
        <li>{slot(t("ig.argo.s1"), { link: <Link href={href} /> })}</li>
        <li>{t("ig.argo.s2")}</li>
        <li>{t("ig.argo.s3")}</li>
      </Steps>
      <PasteForm
        label={st?.loggedIn ? t("ig.replaceToken") : t("ig.token")}
        placeholder={t("ig.argo.ph")}
        onSave={async (token) =>
          (await act(
            () => api("/api/integrations/argocd/token", { token }),
            t("ig.argo.saved"),
          )) && (reload(), true)
        }
        extra={
          (st?.loggedIn || st?.expired) && (
            <button
              className="sm ghost"
              onClick={async () =>
                (await act(
                  () => api("/api/integrations/argocd/logout", {}),
                  t("ig.argo.cleared"),
                )) && reload()
              }
            >
              <LogOut size={14} strokeWidth={2} />
              {t("ig.disconnect")}
            </button>
          )
        }
      />
    </Row>
  );
}

function Kafka(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<any>("/api/integrations/kafka?check=1");
  const health: Health = !st
    ? "loading"
    : st.connected
      ? "ok"
      : st.expired
        ? "expired"
        : "off";
  return (
    <Row
      id="kafka"
      icon={Waypoints}
      title="Kafka UI"
      env="QC"
      health={health}
      {...p}
      summary={
        st?.connected ? (
          <>
            {st.user ?? t("ig.signedIn")}
            {st.clusters?.map((c: any) => (
              <span key={c.name}>
                {" "}
                · {c.name} ({t("ig.kafka.topics", { n: c.topics })})
              </span>
            ))}
          </>
        ) : (
          t("ig.kafka.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.kafka.body")}</p>
      <Steps>
        <li>
          {slot(t("ig.kafka.s1"), {
            link: (
              <Link href={st?.baseUrl ?? "https://kafka-ui-qc-v2.hasaki.dev"} />
            ),
          })}
        </li>
        <li>{t("ig.kafka.s2")}</li>
        <li>{t("ig.kafka.s3")}</li>
      </Steps>
      <PasteForm
        label={st?.connected ? t("ig.replaceCookie") : t("ig.cookie")}
        placeholder={t("ig.kafka.ph")}
        onSave={async (cookie) =>
          (await act(
            () => api("/api/integrations/kafka/cookie", { cookie }),
            t("ig.kafka.saved"),
          )) && (reload(), true)
        }
        extra={
          (st?.connected || st?.expired) && (
            <>
              <button className="sm ghost" onClick={reload}>
                <RefreshCw size={14} strokeWidth={2} />
                {t("ig.checkSession")}
              </button>
              <button
                className="sm ghost"
                onClick={async () =>
                  (await act(
                    () => api("/api/integrations/kafka/logout", {}),
                    t("ig.kafka.cleared"),
                  )) && reload()
                }
              >
                <LogOut size={14} strokeWidth={2} />
                {t("ig.disconnect")}
              </button>
            </>
          )
        }
      />
    </Row>
  );
}

function Splunk(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<any>("/api/integrations/splunk");
  const health: Health = !st
    ? "loading"
    : st.connected
      ? "ok"
      : st.expired
        ? "expired"
        : "off";
  const check = async () =>
    (await act(() => api("/api/integrations/splunk?check=1"))) && reload();
  return (
    <Row
      id="splunk"
      icon={ShieldAlert}
      title="Splunk"
      env="Production"
      health={health}
      {...p}
      summary={
        st?.user ? (
          <>
            {st.user}
            {st.roles?.length ? ` · ${st.roles.join(", ")}` : ""}
          </>
        ) : (
          t("ig.splunk.summaryOff")
        )
      }
    >
      <p className="muted small">
        {t("ig.splunk.body", {
          hours: st ? Math.round(st.limits.maxMinutes / 60) : "…",
          rows: st?.limits.maxResults ?? "…",
        })}
        {st?.limits.allowedIndexes.length ? (
          <>
            {" "}
            {t("ig.splunk.indexes", {
              indexes: st.limits.allowedIndexes.join(", "),
            })}
          </>
        ) : null}
        {st?.checkedAt && (
          <> {t("ig.splunk.checked", { time: time(st.checkedAt) })}</>
        )}
      </p>
      <Steps>
        <li>
          {slot(t("ig.splunk.s1"), {
            link: <Link href={st?.baseUrl ?? "https://siem.hasaki.work"} />,
          })}
        </li>
        <li>{t("ig.splunk.s2")}</li>
        <li>{t("ig.splunk.s3")}</li>
      </Steps>
      <PasteForm
        label={st?.connected ? t("ig.replaceCookie") : t("ig.cookie")}
        placeholder={t("ig.splunk.ph")}
        onSave={async (cookie) =>
          (await act(
            () => api("/api/integrations/splunk/cookie", { cookie }),
            t("ig.splunk.saved"),
          )) && (reload(), true)
        }
        extra={
          st?.user && (
            <>
              <button className="sm ghost" onClick={check}>
                <RefreshCw size={14} strokeWidth={2} />
                {t("ig.checkSession")}
              </button>
              <button
                className="sm ghost"
                onClick={async () =>
                  (await act(
                    () => api("/api/integrations/splunk/logout", {}),
                    t("ig.kafka.cleared"),
                  )) && reload()
                }
              >
                <LogOut size={14} strokeWidth={2} />
                {t("ig.disconnect")}
              </button>
            </>
          )
        }
      />
      <SplunkToken onSaved={reload} connected={!!st?.connected} />
      <SplunkTest connected={!!st?.connected} />
      <SplunkShared st={st} onSaved={reload} />
    </Row>
  );
}

/** Alternative to the cookie: a personal Splunk authentication token (Settings → Tokens), validated before saving. */
function SplunkToken({ onSaved, connected }: { onSaved: () => void; connected: boolean }) {
  const { t } = useI18n();
  return (
    <details className="ig-more">
      <summary className="small">{t("ig.splunk.tokenTitle")}</summary>
      <p className="muted small">{t("ig.splunk.tokenBody")}</p>
      <PasteForm
        label={connected ? t("ig.splunk.tokenReplace") : t("ig.splunk.token")}
        placeholder="eyJraWQiOiJzcGx1bmsuc2VjcmV0…"
        onSave={async (token) => (await act(() => api("/api/integrations/splunk/token", { token }), t("ig.splunk.saved"))) && (onSaved(), true)}
      />
    </details>
  );
}

/** Test connection: identity, read-only posture and access to the default indexes. Never shows credentials. */
function SplunkTest({ connected }: { connected: boolean }) {
  const { t } = useI18n();
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (!connected) return null;
  return (
    <div className="ig-test">
      <button
        className="sm ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setRes(await act(() => api("/api/integrations/splunk/test", {})).finally(() => setBusy(false)));
        }}
      >
        <PlugZap size={14} strokeWidth={2} />
        {busy ? t("ig.splunk.testing") : t("ig.splunk.test")}
      </button>
      {res && (
        <div className="ig-test-result small" role="status">
          <span className={res.ok ? "ig-ok-text" : "ig-err-text"}>{res.ok ? t("ig.splunk.testOk") : t("ig.splunk.testFail")}</span>{" "}
          · {res.user} ({res.auth}) · {res.latency_ms} ms
          {!res.read_only && <div className="ig-err-text">{res.warning}</div>}
          <ul>
            {res.indexes.map((i: any) => (
              <li key={i.index}>
                <code>{i.index}</code>: {i.ok ? t("ig.splunk.indexOk", { n: i.events_15m }) : i.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Administrators: a shared read-only service-account token; members use it only when splunk.allowSharedToken is on. */
function SplunkShared({ st, onSaved }: { st: any; onSaved: () => void }) {
  const { t } = useI18n();
  const { data: me } = useApi<any>("/api/auth/me");
  if (me?.user?.role !== "admin" || !st) return null;
  return (
    <details className="ig-more">
      <summary className="small">
        {t("ig.splunk.sharedTitle")} · {st.shared.configured ? `${st.shared.user ?? "?"} (${st.shared.allowed ? t("ig.splunk.sharedOn") : t("ig.splunk.sharedOff")})` : t("common.none")}
      </summary>
      <p className="muted small">{t("ig.splunk.sharedBody")}</p>
      <PasteForm
        label={t("ig.splunk.token")}
        placeholder="eyJraWQiOiJzcGx1bmsuc2VjcmV0…"
        onSave={async (token) => (await act(() => api("/api/integrations/splunk/shared", { token }), t("ig.splunk.saved"))) && (onSaved(), true)}
        extra={
          st.shared.configured && (
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/integrations/splunk/shared/clear", {}), t("ig.kafka.cleared"))) && onSaved()}>
              <LogOut size={14} strokeWidth={2} />
              {t("ig.disconnect")}
            </button>
          )
        }
      />
    </details>
  );
}

function Vault(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<any>("/api/integrations/vault?check=1");
  const health: Health = !st
    ? "loading"
    : st.connected
      ? "ok"
      : st.expired
        ? "expired"
        : "off";
  return (
    <Row
      id="vault"
      icon={LockKeyhole}
      title="Vault"
      env="QC"
      health={health}
      {...p}
      summary={
        st?.connected ? (
          <>
            {st.user}
            {st.expiresAt && (
              <> · {t("ig.expires", { time: time(st.expiresAt) })}</>
            )}
            {st.renewable && <> · {t("ig.renews")}</>}
          </>
        ) : (
          t("ig.vault.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.vault.body")}</p>
      {st?.connected && st.policies?.length > 0 && (
        <div className="small">
          {t("ig.vault.policies", { policies: st.policies.join(", ") })}
        </div>
      )}
      <Steps>
        <li>
          {slot(t("ig.vault.s1"), {
            link: (
              <Link href={st?.baseUrl ?? "https://vault-qc-v2.hasaki.dev"} />
            ),
          })}
        </li>
        <li>{t("ig.vault.s2")}</li>
        <li>{t("ig.vault.s3")}</li>
      </Steps>
      <PasteForm
        label={st?.connected ? t("ig.replaceToken") : t("ig.token")}
        placeholder={t("ig.vault.ph")}
        onSave={async (token) =>
          (await act(
            () => api("/api/integrations/vault/token", { token }),
            t("ig.vault.saved"),
          )) && (reload(), true)
        }
        extra={
          (st?.connected || st?.expired) && (
            <button
              className="sm ghost"
              onClick={async () =>
                (await act(
                  () => api("/api/integrations/vault/logout", {}),
                  t("ig.argo.cleared"),
                )) && reload()
              }
            >
              <LogOut size={14} strokeWidth={2} />
              {t("ig.disconnect")}
            </button>
          )
        }
      />
    </Row>
  );
}

// ---------------------------------------------------------------- platform accounts

function sourceLabel(t: (k: string) => string, source: string) {
  return source === "platform" || source === "env" ? t(`ig.src.${source}`) : "";
}

function EnvNote({
  st,
  which,
  reload,
}: {
  st: any;
  which: string;
  reload: () => void;
}) {
  const { t } = useI18n();
  if (st?.source === "env")
    return (
      <div className="ig-note small">
        {t("ig.envUsing")}
        <button
          className="sm ghost"
          onClick={async () =>
            (await act(
              () => api(`/api/integrations/${which}/adopt-env`, {}),
              t("ig.adopted"),
            )) && reload()
          }
        >
          <Upload size={14} strokeWidth={2} />
          {t("ig.adopt")}
        </button>
      </div>
    );
  if (st?.source === "platform" && st?.envAvailable)
    return <div className="ig-note small">{t("ig.envStored")}</div>;
  return null;
}

function Bitbucket(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<any>("/api/integrations/bitbucket");
  const [f, setF] = useState<{
    user?: string;
    token: string;
    workspace?: string;
    reviewers?: string;
  }>({ token: "" });
  const [busy, setBusy] = useState(false);
  const v = {
    user: f.user ?? st?.user ?? "",
    workspace: f.workspace ?? st?.workspace ?? "",
    reviewers: f.reviewers ?? (st?.reviewers ?? []).join("\n"),
  };
  const save = async () => {
    setBusy(true);
    const r = await act(
      () => api<any>("/api/integrations/bitbucket", { ...v, token: f.token }),
      t("ig.bb.saved"),
    );
    setBusy(false);
    if (r) (setF({ token: "" }), reload());
  };
  return (
    <Row
      id="bitbucket"
      icon={GitPullRequest}
      title="Bitbucket"
      health={!st ? "loading" : st.configured ? "ok" : "off"}
      {...p}
      summary={
        st?.configured ? (
          <>
            {st.user} · {st.workspace} · {sourceLabel(t, st.source)}
          </>
        ) : (
          t("ig.bb.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.bb.body")}</p>
      <EnvNote st={st} which="bitbucket" reload={reload} />
      <Steps>
        <li>
          {slot(t("ig.bb.s1"), {
            link: (
              <Link href="https://id.atlassian.com/manage-profile/security/api-tokens" />
            ),
          })}
        </li>
        <li>{t("ig.bb.s2")}</li>
      </Steps>
      <div className="ig-grid">
        <Field label={t("ig.bb.user")}>
          <input
            value={v.user}
            placeholder="you@hasaki.vn"
            onChange={(e) => setF({ ...f, user: e.target.value })}
          />
        </Field>
        <Field label={t("ig.bb.workspace")}>
          <input
            value={v.workspace}
            placeholder="hasaki-tech"
            onChange={(e) => setF({ ...f, workspace: e.target.value })}
          />
        </Field>
        <Field
          label={
            st?.configured
              ? t("ig.bb.tokenNow", { token: st.token })
              : t("ig.bb.token")
          }
        >
          <input
            type="password"
            autoComplete="off"
            value={f.token}
            placeholder={st?.configured ? t("ig.keep") : t("ig.bb.tokenPh")}
            onChange={(e) => setF({ ...f, token: e.target.value })}
          />
        </Field>
        <Field label={t("ig.bb.reviewers")} hint={t("ig.bb.reviewersHint")}>
          <textarea
            rows={2}
            className="mono"
            value={v.reviewers}
            onChange={(e) => setF({ ...f, reviewers: e.target.value })}
          />
        </Field>
      </div>
      <div className="ig-actions">
        <button
          className="sm"
          disabled={busy || !v.user || (!f.token && !st?.configured)}
          onClick={save}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        {st?.source === "platform" && (
          <button
            className="sm ghost"
            onClick={async () =>
              (await act(
                () => api("/api/integrations/bitbucket/clear", {}),
                st.envAvailable ? t("ig.backEnv") : t("ig.removed"),
              )) && (setF({ token: "" }), reload())
            }
          >
            <LogOut size={14} strokeWidth={2} />
            {t("ig.removePlatform")}
          </button>
        )}
      </div>
    </Row>
  );
}

function Telegram(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<any>("/api/integrations/telegram");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState<string>();
  const [mine, setMine] = useState<string>();
  const [chats, setChats] = useState<Array<{id:string;name:string;type:string}> | null>(null);
  const [bindingLink, setBindingLink] = useState("");
  const [prefs, setPrefs] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const chat = chatId ?? st?.chatId ?? "";
  const connect = async () => {
    const result = await act(() => api<any>("/api/integrations/telegram/connect", {}));
    if (result) setBindingLink(result.url);
  };
  const disconnect = async () => {
    if (await act(() => api("/api/integrations/telegram/disconnect", {}))) { setBindingLink(""); reload(); }
  };
  const savePrefs = async () => {
    if (await act(() => api("/api/integrations/telegram/preferences", prefs), t("ig.tg.prefsSaved"))) { setPrefs({}); reload(); }
  };
  const save = async () => {
    setBusy(true);
    const result = await act(() => api("/api/integrations/telegram", {botToken:token,chatId:chat}), t("ig.tg.saved"));
    setBusy(false);
    if (result) { setToken(""); setChatId(undefined); reload(); }
  };
  return <Row id="telegram" icon={Send} title="Telegram" health={!st ? "loading" : st.configured ? "ok" : "off"} {...p}
    summary={st?.configured ? <>{sourceLabel(t,st.source)} · {st.binding ? t("ig.tg.connected",{id:st.binding.telegram_user_id}) : t("ig.tg.mineMissing")}</> : t("ig.tg.summaryOff")}>
    <p className="muted small">{t("ig.tg.body")}</p>
    {st?.canManage && <>
      <EnvNote st={st} which="telegram" reload={reload}/>
      <Steps><li>{slot(t("ig.tg.s1"),{link:<Link href="https://t.me/BotFather"/>})}</li><li>{t("ig.tg.s2")}</li><li>{t("ig.tg.s3")}</li></Steps>
      <div className="ig-grid">
        <Field label={st.configured ? t("ig.tg.tokenNow",{token:st.botToken}) : t("ig.tg.token")}><input type="password" autoComplete="off" value={token} placeholder={st.configured?t("ig.keep"):"123456789:AA…"} onChange={e=>setToken(e.target.value)}/></Field>
        <Field label={t("ig.tg.chatId")}><input value={chat} onChange={e=>setChatId(e.target.value)}/></Field>
      </div>
      {chats && <div className="ig-chats small">{chats.length ? chats.map(c=><button key={c.id} type="button" className="sm ghost" onClick={()=>setChatId(c.id)}>{c.name || c.id} · {c.type} · {c.id}</button>) : <span>{t("ig.tg.none")}</span>}</div>}
      <div className="ig-actions">
        <button type="button" className="sm" disabled={busy || (!token && !st.configured)} onClick={save}>{busy?t("ig.checking"):t("ig.save")}</button>
        <button type="button" className="sm ghost" disabled={!token && !st.configured} onClick={async()=>{const result=await act(()=>api<any[]>("/api/integrations/telegram/chats",{botToken:token}));if(result)setChats(result);}}>{t("ig.tg.find")}</button>
        {st.source==="platform" && <button type="button" className="sm ghost" onClick={async()=>{if(await act(()=>api("/api/integrations/telegram/clear",{})))reload();}}>{t("ig.removePlatform")}</button>}
      </div>
    </>}
    {st?.configured && <section className="ig-telegram-settings">
      <h4>{t("ig.tg.interactiveTitle")}</h4><p className="muted small">{t("ig.tg.bindingHint")}</p>
      <p className="small">{t("ig.tg.transport")}: <code>{st.mode ?? "off"}</code>{st.mode && st.mode!=="off" && <> · <span className={`ig-tg-receiver ${st.receiver?.active?"is-ok":"is-warn"}`} role="status">{t(st.receiver?.active?"ig.tg.receiverActive":"ig.tg.receiverDown")}</span></>}</p>
      {st.mode==="off" && <p className="muted small">{t("ig.tg.modeOff")}</p>}
      {st.needsRebind && <p>{t("ig.tg.rebind")}</p>}
      <div className="ig-actions">
        {st.binding || st.needsRebind ? <button type="button" className="ghost sm" onClick={disconnect}>{t("ig.tg.disconnect")}</button> : <button type="button" className="sm" disabled={st.mode==="off"} onClick={connect}>{t("ig.tg.connect")}</button>}
        {bindingLink && !st.binding && <><a className="btn ghost sm" href={bindingLink} target="_blank" rel="noreferrer">{t("ig.tg.openBinding")}</a><button type="button" className="ghost sm" onClick={reload}>{t("ig.tg.checkBinding")}</button></>}
      </div>
      <div className="ig-grid">
        {(["approvals","questions","failures","completions","interactive"] as const).map(key=><label className="row tight small" key={key}><input type="checkbox" checked={prefs[key] ?? st.preferences?.[key] ?? true} onChange={e=>setPrefs(v=>({...v,[key]:e.target.checked}))}/>{t(`ig.tg.pref.${key}`)}</label>)}
        <Field label={t("ig.tg.language")}><select aria-label={t("ig.tg.language")} value={prefs.locale ?? st.preferences?.locale ?? "vi"} onChange={e=>setPrefs(v=>({...v,locale:e.target.value}))}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></Field>
      </div>
      <button type="button" className="ghost sm" disabled={!Object.keys(prefs).length} onClick={savePrefs}>{t("ig.save")}</button>
      {!st.binding && <details><summary>{t("ig.tg.legacy")}</summary><Field label={t("ig.tg.mine")}><input value={mine ?? st.myChatId ?? ""} onChange={e=>setMine(e.target.value)}/></Field><button type="button" className="ghost sm" onClick={async()=>{if(await act(()=>api("/api/integrations/telegram/destination",{chatId:mine ?? st.myChatId ?? ""}))) {setMine(undefined);reload();}}}>{t("ig.tg.mineSave")}</button><p className="muted small">{t("ig.tg.legacyHint")}</p></details>}
      <button type="button" className="ghost sm" onClick={()=>act(()=>api("/api/integrations/telegram/test",{}),t("ig.tg.sent"))}>{t("ig.tg.test")}</button>
    </section>}
  </Row>;
}

export function IntegrationsPage() {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const row = (id: string) => ({
    open: open === id,
    onToggle: (x: string) => setOpen(open === x ? null : x),
  });
  return (
    <>
      <PageHeader
        icon={PlugZap}
        title={t("ig.title")}
        subtitle={t("ig.subtitle")}
      />
      <section className="ig-group">
        <h3 className="ig-group-title">
          {t("ig.sources")}{" "}
          <span className="muted small">· {t("ig.sourcesHint")}</span>
        </h3>
        <div className="ig-list">
          <ArgoCd {...row("argocd")} />
          <Kafka {...row("kafka")} />
          <Vault {...row("vault")} />
          <Splunk {...row("splunk")} />
        </div>
      </section>
      <section className="ig-group">
        <h3 className="ig-group-title">{t("ig.accounts")}</h3>
        <div className="ig-list">
          <Bitbucket {...row("bitbucket")} />
          <Telegram {...row("telegram")} />
        </div>
      </section>
    </>
  );
}
