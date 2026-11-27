import { useState, type ReactNode } from "react";
import {
  ChevronRight,
  ExternalLink,
  LogOut,
  PlugZap,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { PasteForm } from "./PasteForm.tsx";

/** One translated sentence with a {name} slot rendered as a node (a link), not string concatenation. */
export function slot(text: string, parts: Record<string, ReactNode>) {
  return text.split(/\{(\w+)\}/g).map((part, i) => (i % 2 ? (parts[part] ?? `{${part}}`) : part));
}

export type Health = "ok" | "expired" | "off" | "loading" | "error" | "partial";

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
export function Row({
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

export const Link = ({ href }: { href: string }) => (
  <a href={href} target="_blank" rel="noreferrer">
    {href.replace(/^https?:\/\//, "")} <ExternalLink size={11} />
  </a>
);

export const Steps = ({ children }: { children: ReactNode }) => (
  <ol className="ig-steps small">{children}</ol>
);

// ---------------------------------------------------------------- investigation sources (agent tools, read-only)

export type ArgoStatus = {
  baseUrl: string;
  loggedIn: boolean;
  user: string | null;
  expiresAt: string | null;
  expired: boolean;
};

export type KafkaStatus = {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  clusters?: Array<{ name: string; status: string; brokers: number; topics: number }>;
};

export type SplunkStatus = {
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

export type SignozStatus = {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  base_url: string | null;
  auth: "api_key" | "session" | null;
  token_set: boolean;
  last_ok_at: string | null;
  last_error: string | null;
};

export type SignozTestResult =
  { ok: true; latency_ms: number } | { ok: false; kind: string; message: string };

export type VaultStatus = {
  baseUrl: string;
  connected: boolean;
  expired: boolean;
  user: string | null;
  policies: string[];
  expiresAt: string | null;
  renewable: boolean;
};

/** Alternative to the cookie: a personal Splunk authentication token (Settings → Tokens), validated before saving. */
export function SplunkToken({ onSaved, connected }: { onSaved: () => void; connected: boolean }) {
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
export function SplunkTest({ connected }: { connected: boolean }) {
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
export function SplunkShared({ st, onSaved }: { st: SplunkStatus | null; onSaved: () => void }) {
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

// ---------------------------------------------------------------- project QC databases

export const EMPTY_DB = {
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

export type DbInfo = {
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

export type DbForm = Omit<typeof EMPTY_DB, "port" | "max_rows" | "timeout_ms"> & {
  port: number | string;
  max_rows: number | string;
  timeout_ms: number | string;
  has_password?: boolean;
};

/** A database's state as shown: a test in progress wins, then disabled, then the last known result. */
export type DbState = "checking" | "ok" | "failed" | "untested" | "off";

export const dbState = (d: DbInfo, checking: Set<string>): DbState =>
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
export const STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------- platform accounts

export function sourceLabel(t: (k: string) => string, source: string) {
  return source === "platform" ? t("ig.src.platform") : "";
}

export type BitbucketStatus = {
  configured: boolean;
  source: string;
  personal: boolean;
  user: string | null;
  token: string;
  workspace: string;
  reviewers: string[];
};

export type GithubStatus = {
  configured: boolean;
  source: string;
  personal: boolean;
  token: string;
};

export const TELEGRAM_PREF_KEYS = [
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

export type TelegramPrefs = Partial<Record<TelegramPrefKey, boolean>> & {
  locale?: string;
  level?: string;
  quiet_start?: number | null;
  quiet_end?: number | null;
  timezone?: string;
};

export type TelegramStatus = {
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

/**
 * Background Git sync by consent: indexing and workspace refreshes nobody started in person run with this account's own
 * Git tokens (above), for the repositories this account can read. Off by default; stored with this account only.
 */
export function BackgroundGit(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<{ enabled: boolean; hosts: string[] }>(
    "/api/integrations/background-git",
  );
  const [toggling, setToggling] = useState(false);
  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      if (await act(() => api("/api/integrations/background-git", { enabled }), t("ig.bg.saved")))
        await reload();
    } finally {
      setToggling(false);
    }
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
          disabled={!st || toggling}
          onChange={(e) => void toggle(e.target.checked)}
        />{" "}
        {t("ig.bg.allow")}
      </label>
      {st?.enabled && !st.hosts.length && <p className="small err">{t("ig.bg.noToken")}</p>}
    </Row>
  );
}
