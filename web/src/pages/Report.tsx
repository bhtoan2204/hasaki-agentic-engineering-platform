import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { act, Badge, Copy, Empty, Markdown, Tabs, time } from "../ui.tsx";

const ST: Record<string, [string, string]> = { VERIFIED: ["COMPLETED", "VERIFIED"], PARTIAL: ["WAITING", "PARTIAL"], MISSING: ["FAILED", "MISSING"] };

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
    <div className="row tight" style={{ marginTop: 4, gap: 6 }}>
      <label className="small" style={{ cursor: "pointer" }}>
        <input type="file" accept="image/*,.pdf,.txt,.csv,.json,.md" style={{ display: "none" }} disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) return act(async () => { throw new Error("File tối đa 10MB"); });
            send({ name: f.name, mime: f.type, data_base64: await readFile(f) });
            e.target.value = "";
          }} />
        <span className="badge" style={{ color: "var(--accent)", cursor: "pointer" }}>📎 Tải ảnh/file</span>
      </label>
      <input style={{ flex: 1, minWidth: 160 }} placeholder="hoặc ghi chú / xác nhận thủ công…" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="xs ghost" disabled={busy || !note.trim()} onClick={() => send({ note })}>Thêm ghi chú</button>
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
      <div className="row tight">
        <b className="grow">{report.task?.code} · {report.task?.title}</b>
        {final ? <Badge s="COMPLETED">đã duyệt</Badge> : <Badge s="WAITING_APPROVAL">bản nháp chờ duyệt</Badge>}
      </div>
      <div className="muted small">
        {report.object && <>{report.object}: <b className="mono">{report.object_value}</b> · </>}suggest <span className="mono">{report.suggest_id}</span> · {report.generated_by} · {time(report.generated_at)}
      </div>
      <div className="row tight" style={{ margin: "8px 0", gap: 6 }}>
        <Badge s="COMPLETED">✅ {c.VERIFIED} verified</Badge> <Badge s="WAITING">🟡 {c.PARTIAL} partial</Badge> <Badge s="FAILED">❌ {c.MISSING} missing</Badge>
      </div>
      <Tabs tabs={[["report", "Yêu cầu & bằng chứng"], ["markdown", "Markdown"], ["evidence", `Bằng chứng tải lên (${uploads.length})`], ["history", `Phiên bản (${versions.length})`]]} value={view} onChange={setView} />
      {view === "report" && (
        <div>
          <div className="card" style={{ padding: 10 }}><b className="small">Tóm tắt</b><Markdown text={report.summary} /></div>
          {report.sections.map((s: any) => (
            <div key={s.name}>
              <h3 style={{ textTransform: "none", letterSpacing: 0 }}>{s.name}</h3>
              {s.requirements.map((r: any) => (
                <div key={r.id} className="q" style={{ borderLeftColor: r.status === "VERIFIED" ? "var(--ok)" : r.status === "PARTIAL" ? "var(--warn)" : "var(--err)" }}>
                  <div className="row tight"><Badge s={ST[r.status][0]}>{ST[r.status][1]}</Badge> <span className="mono muted small">{r.id}</span> <span className="grow">{r.text}</span></div>
                  {r.evidence.length > 0 ? (
                    <div className="small" style={{ marginTop: 4 }}>
                      {r.evidence.map((e: any) => (
                        <div key={e.id}>
                          • <span className="mono muted">{e.id}</span> {e.title}{" "}
                          {e.ref?.url && <a href={e.ref.url} target="_blank" rel="noopener">mở</a>}
                          {e.ref?.artifact_id && <a href={`/api/artifacts/${e.ref.artifact_id}/raw`} target="_blank" rel="noopener">xem</a>}
                          {e.ref?.step_key && <> · <a href={`#/runs/${run.id}/${e.ref.step_key}`}>{e.ref.step_key}</a></>}
                        </div>
                      ))}
                    </div>
                  ) : <div className="small err" style={{ marginTop: 4 }}>Không có bằng chứng</div>}
                  {r.explanation && <div className="muted small" style={{ marginTop: 2 }}>{r.explanation}</div>}
                  {!final && r.status !== "VERIFIED" && <EvidenceAdder runId={run.id} requirementId={r.id} onDone={onChanged} />}
                </div>
              ))}
            </div>
          ))}
          {report.limitations?.length > 0 && (
            <div className="card" style={{ padding: 10 }}>
              <b className="small">Thiếu bằng chứng / giới hạn</b>
              <ul className="small" style={{ margin: "4px 0" }}>{report.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {view === "markdown" && (
        <div>
          <div className="row tight"><span className="muted small grow">{final ? "Bản cuối (đã duyệt)." : "Có thể sửa trước khi duyệt; bản sửa sẽ được lưu làm bản cuối."}</span><Copy text={md} label="Copy Markdown" /></div>
          {final ? <div className="card"><Markdown text={md} /></div> : <textarea className="code" rows={22} value={md} onChange={(e) => setMd(e.target.value)} />}
        </div>
      )}
      {view === "evidence" && (
        <div>
          {!final && <><div className="small muted">Bằng chứng chung (không gắn với yêu cầu cụ thể):</div><EvidenceAdder runId={run.id} onDone={onChanged} /></>}
          {uploads.map((a) => (
            <div key={a.id} className="row tight small" style={{ margin: "6px 0" }}>
              {String(a.data?.mime ?? "").startsWith("image/") && <img src={`/api/artifacts/${a.id}/raw`} alt={a.name} style={{ maxHeight: 70, maxWidth: 120, borderRadius: 4, border: "1px solid var(--line)" }} />}
              <span className="grow">{a.data?.note_only ? "📝 ghi chú" : `📎 ${a.name}`} {a.data?.requirement_id && <span className="mono muted">→ {a.data.requirement_id}</span>} <span className="muted">{time(a.created_at)}</span></span>
              <a href={`/api/artifacts/${a.id}/raw`} target="_blank" rel="noopener">mở</a>
              {!final && <button className="xs ghost" onClick={async () => (await act(() => api(`/api/artifacts/${a.id}/delete-evidence`, {}))) && onChanged()}>xoá</button>}
            </div>
          ))}
          {!uploads.length && <div className="muted small">Chưa có.</div>}
        </div>
      )}
      {view === "history" && (
        <div>
          {versions.map((a) => (
            <div key={a.id} className="small">• <a href={`/api/artifacts/${a.id}/raw`} target="_blank" rel="noopener">{a.name}</a> <span className="muted">{time(a.created_at)} · attempt {attempts.find((t: any) => t.id === a.attempt_id)?.number ?? "?"}</span> {a.data?.final && <Badge s="COMPLETED">final</Badge>}</div>
          ))}
        </div>
      )}
      {!final && (
        <div className="card" style={{ borderColor: "var(--warn)", marginTop: 10 }}>
          <div className="small">Bổ sung bằng chứng xong thì <b>tạo lại</b> để cập nhật trạng thái. Có thể duyệt ngay cả khi còn thiếu — các giới hạn sẽ được ghi rõ trong báo cáo cuối.</div>
          <textarea rows={2} placeholder="Nhận xét khi duyệt (tuỳ chọn)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 6 }} />
          <div className="row">
            <button className="ghost" onClick={regenerate}>↻ Tạo lại báo cáo</button>
            <button className="ok" onClick={approve}>✓ Duyệt báo cáo{c.MISSING + c.PARTIAL ? ` (còn ${c.MISSING + c.PARTIAL} mục chưa xác minh)` : ""}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SpecPreview({ spec }: { spec: any }) {
  return (
    <div className="card" style={{ padding: 10 }}>
      <b className="small">Yêu cầu báo cáo từ Hasaki Work (ai_suggest)</b>
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
