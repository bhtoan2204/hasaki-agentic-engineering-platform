import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  Wrench,
  ChevronRight,
  ClipboardPaste,
  ExternalLink,
  FileSearch,
  GitBranch,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { api, isStateChange, useApi, useLive } from "../api.ts";
import {
  act,
  Badge,
  Copy,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Markdown,
  PageHeader,
  navigate,
  time,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { translate, type UiLocale } from "../i18n/messages.ts";
import "./Investigations.css";

/**
 * Production Incident Investigation: start an investigation from a natural-language request, browse saved
 * investigations, and read one: summary, latency breakdown, timeline (observed precision), evidence (SPL, window,
 * Splunk link, expandable sanitized logs), manual result paste when Splunk is not reachable, and the copyable report.
 * The DAG itself is the regular run view (#/runs/<id>).
 */

export const INVESTIGATION_WORKFLOW = "production-incident-investigation";

/**
 * Investigation content follows the language chosen for the run (output_locale), not the UI language: the labels
 * around the agent's text must match it. Falls back to the UI language for runs without a recorded choice.
 */
function useRunT(runLocale?: string | null) {
  const { t, locale } = useI18n();
  const l: UiLocale = runLocale === "vi" || runLocale === "en" ? runLocale : locale;
  return l === locale
    ? t
    : (key: string, params?: Record<string, string | number>) => translate(l, key, params);
}

export function InvestigationsPage({ id }: { id?: number }) {
  return id ? <InvestigationDetail id={id} /> : <InvestigationHome />;
}

function InvestigationHome() {
  const { t } = useI18n();
  const { data: runs, reload } = useApi<any[]>("/api/runs");
  const { data: splunk } = useApi<any>("/api/integrations/splunk");
  const mine = useMemo(
    () => (runs ?? []).filter((r) => r.definition_key === INVESTIGATION_WORKFLOW),
    [runs],
  );
  return (
    <div className="inv-page">
      <PageHeader
        icon={FileSearch}
        title={t("inv.title")}
        subtitle={t("inv.subtitle")}
        crumbs={[[t("nav.overview"), "#/overview"], [t("inv.title")]]}
      />
      <div className="inv-grid">
        <NewInvestigation splunk={splunk} onStarted={reload} />
        <div className="card">
          <div className="card-head">
            <h3>
              <History size={16} /> {t("inv.history")}
            </h3>
            <button
              className="ghost xs icon"
              aria-label={t("inv.refresh")}
              onClick={() => reload()}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {!runs ? (
            <Loading />
          ) : !mine.length ? (
            <EmptyState icon={History} title={t("inv.noHistory")} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t("inv.request")}</th>
                    <th>{t("inv.status")}</th>
                    <th>{t("inv.created")}</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr
                      key={r.id}
                      className="click"
                      onClick={() => navigate(`#/investigations/${r.id}`)}
                    >
                      <td>{r.id}</td>
                      <td className="inv-title-cell">{r.title}</td>
                      <td>
                        <Badge s={r.status} label />
                      </td>
                      <td className="small muted">{time(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewInvestigation({ splunk, onStarted }: { splunk: any; onStarted: () => void }) {
  const { t, locale } = useI18n();
  const [request, setRequest] = useState("");
  const [indexes, setIndexes] = useState("");
  const [earliest, setEarliest] = useState("");
  const [latest, setLatest] = useState("");
  const [outputLocale, setOutputLocale] = useState(locale);
  const [route, setRoute] = useState<any>(null);
  useEffect(() => {
    if (request.trim().length < 12) return setRoute(null);
    const h = setTimeout(
      () =>
        api("/api/workflows/route", { text: request })
          .then(setRoute)
          .catch(() => setRoute(null)),
      500,
    );
    return () => clearTimeout(h);
  }, [request]);
  const tz = splunk?.timezone ?? "Asia/Ho_Chi_Minh";
  // datetime-local has no zone: the value is read as the investigation timezone (fixed offset for Asia/Ho_Chi_Minh)
  const iso = (v: string) =>
    v
      ? `${v.length === 16 ? v + ":00" : v}${tz === "Asia/Ho_Chi_Minh" ? "+07:00" : "Z"}`
      : undefined;
  const start = async () => {
    const run = await act(
      () =>
        api("/api/runs", {
          workflow: INVESTIGATION_WORKFLOW,
          title: request.trim().split("\n")[0].slice(0, 120),
          inputs: {
            request: request.trim(),
            environment: splunk?.environment ?? "production",
            ...(indexes.trim() ? { indexes: indexes.trim() } : {}),
            ...(earliest ? { earliest: iso(earliest) } : {}),
            ...(latest ? { latest: iso(latest) } : {}),
          },
          output_locale: outputLocale,
        }),
      t("inv.started"),
    );
    if (run?.id) {
      onStarted();
      navigate(`#/investigations/${run.id}`);
    }
  };
  const notInvestigation = route && route.workflow !== INVESTIGATION_WORKFLOW;
  return (
    <div className="card inv-new">
      <div className="card-head">
        <h3>
          <Search size={16} /> {t("inv.new")}
        </h3>
        <span className="pill">
          <ShieldCheck size={12} /> {t("inv.readOnly")}
        </span>
      </div>
      {splunk && !splunk.connected && <p className="inv-warn small">{t("inv.notConnected")}</p>}
      <Field label={t("inv.requestLabel")} hint={t("inv.requestHint")}>
        <textarea
          rows={5}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={t("inv.placeholder")}
        />
      </Field>
      {notInvestigation && <p className="inv-warn small">{t("inv.routeHint")}</p>}
      <details className="inv-filters">
        <summary className="small">{t("inv.filters")}</summary>
        <div className="inv-filter-grid">
          <Field label={t("inv.environment")}>
            <select value={splunk?.environment ?? "production"} disabled>
              <option>{splunk?.environment ?? "production"}</option>
            </select>
          </Field>
          <Field label={t("inv.indexes")} hint={(splunk?.limits?.defaultIndexes ?? []).join(", ")}>
            <input
              value={indexes}
              onChange={(e) => setIndexes(e.target.value)}
              placeholder="k8s_prod"
            />
          </Field>
          <Field label={`${t("inv.from")} (${tz})`}>
            <input
              type="datetime-local"
              step={1}
              value={earliest}
              onChange={(e) => setEarliest(e.target.value)}
            />
          </Field>
          <Field label={`${t("inv.to")} (${tz})`}>
            <input
              type="datetime-local"
              step={1}
              value={latest}
              onChange={(e) => setLatest(e.target.value)}
            />
          </Field>
          <Field label={t("inv.reportLanguage")}>
            <select value={outputLocale} onChange={(e) => setOutputLocale(e.target.value as any)}>
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
      </details>
      <div className="row">
        <button disabled={request.trim().length < 5} onClick={start}>
          <FileSearch size={15} /> {t("inv.start")}
        </button>
      </div>
    </div>
  );
}

const CONF_TONE: Record<string, string> = {
  confirmed: "COMPLETED",
  inferred: "WAITING",
  unknown: "PENDING",
};
const STATUS_TONE: Record<string, string> = {
  complete: "COMPLETED",
  partial: "WAITING",
  insufficient_evidence: "FAILED",
  blocked: "FAILED",
};

function InvestigationDetail({ id }: { id: number }) {
  const { data: run, reload: reloadRun, error } = useApi<any>(`/api/runs/${id}`);
  const t = useRunT(run?.output_locale);
  const { data: inv, reload } = useApi<any>(`/api/runs/${id}/investigation`);
  useLive(id, (p) => {
    if (isStateChange(p)) reloadRun();
    reload(); // searches and evidence arrive with transcript events
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const events = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of inv?.searches ?? []) for (const e of s.events ?? []) m.set(e.ref, e);
    return m;
  }, [inv]);
  if (error) return <ErrorBox error={error} onRetry={reloadRun} />;
  if (!run || !inv) return <Loading />;
  const report = inv.report;
  const timeline: any[] = inv.correlation?.timeline ?? [];
  const latencies: any[] = inv.latency?.latencies ?? [];
  const maxMs = Math.max(1, ...latencies.map((l) => l.latency_ms ?? 0));
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  return (
    <div className="inv-page">
      <PageHeader
        icon={FileSearch}
        title={run.title}
        subtitle={`${t("inv.title")} · #${run.id} · ${inv.environment} · ${inv.timezone}`}
        crumbs={[[t("inv.title"), "#/investigations"], [`#${run.id}`]]}
        actions={
          <>
            <Badge s={run.status} label />
            <a className="btn ghost sm" href={`#/runs/${run.id}`}>
              <GitBranch size={14} /> {t("inv.dag")}
            </a>
            {report?.report_markdown && (
              <Copy text={report.report_markdown} label={t("inv.copyReport")} />
            )}
            <FixButton run={run} hasReport={!!report} followUps={inv.follow_ups} t={t} />
          </>
        }
      />
      <div className="inv-steps" aria-label={t("inv.progress")}>
        {run.steps.map((s: any) => (
          <span key={s.key} className={`inv-step st-${s.status}`} title={s.error ?? s.status}>
            <Badge s={s.status} /> {s.name}
          </span>
        ))}
      </div>

      <section className="card">
        <div className="card-head">
          <h3>
            <Activity size={16} /> {t("inv.summary")}
          </h3>
          {report && (
            <Badge s={STATUS_TONE[report.status] ?? "PENDING"}>
              {t(`inv.st.${report.status}`)}
            </Badge>
          )}
        </div>
        {!report ? (
          <p className="muted small">
            {["COMPLETED", "FAILED", "CANCELED"].includes(run.status)
              ? t("inv.noReport")
              : t("inv.running")}
          </p>
        ) : (
          <div className="inv-summary">
            <dl>
              <dt>{t("inv.entity")}</dt>
              <dd>{report.summary.entity ?? "—"}</dd>
              <dt>{t("inv.sentAt")}</dt>
              <dd className="mono">{report.summary.outbound_at ?? t("inv.unknown")}</dd>
              {report.summary.partner_response.map((p: any) => (
                <Fragment key={p.key}>
                  <dt>{p.label}</dt>
                  <dd>
                    <span className="mono">{p.at ?? "—"}</span> ·{" "}
                    <b>{p.latency ?? t("inv.unknown")}</b>{" "}
                    <Badge s={CONF_TONE[p.confidence]}>{t(`inv.conf.${p.confidence}`)}</Badge>
                    <div className="small muted">{p.qualification}</div>
                  </dd>
                </Fragment>
              ))}
              <dt>{t("inv.label")}</dt>
              <dd>
                {report.summary.shipping_label ? (
                  <>
                    <span className="mono">{report.summary.shipping_label.at}</span> ·{" "}
                    {t(
                      report.summary.shipping_label.kind === "generated"
                        ? "inv.labelGenerated"
                        : "inv.labelObserved",
                    )}
                  </>
                ) : (
                  t("inv.unknown")
                )}
              </dd>
            </dl>
            {report.summary.outbound_message && (
              <div>
                <div className="small muted">
                  {t("inv.outbound")} ({report.summary.outbound_message.evidence_ref})
                </div>
                <pre className="inv-log">
                  {report.summary.outbound_message.payload ??
                    report.summary.outbound_message.excerpt}
                </pre>
              </div>
            )}
            {report.summary.missing?.length > 0 && (
              <ul className="inv-missing small">
                {report.summary.missing.map((m: any, i: number) => (
                  <li key={i}>
                    <b>{m.objective}</b>: {m.needed}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {latencies.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>
              <Timer size={16} /> {t("inv.latency")}
            </h3>
          </div>
          <div className="inv-lat">
            {latencies.map((l, i) => (
              <div key={i} className="inv-lat-row">
                <div className="inv-lat-label">
                  <b>{l.label}</b>
                  {l.attempt ? ` #${l.attempt}` : ""}{" "}
                  <Badge s={CONF_TONE[l.confidence]}>{t(`inv.conf.${l.confidence}`)}</Badge>
                  <div className="small muted">
                    {l.from.event_type} <code>{l.from.evidence_ref}</code> → {l.to.event_type}{" "}
                    <code>{l.to.evidence_ref}</code>
                    {l.shared_ids?.length ? ` · ${l.shared_ids.join(", ")}` : ""}
                  </div>
                  <div className="small muted">
                    {[l.qualification, ...(l.notes ?? [])].join(" · ")}
                  </div>
                </div>
                <div className="inv-lat-bar" aria-hidden>
                  <span style={{ width: `${Math.max(2, ((l.latency_ms ?? 0) / maxMs) * 100)}%` }} />
                </div>
                <div className="inv-lat-val mono">{l.latency_text ?? "—"}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>
            <History size={16} /> {t("inv.timeline")}
          </h3>
          <span className="small muted">{t("inv.timelineHint")}</span>
        </div>
        {!timeline.length ? (
          <p className="muted small">{t("inv.noEvents")}</p>
        ) : (
          <div className="table-wrap">
            <table className="inv-tl">
              <thead>
                <tr>
                  <th />
                  <th>{t("inv.time")}</th>
                  <th>{t("inv.event")}</th>
                  <th>{t("inv.service")}</th>
                  <th>{t("inv.ids")}</th>
                  <th>{t("inv.confidence")}</th>
                  <th>{t("inv.evidence")}</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((e) => (
                  <Fragment key={e.evidence_ref}>
                    <tr className="click" onClick={() => toggle(e.evidence_ref)}>
                      <td>
                        {open[e.evidence_ref] ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </td>
                      <td className="mono nowrap">{e.timestamp ?? "—"}</td>
                      <td>
                        {e.event_type}
                        {e.attempt ? <span className="pill">#{e.attempt}</span> : null}
                        {e.delivery ? (
                          <span className="pill">
                            {e.delivery.n}/{e.delivery.of}
                          </span>
                        ) : null}
                        {e.conflicts?.length ? <span className="pill inv-pill-warn">!</span> : null}
                      </td>
                      <td>{e.service ?? "—"}</td>
                      <td className="small">
                        {Object.entries(e.ids ?? {})
                          .map(([k, v]: any) => `${k}=${v.join(",")}`)
                          .join(" · ")}
                      </td>
                      <td>
                        <Badge s={CONF_TONE[e.confidence]}>{t(`inv.conf.${e.confidence}`)}</Badge>
                      </td>
                      <td>
                        <code>{e.evidence_ref}</code>
                      </td>
                    </tr>
                    {open[e.evidence_ref] && (
                      <tr className="inv-expand">
                        <td colSpan={7}>
                          {e.conflicts?.map((c: string, i: number) => (
                            <div key={i} className="inv-warn small">
                              {c}
                            </div>
                          ))}
                          <div className="small muted">
                            {e.time_original && (
                              <>
                                {t("inv.original")}: <code>{e.time_original}</code> ·{" "}
                              </>
                            )}
                            {e.precision && (
                              <>
                                {t("inv.precision")}: {e.precision}
                              </>
                            )}
                            {e.link?.via?.length ? (
                              <>
                                {" "}
                                · {t("inv.linkedBy")}: {e.link.via.join(", ")}
                              </>
                            ) : null}
                          </div>
                          <pre className="inv-log">
                            {events.get(e.evidence_ref)?.raw ?? e.payload ?? e.excerpt}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(inv.correlation?.rejected?.length ?? 0) + (inv.correlation?.uncorrelated?.length ?? 0) >
          0 && (
          <details className="small inv-rejected">
            <summary>
              {t("inv.excluded", {
                n:
                  (inv.correlation.rejected?.length ?? 0) +
                  (inv.correlation.uncorrelated?.length ?? 0),
              })}
            </summary>
            <ul>
              {inv.correlation.rejected?.map((r: any, i: number) => (
                <li key={`r${i}`}>
                  <code>{r.evidence_ref}</code> {r.event_type}: {r.reason}
                </li>
              ))}
              {inv.correlation.uncorrelated?.map((u: any) => (
                <li key={u.evidence_ref}>
                  <code>{u.evidence_ref}</code> {u.event_type} {u.timestamp} —{" "}
                  {t("inv.uncorrelated")}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            <Search size={16} /> {t("inv.queries", { n: inv.searches.length })}
          </h3>
        </div>
        {!inv.searches.length ? (
          <p className="muted small">{t("inv.noSearches")}</p>
        ) : (
          inv.searches.map((s: any) => (
            <SearchCard
              key={s.id}
              t={t}
              s={s}
              runId={id}
              onPasted={reload}
              open={!!open[`s${s.id}`]}
              onToggle={() => toggle(`s${s.id}`)}
            />
          ))
        )}
      </section>

      {report?.report_markdown && (
        <section className="card">
          <div className="card-head">
            <h3>
              <FileSearch size={16} /> {t("inv.report")}
            </h3>
            <Copy text={report.report_markdown} label={t("inv.copyReport")} />
          </div>
          <Markdown text={report.report_markdown} />
        </section>
      )}
    </div>
  );
}

function SearchCard({
  t,
  s,
  runId,
  onPasted,
  open,
  onToggle,
}: {
  t: (k: string, p?: Record<string, string | number>) => string;
  s: any;
  runId: number;
  onPasted: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const [paste, setPaste] = useState("");
  const pending = s.status === "manual_pending";
  return (
    <div className={`inv-search${pending ? " is-pending" : ""}`}>
      <div className="inv-search-head">
        <button className="quiet xs" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} #{s.id}
        </button>
        <Badge
          s={
            pending
              ? "WAITING_INPUT"
              : s.status === "done"
                ? "COMPLETED"
                : s.status === "failed"
                  ? "FAILED"
                  : "RUNNING"
          }
        >
          {pending ? t("inv.manualPending") : s.status}
        </Badge>
        <span className="small muted">
          {s.step_key ?? ""} · {s.earliest} → {s.latest} · {s.result_count ?? 0} {t("inv.rows")}
          {s.truncated ? "+" : ""}
          {s.duration_ms != null ? ` · ${s.duration_ms} ms` : ""} · {s.mode}
        </span>
        <a className="small" href={s.splunk_url} target="_blank" rel="noreferrer">
          Splunk <ExternalLink size={11} />
        </a>
        <Copy text={s.query} />
      </div>
      <code className="inv-spl">{s.query}</code>
      {s.error && <div className="inv-warn small">{s.error}</div>}
      {pending && (
        <div className="inv-paste">
          <p className="small">{t("inv.pasteHelp")}</p>
          <textarea
            rows={4}
            className="mono"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder='{"results":[{"_time":"…","_raw":"…"}]}'
          />
          <button
            className="sm"
            disabled={!paste.trim()}
            onClick={async () => {
              if (
                await act(
                  () =>
                    api(`/api/runs/${runId}/investigation/manual-results`, {
                      search_id: s.id,
                      text: paste,
                    }),
                  t("inv.pasted"),
                )
              ) {
                setPaste("");
                onPasted();
              }
            }}
          >
            <ClipboardPaste size={14} /> {t("inv.submitPaste")}
          </button>
        </div>
      )}
      {open && (
        <div className="inv-events">
          {(s.events ?? []).map((e: any) => (
            <details key={e.ref}>
              <summary className="small">
                <code>{e.ref}</code> <span className="mono">{e.time?.iso ?? "—"}</span> ·{" "}
                {e.service ?? "?"} · {e.message.slice(0, 160)}
              </summary>
              <pre className="inv-log">{e.raw}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact card for the run view sidebar. */
export function InvestigationRunCard({ run }: { run: any }) {
  const t = useRunT(run.output_locale);
  if (run.definition_key !== INVESTIGATION_WORKFLOW) return null;
  const rep = run.steps.find(
    (s: any) => s.config?.action === "investigation_report" || s.key === "report",
  )?.output;
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <FileSearch size={16} /> {t("inv.title")}
        </h4>
        {rep?.status && (
          <Badge s={STATUS_TONE[rep.status] ?? "PENDING"}>{t(`inv.st.${rep.status}`)}</Badge>
        )}
      </div>
      {rep?.business_summary && <pre className="inv-log small">{rep.business_summary}</pre>}
      <div className="row">
        <a className="btn ghost sm" href={`#/investigations/${run.id}`}>
          {t("inv.openEvidence")}
        </a>
        <FixButton run={run} hasReport={!!rep} t={t} />
      </div>
    </div>
  );
}

/**
 * Localized view of an investigation step's output (findings agent, report) for the step inspector. The raw JSON
 * stays below it: property names and enums are technical keys and are not translated.
 */
export function InvestigationOutput({ value, locale }: { value: any; locale?: string | null }) {
  const t = useRunT(locale);
  if (!value || typeof value !== "object") return null;
  if (typeof value.report_markdown === "string")
    return (
      <div className="rv-card">
        <div className="rv-card-head">
          <h4>
            <FileSearch size={15} /> {t("inv.report")}
          </h4>
          {value.status && (
            <Badge s={STATUS_TONE[value.status] ?? "PENDING"}>{t(`inv.st.${value.status}`)}</Badge>
          )}
          <Copy text={value.report_markdown} />
        </div>
        <Markdown text={value.report_markdown} />
      </div>
    );
  const answers: any[] = Array.isArray(value.answers) ? value.answers : [];
  const findings: any[] = Array.isArray(value.findings) ? value.findings : [];
  if (!answers.length && !findings.length) return null;
  const refs = (r: any) =>
    Array.isArray(r) && r.length ? (
      <span className="small muted">
        {" "}
        ·{" "}
        {r.map((x: string) => (
          <code key={x}>{x} </code>
        ))}
      </span>
    ) : null;
  const list = (title: string, items: any[]) =>
    items.length > 0 && (
      <>
        <h5 className="inv-out-h">{title}</h5>
        <ul className="inv-out-list">
          {items.map((x, i) => (
            <li key={i}>
              {typeof x === "string" ? x : (x.hypothesis ?? JSON.stringify(x))}
              {typeof x === "object" && refs(x.supporting_refs)}
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <div className="rv-card inv-out">
      {answers.length > 0 && (
        <>
          <h5 className="inv-out-h">{t("inv.out.answers")}</h5>
          {answers.map((a, i) => (
            <div key={i} className="inv-out-answer">
              <div className="small muted">
                {t("inv.out.question")}: {a.question}
              </div>
              <div>{a.answer}</div>
              {refs(a.evidence_refs)}
            </div>
          ))}
        </>
      )}
      {findings.length > 0 && (
        <>
          <h5 className="inv-out-h">{t("inv.out.findings")}</h5>
          <ul className="inv-out-list">
            {findings.map((f, i) => (
              <li key={i}>
                <Badge s={CONF_TONE[f.classification] ?? "PENDING"}>
                  {t(`inv.conf.${f.classification}`)}
                </Badge>{" "}
                {f.statement}
                {f.code_location && (
                  <span className="small muted">
                    {" "}
                    — <code>{f.code_location}</code>
                  </span>
                )}
                {refs(f.evidence_refs)}
              </li>
            ))}
          </ul>
        </>
      )}
      {list(t("inv.out.hypotheses"), Array.isArray(value.hypotheses) ? value.hypotheses : [])}
      {list(
        t("inv.out.missing"),
        Array.isArray(value.missing_evidence) ? value.missing_evidence : [],
      )}
      {list(t("inv.out.next"), Array.isArray(value.next_steps) ? value.next_steps : [])}
    </div>
  );
}

/**
 * Hand the findings to the Bug Investigation workflow. The investigation stays read-only; the fix run has its own
 * approval gates (fix proposal, PR). Idempotent server-side: an active follow-up is reopened, not duplicated.
 */
function FixButton({
  run,
  hasReport,
  followUps,
  t,
}: {
  run: any;
  hasReport: boolean;
  followUps?: any[];
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const active = (followUps ?? []).find((r) => !["FAILED", "CANCELED"].includes(r.status));
  if (active)
    return (
      <a className="btn sm" href={`#/runs/${active.id}`}>
        <Wrench size={14} /> {t("inv.fixOpen", { id: active.id })}
      </a>
    );
  if (!hasReport || run.status !== "COMPLETED") return null;
  return (
    <button
      className="sm"
      title={t("inv.fixHint")}
      onClick={async () => {
        if (!window.confirm(t("inv.fixConfirm"))) return;
        const r = await act(
          () => api<any>(`/api/runs/${run.id}/investigation/fix`, {}),
          t("inv.fixStarted"),
        );
        if (r?.run_id) navigate(`#/runs/${r.run_id}`);
      }}
    >
      <Wrench size={14} /> {t("inv.fix")}
    </button>
  );
}
