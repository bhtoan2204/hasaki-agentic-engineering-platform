import { useState } from "react";
import { Activity, KeyRound, LogOut, PlugZap } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, Field, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type Health, Row, type SignozStatus, type SignozTestResult, Steps } from "./shared.tsx";

/** SigNoz: the user's own domain and API key or session tokens (never sent back), enable switch, test and disconnect. */
export function SigNoz(p: { open: boolean; onToggle: (id: string) => void }) {
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
          aria-describedby={
            !(baseUrl ?? st?.base_url) || (!token && !st?.token_set) ? "ig-h2" : undefined
          }
        >
          <KeyRound size={14} strokeWidth={2} />
          {st?.enabled ? t("ig.signoz.update") : t("ig.signoz.enable")}
        </button>
        {!(baseUrl ?? st?.base_url) ||
          (!token && !st?.token_set && (
            <span id="ig-h2" className="muted small">
              {t("hint.fillRequired")}
            </span>
          ))}
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
