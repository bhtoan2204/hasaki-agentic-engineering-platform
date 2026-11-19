import { useState } from "react";
import { Bot } from "lucide-react";
import { api, useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { act, ErrorBox } from "../ui.tsx";

type Policy = {
  id: number;
  scope_kind: "global" | "owner" | "repository";
  scope_ref: string;
  mode: string;
  shadow: boolean;
  gates: string[];
  max_diff_lines: number;
  revision: number;
  revoked_at: string | null;
};
type View = { policies: Policy[]; modes: string[]; gates: string[] };

/** Admin-only: autonomy policies per scope. New policies start in shadow; revocation applies to running runs too. */
export function AutonomyPolicies() {
  const { t } = useI18n();
  const { data, error, reload } = useApi<View>("/api/autonomy/policies");
  const [draft, setDraft] = useState({
    scope_kind: "global" as Policy["scope_kind"],
    scope_ref: "",
    mode: "SUPERVISED",
    shadow: true,
    gates: [] as string[],
    max_diff_lines: 400,
  });
  const save = async () => (await act(() => api("/api/autonomy/policies", draft))) && reload();
  const revoke = async (id: number) =>
    (await act(() => api(`/api/autonomy/policies/${id}/revoke`, {}))) && reload();
  return (
    <section id="set-autonomy" className="card set-section">
      <header className="set-section-head">
        <Bot size={18} aria-hidden />
        <h3>{t("au.policies")}</h3>
      </header>
      <p className="muted small">{t("au.policiesHint")}</p>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.policies.length === 0 && <p className="small muted">{t("au.empty")}</p>}
      {data?.policies.map((p) => (
        <div
          key={p.id}
          className="small"
          style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }}
        >
          <span className="mono">
            {p.scope_kind === "global" ? "global" : `${p.scope_kind}:${p.scope_ref}`}
          </span>
          <b>{p.mode}</b>
          {p.shadow && <span className="muted">shadow</span>}
          <span className="muted">{p.gates.join(", ") || "—"}</span>
          <span className="muted">≤ {p.max_diff_lines}</span>
          <span className="muted">{t("au.rev", { n: p.revision })}</span>
          {p.revoked_at ? (
            <span className="err">{t("au.revoked")}</span>
          ) : (
            <button className="ghost sm" onClick={() => revoke(p.id)}>
              {t("au.revoke")}
            </button>
          )}
        </div>
      ))}
      {data && (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", marginTop: 10 }}
        >
          <label className="small">
            {t("au.scope")}
            <select
              value={draft.scope_kind}
              onChange={(e) =>
                setDraft({ ...draft, scope_kind: e.target.value as Policy["scope_kind"] })
              }
            >
              <option value="global">global</option>
              <option value="owner">owner</option>
              <option value="repository">repository</option>
            </select>
          </label>
          {draft.scope_kind !== "global" && (
            <label className="small">
              {t("au.scopeRef")}
              <input
                value={draft.scope_ref}
                onChange={(e) => setDraft({ ...draft, scope_ref: e.target.value })}
              />
            </label>
          )}
          <label className="small">
            {t("au.mode")}
            <select
              value={draft.mode}
              onChange={(e) => setDraft({ ...draft, mode: e.target.value })}
            >
              {data.modes.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="small">
            <input
              type="checkbox"
              checked={draft.shadow}
              onChange={(e) => setDraft({ ...draft, shadow: e.target.checked })}
            />{" "}
            shadow
          </label>
          <fieldset className="small" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{t("au.gates")}</legend>
            {data.gates.map((g) => (
              <label key={g} style={{ marginRight: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.gates.includes(g)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      gates: e.target.checked
                        ? [...draft.gates, g]
                        : draft.gates.filter((x) => x !== g),
                    })
                  }
                />{" "}
                {g}
              </label>
            ))}
          </fieldset>
          <label className="small">
            {t("au.maxDiff")}
            <input
              type="number"
              min={1}
              value={draft.max_diff_lines}
              onChange={(e) => setDraft({ ...draft, max_diff_lines: Number(e.target.value) })}
              style={{ width: 90 }}
            />
          </label>
          <button onClick={save}>{t("au.save")}</button>
        </div>
      )}
    </section>
  );
}
