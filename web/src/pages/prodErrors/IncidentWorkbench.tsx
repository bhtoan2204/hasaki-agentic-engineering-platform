import { useCallback, useState } from "react";
import { Activity, Bug, ExternalLink, Layers, Wrench } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { Button, ErrorBox, toast } from "../../ui.tsx";
import { dialog } from "../../dialog/index.ts";
import { useI18n } from "../../i18n/index.tsx";
import { usePolling } from "./bugHuntParts.tsx";
import { SharedAnalysisCard } from "../../components/SharedAnalysis.tsx";
import type { SharedView } from "../../sharedAnalysis.ts";
import "./incident-workbench.css";

/** Shapes of GET /api/prod-errors/:fp/workbench (src/incidents/unified.ts). */
interface Loc {
  repository: string;
  file: string;
  line_start?: number | null;
  function?: string | null;
}
interface Cause {
  key: string;
  location: Loc | null;
  statement: string;
  level: "confirmed" | "probable" | "unknown";
  code_fixable: boolean;
  supporting: string[];
  contradicting: string[];
  defect: string;
  sources: string[];
}
interface Metrics {
  llm_attempts: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  cost_availability: string;
  latency_ms?: number | null;
}
interface Progress {
  run_id: number;
  status: string;
  active: boolean;
  steps_done: number;
  steps_total: number;
  current: string | null;
  outcome: string | null;
  metrics: Metrics | null;
  hunt_id?: number | null;
}
export interface Workbench {
  rca: {
    version: number | null;
    status: string;
    reasons: string[];
    causes: Cause[];
    conflicts: Array<{ cause: string; detail: string; refs: string[] }>;
    verified_defects: Array<{
      ref: string;
      location: Loc | null;
      causality: string;
      statement: string;
    }>;
    runtime_findings: Array<{ ref: string; statement: string }>;
    missing_evidence: string[];
    next_actions: Array<{ kind: string; detail: string; cause?: string }>;
    impact: string[];
    excluded: Array<{ ref: string; reason: string }>;
  };
  runtime: Progress | null;
  bug_hunt: Progress | null;
  evidence: Array<{ ref: string; run_id: number; stale: boolean; valid: boolean }>;
  fix_tasks: Array<{
    cause_key: string;
    run_id: number | null;
    code: string | null;
    status: string | null;
  }>;
  versions: Array<{ version: number; status: string; created_at: string }>;
  metrics: Metrics & {
    verified_rcas: number;
    cost_per_verified_rca: number | null;
    reconciliation_llm_calls: number;
  };
}

const loc = (l: Loc | null) =>
  l
    ? `${l.repository}:${l.file}${l.line_start ? `:${l.line_start}` : ""}${l.function ? ` (${l.function})` : ""}`
    : "—";
const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const runOf = (ref: string) => /^(?:run:(\d+)|bug_hunt:(\d+))/.exec(ref);

/** A reference rendered as a link to the run (or hunt) that holds the evidence. */
function Ref({ r, wb }: { r: string; wb: Workbench }) {
  const m = runOf(r);
  const run = m?.[1] ? Number(m[1]) : wb.evidence.find((e) => e.ref === r)?.run_id;
  return run ? (
    <a className="mono small" href={`#/runs/${run}`}>
      {r}
    </a>
  ) : (
    <span className="mono small">{r}</span>
  );
}

function MetricsLine({ m }: { m: Metrics | null }) {
  const { t } = useI18n();
  if (!m) return null;
  return (
    <span className="muted small" data-testid="wb-metrics">
      {t("an.wb.metricsLine", {
        calls: m.llm_attempts,
        turns: m.turns,
        tin: m.input_tokens.toLocaleString(),
        tout: m.output_tokens.toLocaleString(),
        cost: usd(m.cost_usd),
        availability: t(`an.wb.cost.${m.cost_availability}`),
      })}
    </span>
  );
}

