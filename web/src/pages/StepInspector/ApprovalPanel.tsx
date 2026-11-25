import { EvidenceSummary } from "../../EvidenceGate.tsx";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileDiff, Hand, ShieldCheck, X, XCircle } from "lucide-react";
import { api } from "../../api.ts";
import { act, navigate } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type InspectorRun, OutputView, type StepRow } from "./shared.tsx";

export function ApprovalPanel({
  run,
  step,
  onDone,
}: {
  run: InspectorRun;
  step: StepRow;
  onDone: () => void | Promise<unknown>;
}) {
  const { t } = useI18n();
  const req = step.approval?.request;
  const gate = step.approval?.gate && !step.approval?.granted;
  const [comment, setComment] = useState("");
  const [ackRisk, setAckRisk] = useState(false);
  const [repos, setRepos] = useState<string[]>(req?.recommended ?? run.selected_repositories ?? []);
  const [branch, setBranch] = useState<string>(req?.branch ?? "");
  const [branches, setBranches] = useState<Record<string, string>>(() => ({
    ...(req?.branches ?? {}),
  }));
  const [repoFilter, setRepoFilter] = useState("");
  const allowed: string[] = req?.allowed ?? run.allowed_repositories ?? [];
  const candidateNames = new Set<string>((req?.candidates ?? []).map((c) => c.repo));
  // Every allowed repository the discovery did not suggest, plus anything already selected that is not a candidate
  // (e.g. reused from an earlier run), so the reviewer can add or remove any repo, not only the suggested ones.
  const others = [...new Set([...allowed, ...repos])].filter((r) => !candidateNames.has(r)).sort();
  const f = repoFilter.trim().toLowerCase();
  const shownOthers = f
    ? others.filter((r) => r.toLowerCase().includes(f) || repos.includes(r))
    : others;
  const toggleRepo = (r: string, on: boolean) =>
    setRepos((cur) => (on ? [...new Set([...cur, r])] : cur.filter((x) => x !== r)));
  // "payment-fiserv: Nhánh split/8-channel-splitting  payment_gateway_global: Nhánh split/6-channel-splitting" pasted
  // into the common field fills the per-repository fields instead.
  const onCommon = (v: string) => {
    const names: string[] = [
      ...new Set([
        ...(req?.candidates ?? []).map((c) => c.repo),
        ...(req?.allowed ?? run.allowed_repositories ?? []),
      ]),
    ];
    const found: Record<string, string> = {};
    for (const m of v.matchAll(
      /([A-Za-z0-9._-]+)\s*:\s*(?:nhánh|branch)?\s*([A-Za-z0-9][A-Za-z0-9._/-]*)/gi,
    ))
      if (names.includes(m[1])) found[m[1]] = m[2];
    if (Object.keys(found).length) {
      setBranches((b) => ({ ...b, ...found }));
      setRepos((r) => [...new Set([...r, ...Object.keys(found)])]);
      setBranch("");
    } else setBranch(v);
  };
  const send = async (approve: boolean) => {
    const body: {
      comment: string;
      repositories?: string[];
      data?: { branch?: string; branches?: Record<string, string>; acknowledge_risk?: boolean };
      subject?: string;
    } = { comment };
    if (approve && req?.select_repositories) body.repositories = repos;
    if (approve && req?.ask_branch)
      body.data = {
        branch: branch.trim(),
        branches: Object.fromEntries(repos.map((r) => [r, (branches[r] ?? "").trim()])),
      };
    if (approve && req?.requires_risk_acknowledgement)
      body.data = { ...(body.data ?? {}), acknowledge_risk: ackRisk };
    if (approve && req?.autonomy?.subject?.hash) body.subject = req.autonomy.subject.hash;
    await act(
      async () => {
        const result = await api(
          `/api/runs/${run.id}/steps/${step.key}/${approve ? "approve" : "reject"}`,
          body,
        );
        await onDone();
        return result;
      },
      approve ? t("si.approved") : t("si.rejected"),
    );
  };
  const reexec = step.config?.on_reject?.reexecute;
  return (
    <section className="rv-attn" aria-label={t("si.needsApproval")}>
      <div className="rv-attn-head">
        <span className="rv-attn-icon">
          <Hand size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>{gate ? t("si.approveBefore") : (req?.message ?? t("si.needsApproval"))}</h4>
          <div className="rv-attn-sub">{t("si.stoppedAt", { step: step.name })}</div>
        </div>
      </div>
      {req?.autonomy && (
        <div className="small" style={{ margin: "6px 0" }}>
          <span className="muted">{t("au.why")}</span>{" "}
          {[...(req.autonomy.reasons ?? []), ...(req.recheck_reasons ?? [])].join("; ")}
          {req.autonomy.shadow && req.autonomy.result === "ALLOW" && (
            <span className="muted"> · {t("au.shadow")}</span>
          )}
          {(req.autonomy.required_evidence ?? []).length > 0 && (
            <div className="muted">
              {t("au.required", { list: (req.autonomy.required_evidence ?? []).join(", ") })}
            </div>
          )}
        </div>
      )}
      {step.type === "git_pull_request" && (
        <div className="row">
          <button
            type="button"
            className="ghost sm"
            onClick={() => navigate(`/runs/${run.id}/~changes`)}
          >
            <FileDiff size={14} /> {t("si.seeChanges")}
          </button>
        </div>
      )}
      {req?.select_repositories && (
        <div style={{ marginTop: 10 }}>
          <div
            className="small"
            style={{
              color: req.ambiguous ? "var(--st-wait)" : "var(--ink-2)",
              fontWeight: 600,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            {req.ambiguous && <AlertTriangle size={14} />}
            {req.ambiguous ? t("si.ambiguous") : t("si.suggestedRepos")}
          </div>
          {(req.candidates ?? []).map((c) => (
            <label key={c.repo} className="rv-repo-opt">
              <input
                type="checkbox"
                checked={repos.includes(c.repo)}
                onChange={(e) => toggleRepo(c.repo, e.target.checked)}
              />
              <span style={{ minWidth: 0 }}>
                <b>{c.repo}</b> <span className="muted small">{t("si.score", { n: c.score })}</span>
                <br />
                <span className="muted small">{(c.reasons ?? []).join(" · ")}</span>
              </span>
            </label>
          ))}
          {others.length > 0 && (
            <div className="rv-repo-more">
              <div className="rv-repo-more-head">
                <span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
                  {t("si.otherRepos", { n: others.length })}
                </span>
                {others.length > 8 && (
                  <input
                    className="sm"
                    type="search"
                    value={repoFilter}
                    placeholder={t("si.filterRepos")}
                    aria-label={t("si.filterRepos")}
                    onChange={(e) => setRepoFilter(e.target.value)}
                  />
                )}
              </div>
              <div className="rv-repo-chips">
                {shownOthers.map((r) => (
                  <label key={r} className={`rv-repo-chip${repos.includes(r) ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={repos.includes(r)}
                      onChange={(e) => toggleRepo(r, e.target.checked)}
                    />
                    <span className="mono">{r}</span>
                  </label>
                ))}
                {shownOthers.length === 0 && (
                  <span className="muted small">{t("si.noRepoMatch")}</span>
                )}
              </div>
            </div>
          )}
          {req.ask_branch && (
            <div className="si-branch">
              <span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
                {t("si.branch")}
              </span>
              <input
                className="mono"
                value={branch}
                placeholder={t("si.branchCommonPh")}
                aria-label={t("si.branchCommonPh")}
                onChange={(e) => onCommon(e.target.value)}
              />
              {repos.length > 0 && (
                <div className="si-branch-grid">
                  {repos.map((r) => (
                    <label key={r} className="si-branch-row">
                      <span className="mono small">{r}</span>
                      <input
                        className="mono"
                        value={branches[r] ?? ""}
                        placeholder={branch.trim() || t("si.branchBase")}
                        onChange={(e) => setBranches((b) => ({ ...b, [r]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
              )}
              <span className="muted small">{t("si.branchHint")}</span>
            </div>
          )}
        </div>
      )}
      {req?.scope && <EvidenceSummary scope={req.scope} />}
      {Object.entries(req?.outputs ?? {}).map(([k, v]) => (
        <details key={k} open style={{ marginTop: 8 }}>
          <summary>{t("si.stepOutput", { step: k })}</summary>
          <OutputView value={v} locale={run.output_locale} />
        </details>
      ))}
      <textarea
        rows={2}
        placeholder={gate ? t("si.gateCommentPh") : t("si.commentPh")}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        style={{ marginTop: 10, background: "var(--surface)" }}
      />
      <div className="rv-consequence">
        <CheckCircle2 size={14} color="var(--st-ok)" />
        <span>
          {req?.select_repositories
            ? t("si.approveRepos", { n: repos.length })
            : t("si.approveDoes")}
        </span>
        <XCircle size={14} color="var(--st-err)" />
        <span>{reexec ? t("si.rejectRedo", { step: reexec }) : t("si.rejectDoes")}</span>
      </div>
      {req?.requires_risk_acknowledgement && (
        <label
          className="small"
          style={{ display: "flex", gap: 6, marginTop: 8, color: "var(--st-err)" }}
        >
          <input type="checkbox" checked={ackRisk} onChange={(e) => setAckRisk(e.target.checked)} />
          <span>{t("ev.ack")}</span>
        </label>
      )}
      <div className="rv-attn-actions">
        <button
          type="button"
          className="ok big"
          disabled={req?.requires_risk_acknowledgement && (!ackRisk || !comment.trim())}
          aria-describedby={
            req?.requires_risk_acknowledgement && (!ackRisk || !comment.trim())
              ? "si-ack-hint"
              : undefined
          }
          onClick={() => send(true)}
        >
          <ShieldCheck size={16} /> {t("si.approve")}
        </button>
        {req?.requires_risk_acknowledgement && (!ackRisk || !comment.trim()) && (
          <span id="si-ack-hint" className="muted small">
            {t("ev.ackHint")}
          </span>
        )}
        {gate && (
          <button
            type="button"
            className="ghost"
            title={t("si.skipGateHint")}
            onClick={async () =>
              (await act(
                () =>
                  api(`/api/runs/${run.id}/steps/${step.key}/skip`, {
                    reason: comment || "skipped by user",
                  }),
                t("si.skipped"),
              )) && onDone()
            }
          >
            {t("si.skipGate")}
          </button>
        )}
        <button type="button" className="danger" onClick={() => send(false)}>
          <X size={15} /> {reexec ? t("si.rejectRedoBtn", { step: reexec }) : t("si.reject")}
        </button>
      </div>
    </section>
  );
}
