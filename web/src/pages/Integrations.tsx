import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ChevronRight,
  Database,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  LogOut,
  PlugZap,
  Plus,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  Trash2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { dialog } from "../dialog/index.ts";
import { act, ago, Empty, ErrorBox, Field, PageHeader, SkeletonRows, time } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Integrations.css";

/** One translated sentence with a {name} slot rendered as a node (a link), not string concatenation. */
function slot(text: string, parts: Record<string, ReactNode>) {
  return text.split(/\{(\w+)\}/g).map((part, i) => (i % 2 ? (parts[part] ?? `{${part}}`) : part));
}

type Health = "ok" | "expired" | "off" | "loading" | "error" | "partial";

function StatusPill({ h }: { h: Health }) {
  const { t } = useI18n();
  const label = {
    ok: t("ig.connected"),
    expired: t("ig.expired"),
    off: t("ig.off"),
    loading: "…",
    error: t("ig.connError"),
    partial: t("ig.partial"),
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
        type="button"
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
          type="button"
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

type ArgoStatus = {
  baseUrl: string;
  loggedIn: boolean;
  user: string | null;
  expiresAt: string | null;
  expired: boolean;
};
type KafkaStatus = {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  clusters?: Array<{ name: string; status: string; brokers: number; topics: number }>;
};
type SplunkStatus = {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  roles: string[];
  checkedAt: string | null;
  shared: { configured: boolean; valid: boolean; allowed: boolean; user: string | null };
  limits: { maxMinutes: number; maxResults: number; allowedIndexes: string[] };
};
type SplunkTestResult = {
  ok: boolean;
  auth: string;
  user: string;
  read_only: boolean;
  warning?: string;
  indexes: Array<
    { index: string; ok: true; events_15m: number } | { index: string; ok: false; error: string }
  >;
  latency_ms: number;
};
type SignozStatus = {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  base_url: string | null;
  auth: "api_key" | "session" | null;
  token_set: boolean;
  last_ok_at: string | null;
  last_error: string | null;
};
type SignozTestResult =
  { ok: true; latency_ms: number } | { ok: false; kind: string; message: string };
type VaultStatus = {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  policies: string[];
  expiresAt: string | null;
  renewable: boolean;
};

function ArgoCd(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<ArgoStatus>("/api/integrations/argocd");
  const health: Health = !st ? "loading" : st.loggedIn ? "ok" : st.expired ? "expired" : "off";
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
            {st.expiresAt && <> · {t("ig.expires", { time: time(st.expiresAt) })}</>}
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
          (await act(() => api("/api/integrations/argocd/token", { token }), t("ig.argo.saved"))) &&
          (reload(), true)
        }
        extra={
          (st?.loggedIn || st?.expired) && (
            <button
              type="button"
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
  const { data: st, reload } = useApi<KafkaStatus>("/api/integrations/kafka?check=1");
  const health: Health = !st ? "loading" : st.connected ? "ok" : st.expired ? "expired" : "off";
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
            {st.clusters?.map((c) => (
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
            link: <Link href={st?.baseUrl ?? "https://kafka-ui-qc-v2.hasaki.dev"} />,
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
              <button type="button" className="sm ghost" onClick={reload}>
                <RefreshCw size={14} strokeWidth={2} />
                {t("ig.checkSession")}
              </button>
              <button
                type="button"
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
  const { data: st, reload } = useApi<SplunkStatus>("/api/integrations/splunk");
  const health: Health = !st ? "loading" : st.connected ? "ok" : st.expired ? "expired" : "off";
  const check = async () => (await act(() => api("/api/integrations/splunk?check=1"))) && reload();
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
        {st?.checkedAt && <> {t("ig.splunk.checked", { time: time(st.checkedAt) })}</>}
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
              <button type="button" className="sm ghost" onClick={check}>
                <RefreshCw size={14} strokeWidth={2} />
                {t("ig.checkSession")}
              </button>
              <button
                type="button"
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

/** SigNoz: the user's own domain and API key or session tokens (never sent back), enable switch, test and disconnect. */
function SigNoz(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<SignozStatus>("/api/integrations/signoz");
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [auth, setAuth] = useState<"api_key" | "session" | null>(null);
  const [token, setToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [res, setRes] = useState<SignozTestResult | null | undefined>(null);
  const mode = auth ?? st?.auth ?? "api_key";
  const keepStored = st?.token_set && st?.auth === mode;
  const health: Health = !st
    ? "loading"
    : st.connected
      ? "ok"
      : st.configured && st.last_error
        ? "error"
        : "off";
  const save = async (enabled: boolean) => {
    const out = await act(
      () =>
        api("/api/integrations/signoz", {
          baseUrl: baseUrl ?? st?.base_url ?? "",
          auth: mode,
          ...(mode === "session" ? { accessToken, refreshToken } : { token }),
          enabled,
        }),
      enabled ? t("ig.signoz.saved") : t("ig.signoz.disabled"),
    );
    if (out) {
      setToken("");
      setAccessToken("");
      setRefreshToken("");
      setAuth(null);
      setRes(null);
      reload();
    }
  };
  return (
    <Row
      id="signoz"
      icon={Activity}
      title="SigNoz"
      env="Production"
      health={health}
      {...p}
      summary={
        st?.base_url
          ? `${st.base_url.replace(/^https?:\/\//, "")}${st.enabled ? "" : ` · ${t("ig.off")}`}`
          : t("ig.signoz.summaryOff")
      }
    >
      <p className="muted small">{t("ig.signoz.body")}</p>
      <Steps>
        <li>{t("ig.signoz.s1")}</li>
        <li>{t("ig.signoz.s2")}</li>
        <li>{t("ig.signoz.s3")}</li>
      </Steps>
      <Field label={t("ig.signoz.domain")} hint={t("ig.signoz.domainHint")}>
        <input
          type="url"
          placeholder="https://signoz.example.com"
          value={baseUrl ?? st?.base_url ?? ""}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </Field>
      <Field label={t("ig.signoz.auth")}>
        <select value={mode} onChange={(e) => setAuth(e.target.value as "api_key" | "session")}>
          <option value="api_key">{t("ig.signoz.authKey")}</option>
          <option value="session">{t("ig.signoz.authSession")}</option>
        </select>
      </Field>
      {mode === "session" ? (
        <>
          <p className="muted small">{t("ig.signoz.sessionHint")}</p>
          <Field
            label={t("ig.signoz.access")}
            hint={keepStored ? t("ig.signoz.sessionKeep") : undefined}
          >
            <input
              type="password"
              autoComplete="off"
              placeholder={keepStored ? "••••••••••••" : "eyJ…"}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </Field>
          <Field
            label={t("ig.signoz.refresh")}
            hint={keepStored ? t("ig.signoz.sessionKeep") : undefined}
          >
            <input
              type="password"
              autoComplete="off"
              placeholder={keepStored ? "••••••••••••" : ""}
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
            />
          </Field>
        </>
      ) : (
        <Field
          label={t("ig.signoz.token")}
          hint={keepStored ? t("ig.signoz.tokenKeep") : undefined}
        >
          <input
            type="password"
            autoComplete="off"
            placeholder={keepStored ? "••••••••••••" : "SIGNOZ-API-KEY"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      )}
      {st?.last_ok_at && (
        <p className="muted small">{t("ig.signoz.lastOk", { time: time(st.last_ok_at) })}</p>
      )}
      {st?.last_error && <p className="ig-err-text small">{st.last_error}</p>}
      <div className="ig-actions">
        <button
          type="button"
          className="sm"
          onClick={() => save(true)}
          disabled={!(baseUrl ?? st?.base_url) || (!token && !st?.token_set)}
        >
          <KeyRound size={14} strokeWidth={2} />
          {st?.enabled ? t("ig.signoz.update") : t("ig.signoz.enable")}
        </button>
        {st?.configured && (
          <>
            <button
              type="button"
              className="sm ghost"
              onClick={async () => {
                setRes(await act(() => api<SignozTestResult>("/api/integrations/signoz/test", {})));
                reload();
              }}
            >
              <PlugZap size={14} strokeWidth={2} />
              {t("ig.signoz.test")}
            </button>
            {st.enabled && (
              <button type="button" className="sm ghost" onClick={() => save(false)}>
                {t("ig.signoz.disable")}
              </button>
            )}
            <button
              type="button"
              className="sm ghost"
              onClick={async () =>
                (await act(
                  () => api("/api/integrations/signoz/disconnect", {}),
                  t("ig.signoz.removed"),
                )) && (setBaseUrl(null), setRes(null), reload())
              }
            >
              <LogOut size={14} strokeWidth={2} />
              {t("ig.disconnect")}
            </button>
          </>
        )}
      </div>
      {res && (
        <div className="ig-test-result small" role="status">
          {res.ok ? (
            <span className="ig-ok-text">{t("ig.signoz.testOk", { ms: res.latency_ms })}</span>
          ) : (
            <span className="ig-err-text">
              {t(`ig.signoz.err.${res.kind}`)} — {res.message}
            </span>
          )}
        </div>
      )}
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
        onSave={async (token) =>
          (await act(
            () => api("/api/integrations/splunk/token", { token }),
            t("ig.splunk.saved"),
          )) && (onSaved(), true)
        }
      />
    </details>
  );
}

/** Test connection: identity, read-only posture and access to the default indexes. Never shows credentials. */
function SplunkTest({ connected }: { connected: boolean }) {
  const { t } = useI18n();
  const [res, setRes] = useState<SplunkTestResult | null | undefined>(null);
  const [busy, setBusy] = useState(false);
  if (!connected) return null;
  return (
    <div className="ig-test">
      <button
        type="button"
        className="sm ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setRes(
            await act(() => api<SplunkTestResult>("/api/integrations/splunk/test", {})).finally(
              () => setBusy(false),
            ),
          );
        }}
      >
        <PlugZap size={14} strokeWidth={2} />
        {busy ? t("ig.splunk.testing") : t("ig.splunk.test")}
      </button>
      {res && (
        <div className="ig-test-result small" role="status">
          <span className={res.ok ? "ig-ok-text" : "ig-err-text"}>
            {res.ok ? t("ig.splunk.testOk") : t("ig.splunk.testFail")}
          </span>{" "}
          · {res.user} ({res.auth}) · {res.latency_ms} ms
          {!res.read_only && <div className="ig-err-text">{res.warning}</div>}
          <ul>
            {res.indexes.map((i) => (
              <li key={i.index}>
                <code>{i.index}</code>:{" "}
                {i.ok ? t("ig.splunk.indexOk", { n: i.events_15m }) : i.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Administrators: a shared read-only service-account token; members use it only when splunk.allowSharedToken is on. */
function SplunkShared({ st, onSaved }: { st: SplunkStatus | null; onSaved: () => void }) {
  const { t } = useI18n();
  const { data: me } = useApi<{ user: { role: string } }>("/api/auth/me");
  if (me?.user?.role !== "admin" || !st) return null;
  return (
    <details className="ig-more">
      <summary className="small">
        {t("ig.splunk.sharedTitle")} ·{" "}
        {st.shared.configured
          ? `${st.shared.user ?? "?"} (${st.shared.allowed ? t("ig.splunk.sharedOn") : t("ig.splunk.sharedOff")})`
          : t("common.none")}
      </summary>
      <p className="muted small">{t("ig.splunk.sharedBody")}</p>
      <PasteForm
        label={t("ig.splunk.token")}
        placeholder="eyJraWQiOiJzcGx1bmsuc2VjcmV0…"
        onSave={async (token) =>
          (await act(
            () => api("/api/integrations/splunk/shared", { token }),
            t("ig.splunk.saved"),
          )) && (onSaved(), true)
        }
        extra={
          st.shared.configured && (
            <button
              type="button"
              className="sm ghost"
              onClick={async () =>
                (await act(
                  () => api("/api/integrations/splunk/shared/clear", {}),
                  t("ig.kafka.cleared"),
                )) && onSaved()
              }
            >
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
  const { data: st, reload } = useApi<VaultStatus>("/api/integrations/vault?check=1");
  const health: Health = !st ? "loading" : st.connected ? "ok" : st.expired ? "expired" : "off";
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
            {st.expiresAt && <> · {t("ig.expires", { time: time(st.expiresAt) })}</>}
            {st.renewable && <> · {t("ig.renews")}</>}
          </>
        ) : (
          t("ig.vault.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.vault.body")}</p>
      {st?.connected && st.policies?.length > 0 && (
        <div className="small">{t("ig.vault.policies", { policies: st.policies.join(", ") })}</div>
      )}
      <Steps>
        <li>
          {slot(t("ig.vault.s1"), {
            link: <Link href={st?.baseUrl ?? "https://vault-qc-v2.hasaki.dev"} />,
          })}
        </li>
        <li>{t("ig.vault.s2")}</li>
        <li>{t("ig.vault.s3")}</li>
      </Steps>
      <PasteForm
        label={st?.connected ? t("ig.replaceToken") : t("ig.token")}
        placeholder={t("ig.vault.ph")}
        onSave={async (token) =>
          (await act(() => api("/api/integrations/vault/token", { token }), t("ig.vault.saved"))) &&
          (reload(), true)
        }
        extra={
          (st?.connected || st?.expired) && (
            <button
              type="button"
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

// ---------------------------------------------------------------- project QC databases

const EMPTY_DB = {
  key: "",
  project: "",
  repositories: "",
  environment: "qc",
  host: "",
  port: 3306,
  database_name: "",
  username: "",
  password: "",
  ssl: false,
  description: "",
  max_rows: 200,
  timeout_ms: 15000,
  enabled: true,
};

type DbInfo = {
  key: string;
  project: string;
  repositories?: string[];
  environment?: string;
  database_name: string;
  description?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  has_password?: boolean;
  last_status?: "ok" | "failed" | null;
  last_checked_at?: string | null;
  last_used_at?: string | null;
  last_error_kind?: string | null;
  last_error?: string | null;
  last_version?: string | null;
  last_can_write?: boolean | null;
  last_latency_ms?: number | null;
};
type DbForm = Omit<typeof EMPTY_DB, "port" | "max_rows" | "timeout_ms"> & {
  port: number | string;
  max_rows: number | string;
  timeout_ms: number | string;
  has_password?: boolean;
};

/** A database's state as shown: a test in progress wins, then disabled, then the last known result. */
type DbState = "checking" | "ok" | "failed" | "untested" | "off";
const dbState = (d: DbInfo, checking: Set<string>): DbState =>
  checking.has(d.key)
    ? "checking"
    : d.enabled === false
      ? "off"
      : d.last_status === "ok"
        ? "ok"
        : d.last_status === "failed"
          ? "failed"
          : "untested";
/** Older than this, the last check is redone automatically when an admin opens the card. */
const STALE_MS = 5 * 60_000;

function DbCard({
  d,
  state,
  isAdmin,
  onTest,
  onEdit,
  onDelete,
}: {
  d: DbInfo;
  state: DbState;
  isAdmin: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const when = (v?: string | null) => (v ? t("common.ago", { when: ago(v) }) : "");
  const scope = [d.project, ...(d.repositories ?? [])].filter(Boolean);
  return (
    <article className={`ig-db-card is-${state}`}>
      <header className="ig-db-card-head">
        <span className="ig-db-light" aria-hidden />
        <b className="mono">{d.key}</b>
        <span className="ig-env">{String(d.environment ?? "qc").toUpperCase()}</span>
        <span className="grow" />
        <span className={`ig-db-state is-${state}`}>{t(`ig.db.state.${state}`)}</span>
      </header>
      <div className="ig-db-target mono small">
        {d.database_name}
        {isAdmin && d.host && (
          <span className="muted">
            {" "}
            · {d.username}@{d.host}:{d.port}
          </span>
        )}
      </div>
      {scope.length > 0 && (
        <div className="ig-db-chips">
          {scope.map((x) => (
            <span key={x} className="ig-db-chip">
              {x}
            </span>
          ))}
        </div>
      )}
      {d.description && <div className="small">{d.description}</div>}
      <div className="ig-db-meta small muted">
        {d.last_status === "ok" && d.last_version && (
          <span>{d.last_version.replace(/-MariaDB.*$/, " MariaDB")}</span>
        )}
        {d.last_status === "ok" && d.last_latency_ms != null && (
          <span>{t("ig.db.latency", { ms: d.last_latency_ms })}</span>
        )}
        {d.last_checked_at ? (
          <span>{t("ig.db.checkedAgo", { when: when(d.last_checked_at) })}</span>
        ) : (
          <span>{t("ig.db.neverChecked")}</span>
        )}
        <span>
          {d.last_used_at
            ? t("ig.db.usedAgo", { when: when(d.last_used_at) })
            : t("ig.db.neverUsed")}
        </span>
      </div>
      {state === "failed" && (
        <div className="ig-db-error small">
          <b>{t(`ig.db.kind.${d.last_error_kind ?? "unknown"}`)}</b>
          <div>{t(`ig.db.hint.${d.last_error_kind ?? "unknown"}`)}</div>
          {isAdmin && d.last_error && <code>{d.last_error}</code>}
        </div>
      )}
      {isAdmin && d.has_password === false && state !== "failed" && (
        <div className="ig-db-warn small">{t("ig.db.noPassword")}</div>
      )}
      {isAdmin && d.last_can_write && <div className="ig-db-warn small">{t("ig.db.canWrite")}</div>}
      {isAdmin && (
        <footer className="ig-db-actions">
          <button
            type="button"
            className="sm ghost"
            onClick={onTest}
            disabled={state === "checking"}
          >
            <RefreshCw size={13} className={state === "checking" ? "ig-spin" : undefined} />{" "}
            {t("ig.db.test")}
          </button>
          <button type="button" className="sm ghost" onClick={onEdit}>
            {t("common.edit")}
          </button>
          <button type="button" className="sm ghost" onClick={onDelete}>
            {t("common.delete")}
          </button>
        </footer>
      )}
    </article>
  );
}

/**
 * Read-only MySQL QC databases per project. Agents query them through the platform tools (database.list / schema /
 * query) only when their run's repository scope covers the database's project or repositories. The status shown is the
 * last real connection (admin test, automatic re-check, or an agent query), never just "configured".
 */
function ProjectDatabases(p: { open: boolean; onToggle: (id: string) => void; isAdmin: boolean }) {
  const { t } = useI18n();
  const { data, reload } = useApi<DbInfo[]>("/api/integrations/databases");
  const [form, setForm] = useState<DbForm | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const list = data ?? [];
  const enabled = list.filter((d) => d.enabled !== false);
  const states = enabled.map((d) => dbState(d, checking));
  const health: Health = !data
    ? "loading"
    : !enabled.length
      ? "off"
      : states.some((s) => s === "failed")
        ? "error"
        : states.every((s) => s === "ok")
          ? "ok"
          : "partial";
  const test = useCallback(
    async (keys: string[]) => {
      if (!keys.length) return;
      setChecking((c) => new Set([...c, ...keys]));
      // A failed connection is a result (ok: false), shown on the card, not an error toast.
      await Promise.all(
        keys.map((k) => api(`/api/integrations/databases/${k}/test`, {}).catch(() => null)),
      );
      setChecking((c) => new Set([...c].filter((k) => !keys.includes(k))));
      reload();
    },
    [reload],
  );
  // Loading the page re-checks databases never checked or checked more than five minutes ago (admins only), so the
  // lights in the collapsed row are current before anyone opens it.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!p.isAdmin || !data || autoChecked.current) return;
    autoChecked.current = true;
    const stale = data
      .filter((d) => d.enabled !== false && d.has_password)
      .filter(
        (d) => !d.last_checked_at || Date.now() - new Date(d.last_checked_at).getTime() > STALE_MS,
      )
      .map((d) => d.key);
    void test(stale);
  }, [p.isAdmin, data, test]);
  const set = (k: keyof DbForm, v: DbForm[keyof DbForm]) => {
    if (form) setForm({ ...form, [k]: v });
  };
  const save = async () => {
    if (!form) return;
    const body = {
      ...Object.fromEntries(
        Object.entries(form).filter(
          ([k]) =>
            !k.startsWith("last_") &&
            !["id", "has_password", "updated_at", "created_at", "created_by"].includes(k),
        ),
      ),
      port: Number(form.port),
      max_rows: Number(form.max_rows),
      timeout_ms: Number(form.timeout_ms),
      repositories: String(form.repositories)
        .split(",")
        .map((x: string) => x.trim())
        .filter(Boolean),
      password: form.password || undefined,
    };
    const r = await act(
      () => api<{ key: string }>("/api/integrations/databases", body),
      t("ig.db.saved"),
    );
    if (r) {
      setForm(null);
      reload();
      void test([r.key]); // check the new settings right away
    }
  };
  const summary = !enabled.length ? (
    t("ig.db.summaryOff")
  ) : (
    <span className="ig-db-summary">
      {enabled.map((d, i) => (
        <span key={d.key} className={`ig-db-sum is-${states[i]}`}>
          <span className="ig-db-light" aria-hidden />
          {d.key}
        </span>
      ))}
    </span>
  );
  return (
    <Row
      id="databases"
      icon={Database}
      title={t("ig.db.title")}
      env="QC"
      health={health}
      {...p}
      summary={summary}
    >
      <p className="muted small">{t("ig.db.body")}</p>
      {!list.length ? (
        <p className="muted small">{t(p.isAdmin ? "ig.db.emptyAdmin" : "ig.db.emptyMember")}</p>
      ) : (
        <div className="ig-db-cards">
          {list.map((d) => (
            <DbCard
              key={d.key}
              d={d}
              state={dbState(d, checking)}
              isAdmin={p.isAdmin}
              onTest={() => void test([d.key])}
              onEdit={() =>
                setForm({
                  ...EMPTY_DB,
                  ...d,
                  repositories: (d.repositories ?? []).join(", "),
                  password: "",
                })
              }
              onDelete={async () => {
                const ok = await dialog.confirm({
                  title: t("ig.db.delete.title"),
                  description: t("ig.db.deleteConfirm", { key: d.key }),
                  confirmLabel: t("ig.db.delete.action"),
                  cancelLabel: t("common.cancel"),
                  variant: "destructive",
                });
                if (!ok) return;
                if (
                  await act(
                    () => api(`/api/integrations/databases/${d.key}/delete`, {}),
                    t("ig.db.deleted"),
                  )
                )
                  reload();
              }}
            />
          ))}
        </div>
      )}
      {p.isAdmin && !form && (
        <div className="row">
          <button type="button" className="sm" onClick={() => setForm({ ...EMPTY_DB })}>
            <Database size={14} /> {t("ig.db.add")}
          </button>
          {enabled.length > 1 && (
            <button
              type="button"
              className="sm ghost"
              onClick={() => void test(enabled.filter((d) => d.has_password).map((d) => d.key))}
            >
              <RefreshCw size={14} /> {t("ig.db.checkAll")}
            </button>
          )}
        </div>
      )}
      {p.isAdmin && form && (
        <div className="ig-db-form">
          <div className="ig-db-grid">
            <Field label={t("ig.db.key")}>
              <input
                value={form.key}
                placeholder="oms-qc"
                onChange={(e) => set("key", e.target.value.trim().toLowerCase())}
              />
            </Field>
            <Field label={t("ig.db.project")}>
              <input
                value={form.project}
                placeholder="OMS"
                onChange={(e) => set("project", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.repositories")}>
              <input
                value={form.repositories}
                placeholder="warranty-api, warranty-worker"
                onChange={(e) => set("repositories", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.host")}>
              <input
                value={form.host}
                placeholder="oms-db.qc.internal"
                onChange={(e) => set("host", e.target.value.trim())}
              />
            </Field>
            <Field label={t("ig.db.port")}>
              <input
                type="number"
                value={form.port}
                onChange={(e) => set("port", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.database")}>
              <input
                value={form.database_name}
                onChange={(e) => set("database_name", e.target.value.trim())}
              />
            </Field>
            <Field label={t("ig.db.username")}>
              <input
                value={form.username}
                autoComplete="off"
                onChange={(e) => set("username", e.target.value.trim())}
              />
            </Field>
            <Field label={t("ig.db.password")}>
              <input
                type="password"
                autoComplete="new-password"
                value={form.password}
                placeholder={form.has_password ? t("ig.db.passwordKeep") : ""}
                onChange={(e) => set("password", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.maxRows")}>
              <input
                type="number"
                value={form.max_rows}
                onChange={(e) => set("max_rows", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.timeout")}>
              <input
                type="number"
                value={form.timeout_ms}
                onChange={(e) => set("timeout_ms", e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("ig.db.description")}>
            <input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <label className="small">
            <input
              type="checkbox"
              checked={form.ssl}
              onChange={(e) => set("ssl", e.target.checked)}
            />{" "}
            TLS
          </label>{" "}
          <label className="small">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />{" "}
            {t("ig.db.enabled")}
          </label>
          <p className="muted small">{t("ig.db.scopeHint")}</p>
          <div className="row">
            <button type="button" className="sm" onClick={save}>
              {t("common.save")}
            </button>
            <button type="button" className="sm ghost" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------- platform accounts

function sourceLabel(t: (k: string) => string, source: string) {
  return source === "platform" ? t("ig.src.platform") : "";
}

type BitbucketStatus = {
  configured: boolean;
  source: string;
  personal: boolean;
  user: string | null;
  token: string;
  workspace: string;
  reviewers: string[];
};
type GithubStatus = { configured: boolean; source: string; personal: boolean; token: string };
const TELEGRAM_PREF_KEYS = [
  "approvals",
  "questions",
  "failures",
  "completions",
  "interactive",
  "chat",
  "blocked",
  "recoveries",
  "pull_requests",
  "autonomy",
  "intake",
] as const;
type TelegramPrefKey = (typeof TELEGRAM_PREF_KEYS)[number];
type TelegramPrefs = Partial<Record<TelegramPrefKey, boolean>> & {
  locale?: string;
  level?: string;
  quiet_start?: number | null;
  quiet_end?: number | null;
  timezone?: string;
};
type TelegramStatus = {
  configured: boolean;
  canManage: boolean;
  myChatId: string | null;
  source: string;
  chatId: string | null;
  botToken: string;
  mode: string;
  modeSource: string;
  needsRebind?: boolean;
  binding?: { telegram_user_id: string; chat_id: string; created_at: string } | null;
  preferences?: TelegramPrefs;
  receiver?: { active: boolean; mode: string | null };
};

function Bitbucket(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<BitbucketStatus>("/api/integrations/bitbucket");
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
      () => api<BitbucketStatus>("/api/integrations/bitbucket", { ...v, token: f.token }),
      t("ig.bb.saved"),
    );
    setBusy(false);
    if (r) {
      setF({ token: "" });
      reload();
    }
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
      <Steps>
        <li>
          {slot(t("ig.bb.s1"), {
            link: <Link href="https://id.atlassian.com/manage-profile/security/api-tokens" />,
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
        <Field label={st?.configured ? t("ig.bb.tokenNow", { token: st.token }) : t("ig.bb.token")}>
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
          type="button"
          className="sm"
          disabled={busy || !v.user || (!f.token && !st?.configured)}
          onClick={save}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        {st?.source === "platform" && (
          <button
            type="button"
            className="sm ghost"
            onClick={async () =>
              (await act(() => api("/api/integrations/bitbucket/clear", {}), t("ig.removed"))) &&
              (setF({ token: "" }), reload())
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

function GitHubAccount(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<GithubStatus>("/api/integrations/github");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(
      () => api<GithubStatus>("/api/integrations/github", { token }),
      t("ig.gh.saved"),
    );
    setBusy(false);
    if (r) {
      setToken("");
      reload();
    }
  };
  return (
    <Row
      id="github"
      icon={GitPullRequest}
      title="GitHub"
      health={!st ? "loading" : st.configured ? "ok" : "off"}
      {...p}
      summary={st?.configured ? st.token : t("ig.gh.summaryOff")}
    >
      <p className="muted small">{t("ig.gh.body")}</p>
      <Field label={t("ig.gh.token")}>
        <input
          type="password"
          autoComplete="off"
          value={token}
          placeholder={st?.configured ? t("ig.keep") : t("ig.gh.tokenPh")}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <div className="ig-actions">
        <button type="button" className="sm" disabled={busy || !token} onClick={save}>
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        {st?.personal && (
          <button
            type="button"
            className="sm ghost"
            onClick={async () =>
              (await act(() => api("/api/integrations/github/clear", {}), t("ig.removed"))) &&
              (setToken(""), reload())
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

/**
 * Per-instance GitLab access token (personal or project access token). The host must be one of the allowed instances,
 * which an admin adds here (stored in the database); the token is never shown again, only whether one is saved.
 */
function GitLabAccount(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<{
    instances: Array<{
      host: string;
      base_url: string;
      configured: boolean;
      personal: boolean;
      ssh_available: boolean;
      ssh_key: boolean;
    }>;
    can_manage?: boolean;
  }>("/api/integrations/gitlab");
  const [newHost, setNewHost] = useState("");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; kind: string; message: string } | null>(null);
  const instances = st?.instances ?? [];
  const selected = host || instances[0]?.host || "";
  const current = instances.find((i) => i.host === selected);
  const connected = instances.filter((i) => i.configured);
  const save = async () => {
    setBusy(true);
    setCheck(null);
    const r = await act(
      () => api<unknown>("/api/integrations/gitlab", { host: selected, token }),
      t("ig.gl.saved"),
    );
    setBusy(false);
    if (r) {
      setToken("");
      reload();
    }
  };
  const saveSsh = async () => {
    setBusy(true);
    const r = await act(
      () => api<unknown>("/api/integrations/gitlab/ssh-key", { host: selected, ssh_key: sshKey }),
      t("ig.gl.sshSaved"),
    );
    setBusy(false);
    if (r) {
      setSshKey("");
      reload();
    }
  };
  const addInstance = async () => {
    setBusy(true);
    const r = await act(
      () =>
        api<{ instances: Array<{ host: string }> }>("/api/integrations/gitlab/instances", {
          host: newHost,
        }),
      t("ig.gl.instanceAdded"),
    );
    setBusy(false);
    if (r) {
      const added = r.instances.find((i) => !instances.some((x) => x.host === i.host));
      setNewHost("");
      if (added) setHost(added.host);
      setCheck(null);
      reload();
    }
  };
  const removeInstance = async () => {
    if (!selected) return;
    const ok = await dialog.confirm({
      title: t("ig.gl.instanceRemove.title"),
      description: t("ig.gl.instanceRemoveConfirm", { host: selected }),
      confirmLabel: t("ig.gl.instanceRemove.action"),
      cancelLabel: t("common.cancel"),
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    const r = await act(
      () => api("/api/integrations/gitlab/instances/remove", { host: selected }),
      t("ig.removed"),
    );
    setBusy(false);
    if (r) {
      setHost("");
      setCheck(null);
      reload();
    }
  };
  const test = async () => {
    setBusy(true);
    const r = await act(() =>
      api<{ ok: boolean; kind: string; message: string }>("/api/integrations/gitlab/test", {
        host: selected,
      }),
    );
    setBusy(false);
    if (r) setCheck(r);
  };
  return (
    <Row
      id="gitlab"
      icon={GitPullRequest}
      title="GitLab"
      health={!st ? "loading" : connected.length ? "ok" : "off"}
      {...p}
      summary={connected.length ? connected.map((i) => i.host).join(", ") : t("ig.gl.summaryOff")}
    >
      <p className="muted small">{t("ig.gl.body")}</p>
      <Field label={t("ig.gl.instance")} hint={t("ig.gl.instanceHint")}>
        <span className="ig-gl-instance">
          <select value={selected} onChange={(e) => (setHost(e.target.value), setCheck(null))}>
            {instances.map((i) => (
              <option key={i.host} value={i.host}>
                {i.base_url}
                {i.personal ? ` · ${t("ig.gl.saved")}` : ""}
              </option>
            ))}
          </select>
          {st?.can_manage && selected && (
            <button
              type="button"
              className="sm ghost"
              disabled={busy}
              title={t("ig.gl.instanceRemove")}
              aria-label={t("ig.gl.instanceRemove")}
              onClick={removeInstance}
            >
              <Trash2 size={14} strokeWidth={2} />
            </button>
          )}
        </span>
      </Field>
      {st?.can_manage && (
        <Field label={t("ig.gl.instanceAdd")} hint={t("ig.gl.instanceAddHint")}>
          <span className="ig-gl-instance">
            <input
              value={newHost}
              autoComplete="off"
              placeholder="https://gitlab.example.com"
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newHost.trim() && addInstance()}
            />
            <button
              type="button"
              className="sm ghost"
              disabled={busy || !newHost.trim()}
              onClick={addInstance}
            >
              <Plus size={14} strokeWidth={2} />
              {t("ig.gl.instanceAddButton")}
            </button>
          </span>
        </Field>
      )}
      <Field label={t("ig.gl.token")}>
        <input
          type="password"
          autoComplete="off"
          value={token}
          placeholder={current?.personal ? t("ig.keep") : "glpat-…"}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      {current?.ssh_available && (
        <Field label={t("ig.gl.sshKey")} hint={t("ig.gl.sshKeyHint")}>
          <textarea
            rows={3}
            autoComplete="off"
            spellCheck={false}
            value={sshKey}
            placeholder={current.ssh_key ? t("ig.keep") : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            onChange={(e) => setSshKey(e.target.value)}
          />
          <button type="button" className="sm ghost" disabled={busy || !sshKey} onClick={saveSsh}>
            <KeyRound size={14} strokeWidth={2} />
            {t("ig.gl.sshSave")}
          </button>
        </Field>
      )}
      {check && (
        <p className={`small ${check.ok ? "" : "error"}`}>
          {check.ok ? "✓ " : `${t(`ig.gl.err.${check.kind}`)}: `}
          {check.message}
        </p>
      )}
      <div className="ig-actions">
        <button type="button" className="sm" disabled={busy || !token || !selected} onClick={save}>
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        <button
          type="button"
          className="sm ghost"
          disabled={busy || !current?.configured}
          onClick={test}
        >
          {t("ig.gl.test")}
        </button>
        {current?.personal && (
          <button
            type="button"
            className="sm ghost"
            onClick={async () => {
              const ok = await act(
                () => api("/api/integrations/gitlab/clear", { host: selected }),
                t("ig.removed"),
              );
              if (!ok) return;
              setToken("");
              setCheck(null);
              reload();
            }}
          >
            <LogOut size={14} strokeWidth={2} />
            {t("ig.removePlatform")}
          </button>
        )}
      </div>
    </Row>
  );
}

/**
 * Background Git sync by consent: indexing and workspace refreshes nobody started in person run with this account's own
 * Git tokens (above), for the repositories this account can read. Off by default; stored with this account only.
 */
function BackgroundGit(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<{ enabled: boolean; hosts: string[] }>(
    "/api/integrations/background-git",
  );
  const toggle = async (enabled: boolean) => {
    if (await act(() => api("/api/integrations/background-git", { enabled }), t("ig.bg.saved")))
      void reload();
  };
  return (
    <Row
      id="background-git"
      icon={RefreshCw}
      title={t("ig.bg.title")}
      health={!st ? "loading" : st.enabled ? (st.hosts.length ? "ok" : "partial") : "off"}
      summary={st?.enabled ? st.hosts.join(", ") || t("ig.bg.noToken") : t("ig.bg.offSummary")}
      {...p}
    >
      <p className="small">{t("ig.bg.explain")}</p>
      <label className="ig-check">
        <input
          type="checkbox"
          checked={!!st?.enabled}
          disabled={!st}
          onChange={(e) => void toggle(e.target.checked)}
        />{" "}
        {t("ig.bg.allow")}
      </label>
      {st?.enabled && !st.hosts.length && <p className="small err">{t("ig.bg.noToken")}</p>}
    </Row>
  );
}

function Telegram(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<TelegramStatus>("/api/integrations/telegram");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState<string>();
  const [mine, setMine] = useState<string>();
  const [chats, setChats] = useState<Array<{ id: string; name: string; type: string }> | null>(
    null,
  );
  const [bindingLink, setBindingLink] = useState("");
  const [prefs, setPrefs] = useState<TelegramPrefs>({});
  const [busy, setBusy] = useState(false);
  const chat = chatId ?? st?.chatId ?? "";
  const connect = async () => {
    const result = await act(() => api<{ url: string }>("/api/integrations/telegram/connect", {}));
    if (result) setBindingLink(result.url);
  };
  const disconnect = async () => {
    if (await act(() => api("/api/integrations/telegram/disconnect", {}))) {
      setBindingLink("");
      reload();
    }
  };
  const savePrefs = async () => {
    if (
      await act(() => api("/api/integrations/telegram/preferences", prefs), t("ig.tg.prefsSaved"))
    ) {
      setPrefs({});
      reload();
    }
  };
  const save = async () => {
    setBusy(true);
    const result = await act(
      () => api("/api/integrations/telegram", { botToken: token, chatId: chat }),
      t("ig.tg.saved"),
    );
    setBusy(false);
    if (result) {
      setToken("");
      setChatId(undefined);
      reload();
    }
  };
  return (
    <Row
      id="telegram"
      icon={Send}
      title="Telegram"
      health={!st ? "loading" : st.configured ? "ok" : "off"}
      {...p}
      summary={
        st?.configured ? (
          <>
            {sourceLabel(t, st.source)} ·{" "}
            {st.binding
              ? t("ig.tg.connected", { id: st.binding.telegram_user_id })
              : t("ig.tg.mineMissing")}
          </>
        ) : (
          t("ig.tg.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.tg.body")}</p>
      {st?.canManage && (
        <>
          <Steps>
            <li>{slot(t("ig.tg.s1"), { link: <Link href="https://t.me/BotFather" /> })}</li>
            <li>{t("ig.tg.s2")}</li>
            <li>{t("ig.tg.s3")}</li>
          </Steps>
          <div className="ig-grid">
            <Field
              label={st.configured ? t("ig.tg.tokenNow", { token: st.botToken }) : t("ig.tg.token")}
            >
              <input
                type="password"
                autoComplete="off"
                value={token}
                placeholder={st.configured ? t("ig.keep") : "123456789:AA…"}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <Field label={t("ig.tg.chatId")}>
              <input value={chat} onChange={(e) => setChatId(e.target.value)} />
            </Field>
          </div>
          {chats && (
            <div className="ig-chats small">
              {chats.length ? (
                chats.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="sm ghost"
                    onClick={() => setChatId(c.id)}
                  >
                    {c.name || c.id} · {c.type} · {c.id}
                  </button>
                ))
              ) : (
                <span>{t("ig.tg.none")}</span>
              )}
            </div>
          )}
          <div className="ig-actions">
            <button
              type="button"
              className="sm"
              disabled={busy || (!token && !st.configured)}
              onClick={save}
            >
              {busy ? t("ig.checking") : t("ig.save")}
            </button>
            <button
              type="button"
              className="sm ghost"
              disabled={!token && !st.configured}
              onClick={async () => {
                const result = await act(() =>
                  api<Array<{ id: string; name: string; type: string }>>(
                    "/api/integrations/telegram/chats",
                    { botToken: token },
                  ),
                );
                if (result) setChats(result);
              }}
            >
              {t("ig.tg.find")}
            </button>
            {st.source === "platform" && (
              <button
                type="button"
                className="sm ghost"
                onClick={async () => {
                  if (await act(() => api("/api/integrations/telegram/clear", {}))) reload();
                }}
              >
                {t("ig.removePlatform")}
              </button>
            )}
          </div>
        </>
      )}
      {st?.configured && (
        <section className="ig-telegram-settings">
          <h4>{t("ig.tg.interactiveTitle")}</h4>
          <p className="muted small">{t("ig.tg.bindingHint")}</p>
          <p className="small">
            {t("ig.tg.transport")}: <code>{st.mode ?? "off"}</code>
            {st.mode && st.mode !== "off" && (
              <>
                {" "}
                ·{" "}
                <span
                  className={`ig-tg-receiver ${st.receiver?.active ? "is-ok" : "is-warn"}`}
                  role="status"
                >
                  {t(st.receiver?.active ? "ig.tg.receiverActive" : "ig.tg.receiverDown")}
                </span>
              </>
            )}
          </p>
          {st.canManage && (
            <Field label={t("ig.tg.modeTitle")}>
              <select
                aria-label={t("ig.tg.modeTitle")}
                value={st.mode === "polling" ? "polling" : "off"}
                onChange={async (e) => {
                  if (
                    await act(
                      () => api("/api/integrations/telegram/mode", { mode: e.target.value }),
                      t("ig.tg.modeSaved"),
                    )
                  )
                    reload();
                }}
              >
                <option value="off">{t("ig.tg.modeOffOpt")}</option>
                <option value="polling">{t("ig.tg.modePolling")}</option>
              </select>
            </Field>
          )}
          {st.mode === "off" && <p className="muted small">{t("ig.tg.modeOff")}</p>}
          {st.needsRebind && <p>{t("ig.tg.rebind")}</p>}
          <div className="ig-actions">
            {st.binding || st.needsRebind ? (
              <button type="button" className="ghost sm" onClick={disconnect}>
                {t("ig.tg.disconnect")}
              </button>
            ) : (
              <button type="button" className="sm" disabled={st.mode === "off"} onClick={connect}>
                {t("ig.tg.connect")}
              </button>
            )}
            {bindingLink && !st.binding && (
              <>
                <a className="btn ghost sm" href={bindingLink} target="_blank" rel="noreferrer">
                  {t("ig.tg.openBinding")}
                </a>
                <button type="button" className="ghost sm" onClick={reload}>
                  {t("ig.tg.checkBinding")}
                </button>
              </>
            )}
          </div>
          <div className="ig-grid">
            {TELEGRAM_PREF_KEYS.map((key) => (
              <label className="row tight small" key={key}>
                <input
                  type="checkbox"
                  checked={prefs[key] ?? st.preferences?.[key] ?? true}
                  onChange={(e) => setPrefs((v) => ({ ...v, [key]: e.target.checked }))}
                />
                {t(`ig.tg.pref.${key}`)}
              </label>
            ))}
            <Field label={t("ig.tg.level")}>
              <select
                aria-label={t("ig.tg.level")}
                value={prefs.level ?? st.preferences?.level ?? "important"}
                onChange={(e) => setPrefs((v) => ({ ...v, level: e.target.value }))}
              >
                {(["all", "important", "critical"] as const).map((l) => (
                  <option key={l} value={l}>
                    {t(`ig.tg.level.${l}`)}
                  </option>
                ))}
              </select>
            </Field>
            {(["quiet_start", "quiet_end"] as const).map((key) => (
              <Field label={t(`ig.tg.${key}`)} key={key}>
                <select
                  aria-label={t(`ig.tg.${key}`)}
                  value={String((key in prefs ? prefs[key] : st.preferences?.[key]) ?? "")}
                  onChange={(e) =>
                    setPrefs((v) => ({
                      ...v,
                      [key]: e.target.value === "" ? null : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">—</option>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                  ))}
                </select>
              </Field>
            ))}
            <Field label={t("ig.tg.language")}>
              <select
                aria-label={t("ig.tg.language")}
                value={prefs.locale ?? st.preferences?.locale ?? "vi"}
                onChange={(e) => setPrefs((v) => ({ ...v, locale: e.target.value }))}
              >
                <option value="vi">Tiếng Việt</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
          <button
            type="button"
            className="ghost sm"
            disabled={!Object.keys(prefs).length}
            onClick={savePrefs}
          >
            {t("ig.save")}
          </button>
          {!st.binding && (
            <details>
              <summary>{t("ig.tg.legacy")}</summary>
              <Field label={t("ig.tg.mine")}>
                <input
                  value={mine ?? st.myChatId ?? ""}
                  onChange={(e) => setMine(e.target.value)}
                />
              </Field>
              <button
                type="button"
                className="ghost sm"
                onClick={async () => {
                  if (
                    await act(() =>
                      api("/api/integrations/telegram/destination", {
                        chatId: mine ?? st.myChatId ?? "",
                      }),
                    )
                  ) {
                    setMine(undefined);
                    reload();
                  }
                }}
              >
                {t("ig.tg.mineSave")}
              </button>
              <p className="muted small">{t("ig.tg.legacyHint")}</p>
            </details>
          )}
          <button
            type="button"
            className="ghost sm"
            onClick={() => act(() => api("/api/integrations/telegram/test", {}), t("ig.tg.sent"))}
          >
            {t("ig.tg.test")}
          </button>
        </section>
      )}
    </Row>
  );
}

function AgentAccounts() {
  const { t } = useI18n();
  const status = useApi<Array<{ id: string; ok: boolean; error?: string }>>("/api/agent-providers");
  return (
    <section className="ig-group">
      <h3 className="ig-group-title">{t("ig.cli.title")}</h3>
      <p className="small muted">{t("ig.cli.lead")}</p>
      {status.loading && !status.data && <SkeletonRows rows={2} />}
      {status.error && <ErrorBox error={status.error} onRetry={status.reload} />}
      {status.data && !status.data.length && <Empty>{t("ig.cli.none")}</Empty>}
      {status.data?.map((provider) => (
        <div key={provider.id} className="card">
          <strong>{provider.id}</strong> ·{" "}
          {provider.ok ? t("ig.cli.available") : t("ig.cli.unavailable")}
          {provider.id === "copilot" && (
            <p className="small">
              {slot(t("ig.cli.copilotHint"), { cmd: <code>copilot auth login</code> })}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

export function IntegrationsPage({ me }: { me?: { role?: string } | null } = {}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const row = (id: string) => ({
    open: open === id,
    onToggle: (x: string) => setOpen(open === x ? null : x),
  });
  return (
    <>
      <PageHeader icon={PlugZap} title={t("ig.title")} subtitle={t("ig.subtitle")} />
      <AgentAccounts />
      <section className="ig-group">
        <h3 className="ig-group-title">
          {t("ig.sources")} <span className="muted small">· {t("ig.sourcesHint")}</span>
        </h3>
        <div className="ig-list">
          <ArgoCd {...row("argocd")} />
          <Kafka {...row("kafka")} />
          <Vault {...row("vault")} />
          <Splunk {...row("splunk")} />
          <SigNoz {...row("signoz")} />
          <ProjectDatabases {...row("databases")} isAdmin={me?.role === "admin"} />
        </div>
      </section>
      <section className="ig-group">
        <h3 className="ig-group-title">{t("ig.accounts")}</h3>
        <div className="ig-list">
          <Bitbucket {...row("bitbucket")} />
          <GitHubAccount {...row("github")} />
          <GitLabAccount {...row("gitlab")} />
          <BackgroundGit {...row("background-git")} />
          <Telegram {...row("telegram")} />
        </div>
      </section>
    </>
  );
}
