import { useState } from "react";
import { GitPullRequest, KeyRound, LogOut } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type BitbucketStatus, Link, Row, Steps, slot, sourceLabel } from "./shared.tsx";

export function Bitbucket(p: { open: boolean; onToggle: (id: string) => void }) {
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
          aria-describedby={!v.user || (!f.token && !st?.configured) ? "ig-h3" : undefined}
          onClick={save}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        {!v.user ||
          (!f.token && !st?.configured && (
            <span id="ig-h3" className="muted small">
              {t("hint.fillRequired")}
            </span>
          ))}
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
