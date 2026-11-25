import { useState } from "react";
import { GitPullRequest, KeyRound, LogOut } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type GithubStatus, Row } from "./shared.tsx";

export function GitHubAccount(p: { open: boolean; onToggle: (id: string) => void }) {
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
        <button
          type="button"
          className="sm"
          disabled={busy || !token}
          aria-describedby={!token ? "ig-h4" : undefined}
          onClick={save}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        {!token && (
          <span id="ig-h4" className="muted small">
            {t("hint.fillRequired")}
          </span>
        )}
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
