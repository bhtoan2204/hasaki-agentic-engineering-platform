import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { AlertTriangle, CheckCircle2, ClipboardList, ExternalLink, FileText, Hand, Link2, Paperclip, RotateCcw, ShieldCheck, StickyNote, Trash2, Upload, XCircle } from "lucide-react";
import { act, Badge, Copy, Empty, Markdown, Tabs, time } from "../ui.tsx";
import "./RunView.css";

const ST: Record<string, [string, string]> = { VERIFIED: ["COMPLETED", "VERIFIED"], PARTIAL: ["WAITING", "PARTIAL"], MISSING: ["FAILED", "MISSING"] };
const ST_COLOR: Record<string, string> = { VERIFIED: "var(--st-ok)", PARTIAL: "var(--st-wait)", MISSING: "var(--st-err)" };

function readFile(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
}

/** Attach a file or a note as evidence, optionally to one requirement. */
function EvidenceAdder({ runId, requirementId, onDone }: { runId: number; requirementId?: string; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (body: any) => {
    setBusy(true);
    const r = await act(() => api(`/api/runs/${runId}/steps/task_result_report/evidence`, { requirement_id: requirementId ?? null, ...body }), "Đã thêm bằng chứng — bấm “Tạo lại báo cáo” để cập nhật");
    setBusy(false);
    if (r) (setNote(""), onDone());
  };
  return (
    <div className="row tight" style={{ marginTop: 8, gap: 6 }}>
      <label className="small" style={{ cursor: "pointer" }}>
        <input type="file" accept="image/*,.pdf,.txt,.csv,.json,.md" style={{ display: "none" }} disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) return act(async () => { throw new Error("File tối đa 10MB"); });
            send({ name: f.name, mime: f.type, data_base64: await readFile(f) });
            e.target.value = "";
          }} />
        <span className="rp-upload"><Upload size={12} /> Tải ảnh/file</span>
      </label>
      <input style={{ flex: 1, minWidth: 160 }} placeholder="hoặc ghi chú / xác nhận thủ công…" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="xs ghost" disabled={busy || !note.trim()} onClick={() => send({ note })}><StickyNote size={11} /> Thêm ghi chú</button>
    </div>
  );
}

