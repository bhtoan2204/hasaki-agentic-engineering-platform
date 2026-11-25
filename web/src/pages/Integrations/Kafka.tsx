import { LogOut, RefreshCw, Waypoints } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { PasteForm } from "./PasteForm.tsx";
import { type Health, type KafkaStatus, Link, Row, Steps, slot } from "./shared.tsx";

export function Kafka(p: { open: boolean; onToggle: (id: string) => void }) {
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
            link: <Link href={st?.baseUrl ?? "https://kafka-ui-qc-v2.example.dev"} />,
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