function SourceCard({
  title,
  icon,
  p,
  hunt,
}: {
  title: string;
  icon: React.ReactNode;
  p: Progress | null;
  hunt?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="wb-source" data-testid={hunt ? "wb-hunt" : "wb-runtime"}>
      <div className="wb-source-head">
        {icon} <strong>{title}</strong>
        {p && (
          <span className={`pill wb-run-${p.status.toLowerCase()}`} data-status={p.status}>
            {p.status}
          </span>
        )}
      </div>
      {!p && <p className="muted small">{t("an.wb.notRun")}</p>}
      {p && (
        <>
          <div
            className="wb-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={p.steps_total}
            aria-valuenow={p.steps_done}
          >
            <span
              style={{ width: `${p.steps_total ? (100 * p.steps_done) / p.steps_total : 0}%` }}
            />
          </div>
          <div className="small">
            {t("an.wb.steps", { done: p.steps_done, total: p.steps_total })}
            {p.current ? ` · ${p.current}` : ""}
            {p.outcome ? ` · ${t("an.wb.outcome")}: ${p.outcome}` : ""}
          </div>
          <MetricsLine m={p.metrics} />
          <a className="btn ghost sm" href={`#/runs/${p.run_id}`}>
            {t("an.wb.openRun", { id: p.run_id })} <ExternalLink size={12} />
          </a>
        </>
      )}
    </div>
  );
}

