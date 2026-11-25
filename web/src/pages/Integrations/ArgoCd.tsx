import { LogOut, Server } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { PasteForm } from "./PasteForm.tsx";
import { type ArgoStatus, type Health, Link, Row, Steps, slot } from "./shared.tsx";

export function ArgoCd(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<ArgoStatus>("/api/integrations/argocd");
  const health: Health = !st ? "loading" : st.loggedIn ? "ok" : st.expired ? "expired" : "off";
  const href = st?.baseUrl ?? "https://argocd-qc-v2.example.dev";
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
