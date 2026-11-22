import { useEffect, useState } from "react";
import { Bug, ExternalLink, Play, Square, Wrench } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { AgentProviderField, type AgentProvider } from "../../agentProvider.tsx";
import { Button, ErrorBox, toast } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { dateCell, Panel, type Row } from "../analytics/shared.tsx";

/** Hunt statuses that still change: the panel re-reads them on a timer (polling, not live push). */
const ACTIVE = new Set(["queued", "running", "verifying"]);
const POLL_MS = 5000;
const SECTIONS = ["CONFIRMED", "SUSPECTED", "BLOCKED", "REJECTED"] as const;

function StatusPill({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`pill bh-status bh-${status}`}>{t(`an.bh.status.${status}`)}</span>;
}

function Finding({
  f,
  huntId,
  runId,
  onTask,
}: {
  f: Row;
  huntId: number;
  runId: number;
  onTask: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const task = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: boolean; run_id: number }>(
        `/api/bug-hunts/${huntId}/findings/${f.finding_id}/fix-task`,
        {},
      );
      toast(t(r.created ? "an.bh.taskCreated" : "an.bh.taskExists", { run: r.run_id }), "ok");
      onTask();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const repro = f.reproduction as Row | null;
  const v = f.verification as Row | null;
  return (
    <article className="bh-finding" data-status={f.bug_verification_status}>
      <header>
        <code>
          {f.repository}@{String(f.commit ?? "").slice(0, 10)} · {f.file_path}:{f.line_start}-
          {f.line_end}
        </code>
        <b>{f.function}</b>
        <span className="pill">{f.category}</span>
        <span className={`pill bh-verdict bh-v-${f.bug_verification_status}`}>
          {t("an.bh.bug")}: {f.bug_verification_status}
        </span>
        <span className={`pill bh-cause bh-c-${f.incident_causality_status}`}>
          {t("an.bh.cause")}: {f.incident_causality_status}
        </span>
      </header>
      <p>{f.hypothesis}</p>
      <dl>
        {f.trigger && (
          <>
            <dt>{t("an.bh.trigger")}</dt>
            <dd>{f.trigger}</dd>
          </>
        )}
        {f.expected && (
          <>
            <dt>{t("an.bh.expected")}</dt>
            <dd>{f.expected}</dd>
          </>
        )}
        {f.actual && (
          <>
            <dt>{t("an.bh.actual")}</dt>
            <dd>{f.actual}</dd>
          </>
        )}
        <dt>{t("an.bh.basis")}</dt>
        <dd>{f.basis}</dd>
        {!!(f.causality_basis as string[] | undefined)?.length && (
          <>
            <dt>{t("an.bh.causeBasis")}</dt>
            <dd>{(f.causality_basis as string[]).join("; ")}</dd>
          </>
        )}
        {repro && (
          <>
            <dt>{t("an.bh.reproduction")}</dt>
            <dd>
              <span className={`pill bh-repro-${repro.outcome}`}>{repro.outcome}</span>{" "}
              {repro.detail}
              {repro.command && <code className="bh-cmd">{repro.command}</code>}
              {repro.artifact_id && (
                <a href={`#/runs/${runId}`} title={t("an.bh.artifact", { id: repro.artifact_id })}>
                  {t("an.bh.artifact", { id: repro.artifact_id })} <ExternalLink size={12} />
                </a>
              )}
            </dd>
          </>
        )}
        {!!(v?.alternative_explanations as string[] | undefined)?.length && (
          <>
            <dt>{t("an.bh.alternatives")}</dt>
            <dd>{(v!.alternative_explanations as string[]).join("; ")}</dd>
          </>
        )}
        {!!(f.missing_proof as string[] | undefined)?.length && (
          <>
            <dt>{t("an.bh.missingProof")}</dt>
            <dd>{(f.missing_proof as string[]).join("; ")}</dd>
          </>
        )}
        {!!(f.supporting_evidence as string[] | undefined)?.length && (
          <>
            <dt>{t("an.bh.evidence")}</dt>
            <dd>
              <ul>
                {(f.supporting_evidence as string[]).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {["CONFIRMED", "SUSPECTED"].includes(f.bug_verification_status) && (
        <Button
          size="sm"
          variant="secondary"
          icon={<Wrench size={14} />}
          loading={busy}
          onClick={task}
        >
          {t("an.bh.fixTask")}
        </Button>
      )}
    </article>
  );
}

function HuntDetail({ id, onChange }: { id: number; onChange: () => void }) {
  const { t } = useI18n();
  const { data, error, reload } = useApi<Row>(`/api/bug-hunts/${id}`);
  const active = data && ACTIVE.has(data.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const report = data.report as Row | null;
  const findings = (data.findings ?? []) as Row[];
  const cancel = async () => {
    try {
      await api(`/api/runs/${data.run_id}/cancel`, {
        reason: "bug hunt canceled from the incident",
      });
      reload();
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="bh-detail">
      <div className="bh-detail-head">
        <StatusPill status={data.status} />
        <a href={`#/runs/${data.run_id}`}>
          {t("an.bh.run", { id: data.run_id })} <ExternalLink size={12} />
        </a>
        {Object.entries(data.revisions ?? {}).map(([repo, rev]) => (
          <code key={repo}>
            {repo}@{String(rev).slice(0, 12)}
          </code>
        ))}
        {active && (
          <>
            <span className="muted small">{t("an.bh.polling", { s: POLL_MS / 1000 })}</span>
            <Button size="sm" variant="danger" icon={<Square size={13} />} onClick={cancel}>
              {t("an.bh.cancel")}
            </Button>
          </>
        )}
      </div>
      <ol className="bh-stages" aria-label={t("an.bh.stages")}>
        {(data.stages as Row[]).map((s) => (
          <li key={s.key} data-status={s.status}>
            <span>{s.name}</span>
            <small>{s.status}</small>
          </li>
        ))}
      </ol>
      {(data.errors as Row[]).map((e) => (
        <p key={e.step} className="bh-error">
          {e.step}: {e.error}
        </p>
      ))}
      {!report && !!(data.unverified_candidates as Row[]).length && (
        <section>
          <h4>{t("an.bh.unverified")}</h4>
          <ul className="bh-candidates">
            {(data.unverified_candidates as Row[]).map((c, i) => (
              <li key={i}>
                <code>
                  {c.file_path}:{c.line_start}
                </code>{" "}
                {c.function} — {c.hypothesis}
              </li>
            ))}
          </ul>
        </section>
      )}
      {report &&
        SECTIONS.map((s) => {
          const list = findings.filter((f) => f.bug_verification_status === s);
          const rejected =
            s === "REJECTED"
              ? ((report.rejected as Row[]) ?? []).filter(
                  (r) => !r.finding_id && r.basis?.startsWith("platform check"),
                )
              : [];
          if (!list.length && !rejected.length) return null;
          return (
            <section key={s} className="bh-section">
              <h4>
                {t(`an.bh.section.${s}`)} ({list.length + rejected.length})
              </h4>
              {list.map((f) => (
                <Finding key={f.finding_id} f={f} huntId={id} runId={data.run_id} onTask={reload} />
              ))}
              {rejected.map((r, i) => (
                <p key={`r${i}`} className="bh-rejected">
                  <code>
                    {r.file_path}:{r.line_start}
                  </code>{" "}
                  {r.function} — {r.basis}
                </p>
              ))}
            </section>
          );
        })}
      {report && !findings.length && <p className="muted">{t("an.bh.noFindings")}</p>}
      {report && (
        <details className="bh-coverage">
          <summary>{t("an.bh.coverage")}</summary>
          <dl>
            <dt>{t("an.bh.scope")}</dt>
            <dd>{((report.coverage as Row).functions_in_scope as string[]).join(", ") || "—"}</dd>
            <dt>{t("an.bh.inspected")}</dt>
            <dd>{((report.coverage as Row).files_inspected as string[]).join(", ") || "—"}</dd>
            <dt>{t("an.bh.tools")}</dt>
            <dd>
              {Object.entries((report.coverage as Row).tools ?? {})
                .map(([k, v]) => `${k}: ${v}`)
                .join("; ") || "—"}
            </dd>
            <dt>{t("an.bh.unavailable")}</dt>
            <dd>{((report.coverage as Row).sources_unavailable as string[]).join("; ") || "—"}</dd>
            <dt>{t("an.bh.limitations")}</dt>
            <dd>{((report.coverage as Row).scope_limitations as string[]).join("; ") || "—"}</dd>
            <dt>{t("an.bh.execution")}</dt>
            <dd>
              {t("an.bh.executionLine", {
                providers: ((report.execution as Row).providers as string[]).join(", ") || "—",
                models: ((report.execution as Row).models as string[]).join(", ") || "—",
                tools: (report.execution as Row).tool_calls ?? "—",
                tokensIn: (report.execution as Row).tokens?.input ?? "—",
                tokensOut: (report.execution as Row).tokens?.output ?? "—",
                cost:
                  (report.execution as Row).cost_usd == null
                    ? t("an.bh.notReported")
                    : `$${Number((report.execution as Row).cost_usd).toFixed(4)}`,
                perBug:
                  (report.execution as Row).cost_per_confirmed_bug == null
                    ? "—"
                    : `$${Number((report.execution as Row).cost_per_confirmed_bug).toFixed(4)}`,
              })}
            </dd>
          </dl>
        </details>
      )}
      {!!(data.follow_ups as Row[]).length && (
        <p className="bh-followups">
          {(data.follow_ups as Row[]).map((u) => (
            <a key={u.run_id} href={`#/runs/${u.run_id}`}>
              {u.code ?? `#${u.work_item_id}`} · {t("an.bh.run", { id: u.run_id })} · {u.status}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

/** Bug Hunter on an incident: start a bounded, evidence-driven hunt and review its independently verified findings. */
export function BugHunter({ fingerprint }: { fingerprint: string }) {
  const { t } = useI18n();
  const list = useApi<{ hunts: Row[] }>(`/api/prod-errors/${fingerprint}/bug-hunts`);
  const repos =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean }>>("/api/repositories");
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [busy, setBusy] = useState(false);
  const hunts = list.data?.hunts ?? [];
  const current = selected ?? (hunts[0]?.id as number | undefined) ?? null;
  const anyActive = hunts.some((h) => ACTIVE.has(h.status));
  const { reload } = list;
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, reload]);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: boolean; hunt_id: number }>(
        `/api/prod-errors/${fingerprint}/bug-hunts`,
        { repositories: chosen, provider },
      );
      if (!r.created) toast(t("an.bh.alreadyRunning"), "ok");
      setSelected(r.hunt_id);
      setForm(false);
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const available = (repos.data ?? []).filter((r) => r.enabled && !r.self);
  return (
    <Panel title={t("an.bh.title")}>
      <div className="bh-intro">
        <p className="muted">{t("an.bh.intro")}</p>
        {!form && (
          <Button size="sm" icon={<Bug size={14} />} onClick={() => setForm(true)}>
            {t("an.bh.start")}
          </Button>
        )}
      </div>
      {form && (
        <div className="bh-form">
          <fieldset>
            <legend>{t("an.bh.repositories")}</legend>
            {!available.length && <span className="muted">{t("an.bh.noRepositories")}</span>}
            {available.map((r) => (
              <label key={r.name}>
                <input
                  type="checkbox"
                  checked={chosen.includes(r.name)}
                  disabled={!chosen.includes(r.name) && chosen.length >= 3}
                  onChange={(e) =>
                    setChosen((c) =>
                      e.target.checked ? [...c, r.name] : c.filter((x) => x !== r.name),
                    )
                  }
                />{" "}
                {r.name}
              </label>
            ))}
            <small className="muted">{t("an.bh.repositoriesHint")}</small>
          </fieldset>
          <AgentProviderField value={provider} onChange={setProvider} healthyOnly />
          <div className="bh-form-actions">
            <Button
              size="sm"
              icon={<Play size={14} />}
              loading={busy}
              disabled={!chosen.length}
              onClick={start}
            >
              {t("an.bh.startConfirm")}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setForm(false)}>
              {t("an.bh.close")}
            </Button>
          </div>
        </div>
      )}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {!!hunts.length && (
        <ul className="bh-hunts" aria-label={t("an.bh.history")}>
          {hunts.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className={h.id === current ? "active" : ""}
                aria-pressed={h.id === current}
                onClick={() => setSelected(h.id)}
              >
                <span>#{h.id}</span>
                <StatusPill status={h.status} />
                <span>{dateCell(h.created_at)}</span>
                <span className="muted">{(h.repositories as string[]).join(", ")}</span>
                <span>
                  {t("an.bh.counts", {
                    c: h.counts.CONFIRMED,
                    s: h.counts.SUSPECTED,
                    r: h.counts.REJECTED,
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!hunts.length && !list.loading && <p className="muted">{t("an.bh.none")}</p>}
      {current != null && <HuntDetail key={current} id={current} onChange={list.reload} />}
    </Panel>
  );
}
