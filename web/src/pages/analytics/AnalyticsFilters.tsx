import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../../i18n/index.tsx";
import type { Row } from "./shared.tsx";
export function defaultFilters() {
  const now = new Date();
  const to = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  );
  const from = new Date(to.getTime() - 30 * 86400000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
    bucket: "day",
    provider: "",
    model: "",
    user: "",
    workflow: "",
    repository: "",
    project: "",
    service: "",
    namespace: "",
    severity: "",
    incident_status: "",
    environment: "",
  };
}
export function AnalyticsFilters({
  query,
  options,
  onApply,
  domain = "insights",
}: {
  domain?: "insights" | "production";
  query: string;
  options: Row | null;
  onApply: (params: URLSearchParams) => void;
}) {
  const { t } = useI18n();
  const initial = () => {
    const p = new URLSearchParams(query);
    const defaults = defaultFilters();
    return Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [k, p.get(k) ?? v]),
    );
  };
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(initial());
  }, [query]); // URL is the applied filter state shared by the domain dashboards.
  const set = (k: string, v: string) =>
    setDraft((d) => ({
      ...d,
      [k]: v,
      ...(k === "namespace" ? { service: "" } : {}),
    }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    const old = new URLSearchParams(query);
    for (const [k, v] of Object.entries(draft)) {
      if (!v) continue;
      if (k === "from" || k === "to") {
        const original = old.get(k) ?? "";
        const originalDate = datePart(original, draft.timezone);
        p.set(k, v === originalDate ? original : v);
      } else p.set(k, v);
    }
    if (old.has("group_by")) p.set("group_by", old.get("group_by")!);
    for (const key of ["view", "return_query", "return_tab", "scope"])
      if (old.has(key)) p.set(key, old.get(key)!);
    onApply(p);
  };
  const select = (key: string, values: Array<[string, string]>) => (
    <label key={key}>
      {t(`an.${key}`)}
      <select
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
        aria-label={t(`an.${key}`)}
      >
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
            <input
              required
              type="date"
              value={datePart(draft.from, draft.timezone)}
              onChange={(e) => set("from", e.target.value)}
            />
          </label>
          <label>
            {t("an.to")}
            <input
              required
              type="date"
              value={datePart(draft.to, draft.timezone)}
              onChange={(e) => set("to", e.target.value)}
            />
          </label>
          <label>
            {t("an.timezone")}
            <select
              value={draft.timezone}
              onChange={(e) => set("timezone", e.target.value)}
            >
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
            <select
              value={draft.bucket}
              onChange={(e) => set("bucket", e.target.value)}
            >
              <option value="day">{t("an.day")}</option>
              <option value="hour">{t("an.hour")}</option>
            </select>
          </label>
          {domain === "insights" && <>{select(
            "provider",
            ["claude", "codex", "cursor", "antigravity"].map((v) => [v, v]),
          )}
          <label>
            {t("an.model")}
            <input
              value={draft.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder={t("an.all")}
            />
          </label>
          {select(
            "user",
            (options?.users ?? []).map((u: Row) => [String(u.id), u.username]),
          )}
          {(["workflow", "repository", "project"] as const).map((k) =>
            select(
              k,
              (
                options?.[
                  {
                    workflow: "workflows",
                    repository: "repositories",
                    project: "projects",
                  }[k]
                ] ?? []
              ).map((v: string) => [v, v]),
            ),
          )}
          </>}
          {domain === "production" && <>{select(
            "namespace",
            (options?.namespaces ?? []).map((v: string) => [v, v]),
          )}
          {select(
            "environment",
            (options?.environments ?? []).map((v: string) => [v, v]),
          )}
          {select(
            "severity",
            ["critical", "high", "medium", "low", "unknown"].map((v) => [v, v]),
          )}
          {select(
            "incident_status",
            ["open", "acknowledged", "resolved", "recurring"].map((v) => [
              v,
              t(
                `an.${v === "recurring" ? "recurringIncidents" : v === "open" ? "openIncidents" : v === "acknowledged" ? "acknowledgedIncidents" : "resolvedIncidents"}`,
              ),
            ]),
          )}
          <label>
            {t("an.service")}
            <select
              value={
                draft.service
                  ? `${draft.namespace || "*"}\u001f${draft.service}`
                  : ""
              }
              onChange={(e) => {
                const [namespace, service] = e.target.value.split("\u001f");
                setDraft((d) => ({
                  ...d,
                  service: service ?? "",
                  ...(namespace && namespace !== "*" ? { namespace } : {}),
                }));
              }}
              aria-label={t("an.service")}
            >
              <option value="">{t("an.all")}</option>
              {(options?.services ?? [])
                .filter(
                  (v: Row) =>
                    !draft.namespace || v.namespace === draft.namespace,
                )
                .map((v: Row) => (
                  <option
                    key={`${v.namespace}\u001f${v.service}`}
                    value={`${v.namespace}\u001f${v.service}`}
                  >
                    {v.service} · {v.namespace}
                  </option>
                ))}
            </select>
          </label>
          </>}
        </div>
        <div className="an-filter-footer">
          <p className="muted small">{t(domain === "production" ? "an.productionFilterHint" : "an.scopeHint")}</p>
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

function datePart(value: string, timezone: string) {
  if (!value) return "";
  if (value.length === 10) return value;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return value.slice(0, 10);
  }
}
