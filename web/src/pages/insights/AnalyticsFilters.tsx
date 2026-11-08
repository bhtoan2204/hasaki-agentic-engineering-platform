import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../../i18n/index.tsx";
import type { Row } from "./shared.tsx";
export function defaultFilters() {
  const now = new Date();
  const to = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const from = new Date(to.getTime() - 30 * 86400000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
    bucket: "day",
    provider: "",
    model: "",
    user: "",
    workflow: "",
    repository: "",
    project: "",
    service: "",
  };
}
export function AnalyticsFilters({
  query,
  options,
  onApply,
}: {
  query: string;
  options: Row | null;
  onApply: (params: URLSearchParams) => void;
}) {
  const { t } = useI18n();
  const initial = () => {
    const p = new URLSearchParams(query);
    const defaults = defaultFilters();
    return Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, p.get(k) ?? v]));
  };
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(initial());
  }, [query]); // URL is the applied filter state shared by all four tabs.
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) if (v) p.set(k, v);
    const old = new URLSearchParams(query);
    if (old.has("group_by")) p.set("group_by", old.get("group_by")!);
    onApply(p);
  };
  const select = (key: string, values: Array<[string, string]>) => (
    <label key={key}>
      {t(`an.${key}`)}
      <select value={draft[key]} onChange={(e) => set(key, e.target.value)} aria-label={t(`an.${key}`)}>
        <option value="">{t("an.all")}</option>
        {values.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form className="card an-filter" onSubmit={submit}>
      <details open>
        <summary>{t("an.filters")}</summary>
        <div className="an-filter-grid">
          <label>
            {t("an.from")}
            <input required type="date" value={draft.from} onChange={(e) => set("from", e.target.value)} />
          </label>
          <label>
            {t("an.to")}
            <input required type="date" value={draft.to} onChange={(e) => set("to", e.target.value)} />
          </label>
          <label>
            {t("an.timezone")}
            <select value={draft.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {[
                ...new Set([
                  draft.timezone,
                  "Asia/Bangkok",
                  "Asia/Ho_Chi_Minh",
                  "UTC",
                  "America/New_York",
                  "Europe/London",
                ]),
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            {t("an.bucket")}
            <select value={draft.bucket} onChange={(e) => set("bucket", e.target.value)}>
              <option value="day">{t("an.day")}</option>
              <option value="hour">{t("an.hour")}</option>
            </select>
          </label>
          {select(
            "provider",
            ["claude", "codex", "cursor"].map((v) => [v, v]),
          )}
          <label>
            {t("an.model")}
            <input value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder={t("an.all")} />
          </label>
          {select(
            "user",
            (options?.users ?? []).map((u: Row) => [String(u.id), u.username]),
          )}
          {(["workflow", "repository", "project"] as const).map((k) =>
            select(
              k,
              (options?.[{ workflow: "workflows", repository: "repositories", project: "projects" }[k]] ?? []).map(
                (v: string) => [v, v],
              ),
            ),
          )}
          <label>
            {t("an.service")}
            <input value={draft.service} onChange={(e) => set("service", e.target.value)} placeholder={t("an.all")} />
          </label>
        </div>
        <div className="an-filter-footer">
          <p className="muted small">{t("an.scopeHint")}</p>
          <button
            className="ghost sm"
            type="button"
            onClick={() => {
              setDraft(defaultFilters());
              onApply(new URLSearchParams(defaultFilters()));
            }}
          >
            {t("an.reset")}
          </button>
          <button type="submit" className="sm">
            {t("an.apply")}
          </button>
        </div>
      </details>
    </form>
  );
}
