import { useI18n } from "./i18n/index.tsx";
import { time } from "./ui.tsx";

interface HandoffPackage {
  scratch_omitted?: { count: number } | null;
  original_task?: string;
  repository_state?: Array<{
    repository: string;
    branch?: string;
    head?: string;
    status?: string;
    diff_summary?: string;
  }>;
  previous_decisions_and_pending_work?: string;
  context_references?: unknown;
  workspace_artifact_id?: number | null;
  progress?: string;
  commands_tests_and_verification?: string;
}

export interface Handoff {
  id: number;
  source_attempt_id: number;
  status: string;
  reason?: string | null;
  ready_at?: string | null;
  created_at?: string | null;
  workspace_fingerprint?: string | null;
  original_provider?: string | null;
  target_provider?: string | null;
  failure_category?: string | null;
  blocked_reason?: string | null;
  package?: HandoffPackage | null;
}

export function HandoffPreview({ handoff }: { handoff: Handoff }) {
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
          {pack.scratch_omitted && pack.scratch_omitted.count > 0 && (
            <p>{t("hop.scratchOmitted", { count: pack.scratch_omitted.count })}</p>
          )}
          <b>{t("hop.originalTask")}</b>
          <pre style={{ maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {pack.original_task}
          </pre>
          <b>{t("hop.preservedChanges")}</b>
          {pack.repository_state?.length ? (
            pack.repository_state.map((repo) => (
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
