import { useApi, useLive } from "../api.ts";
import { Badge, Empty, ErrorBox, Loading, navigate, time } from "../ui.tsx";
import { QuestionsForm } from "./StepInspector.tsx";

/** Every open question across runs, grouped by blocked step; answer inline or jump to the step in its run graph. */
export function QuestionsPage() {
  const { data: open, error, loading, reload } = useApi<any[]>("/api/questions");
  const { data: history, reload: reloadHistory } = useApi<any[]>("/api/questions/history");
  useLive(null, () => (reload(), reloadHistory()));
  if (loading && !open) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const groups: Record<string, any[]> = {};
  for (const q of open ?? []) (groups[`${q.run_id}:${q.step_key}`] ??= []).push(q);
  return (
    <div>
      <h2>Questions Inbox</h2>
      <div className="muted">Câu hỏi các bước đang chờ. Trả lời xong, bước tự tiếp tục từ checkpoint.</div>
      {!Object.keys(groups).length && <Empty>Không có câu hỏi nào đang chờ 🎉</Empty>}
      {Object.entries(groups).map(([k, qs]) => (
        <div key={k}>
          <div className="row" style={{ marginTop: 14 }}>
            <b>Run #{qs[0].run_id}</b> <span className="muted">{qs[0].run_title}</span> · bước <b>{qs[0].step_name}</b> <Badge s={qs[0].run_status} />
            {qs[0].work_item_code && <span className="mono muted small">{qs[0].work_item_code}</span>}
            <span className="grow" />
            <button className="xs ghost" onClick={() => navigate(`/runs/${qs[0].run_id}/${qs[0].step_key}`)}>Mở trong workflow →</button>
          </div>
          <QuestionsForm questions={qs} onDone={() => (reload(), reloadHistory())} />
        </div>
      ))}
      <h3>Lịch sử trả lời</h3>
      {!history?.length ? <Empty>Chưa có.</Empty> : (
        <table>
          <thead><tr><th>Run</th><th>Bước</th><th>Câu hỏi</th><th>Trả lời</th><th>Bước hiện tại</th><th>Lúc</th></tr></thead>
          <tbody>
            {history.map((q) => (
              <tr key={q.id} className="click" onClick={() => navigate(`/runs/${q.run_id}/${q.step_key}`)}>
                <td>#{q.run_id}</td><td>{q.step_name}</td><td>{q.question}</td><td>{q.answer}</td><td><Badge s={q.step_status} /></td><td className="muted small">{time(q.answered_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
