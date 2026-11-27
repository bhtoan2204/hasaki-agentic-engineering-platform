import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  Hand,
  Link2,
  Paperclip,
  RotateCcw,
  ShieldCheck,
  StickyNote,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { act, Badge, Copy, Empty, Markdown, Tabs, time } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./RunView.css";
import "./Report.css";

type ReportRequirement = {
  id: string;
  text: string;
  status: string;
  explanation?: string;
  evidence: Array<{
    id: string;
    title: string;
    ref?: { url?: string; artifact_id?: number; step_key?: string };
  }>;
};
export type TaskReport = {
  task?: { code?: string; title?: string };
  object?: string;
  object_value?: string;
  suggest_id: string;
  generated_by: string;
  generated_at: string;
  counts: { VERIFIED: number; PARTIAL: number; MISSING: number };
  summary: string;
  sections: Array<{ name: string; requirements: ReportRequirement[] }>;
  limitations?: string[];
};
export type ReportPayload = { report?: TaskReport; markdown?: string; skipped?: boolean };
export type ReportSpec = {
  sections: Array<{ name: string; requirements: Array<{ id: string; text: string }> }>;
  reasoning?: string;
};
export type ReportStep = {
  key: string;
  status: string;
  output?: ReportPayload | null;
  approval?: { request?: ReportPayload } | null;
  config?: { ai_suggest?: ReportSpec };
};
export type ReportArtifact = {
  id: number;
  kind: string;
  name: string;
  attempt_id: number | null;
  created_at: string;
  data?: { mime?: string; note_only?: boolean; requirement_id?: string; final?: boolean } | null;
};
type EvidenceBody = { note: string } | { name: string; mime: string; data_base64: string };

const ST: Record<string, [string, string]> = {
  VERIFIED: ["COMPLETED", "VERIFIED"],
  PARTIAL: ["WAITING", "PARTIAL"],
  MISSING: ["FAILED", "MISSING"],
};

function readFile(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
}

/** Attach a file or a note as evidence, optionally to one requirement. */
function EvidenceAdder({
  runId,
  requirementId,
  onDone,
}: {
  runId: number;
  requirementId?: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const send = async (body: EvidenceBody) => {
    setBusy(true);
    const r = await act(
      () =>
        api(`/api/runs/${runId}/steps/task_result_report/evidence`, {
          requirement_id: requirementId ?? null,
          ...body,
        }),
      t("rp.added"),
    );
    setBusy(false);
    if (r) {
      setNote("");
      onDone();
    }
  };
  return (
    <div className="row tight rp-adder">
      <button
        type="button"
        className="ghost xs"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        <Upload size={12} /> {t("rp.upload")}
      </button>
      <span>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,.pdf,.txt,.csv,.json,.md"
          hidden
          disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024)
              return act(async () => {
                throw new Error(t("rp.fileMax"));
              });
            send({
              name: f.name,
              mime: f.type,
              data_base64: await readFile(f),
            });
            e.target.value = "";
          }}
        />
      </span>
      <input
        className="rp-adder-input"
        placeholder={t("rp.notePh")}
        aria-label={t("rp.notePh")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="button"
        className="xs ghost"
        disabled={busy || !note.trim()}
        onClick={() => send({ note })}
      >
        <StickyNote size={11} /> {t("rp.addNote")}
      </button>
    </div>
  );
}

