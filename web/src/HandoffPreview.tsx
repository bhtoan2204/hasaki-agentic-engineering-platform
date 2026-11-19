import { useI18n } from "./i18n/index.tsx";
import { time } from "./ui.tsx";

export function HandoffPreview({ handoff }: { handoff: any }) {
  const { t } = useI18n();
  const pack = handoff.package;
  return (
    <details>
      <summary>{t("hop.reviewTitle")}</summary>
      {!pack ? (
        <p className="muted">{t("hop.noCheckpoint")}</p>
      ) : (
        <>
          <p>
            <b>{t("hop.reason")}:</b> {handoff.reason}
          </p>
          <p className="small muted">
            {t("hop.preservedAt")}: {time(handoff.ready_at)}
          </p>
          {pack.scratch_omitted?.count > 0 && (
            <p>{t("hop.scratchOmitted", { count: pack.scratch_omitted.count })}</p>
          )}
          <b>{t("hop.originalTask")}</b>
          <pre style={{ maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {pack.original_task}
          </pre>
          <b>{t("hop.preservedChanges")}</b>
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
                  {repo.diff_summary || repo.status || t("hop.noTrackedChanges")}
                </pre>
              </div>
            ))
          ) : (
            <p className="muted small">{t("hop.noWorktree")}</p>
          )}
          <b>{t("hop.decisionsAndPending")}</b>
          <pre style={{ maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {pack.previous_decisions_and_pending_work}
          </pre>
          <p className="muted small">{t("hop.progressHistorical")}</p>
          <details>
            <summary>{t("hop.detailedReferences")}</summary>
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
