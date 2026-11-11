import { useI18n } from "./i18n/index.tsx";
import { time } from "./ui.tsx";

export function HandoffPreview({ handoff }: { handoff: any }) {
  const { locale } = useI18n();
  const en = locale === "en";
  const pack = handoff.package;
  return (
    <details>
      <summary>
        {en ? "Review handoff package and checkpoint" : "Xem gói bàn giao và checkpoint"}
      </summary>
      {!pack ? (
        <p className="muted">
          {en ? "A stable checkpoint is not available yet." : "Chưa có checkpoint ổn định."}
        </p>
      ) : (
        <>
          <p>
            <b>{en ? "Reason" : "Lý do"}:</b> {handoff.reason}
          </p>
          <p className="small muted">
            {en ? "Preserved at" : "Được giữ lại lúc"}: {time(handoff.ready_at)}
          </p>
          <b>{en ? "Original task" : "Nhiệm vụ ban đầu"}</b>
          <pre style={{ maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {pack.original_task}
          </pre>
          <b>{en ? "Preserved repository changes" : "Thay đổi repository được giữ lại"}</b>
          {pack.repository_state?.length ? (
            pack.repository_state.map((repo: any) => (
              <div key={repo.repository} className="small">
                <p>
                  <b>{repo.repository}</b> · {repo.branch} · {repo.head?.slice(0, 12)}
                </p>
                <pre
                  style={{
                    maxHeight: 120,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {repo.diff_summary ||
                    repo.status ||
                    (en ? "No tracked changes" : "Không có thay đổi được theo dõi")}
                </pre>
              </div>
            ))
          ) : (
            <p className="muted small">
              {en
                ? "No worktree had been registered. Context and task references are preserved."
                : "Chưa có worktree được ghi nhận. Ngữ cảnh và tham chiếu nhiệm vụ được giữ lại."}
            </p>
          )}
          <b>{en ? "Decisions and unfinished work" : "Quyết định và công việc chưa hoàn tất"}</b>
          <pre style={{ maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {pack.previous_decisions_and_pending_work}
          </pre>
          <p className="muted small">
            {en
              ? "Progress is historical evidence. Agent completion does not establish verification; the next attempt must check the remaining acceptance criteria."
              : "Tiến độ là bằng chứng lịch sử. Agent báo hoàn tất không đồng nghĩa đã xác minh; lần thử tiếp theo phải kiểm tra tiêu chí chấp nhận còn lại."}
          </p>
          <details>
            <summary>
              {en ? "Detailed checkpoint references" : "Tham chiếu checkpoint chi tiết"}
            </summary>
            <pre
              style={{
                maxHeight: 280,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {JSON.stringify(
                {
                  id: handoff.id,
                  source_attempt_id: handoff.source_attempt_id,
                  workspace_fingerprint: handoff.workspace_fingerprint,
                  context_references: pack.context_references,
                  workspace_artifact_id: pack.workspace_artifact_id,
                  progress: pack.progress,
                  commands_tests_and_verification: pack.commands_tests_and_verification,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </details>
  );
}
