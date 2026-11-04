import { useState } from "react";
import { ArrowUpRight, CircleCheck, CircleHelp, History, Inbox, Layers, MessageCircleQuestion, Send, Star } from "lucide-react";
import { api, useApi, useLive } from "../api.ts";
import { act, Badge, Copy, EmptyState, ErrorBox, Loading, navigate, PageHeader, StatCard, time } from "../ui.tsx";
import "./Questions.css";

/** One blocked step: its open questions, option picks / free-text answers, and a single submit that resumes the step. */
function StepQuestionsCard({ qs, onDone }: { qs: any[]; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const head = qs[0];
  const ready = Object.values(answers).some((a) => a.trim());
  const answered = qs.filter((q) => answers[q.id]?.trim()).length;
  const submit = async () => {
    setBusy(true);
    const r = await act(() => api("/api/questions/answers", { answers }));
    setBusy(false);
    if (r) {
      setAnswers({});
      onDone();
    }
  };
  return (
    <section className="qx-card">
      <header className="qx-head">
        <div className="qx-icon"><MessageCircleQuestion size={20} strokeWidth={1.9} /></div>
        <div className="qx-ctx">
          <div className="qx-run">
            <span className="qx-runid">Run #{head.run_id}</span>
            {head.work_item_code && <span className="mono muted">{head.work_item_code}</span>}
            <Badge s={head.run_status} label />
          </div>
          <div className="qx-title">{head.run_title}</div>
          <div className="qx-step"><Layers size={13} strokeWidth={2} /> Bước <b>{head.step_name}</b> <span className="mono muted">{head.step_key}</span></div>
        </div>
        <button className="ghost sm" onClick={() => navigate(`/runs/${head.run_id}/${head.step_key}`)}>Mở trong workflow <ArrowUpRight size={14} strokeWidth={2} /></button>
      </header>

      <div className="qx-body">
        {qs.map((q, n) => (
          <div key={q.id} className="qx-q">
            <div className="qx-q-top">
              <span className="qx-num">{n + 1}</span>
              <div className="qx-q-text">{q.question}</div>
              <Copy text={q.question} />
            </div>
            {q.context && <div className="qx-q-context">{q.context}</div>}
            {!!q.options?.length && (
              <div className="qx-options" role="group" aria-label="Lựa chọn">
                {q.options.map((o: string, i: number) => (
                  <button key={o} type="button" className={`qx-opt${answers[q.id] === o ? " on" : ""}`} aria-pressed={answers[q.id] === o} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                    {i === 0 && <Star size={13} strokeWidth={2} aria-label="Đề xuất" />}
                    {o}
                  </button>
                ))}
              </div>
            )}
            <textarea rows={2} aria-label={`Trả lời câu ${n + 1}`} placeholder={q.suggested_answer ? `Gợi ý: ${q.suggested_answer}` : "Câu trả lời…"} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
          </div>
        ))}
      </div>

      <footer className="qx-foot">
        <div className="qx-consequence">
          <CircleHelp size={15} strokeWidth={2} />
          <span>Gửi xong, câu trả lời được lưu vào PostgreSQL và bước <b>{head.step_name}</b> tiếp tục từ checkpoint khi mọi câu đã được trả lời.</span>
        </div>
        <span className="muted small">{answered}/{qs.length} đã trả lời</span>
        <button disabled={busy || !ready} onClick={submit}><Send size={15} strokeWidth={2} />{busy ? "Đang gửi…" : "Gửi trả lời & tiếp tục bước"}</button>
      </footer>
    </section>
  );
}

/** Every open question across runs, grouped by blocked step; answer inline or jump to the step in its run graph. */
export function QuestionsPage() {
  const { data: open, error, loading, reload } = useApi<any[]>("/api/questions");
  const { data: history, reload: reloadHistory } = useApi<any[]>("/api/questions/history");
  useLive(null, () => (reload(), reloadHistory()));
  if (loading && !open) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const groups: Record<string, any[]> = {};
  for (const q of open ?? []) (groups[`${q.run_id}:${q.step_key}`] ??= []).push(q);
  const entries = Object.entries(groups);
  const runs = new Set((open ?? []).map((q) => q.run_id)).size;
  return (
    <div className="qx-page">
      <PageHeader
        icon={Inbox}
        title="Questions & Approvals"
        subtitle="Câu hỏi các bước đang chờ bạn. Trả lời xong, bước tự tiếp tục từ checkpoint. Phê duyệt (approval) thực hiện trong bước của run."
        crumbs={[["Overview", "#/overview"], ["Questions"]]}
      />

      <div className="grid3 qx-stats">
        <StatCard icon={MessageCircleQuestion} tone="wait" label="Câu hỏi đang chờ" value={open?.length ?? 0} hint={`${runs} run bị chặn`} />
        <StatCard icon={Layers} tone="run" label="Bước đang chờ" value={entries.length} />
        <StatCard icon={CircleCheck} tone="ok" label="Đã trả lời" value={history ? history.length : "—"} hint={history && history.length >= 100 ? "100 gần nhất" : undefined} />
      </div>

      {!entries.length ? (
        <div className="qx-empty">
          <EmptyState icon={CircleCheck} title="Không có câu hỏi nào đang chờ">Mọi bước đều đang chạy trơn tru. Câu hỏi mới từ agent sẽ xuất hiện ở đây.</EmptyState>
        </div>
      ) : (
        <div className="qx-list">
          {entries.map(([k, qs]) => <StepQuestionsCard key={k} qs={qs} onDone={() => (reload(), reloadHistory())} />)}
        </div>
      )}

      <h3 className="qx-section"><History size={14} strokeWidth={2} /> Lịch sử trả lời</h3>
      {!history?.length ? <div className="card flat muted small">Chưa có.</div> : (
        <div className="table-wrap">
          <table className="qx-history">
            <thead><tr><th>Run</th><th>Bước</th><th>Câu hỏi</th><th>Trả lời</th><th>Bước hiện tại</th><th>Lúc</th></tr></thead>
            <tbody>
              {history.map((q) => (
                <tr key={q.id} className="click" tabIndex={0} onClick={() => navigate(`/runs/${q.run_id}/${q.step_key}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/runs/${q.run_id}/${q.step_key}`)}>
                  <td className="mono">#{q.run_id}</td><td>{q.step_name}</td><td className="qx-clip">{q.question}</td><td className="qx-clip">{q.answer}</td><td><Badge s={q.step_status} label /></td><td className="muted small" style={{ whiteSpace: "nowrap" }}>{time(q.answered_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
