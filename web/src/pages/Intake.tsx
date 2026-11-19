import { useState } from "react";
import { Inbox } from "lucide-react";
import { api, useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { act, ErrorBox, Loading, time } from "../ui.tsx";

type Item = {
  id: number;
  source: string;
  state: string;
  severity: string | null;
  service: string | null;
  repo_candidate: string | null;
  workflow: string | null;
  occurrences: number;
  last_seen: string;
  reason: string;
  would_start: { workflow: string; repo: string } | null;
  stale_revision: boolean | null;
  run_id: number | null;
  work_item_id: number | null;
};
const STATES = ["", "eligible", "deferred", "running", "superseded", "rejected", "resolved"];

/** Intake queue: why each item would, would not, or did start. Owners see theirs; admins may see all. */
export function IntakeQueue({ all = false }: { all?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState("");
  const { data, error, loading, reload } = useApi<Item[]>(
    `/api/intake/items?${all ? "all=1&" : ""}${state ? `state=${state}` : ""}`,
    [state],
  );
  const retriage = async (id: number) =>
    (await act(() => api(`/api/intake/items/${id}/retriage`, {}))) && reload();
  return (
    <section className="card set-section" id="set-intake-queue">
      <header className="set-section-head">
        <Inbox size={18} aria-hidden />
        <h3>{t("in.queue")}</h3>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label={t("in.state")}>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s || t("in.allStates")}
            </option>
          ))}
        </select>
      </header>
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.length === 0 && <p className="small muted">{t("in.empty")}</p>}
      {data?.map((i) => (
        <div key={i.id} className="small" style={{ margin: "4px 0" }}>
          <b>#{i.id}</b> {i.source} · <b>{i.state}</b>
          {i.severity && <> · {i.severity}</>}
          {i.service && <> · {i.service}</>}
          {i.repo_candidate && <> · {i.repo_candidate}</>}
          {i.workflow && <> · {i.workflow}</>} · ×{i.occurrences} · {time(i.last_seen)}
          {i.run_id && (
            <>
              {" "}
              · <a href={`#/runs/${i.run_id}`}>run #{i.run_id}</a>
            </>
          )}
          {i.would_start && (
            <span className="muted"> · {t("in.wouldStart", { wf: i.would_start.workflow })}</span>
          )}
          {i.stale_revision && <span className="err"> · {t("in.staleRevision")}</span>}
          {i.reason && <div className="muted">{i.reason}</div>}
          {["deferred", "rejected", "superseded"].includes(i.state) && (
            <button className="ghost sm" onClick={() => retriage(i.id)}>
              {t("in.retriage")}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

type Policy = {
  id: number;
  source: string;
  owner_id: number | null;
  mode: string;
  paused: boolean;
  workflows: string[];
  repositories: string[];
  min_severity: string;
  max_active_runs: number;
  max_runs_per_day: number;
  revision: number;
};

/** Admin: per-source intake policies (OFF / SHADOW / AUTOPILOT), with a global pause per policy. */
export function IntakePolicies() {
  const { t } = useI18n();
  const { data, error, reload } = useApi<{
    policies: Policy[];
    modes: string[];
    sources: string[];
  }>("/api/intake/policies");
  const [draft, setDraft] = useState({
    source: "prod_errors",
    owner_id: "",
    mode: "SHADOW",
    workflows: "production-incident-investigation",
    repositories: "",
    min_severity: "high",
    max_active_runs: 2,
    max_runs_per_day: 5,
  });
  const save = async (extra: Partial<Policy> = {}, base?: Policy) =>
    (await act(() =>
      api("/api/intake/policies", {
        ...(base ?? {
          ...draft,
          owner_id: draft.owner_id ? Number(draft.owner_id) : null,
          workflows: draft.workflows
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          repositories: draft.repositories
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
        ...extra,
      }),
    )) && reload();
  return (
    <section className="card set-section" id="set-intake">
      <header className="set-section-head">
        <Inbox size={18} aria-hidden />
        <h3>{t("in.policies")}</h3>
      </header>
      <p className="small muted">{t("in.hint")}</p>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.policies.length === 0 && <p className="small muted">{t("in.noPolicy")}</p>}
      {data?.policies.map((p) => (
        <div key={p.id} className="small" style={{ margin: "4px 0" }}>
          <span className="mono">
            {p.source}
            {p.owner_id ? `:${p.owner_id}` : ""}
          </span>{" "}
          · <b>{p.mode}</b>
          {p.paused && <span className="err"> · {t("in.paused")}</span>} ·{" "}
          {p.workflows.join(", ") || "—"} · {p.repositories.join(", ") || t("in.ownerRepos")} · ≥
          {p.min_severity} · {p.max_active_runs}/{p.max_runs_per_day} · rev {p.revision}{" "}
          <button className="ghost sm" onClick={() => save({ paused: !p.paused }, p)}>
            {p.paused ? t("in.resume") : t("in.pause")}
          </button>
        </div>
      ))}
      {data && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", marginTop: 8 }}>
          {(
            [
              ["source", data.sources],
              ["mode", data.modes],
              ["min_severity", ["critical", "high", "medium", "low"]],
            ] as const
          ).map(([k, options]) => (
            <label key={k} className="small">
              {k}
              <select
                value={String(draft[k])}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              >
                {options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          ))}
          {(["owner_id", "workflows", "repositories"] as const).map((k) => (
            <label key={k} className="small">
              {k}
              <input
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            </label>
          ))}
          {(["max_active_runs", "max_runs_per_day"] as const).map((k) => (
            <label key={k} className="small">
              {k}
              <input
                type="number"
                min={0}
                style={{ width: 70 }}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
              />
            </label>
          ))}
          <button onClick={() => save()}>{t("in.save")}</button>
        </div>
      )}
    </section>
  );
}
