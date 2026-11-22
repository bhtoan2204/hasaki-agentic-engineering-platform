import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  Workflow,
} from "lucide-react";
import { useApi } from "../api.ts";
import { Markdown } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

interface Delegated {
  id: number;
  run_id: number | null;
  work_item_id: number | null;
  work_item_code: string | null;
  run_status: string | null;
  definition_key: string | null;
  progress: {
    done: number;
    total: number;
    current: Array<{ key: string; name: string; status: string }>;
    failed: Array<{ key: string; name: string }>;
  };
  result: {
    summary: string | null;
    status: string | null;
    markdown: string | null;
    verification: string | null;
    root_cause: { status: string; explanation: string } | null;
  } | null;
}

const ACTIVE = new Set(["PENDING", "RUNNING", "WAITING", "PAUSED"]);
const POLL_MS = 5000;
const INVESTIGATIONS = new Set(["production-incident-investigation", "incident-investigation"]);

/**
 * Workflow runs started from this conversation (investigations and tasks), followed in the chat: status, the step
 * running now, and — for investigations — the platform's verified conclusion with the full report on demand. Polls only
 * while a run is active and the tab is visible; the chat says so.
 */
export function ChatDelegations({
  conversationId,
  version,
}: {
  conversationId: number;
  version: number;
}) {
  const { t } = useI18n();
  const { data, reload } = useApi<{ delegations: Delegated[] }>(
    `/api/chat/conversations/${conversationId}/delegations`,
  );
  const [open, setOpen] = useState<number | null>(null);
  const items = data?.delegations ?? [];
  const active = items.some((d) => d.run_status && ACTIVE.has(d.run_status));
  useEffect(() => {
    if (version) void reload();
  }, [version, reload]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => document.visibilityState === "visible" && void reload(),
      POLL_MS,
    );
    return () => clearInterval(timer);
  }, [active, reload]);
  if (!items.length) return null;
  return (
    <section className="chat-runs" aria-label={t("chat.runs.title")}>
      <header>
        <Workflow size={14} aria-hidden="true" /> {t("chat.runs.title")}
        {active && (
          <span className="muted small">{t("chat.runs.polling", { s: POLL_MS / 1000 })}</span>
        )}
      </header>
      <ul>
        {items.map((d) => {
          const investigation = INVESTIGATIONS.has(d.definition_key ?? "");
          const running = !!d.run_status && ACTIVE.has(d.run_status);
          const r = d.result;
          return (
            <li key={d.id} data-status={d.run_status ?? "none"}>
              <div className="chat-run-head">
                {investigation ? (
                  <FileSearch size={14} aria-hidden="true" />
                ) : (
                  <Workflow size={14} aria-hidden="true" />
                )}
                <b>{investigation ? t("chat.runs.investigation") : t("chat.runs.task")}</b>
                {d.work_item_code && <span className="muted small">{d.work_item_code}</span>}
                <span
                  className={`pill chat-run-status is-${(d.run_status ?? "none").toLowerCase()}`}
                >
                  {running && <LoaderCircle size={11} className="spin" aria-hidden="true" />}
                  {d.run_status ?? t("chat.runs.notStarted")}
                </span>
                {d.run_id && (
                  <a href={investigation ? `#/investigations/${d.run_id}` : `#/runs/${d.run_id}`}>
                    {t("chat.runs.open", { id: d.run_id })} <ExternalLink size={11} />
                  </a>
                )}
              </div>
              {running && (
                <p className="small muted">
                  {t("chat.runs.progress", { done: d.progress.done, total: d.progress.total })}
                  {d.progress.current.length > 0 &&
                    ` · ${t("chat.runs.now", { steps: d.progress.current.map((s) => s.name).join(", ") })}`}
                </p>
              )}
              {d.progress.failed.length > 0 && (
                <p className="small chat-run-failed">
                  {t("chat.runs.failed", {
                    steps: d.progress.failed.map((s) => s.name).join(", "),
                  })}
                </p>
              )}
              {r && (
                <div className="chat-run-result">
                  <div className="chat-run-verdicts">
                    {r.verification && (
                      <span className="pill">
                        {t("chat.runs.verification", { status: r.verification })}
                      </span>
                    )}
                    {r.root_cause && (
                      <span className="pill">
                        {t("chat.runs.rootCause", { status: r.root_cause.status })}
                      </span>
                    )}
                    {r.status && <span className="pill">{r.status}</span>}
                  </div>
                  {(r.summary || r.root_cause?.explanation) && (
                    <p>{r.summary || r.root_cause?.explanation}</p>
                  )}
                  {r.markdown && (
                    <>
                      <button
                        type="button"
                        className="ghost xs"
                        aria-expanded={open === d.id}
                        onClick={() => setOpen(open === d.id ? null : d.id)}
                      >
                        {open === d.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {t("chat.runs.report")}
                      </button>
                      {open === d.id && (
                        <div className="chat-run-report">
                          <Markdown text={r.markdown} />
                        </div>
                      )}
                    </>
                  )}
                  <p className="muted small">{t("chat.runs.platformVerdict")}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