/** Task Result Report: sections/requirements with evidence status, evidence upload, regenerate, edit, approve, copy. */
export function ReportPanel({ run, step, artifacts, attempts, onChanged }: { run: any; step: any; artifacts: any[]; attempts: any[]; onChanged: () => void }) {
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

  if (step.output?.skipped) return <Empty>Work item không có ai_suggest.report — bỏ qua báo cáo.</Empty>;
  if (!report)
    return (
      <div>
        <Empty>{step.status === "RUNNING" ? "Đang tạo báo cáo…" : step.status === "PENDING" ? "Báo cáo sẽ được tạo sau khi mọi bước của task hoàn tất (test, review, PR)." : `Chưa có báo cáo (${step.status}).`}</Empty>
        {step.config?.ai_suggest && <SpecPreview spec={step.config.ai_suggest} />}
      </div>
    );
  const regenerate = async () => (await act(() => api(`/api/runs/${run.id}/steps/${step.key}/reexecute`, { feedback: "regenerate the report with the latest evidence" }), "Đang tạo lại báo cáo")) && onChanged();
  const approve = async () => {
    const edited = md.trim() !== (waiting?.markdown ?? "").trim();
    const r = await act(() => api(`/api/runs/${run.id}/steps/${step.key}/approve`, { comment, data: edited ? { markdown: md } : undefined }), "Đã duyệt báo cáo");
    if (r) onChanged();
  };
  const c = report.counts;
  return (
    <div>
      <div className="rv-card" style={{ marginTop: 4 }}>
        <div className="rv-card-head" style={{ marginBottom: 4 }}>
          <h4><ClipboardList size={16} /> {report.task?.code} · {report.task?.title}</h4>
          {final ? <Badge s="COMPLETED">đã duyệt</Badge> : <Badge s="WAITING_APPROVAL">bản nháp chờ duyệt</Badge>}
        </div>
        <div className="muted small">
          {report.object && <>{report.object}: <b className="mono">{report.object_value}</b> · </>}suggest <span className="mono">{report.suggest_id}</span> · {report.generated_by} · {time(report.generated_at)}
        </div>
        <div className="rv-minis" style={{ marginTop: 10 }}>
          <div className="rv-mini tone-ok"><span><CheckCircle2 size={12} /> Verified</span><b>{c.VERIFIED}</b></div>
          <div className="rv-mini tone-wait"><span><AlertTriangle size={12} /> Partial</span><b>{c.PARTIAL}</b></div>
          <div className="rv-mini tone-err"><span><XCircle size={12} /> Missing</span><b>{c.MISSING}</b></div>
        </div>
      </div>
      <Tabs tabs={[["report", "Yêu cầu & bằng chứng"], ["markdown", "Markdown"], ["evidence", `Bằng chứng tải lên (${uploads.length})`], ["history", `Phiên bản (${versions.length})`]]} value={view} onChange={setView} />
      {view === "report" && (
        <div>
          <div className="rv-card"><div className="rv-card-head"><h4><FileText size={15} /> Tóm tắt</h4></div><Markdown text={report.summary} /></div>
          {report.sections.map((s: any) => (
            <div key={s.name}>
              <h3 style={{ textTransform: "none", letterSpacing: 0 }}>{s.name}</h3>
              {s.requirements.map((r: any) => (
                <div key={r.id} className="rp-req" style={{ ["--rp-c" as any]: ST_COLOR[r.status] ?? "var(--line-strong)" }}>
                  <div className="rp-req-head"><Badge s={ST[r.status]?.[0] ?? "PENDING"}>{ST[r.status]?.[1] ?? r.status}</Badge> <span className="mono muted small">{r.id}</span> <span className="grow">{r.text}</span></div>
                  {r.evidence.length > 0 ? (
                    <div style={{ marginTop: 6 }}>
                      {r.evidence.map((e: any) => (
                        <div key={e.id} className="rp-ev">
                          <Link2 size={12} /> <span className="mono muted">{e.id}</span> {e.title}{" "}
                          {e.ref?.url && <a href={e.ref.url} target="_blank" rel="noopener">mở</a>}
                          {e.ref?.artifact_id && <a href={`/api/artifacts/${e.ref.artifact_id}/raw`} target="_blank" rel="noopener">xem</a>}
                          {e.ref?.step_key && <> · <a href={`#/runs/${run.id}/${e.ref.step_key}`}>{e.ref.step_key}</a></>}
                        </div>
                      ))}
                    </div>
                  ) : <div className="small err" style={{ marginTop: 6, display: "flex", gap: 5, alignItems: "center" }}><XCircle size={12} /> Không có bằng chứng</div>}
                  {r.explanation && <div className="muted small" style={{ marginTop: 2 }}>{r.explanation}</div>}
                  {!final && r.status !== "VERIFIED" && <EvidenceAdder runId={run.id} requirementId={r.id} onDone={onChanged} />}
                </div>
              ))}
            </div>
          ))}
          {report.limitations?.length > 0 && (
            <div className="rv-card soft">
              <div className="rv-card-head" style={{ marginBottom: 2 }}><h4><AlertTriangle size={15} /> Thiếu bằng chứng / giới hạn</h4></div>
              <ul className="small" style={{ margin: "4px 0" }}>{report.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {view === "markdown" && (
        <div>
          <div className="row tight"><span className="muted small grow">{final ? "Bản cuối (đã duyệt)." : "Có thể sửa trước khi duyệt; bản sửa sẽ được lưu làm bản cuối."}</span><Copy text={md} label="Copy Markdown" /></div>
          {final ? <div className="rv-card"><Markdown text={md} /></div> : <textarea className="code" rows={22} value={md} onChange={(e) => setMd(e.target.value)} />}
        </div>
      )}
      {view === "evidence" && (
        <div>
          {!final && <><div className="small muted">Bằng chứng chung (không gắn với yêu cầu cụ thể):</div><EvidenceAdder runId={run.id} onDone={onChanged} /></>}
          {uploads.map((a) => (
            <div key={a.id} className="rp-file">
              {String(a.data?.mime ?? "").startsWith("image/") && <img src={`/api/artifacts/${a.id}/raw`} alt={a.name} />}
              {a.data?.note_only ? <StickyNote size={14} color="var(--muted)" /> : <Paperclip size={14} color="var(--brand)" />}
              <span className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{a.data?.note_only ? "ghi chú" : a.name} {a.data?.requirement_id && <span className="mono muted">→ {a.data.requirement_id}</span>} <span className="muted">{time(a.created_at)}</span></span>
              <a href={`/api/artifacts/${a.id}/raw`} target="_blank" rel="noopener" style={{ display: "inline-flex", gap: 3, alignItems: "center" }}><ExternalLink size={12} /> mở</a>
              {!final && <button className="xs ghost" onClick={async () => (await act(() => api(`/api/artifacts/${a.id}/delete-evidence`, {}))) && onChanged()}><Trash2 size={11} /> xoá</button>}
            </div>
          ))}
          {!uploads.length && <div className="muted small">Chưa có.</div>}
        </div>
      )}
      {view === "history" && (
        <div>
          {versions.map((a) => (
            <div key={a.id} className="rp-file"><FileText size={14} color="var(--muted)" /> <a href={`/api/artifacts/${a.id}/raw`} target="_blank" rel="noopener">{a.name}</a> <span className="muted">{time(a.created_at)} · attempt {attempts.find((t: any) => t.id === a.attempt_id)?.number ?? "?"}</span> {a.data?.final && <Badge s="COMPLETED">final</Badge>}</div>
          ))}
        </div>
      )}
      {!final && (
        <section className="rv-attn" aria-label="Duyệt báo cáo">
          <div className="rv-attn-head">
            <span className="rv-attn-icon"><Hand size={20} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4>Báo cáo đang chờ bạn duyệt</h4>
              <div className="rv-attn-sub">Bổ sung bằng chứng xong thì <b>tạo lại</b> để cập nhật trạng thái. Có thể duyệt ngay cả khi còn thiếu — các giới hạn sẽ được ghi rõ trong báo cáo cuối.</div>
            </div>
          </div>
          <textarea rows={2} placeholder="Nhận xét khi duyệt (tuỳ chọn)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 10, background: "var(--surface)" }} />
          <div className="rv-attn-actions">
            <button className="ok big" onClick={approve}><ShieldCheck size={16} /> Duyệt báo cáo{c.MISSING + c.PARTIAL ? ` (còn ${c.MISSING + c.PARTIAL} mục chưa xác minh)` : ""}</button>
            <button className="ghost" onClick={regenerate}><RotateCcw size={14} /> Tạo lại báo cáo</button>
          </div>
        </section>
      )}
    </div>
  );
}

function SpecPreview({ spec }: { spec: any }) {
  return (
    <div className="rv-card">
      <div className="rv-card-head" style={{ marginBottom: 2 }}><h4><ClipboardList size={15} /> Yêu cầu báo cáo từ Hasaki Work (ai_suggest)</h4></div>
      {spec.sections.map((s: any) => (
        <div key={s.name} className="small" style={{ marginTop: 4 }}>
          <b>{s.name}</b>
          {s.requirements.map((r: any) => <div key={r.id}>• <span className="mono muted">{r.id}</span> {r.text}</div>)}
        </div>
      ))}
      {spec.reasoning && <div className="muted small" style={{ marginTop: 4 }}>Bối cảnh: {spec.reasoning}</div>}
    </div>
  );
}