/** Task Result Report: sections/requirements with evidence status, evidence upload, regenerate, edit, approve, copy. */
export function ReportPanel({
  run,
  step,
  artifacts,
  attempts,
  onChanged,
}: {
  run: { id: number };
  step: ReportStep;
  artifacts: ReportArtifact[];
  attempts: Array<{ id: number; number: number }>;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const waiting = step.status === "WAITING_APPROVAL" ? step.approval?.request : null;
  const final = step.status === "COMPLETED" && step.output?.report ? step.output : null;
  const current = final ?? waiting;
  const report = current?.report;
  const [md, setMd] = useState<string>(current?.markdown ?? "");
  const [comment, setComment] = useState("");
  const [view, setView] = useState<"report" | "markdown" | "evidence" | "history">("report");
  useEffect(() => setMd(current?.markdown ?? ""), [current?.markdown]);
  const uploads = artifacts.filter((a) => a.kind === "evidence");
  const versions = artifacts.filter((a) => a.kind === "report");

  if (step.output?.skipped) return <Empty>{t("rp.skipped")}</Empty>;
  if (!report)
    return (
      <div>
        <Empty>
          {step.status === "RUNNING"
            ? t("rp.building")
            : step.status === "PENDING"
              ? t("rp.pending")
              : t("rp.missing", { status: step.status })}
        </Empty>
        {step.config?.ai_suggest && <SpecPreview spec={step.config.ai_suggest} />}
      </div>
    );
  const regenerate = async () =>
    (await act(
      () =>
        api(`/api/runs/${run.id}/steps/${step.key}/reexecute`, {
          feedback: "regenerate the report with the latest evidence",
        }),
      t("rp.regen"),
    )) && onChanged();
  const approve = async () => {
    const edited = md.trim() !== (waiting?.markdown ?? "").trim();
    const r = await act(
      () =>
        api(`/api/runs/${run.id}/steps/${step.key}/approve`, {
          comment,
          data: edited ? { markdown: md } : undefined,
        }),
      t("rp.approved"),
    );
    if (r) onChanged();
  };
  const c = report.counts;
  return (
    <div>
      <div className="rv-card rp-head-card">
        <div className="rv-card-head rp-card-head">
          <h4 className="rp-title-row">
            <ClipboardList size={16} />
            {report.task?.code && <span className="mono">{report.task.code}</span>}
            <span>{report.task?.title}</span>
          </h4>
          {final ? (
            <Badge s="COMPLETED">{t("rp.approvedBadge")}</Badge>
          ) : (
            <Badge s="WAITING_APPROVAL">{t("rp.draftBadge")}</Badge>
          )}
        </div>
        <div className="muted small rp-meta">
          {report.object && (
            <span>
              {report.object}: <b className="mono">{report.object_value}</b>
            </span>
          )}
          <span>
            suggest <span className="mono">{report.suggest_id}</span>
          </span>
          <span>{report.generated_by}</span>
          <span>{time(report.generated_at)}</span>
        </div>
        <div className="rv-minis rp-minis">
          <div className="rv-mini tone-ok">
            <span>
              <CheckCircle2 size={12} /> {t("rp.verified")}
            </span>
            <b>{c.VERIFIED}</b>
          </div>
          <div className="rv-mini tone-wait">
            <span>
              <AlertTriangle size={12} /> {t("rp.partial")}
            </span>
            <b>{c.PARTIAL}</b>
          </div>
          <div className="rv-mini tone-err">
            <span>
              <XCircle size={12} /> {t("rp.missingEv")}
            </span>
            <b>{c.MISSING}</b>
          </div>
        </div>
      </div>
      <Tabs
        tabs={[
          ["report", t("rp.tabReqs")],
          ["markdown", t("rp.tabMd")],
          ["evidence", t("rp.tabUploads", { n: uploads.length })],
          ["history", t("rp.tabHistory", { n: versions.length })],
        ]}
        value={view}
        onChange={setView}
      />
      {view === "report" && (
        <div>
          <div className="rv-card">
            <div className="rv-card-head">
              <h4>
                <FileText size={15} /> {t("rp.summary")}
              </h4>
            </div>
            <Markdown text={report.summary} />
          </div>
          {report.sections.map((s) => (
            <div key={s.name}>
              <h3 className="rp-sec-title">{s.name}</h3>
              {s.requirements.map((r) => (
                <div key={r.id} className={`rp-req rp-req-st-${r.status}`}>
                  <div className="rp-req-head">
                    <Badge s={ST[r.status]?.[0] ?? "PENDING"}>
                      {ST[r.status]?.[1] ?? r.status}
                    </Badge>{" "}
                    <span className="mono muted small">{r.id}</span>{" "}
                    <span className="grow">{r.text}</span>
                  </div>
                  {r.evidence.length > 0 ? (
                    <div className="rp-ev-list">
                      {r.evidence.map((e) => (
                        <div key={e.id} className="rp-ev">
                          <Link2 size={12} /> <span className="mono muted">{e.id}</span>{" "}
                          <span>{e.title}</span>
                          {e.ref?.url && (
                            <a href={e.ref.url} target="_blank" rel="noopener">
                              {t("rp.open")}
                            </a>
                          )}
                          {e.ref?.artifact_id && (
                            <a
                              href={`/api/artifacts/${e.ref.artifact_id}/raw`}
                              target="_blank"
                              rel="noopener"
                            >
                              {t("rp.view")}
                            </a>
                          )}
                          {e.ref?.step_key && (
                            <a href={`#/runs/${run.id}/${e.ref.step_key}`}>{e.ref.step_key}</a>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="small err rp-ev-missing">
                      <XCircle size={12} /> {t("rp.noEvidence")}
                    </div>
                  )}
                  {r.explanation && <div className="muted small rp-expl">{r.explanation}</div>}
                  {!final && r.status !== "VERIFIED" && (
                    <EvidenceAdder runId={run.id} requirementId={r.id} onDone={onChanged} />
                  )}
                </div>
              ))}
            </div>
          ))}
          {!!report.limitations?.length && (
            <div className="rv-card soft">
              <div className="rv-card-head rp-card-head">
                <h4>
                  <AlertTriangle size={15} /> {t("rp.limits")}
                </h4>
              </div>
              <ul className="small rp-limits-list">
                {report.limitations.map((l: string, i: number) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {view === "markdown" && (
        <div>
          <div className="row tight">
            <span className="muted small grow">{final ? t("rp.finalMd") : t("rp.editMd")}</span>
            <Copy text={md} label={t("rp.copyMd")} />
          </div>
          {final ? (
            <div className="rv-card">
              <Markdown text={md} />
            </div>
          ) : (
            <textarea
              className="code"
              rows={22}
              value={md}
              onChange={(e) => setMd(e.target.value)}
            />
          )}
        </div>
      )}
      {view === "evidence" && (
        <div>
          {!final && (
            <>
              <div className="small muted">{t("rp.sharedEv")}</div>
              <EvidenceAdder runId={run.id} onDone={onChanged} />
            </>
          )}
          {uploads.map((a) => (
            <div key={a.id} className="rp-file">
              {String(a.data?.mime ?? "").startsWith("image/") && (
                <img src={`/api/artifacts/${a.id}/raw`} alt={a.name} />
              )}
              {a.data?.note_only ? (
                <StickyNote size={14} color="var(--muted)" />
              ) : (
                <Paperclip size={14} color="var(--brand)" />
              )}
              <span className="grow rp-file-name">
                <span>{a.data?.note_only ? t("rp.note") : a.name}</span>
                {a.data?.requirement_id && (
                  <span className="mono muted">→ {a.data.requirement_id}</span>
                )}
                <span className="muted">{time(a.created_at)}</span>
              </span>
              <a
                className="rp-open-link"
                href={`/api/artifacts/${a.id}/raw`}
                target="_blank"
                rel="noopener"
              >
                <ExternalLink size={12} /> {t("rp.open")}
              </a>
              {!final && (
                <button
                  type="button"
                  className="xs ghost"
                  onClick={async () =>
                    (await act(() => api(`/api/artifacts/${a.id}/delete-evidence`, {}))) &&
                    onChanged()
                  }
                >
                  <Trash2 size={11} /> {t("rp.delete")}
                </button>
              )}
            </div>
          ))}
          {!uploads.length && <div className="muted small">{t("qx.noneYet")}</div>}
        </div>
      )}
      {view === "history" && (
        <div>
          {versions.map((a) => (
            <div key={a.id} className="rp-file">
              <FileText size={14} color="var(--muted)" />{" "}
              <a href={`/api/artifacts/${a.id}/raw`} target="_blank" rel="noopener">
                {a.name}
              </a>{" "}
              <span className="muted rp-meta">
                <span>{time(a.created_at)}</span>
                <span>attempt {attempts.find((t) => t.id === a.attempt_id)?.number ?? "?"}</span>
              </span>{" "}
              {a.data?.final && <Badge s="COMPLETED">final</Badge>}
            </div>
          ))}
        </div>
      )}
      {!final && (
        <section className="rv-attn" aria-label={t("rp.approveAria")}>
          <div className="rv-attn-head">
            <span className="rv-attn-icon">
              <Hand size={20} />
            </span>
            <div className="rp-attn-main">
              <h4>{t("rp.approveTitle")}</h4>
              <div className="rv-attn-sub">{t("rp.approveSub")}</div>
            </div>
          </div>
          <textarea
            className="rp-comment"
            rows={2}
            placeholder={t("rp.commentPh")}
            aria-label={t("rp.commentPh")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="rv-attn-actions">
            <button type="button" className="ok big" onClick={approve}>
              <ShieldCheck size={16} />{" "}
              {c.MISSING + c.PARTIAL
                ? t("rp.approveLeft", { n: c.MISSING + c.PARTIAL })
                : t("rp.approveBtn")}
            </button>
            <button type="button" className="ghost" onClick={regenerate}>
              <RotateCcw size={14} /> {t("rp.regenBtn")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function SpecPreview({ spec }: { spec: ReportSpec }) {
  const { t } = useI18n();
  return (
    <div className="rv-card">
      <div className="rv-card-head rp-card-head">
        <h4>
          <ClipboardList size={15} /> {t("rp.specTitle")}
        </h4>
      </div>
      {spec.sections.map((s) => (
        <div key={s.name} className="small rp-spec-sec">
          <b>{s.name}</b>
          <ul className="rp-spec-list">
            {s.requirements.map((r) => (
              <li key={r.id}>
                <span className="mono muted">{r.id}</span> {r.text}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {spec.reasoning && (
        <div className="muted small rp-spec-sec">
          {t("rp.context")}: {spec.reasoning}
        </div>
      )}
    </div>
  );
}