function RepoPicker({
  onPick,
  onClose,
}: {
  onPick: (repos: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const repos =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean }>>("/api/repositories");
  const [chosen, setChosen] = useState<string[]>([]);
  const available = (repos.data ?? []).filter((r) => r.enabled && !r.self);
  return (
    <div className="bh-form" data-testid="wb-repos">
      <fieldset>
        <legend>{t("an.bh.repositories")}</legend>
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
        {repos.data && !available.length && (
          <span className="muted">{t("an.bh.noRepositories")}</span>
        )}
        <small className="muted">{t("an.bh.repositoriesHint")}</small>
      </fieldset>
      <div className="bh-form-actions">
        <Button
          size="sm"
          disabled={!chosen.length}
          aria-describedby={!chosen.length ? "wb-pick-hint" : undefined}
          onClick={() => onPick(chosen)}
        >
          {t("an.bh.startConfirm")}
        </Button>
        {!chosen.length && (
          <span id="wb-pick-hint" className="muted small">
            {t("hint.pickCause")}
          </span>
        )}
        <Button size="sm" variant="quiet" onClick={onClose}>
          {t("an.bh.close")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Unified Incident Workbench (Incidents accordion): the reconciled RCA first, then each workflow's status, then the
 * evidence. Nothing starts without a click; a completed workflow is re-run only after an explicit confirmation.
 */
export function IncidentWorkbench({
  fingerprint,
  onHunt,
}: {
  fingerprint: string;
  onHunt?: (huntId: number, status?: string) => void;
}) {
  const { t } = useI18n();
  const wb = useApi<Workbench>(`/api/prod-errors/${fingerprint}/workbench`);
  // Shared results (flags SHARED_RESULTS_*): the latest RCA and bug hunt of this error that the viewer may read.
  const shared = useApi<{ runtime_rca: SharedView | null; bug_hunt: SharedView | null }>(
    `/api/prod-errors/${fingerprint}/shared`,
  );
  const [picking, setPicking] = useState<null | "bug-hunt" | "both">(null);
  const [busy, setBusy] = useState(false);
  const d = wb.data;
  const sh = shared.data;
  const sharedRunning = sh?.runtime_rca?.status === "running" || sh?.bug_hunt?.status === "running";
  const { reload: reloadWb } = wb;
  const { reload: reloadShared } = shared;
  const reloadAll = useCallback(() => {
    reloadWb();
    reloadShared();
  }, [reloadWb, reloadShared]);
  usePolling(!!(d?.runtime?.active || d?.bug_hunt?.active || sharedRunning), reloadAll);

  const start = async (
    kind: "runtime" | "bug-hunt" | "both",
    repositories?: string[],
    force = false,
  ): Promise<void> => {
    setBusy(true);
    try {
      const r = await api<Record<string, unknown>>(
        `/api/prod-errors/${fingerprint}/workbench/${kind}`,
        {
          ...(repositories ? { repositories } : {}),
          ...(force ? { force: true } : {}),
        },
      );
      const errs =
        kind === "both" ? Object.values(r).filter((x) => (x as { error?: string })?.error) : [];
      const reused = (kind === "both" ? [r.runtime, r.bug_hunt] : [r])
        .map((x) => (x as { shared?: SharedView } | undefined)?.shared)
        .find((s) => s && (s.outcome === "hit" || s.outcome === "wait"));
      if (errs.length) toast(errs.map((e) => (e as { error: string }).error).join("\n"), "err");
      else if (force) toast(t("sr.forced"), "ok");
      else if (reused?.outcome === "hit")
        toast(t("sr.toastHit", { name: reused.run_by.name ?? "—" }), "ok");
      else if (reused) toast(t("sr.toastWait"), "ok");
      else toast(t("an.wb.started"), "ok");
      const hunt = (kind === "both" ? r.bug_hunt : r) as { hunt_id?: number } | undefined;
      if (hunt?.hunt_id && onHunt) onHunt(hunt.hunt_id, "queued");
      wb.reload();
      shared.reload();
    } catch (e) {
      const msg = (e as Error).message;
      if (/already completed/.test(msg) && !force) {
        setBusy(false);
        const ok = await dialog.confirm({
          title: t("an.wb.rerunTitle"),
          description: `${msg}\n\n${t("an.wb.rerunBody")}`,
          confirmLabel: t("an.wb.rerunConfirm"),
          variant: "warning",
        });
        if (ok) return start(kind, repositories, true);
      } else toast(msg, "err");
    } finally {
      setBusy(false);
      setPicking(null);
    }
  };

  const [fixing, setFixing] = useState<string | null>(null);
  const fix = async (c: Cause) => {
    if (fixing) return;
    const ok = await dialog.confirm({
      title: t("an.wb.fixTitle"),
      description: t(c.level === "unknown" ? "an.wb.fixBodyDefectOnly" : "an.wb.fixBody", {
        cause: loc(c.location),
      }),
      confirmLabel: t("an.wb.fixConfirm"),
    });
    if (!ok) return;
    setFixing(c.key);
    try {
      const r = await api<{ created: boolean; run_id: number }>(
        `/api/prod-errors/${fingerprint}/workbench/fix`,
        {
          cause_key: c.key,
          confirm: true,
        },
      );
      toast(t(r.created ? "an.wb.fixCreated" : "an.wb.fixExists", { id: r.run_id }), "ok");
      wb.reload();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setFixing(null);
    }
  };

  if (wb.error && !d) return <ErrorBox error={wb.error} onRetry={wb.reload} />;
  if (!d?.rca) return <p className="muted small">{t("an.bh.loading")}</p>;
  const rca = d.rca;
  const fixable = new Set(
    rca.next_actions.filter((a) => a.kind === "create_fix").map((a) => a.cause),
  );
  return (
    <section className="wb" aria-label={t("an.wb.title")} data-testid="incident-workbench">
      {(sh?.runtime_rca || sh?.bug_hunt) && (
        <div className="wb-shared" data-testid="wb-shared">
          {sh.runtime_rca && (
            <SharedAnalysisCard
              view={sh.runtime_rca}
              busy={busy}
              onForce={() => start("runtime", undefined, true)}
            />
          )}
          {sh.bug_hunt && (
            <SharedAnalysisCard
              view={sh.bug_hunt}
              busy={busy}
              onForce={() => start("bug-hunt", sh.bug_hunt!.repositories, true)}
            />
          )}
        </div>
      )}
      <div className="wb-summary" data-testid="wb-summary">
        <div className="wb-summary-head">
          <h4>
            <Layers size={15} aria-hidden="true" /> {t("an.wb.summary")}
          </h4>
          <span className={`pill wb-status wb-${rca.status.toLowerCase()}`} data-testid="wb-status">
            {t(`an.wb.status.${rca.status}`)}
          </span>
          {rca.version != null && (
            <span className="muted small">
              {t("an.wb.version", { v: rca.version, n: d.versions.length })}
            </span>
          )}
        </div>
        <ul className="small">
          {rca.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {!!rca.causes.length && (
          <table className="wb-causes small">
            <thead>
              <tr>
                <th>{t("an.wb.cause")}</th>
                <th>{t("an.wb.causality")}</th>
                <th>{t("an.wb.defect")}</th>
                <th>{t("an.wb.evidence")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rca.causes.map((c) => (
                <tr key={c.key} data-testid="wb-cause">
                  <td>
                    <div className="mono">{loc(c.location)}</div>
                    <div className="muted">{c.statement}</div>
                  </td>
                  <td data-label={t("an.wb.causality")}>{t(`an.wb.level.${c.level}`)}</td>
                  <td data-label={t("an.wb.defect")}>{c.defect}</td>
                  <td data-label={t("an.wb.evidence")}>
                    {c.supporting.map((r) => (
                      <div key={r}>
                        + <Ref r={r} wb={d} />
                      </div>
                    ))}
                    {c.contradicting.map((r) => (
                      <div key={r} className="wb-contra">
                        − <Ref r={r} wb={d} />
                      </div>
                    ))}
                  </td>
                  <td>
                    {fixable.has(c.key) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Wrench size={13} />}
                        loading={fixing === c.key}
                        disabled={!!fixing}
                        onClick={() => fix(c)}
                      >
                        {t("an.wb.createFix")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="wb-actions">
        <Button
          size="sm"
          variant="secondary"
          icon={<Activity size={14} />}
          loading={busy}
          disabled={!!d.runtime?.active}
          onClick={() => start("runtime")}
        >
          {t("an.wb.runRuntime")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Bug size={14} />}
          disabled={busy || !!d.bug_hunt?.active}
          onClick={() => setPicking("bug-hunt")}
        >
          {t("an.wb.runHunt")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !!d.runtime?.active || !!d.bug_hunt?.active}
          onClick={() => setPicking("both")}
        >
          {t("an.wb.runBoth")}
        </Button>
      </div>
      {picking && <RepoPicker onPick={(r) => start(picking, r)} onClose={() => setPicking(null)} />}

      <div className="wb-sources">
        <SourceCard title={t("an.wb.runtime")} icon={<Activity size={14} />} p={d.runtime} />
        <SourceCard title={t("an.bh.title")} icon={<Bug size={14} />} p={d.bug_hunt} hunt />
      </div>

      {!!rca.conflicts.length && (
        <div className="wb-block wb-conflicts" data-testid="wb-conflicts">
          <h5>{t("an.wb.conflicts")}</h5>
          <ul className="small">
            {rca.conflicts.map((c) => (
              <li key={c.cause + c.detail}>{c.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {!!rca.verified_defects.length && (
        <div className="wb-block" data-testid="wb-defects">
          <h5>{t("an.wb.defects")}</h5>
          <ul className="small">
            {rca.verified_defects.map((v) => (
              <li key={v.ref}>
                <span className="mono">{loc(v.location)}</span> —{" "}
                {t("an.wb.defectCausality", { c: v.causality })} · <Ref r={v.ref} wb={d} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!rca.runtime_findings.length && (
        <details className="wb-block">
          <summary>{t("an.wb.runtimeFindings", { n: rca.runtime_findings.length })}</summary>
          <ul className="small">
            {rca.runtime_findings.map((f) => (
              <li key={f.ref}>
                {f.statement} · <Ref r={f.ref} wb={d} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!rca.impact.length && (
        <div className="wb-block">
          <h5>{t("an.wb.impact")}</h5>
          <p className="small">{rca.impact.join("; ")}</p>
        </div>
      )}
      {!!rca.missing_evidence.length && (
        <div className="wb-block" data-testid="wb-missing">
          <h5>{t("an.wb.missing")}</h5>
          <ul className="small">
            {rca.missing_evidence.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {!!rca.next_actions.length && (
        <div className="wb-block">
          <h5>{t("an.wb.next")}</h5>
          <ul className="small">
            {rca.next_actions.map((a) => (
              <li key={a.kind + a.detail}>{a.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {!!rca.excluded.length && (
        <details className="wb-block" data-testid="wb-excluded">
          <summary>{t("an.wb.excluded", { n: rca.excluded.length })}</summary>
          <ul className="small">
            {rca.excluded.map((x) => (
              <li key={x.ref}>
                <Ref r={x.ref} wb={d} /> — {x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!d.fix_tasks.length && (
        <div className="wb-block" data-testid="wb-fixes">
          <h5>{t("an.wb.fixTasks")}</h5>
          <ul className="small">
            {d.fix_tasks.map((f) => (
              <li key={f.cause_key}>
                <span className="mono">{f.cause_key}</span>
                {f.run_id && (
                  <>
                    {" "}
                    → <a href={`#/runs/${f.run_id}`}>#{f.run_id}</a> {f.code ?? ""} {f.status ?? ""}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted small" data-testid="wb-total">
        {t("an.wb.total", {
          calls: d.metrics.llm_attempts,
          turns: d.metrics.turns,
          tokens: (d.metrics.input_tokens + d.metrics.output_tokens).toLocaleString(),
          cost: usd(d.metrics.cost_usd),
          perRca: usd(d.metrics.cost_per_verified_rca),
        })}
      </p>
    </section>
  );
}
