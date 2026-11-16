import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  GitCompare,
  History,
  Lightbulb,
  Quote,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import {
  act,
  Badge,
  EmptyState,
  ErrorBox,
  Field,
  navigate,
  SkeletonRows,
  time,
  toast,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

/**
 * Knowledge evolution review: proposals detected from runs (BA answers, review comments), skill updates derived from an
 * approved rule change, and repository-file conflicts. Nothing changes the registry until a reviewer approves here.
 */

const STATUS_TONE: Record<string, string> = {
  pending: "WAITING",
  approved: "COMPLETED",
  rejected: "FAILED",
  rolled_back: "CANCELED",
  obsolete: "CANCELED",
};
const STATUSES = ["pending", "approved", "rejected", "rolled_back", "obsolete", ""] as const;

export function ProposalStatus({ s }: { s: string }) {
  const { t } = useI18n();
  return <Badge s={STATUS_TONE[s] ?? "CANCELED"}>{t(`kp.status.${s}`)}</Badge>;
}

function Section({
  icon: I,
  title,
  children,
  aside,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="kn-section">
      <div className="kn-section-head">
        <I size={15} strokeWidth={2} />
        <h4>{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ProposalsPanel({ id, onChanged }: { id?: string; onChanged: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("pending");
  const list = useApi<any[]>(`/api/knowledge-proposals${status ? `?status=${status}` : ""}`, [
    status,
  ]);
  // Bulk review: only pending proposals are selectable; the selection is dropped whenever the list changes.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => setSelected(new Set()), [status, list.data]);
  const pendingIds = (list.data ?? [])
    .filter((p) => p.status === "pending")
    .map((p) => Number(p.id));
  const toggle = (pid: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });
  const allSelected = pendingIds.length > 0 && pendingIds.every((pid) => selected.has(pid));
  const bulk = async (what: "approve" | "reject") => {
    const ids = pendingIds.filter((pid) => selected.has(pid));
    if (!ids.length || !confirm(t(`kp.bulk.confirm.${what}`, { n: ids.length }))) return;
    setBulkBusy(true);
    // One request per proposal, sequentially: each keeps its own reviewer check, validation and audit trail, and one
    // failure (e.g. validation) does not block the others.
    const failed: string[] = [];
    for (const pid of ids) {
      try {
        await api(`/api/knowledge-proposals/${pid}/${what}`, { comment: "" });
      } catch (e) {
        failed.push(`#${pid}: ${(e as Error).message}`);
      }
    }
    setBulkBusy(false);
    const okN = ids.length - failed.length;
    if (okN) toast(t(`kp.bulk.done.${what}`, { n: okN }), "ok");
    if (failed.length)
      toast(t("kp.bulk.failed", { n: failed.length, detail: failed.slice(0, 3).join("; ") }));
    list.reload();
    onChanged();
  };
  const back = (
    <button className="quiet sm kn-back" onClick={() => navigate("/knowledge")}>
      <ArrowLeft size={15} />
      {t("kn.back")}
    </button>
  );
  if (id) return <ProposalDetail id={Number(id)} onChanged={() => (list.reload(), onChanged())} />;
  return (
    <div className="kn-editor">
      {back}
      <div className="card kn-head">
        <span className="kn-head-icon">
          <Lightbulb size={20} strokeWidth={2} />
        </span>
        <div className="kn-head-main">
          <h2 className="kn-head-title">{t("kp.title")}</h2>
          <div className="muted small">{t("kp.subtitle")}</div>
        </div>
      </div>
      <div className="card kn-body">
        <div className="kp-filter" role="tablist" aria-label={t("kp.filter")}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === status}
              className={`kn-cat${s === status ? " on" : ""}`}
              onClick={() => setStatus(s)}
            >
              {t(`kp.status.${s || "all"}`)}
            </button>
          ))}
        </div>
        {list.loading && !list.data ? (
          <SkeletonRows rows={4} />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={list.reload} />
        ) : !list.data?.length ? (
          <EmptyState icon={Lightbulb} title={t("kp.emptyTitle")}>
            {t("kp.emptyBody")}
          </EmptyState>
        ) : (
          <>
            {pendingIds.length > 0 && (
              <div className="kp-bulk" role="toolbar" aria-label={t("kp.bulk.toolbar")}>
                <label className="kp-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(pendingIds))}
                  />
                  {t("kp.bulk.selectAll", { n: pendingIds.length })}
                </label>
                <span className="muted small">{t("kp.bulk.selected", { n: selected.size })}</span>
                <span className="kp-bulk-actions">
                  <button
                    className="sm"
                    disabled={!selected.size || bulkBusy}
                    aria-busy={bulkBusy}
                    onClick={() => bulk("approve")}
                  >
                    <CheckCircle2 size={14} />
                    {t("kp.bulk.approve", { n: selected.size })}
                  </button>
                  <button
                    className="ghost sm"
                    disabled={!selected.size || bulkBusy}
                    onClick={() => bulk("reject")}
                  >
                    <XCircle size={14} />
                    {t("kp.bulk.reject", { n: selected.size })}
                  </button>
                </span>
              </div>
            )}
            <ul className="kp-list">
              {list.data.map((p) => (
                <li key={p.id} className={p.status === "pending" ? "kp-row" : undefined}>
                  {p.status === "pending" && (
                    <input
                      type="checkbox"
                      className="kp-row-check"
                      aria-label={t("kp.bulk.selectOne", { id: p.id })}
                      checked={selected.has(Number(p.id))}
                      onChange={() => toggle(Number(p.id))}
                    />
                  )}
                  <button
                    type="button"
                    className="kn-item"
                    onClick={() => navigate(`/knowledge/~proposals/${p.id}`)}
                  >
                    <span className="kn-item-icon">
                      {p.source_kind === "skill_evolution" ? (
                        <Sparkles size={16} />
                      ) : p.source_kind === "repository_import" ? (
                        <GitCompare size={16} />
                      ) : (
                        <Lightbulb size={16} />
                      )}
                    </span>
                    <span className="kn-item-body">
                      <span className="kn-item-title">
                        <b>{p.proposed?.title || p.target_key || `#${p.id}`}</b>
                        <ProposalStatus s={p.status} />
                        <span className="kn-tag">{p.change_type}</span>
                      </span>
                      <span className="kn-item-key mono">
                        #{p.id}
                        {p.target_key
                          ? ` · ${p.target_key}${p.target_version ? ` v${p.target_version}` : ""}`
                          : ""}
                      </span>
                      <span className="kn-item-meta">
                        <span className="kn-tag">{t(`kp.source.${p.source_kind}`)}</span>
                        {p.proposed?.scope_type && (
                          <span className="kn-tag mono">
                            {p.proposed.scope_type}
                            {p.proposed.scope_ref ? `:${p.proposed.scope_ref}` : ""}
                          </span>
                        )}
                        <span className="kn-tag">
                          {t("kp.confidence", {
                            n: Math.round(Number(p.confidence) * 100),
                          })}
                        </span>
                        <span className="kn-tag">{t("kp.evidenceN", { n: p.evidence_count })}</span>
                        {p.validation_passed === "false" && (
                          <span className="kn-tag kp-warn">{t("kp.validationFailed")}</span>
                        )}
                        {p.source_run_id && (
                          <span className="muted small">Run #{p.source_run_id}</span>
                        )}
                        <span className="muted small">{time(p.created_at)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Diff({ lines }: { lines: Array<{ op: string; line: string }> }) {
  const { t } = useI18n();
  if (!lines?.length) return <div className="muted small">{t("kp.noDiff")}</div>;
  return (
    <pre className="kp-diff" aria-label={t("kp.diff")}>
      {lines.map((d, i) => (
        <div key={i} className={d.op === "+" ? "is-add" : d.op === "-" ? "is-del" : ""}>
          <span aria-hidden>{d.op}</span> {d.line || " "}
        </div>
      ))}
    </pre>
  );
}

function ProposalDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { t } = useI18n();
  const { data: p, error, reload } = useApi<any>(`/api/knowledge-proposals/${id}`, [id]);
  const [comment, setComment] = useState("");
  const [edit, setEdit] = useState<{
    content: string;
    scope_type: string;
    scope_ref: string;
    effective_from: string;
  } | null>(null);
  const [override, setOverride] = useState(false);
  const [accept, setAccept] = useState(false);
  useEffect(() => {
    if (p)
      setEdit({
        content: p.proposed?.content ?? "",
        scope_type: p.proposed?.scope_type ?? "GLOBAL",
        scope_ref: p.proposed?.scope_ref ?? "",
        effective_from: p.proposed?.effective_from
          ? String(p.proposed.effective_from).slice(0, 10)
          : "",
      });
  }, [p]);
  const back = (
    <button className="quiet sm" onClick={() => navigate("/knowledge/~proposals")}>
      <ArrowLeft size={15} />
      {t("kp.backToList")}
    </button>
  );
  if (error)
    return (
      <div>
        {back}
        <ErrorBox error={error} />
      </div>
    );
  if (!p || !edit)
    return (
      <div className="card">
        <SkeletonRows rows={5} />
      </div>
    );
  const pending = p.status === "pending";
  const done = () => (reload(), onChanged());
  const decide = async (what: "approve" | "reject" | "rollback") => {
    const body: any = { comment };
    if (what === "approve") {
      const edits: any = {};
      if (edit.content !== (p.proposed?.content ?? "")) edits.content = edit.content;
      if (
        edit.scope_type !== p.proposed?.scope_type ||
        edit.scope_ref !== (p.proposed?.scope_ref ?? "")
      )
        Object.assign(edits, {
          scope_type: edit.scope_type,
          scope_ref: edit.scope_type === "GLOBAL" ? "" : edit.scope_ref,
        });
      const ef = edit.effective_from
        ? new Date(`${edit.effective_from}T00:00:00`).toISOString()
        : null;
      if ((ef ?? null) !== (p.proposed?.effective_from ?? null)) edits.effective_from = ef;
      Object.assign(body, {
        edits,
        accept_current_version: accept,
        override_validation: override,
      });
    }
    if (await act(() => api(`/api/knowledge-proposals/${id}/${what}`, body), t(`kp.done.${what}`)))
      done();
  };
  const scopeEditable = pending && (p.change_type === "SUPERSEDE" || p.change_type === "CREATE");
  const resultKey = p.applied?.created_key ?? p.applied?.item_key ?? p.target_key;
  return (
    <div className="kn-editor">
      {back}
      <div className="card kn-head">
        <span className="kn-head-icon">
          {p.source_kind === "skill_evolution" ? <Sparkles size={20} /> : <Lightbulb size={20} />}
        </span>
        <div className="kn-head-main">
          <h2 className="kn-head-title">{p.proposed?.title || p.target_key || `#${p.id}`}</h2>
          <div className="kn-item-meta">
            <ProposalStatus s={p.status} />
            <span className="kn-tag">{p.change_type}</span>
            <span className="kn-tag">{t(`kp.source.${p.source_kind}`)}</span>
            {p.domain && <span className="kn-tag">{p.domain}</span>}
            <span className="kn-tag">
              {t("kp.confidence", {
                n: Math.round(Number(p.confidence) * 100),
              })}
            </span>
            {p.target_key && (
              <a className="kn-tag mono" href={`#/knowledge/${p.target_key}`}>
                {p.target_key}
                {p.target_version ? ` v${p.target_version}` : ""}
              </a>
            )}
            {p.source_run_id && (
              <a className="kn-tag" href={`#/runs/${p.source_run_id}`}>
                Run #{p.source_run_id}
              </a>
            )}
          </div>
        </div>
        <div className="kn-head-time muted small">
          #{p.id} · {time(p.created_at)}
        </div>
      </div>

      <div className="card kn-body">
        {p.parent && (
          <div className="kp-note small">
            {t("kp.derivedFrom")}{" "}
            <a href={`#/knowledge/~proposals/${p.parent.id}`}>#{p.parent.id}</a> (
            {p.parent.change_type} {p.parent.target_key ?? ""})
          </div>
        )}
        {p.uncertainty && (
          <div className="kp-note kp-warn small">
            <ShieldAlert size={14} /> {p.uncertainty}
          </div>
        )}
        {p.target_changed && (
          <div className="kp-note kp-warn small">
            <History size={14} />{" "}
            {t("kp.targetChanged", {
              from: p.target_version,
              to: p.target?.current_version,
            })}
          </div>
        )}

        <Section
          icon={GitCompare}
          title={t("kp.compare")}
          aside={
            p.terms && (p.terms.removed.length || p.terms.added.length) ? (
              <span className="small muted">
                {p.terms.removed.map((x: string) => (
                  <s key={x} className="mono">
                    {x}
                  </s>
                ))}
                {p.terms.removed.length && p.terms.added.length ? " → " : ""}
                {p.terms.added.map((x: string) => (
                  <b key={x} className="mono">
                    {x}{" "}
                  </b>
                ))}
              </span>
            ) : undefined
          }
        >
          <div className="kp-compare">
            <div>
              <div className="kn-sub-head">{t("kp.oldRule")}</div>
              <pre className="kp-text">{p.existing_rule || t("kp.none")}</pre>
            </div>
            <div>
              <div className="kn-sub-head">
                {p.change_type === "DEPRECATE" ? t("kp.deprecated") : t("kp.newRule")}
              </div>
              <pre className="kp-text">
                {p.change_type === "DEPRECATE" ? t("kp.deprecatedBody") : p.proposed?.content}
              </pre>
            </div>
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="small">{t("kp.diff")}</summary>
            <Diff lines={p.diff} />
          </details>
        </Section>

        <div className="kn-overview-grid">
          <Section icon={Quote} title={t("kp.evidence")}>
            <ul className="kp-evidence">
              {(p.evidence ?? []).map((e: any, i: number) => (
                <li key={i}>
                  <div className="small">
                    <span className="kn-tag">{t(`kp.ev.${e.source}`)}</span>{" "}
                    <span className="kn-tag">{e.trust}</span> <b>{e.author}</b>
                    {e.ref?.run_id && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={`#/runs/${e.ref.run_id}${e.ref.step ? `/${e.ref.step}` : ""}`}>
                          Run #{e.ref.run_id}
                          {e.ref.step ? ` / ${e.ref.step}` : ""}
                        </a>
                      </>
                    )}
                    {e.ref?.path && (
                      <>
                        {" "}
                        ·{" "}
                        <span className="mono">
                          {e.ref.repo}/{e.ref.path}
                        </span>
                      </>
                    )}
                  </div>
                  <blockquote className="kp-quote">{e.quote}</blockquote>
                </li>
              ))}
            </ul>
          </Section>
          <Section icon={Sparkles} title={t("kp.impacts")}>
            <dl className="kn-kv">
              <div className="kn-kv-row">
                <dt>{t("kp.skills")}</dt>
                <dd>
                  {p.impacts?.skills?.length ? (
                    p.impacts.skills.map((s: any) => (
                      <div key={s.key}>
                        <a className="mono" href={`#/knowledge/${s.key}`}>
                          {s.key}
                        </a>{" "}
                        <span className="muted small">{s.reason}</span>
                      </div>
                    ))
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
              </div>
              <div className="kn-kv-row">
                <dt>{t("kp.repos")}</dt>
                <dd>
                  {p.impacts?.repositories?.length ? (
                    p.impacts.repositories.map((r: string) => (
                      <span key={r} className="pill">
                        {r}
                      </span>
                    ))
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
              </div>
              <div className="kn-kv-row">
                <dt>{t("kp.workflows")}</dt>
                <dd>
                  {p.impacts?.workflows?.length ? (
                    p.impacts.workflows.map((w: string) => (
                      <a key={w} className="pill" href={`#/workflows/${w}`}>
                        {w}
                      </a>
                    ))
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
              </div>
              {p.impacts?.competing_rules?.length > 0 && (
                <div className="kn-kv-row">
                  <dt>{t("kp.competing")}</dt>
                  <dd>
                    {p.impacts.competing_rules.map((r: any) => (
                      <a key={r.key} className="pill mono" href={`#/knowledge/${r.key}`}>
                        {r.key}
                      </a>
                    ))}
                  </dd>
                </div>
              )}
              {p.impacts?.open_proposals?.filter((x: any) => x.id !== p.id).length > 0 && (
                <div className="kn-kv-row">
                  <dt>{t("kp.otherOpen")}</dt>
                  <dd>
                    {p.impacts.open_proposals
                      .filter((x: any) => x.id !== p.id)
                      .map((x: any) => (
                        <a key={x.id} className="pill" href={`#/knowledge/~proposals/${x.id}`}>
                          #{x.id}
                        </a>
                      ))}
                  </dd>
                </div>
              )}
            </dl>
          </Section>
        </div>

        {p.validation && (
          <Section
            icon={CheckCircle2}
            title={t("kp.validation")}
            aside={
              <Badge s={p.validation.passed ? "COMPLETED" : "FAILED"}>
                {p.validation.passed ? t("kp.passed") : t("kp.failed")}
              </Badge>
            }
          >
            <ul className="kp-checks">
              {p.validation.checks.map((c: any) => (
                <li key={c.name} className={c.passed ? "okc" : "err"}>
                  {c.passed ? "✓" : "✗"} <b>{c.name}</b>{" "}
                  <span className="muted small">{c.detail}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {p.children?.length > 0 && (
          <Section icon={Sparkles} title={t("kp.children")}>
            <ul className="kn-use-list">
              {p.children.map((c: any) => (
                <li key={c.id}>
                  <a href={`#/knowledge/~proposals/${c.id}`}>
                    #{c.id} {c.target_key}
                  </a>{" "}
                  <ProposalStatus s={c.status} />{" "}
                  {c.validation && !c.validation.passed && (
                    <span className="kn-tag kp-warn">{t("kp.validationFailed")}</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {p.status !== "pending" && (
          <div className="kv small kp-review">
            {p.reviewed_by && (
              <>
                <span>{t("kp.reviewedBy")}</span>
                <span>
                  {p.reviewed_by} · {time(p.reviewed_at)}
                </span>
              </>
            )}
            {p.review_comment && (
              <>
                <span>{t("kp.comment")}</span>
                <span>{p.review_comment}</span>
              </>
            )}
            {p.applied && (
              <>
                <span>{t("kp.applied")}</span>
                <span className="mono">
                  {resultKey ? <a href={`#/knowledge/${resultKey}`}>{resultKey}</a> : null}{" "}
                  {p.applied.new_version
                    ? `v${p.applied.previous_version} → v${p.applied.new_version}`
                    : ""}
                  {p.applied.superseded_key
                    ? ` ${t("kp.supersedes", { key: p.applied.superseded_key })}`
                    : ""}
                </span>
              </>
            )}
            {p.rolled_back_by && (
              <>
                <span>{t("kp.rolledBack")}</span>
                <span>
                  {p.rolled_back_by} · {time(p.rolled_back_at)}
                </span>
              </>
            )}
          </div>
        )}

        {pending && (
          <fieldset className="kn-fieldset kp-decide">
            <legend>{t("kp.review")}</legend>
            {p.change_type !== "DEPRECATE" && (
              <Field label={t("kp.finalText")} hint={t("kp.finalTextHint")}>
                <textarea
                  className="kn-textarea"
                  rows={Math.min(14, Math.max(4, edit.content.split("\n").length + 1))}
                  value={edit.content}
                  onChange={(e) => setEdit({ ...edit, content: e.target.value })}
                />
              </Field>
            )}
            <div className="kn-form-grid">
              {scopeEditable && (
                <>
                  <Field label={t("kn.scope")}>
                    <select
                      value={edit.scope_type}
                      onChange={(e) => setEdit({ ...edit, scope_type: e.target.value })}
                    >
                      {["GLOBAL", "ORGANIZATION", "PROJECT", "REPOSITORY"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  {edit.scope_type !== "GLOBAL" && (
                    <Field label={t("kn.scopeRef")}>
                      <input
                        value={edit.scope_ref}
                        onChange={(e) => setEdit({ ...edit, scope_ref: e.target.value })}
                      />
                    </Field>
                  )}
                </>
              )}
              <Field label={t("kp.effectiveFrom")} hint={t("kp.effectiveHint")}>
                <input
                  type="date"
                  value={edit.effective_from}
                  onChange={(e) => setEdit({ ...edit, effective_from: e.target.value })}
                />
              </Field>
            </div>
            {p.target_changed && (
              <label className="kn-toggle">
                <input
                  type="checkbox"
                  checked={accept}
                  onChange={(e) => setAccept(e.target.checked)}
                />
                <span>{t("kp.acceptCurrent")}</span>
              </label>
            )}
            {p.validation && !p.validation.passed && (
              <label className="kn-toggle">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                <span>{t("kp.override")}</span>
              </label>
            )}
            <Field label={t("kp.comment")}>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t("kp.commentPh")}
              />
            </Field>
            <div className="rv-consequence small">
              <CheckCircle2 size={14} color="var(--st-ok)" />
              <span>{t(`kp.effect.${p.change_type}`)}</span>
              <XCircle size={14} color="var(--st-err)" />
              <span>{t("kp.rejectEffect")}</span>
            </div>
            <div className="row tight">
              <button
                className="ok"
                disabled={
                  (p.target_changed && !accept) ||
                  (p.validation && !p.validation.passed && !override)
                }
                onClick={() => decide("approve")}
              >
                <CheckCircle2 size={15} />
                {t("kp.approve")}
              </button>
              <button className="ghost" onClick={() => decide("reject")}>
                <XCircle size={15} />
                {t("kp.reject")}
              </button>
            </div>
          </fieldset>
        )}
        {p.status === "approved" && (
          <div className="row tight kp-decide">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("kp.rollbackPh")}
              aria-label={t("kp.rollbackPh")}
              style={{ flex: 1 }}
            />
            <button
              className="ghost"
              onClick={() => confirm(t("kp.rollbackConfirm")) && decide("rollback")}
            >
              <RotateCcw size={15} />
              {t("kp.rollback")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
