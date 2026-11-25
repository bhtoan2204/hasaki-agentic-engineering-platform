import { LockKeyhole, LogOut } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { PasteForm } from "./PasteForm.tsx";
import { type Health, Link, Row, Steps, type VaultStatus, slot } from "./shared.tsx";

export function Vault(p: { open: boolean; onToggle: (id: string) => void }) {
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
            link: <Link href={st?.baseUrl ?? "https://vault-qc-v2.example.dev"} />,
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
