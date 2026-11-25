import { LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { PasteForm } from "./PasteForm.tsx";
import {
  type Health,
  Link,
  Row,
  SplunkShared,
  type SplunkStatus,
  SplunkTest,
  SplunkToken,
  Steps,
  slot,
} from "./shared.tsx";

export function Splunk(p: { open: boolean; onToggle: (id: string) => void }) {
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
            link: <Link href={st?.baseUrl ?? "https://siem.example.work"} />,
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
