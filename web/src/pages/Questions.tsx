import { useState } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  CircleHelp,
  History,
  Inbox,
  Layers,
  MessageCircleQuestion,
  Send,
  Star,
} from "lucide-react";
import { api, isStateChange, useApi, useLive } from "../api.ts";
import {
  act,
  Badge,
  Copy,
  EmptyState,
  ErrorBox,
  Loading,
  navigate,
  PageHeader,
  StatCard,
  time,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Questions.css";

/** One blocked step: its open questions, option picks / free-text answers, and a single submit that resumes the step. */
function StepQuestionsCard({ qs, onDone }: { qs: any[]; onDone: () => void }) {
  const { t } = useI18n();
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
        <div className="qx-icon">
          <MessageCircleQuestion size={20} strokeWidth={1.9} />
        </div>
        <div className="qx-ctx">
          <div className="qx-run">
            <span className="qx-runid">Run #{head.run_id}</span>
            {head.work_item_code && (
              <span className="mono muted">{head.work_item_code}</span>
            )}
            <Badge s={head.run_status} label />
          </div>
          <div className="qx-title">{head.run_title}</div>
          <div className="qx-step">
            <Layers size={13} strokeWidth={2} /> {t("qx.step")}{" "}
            <b>{head.step_name}</b>{" "}
            <span className="mono muted">{head.step_key}</span>
          </div>
        </div>
        <button
          className="ghost sm"
          onClick={() => navigate(`/runs/${head.run_id}/${head.step_key}`)}
        >
          {t("qx.openInWf")} <ArrowUpRight size={14} strokeWidth={2} />
        </button>
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
              <div
                className="qx-options"
                role="group"
                aria-label={t("qx.choices")}
              >
                {q.options.map((o: string, i: number) => (
                  <button
                    key={o}
                    type="button"
                    className={`qx-opt${answers[q.id] === o ? " on" : ""}`}
                    aria-pressed={answers[q.id] === o}
                    onClick={() => setAnswers({ ...answers, [q.id]: o })}
                  >
                    {i === 0 && (
                      <Star
                        size={13}
                        strokeWidth={2}
                        aria-label={t("qx.suggested")}
                      />
                    )}
                    {o}
                  </button>
                ))}
              </div>
            )}
            <textarea
              rows={2}
              aria-label={t("qx.answerN", { n: n + 1 })}
              placeholder={
                q.suggested_answer
                  ? t("qx.hintPh", { text: q.suggested_answer })
                  : t("qx.answerPh")
              }
              value={answers[q.id] ?? ""}
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
            />
          </div>
        ))}
      </div>

      <footer className="qx-foot">
        <div className="qx-consequence">
          <CircleHelp size={15} strokeWidth={2} />
          <span>{t("qx.consequence", { step: head.step_name })}</span>
        </div>
        <span className="muted small">
          {t("qx.answered", { done: answered, total: qs.length })}
        </span>
        <button disabled={busy || !ready} onClick={submit}>
          <Send size={15} strokeWidth={2} />
          {busy ? t("qx.sending") : t("qx.send")}
        </button>
      </footer>
    </section>
  );
}

/** Every open question across runs, grouped by blocked step; answer inline or jump to the step in its run graph. */
export function QuestionsPage() {
  const { t } = useI18n();
  const {
    data: open,
    error,
    loading,
    reload,
  } = useApi<any[]>("/api/questions");
  const { data: history, reload: reloadHistory } = useApi<any[]>(
    "/api/questions/history",
  );
  // Questions open and close with step status changes and user actions, never with transcript lines.
  useLive(null, (p) => isStateChange(p) && (reload(), reloadHistory()));
  if (loading && !open) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const groups: Record<string, any[]> = {};
  for (const q of open ?? [])
    (groups[`${q.run_id}:${q.step_key}`] ??= []).push(q);
  const entries = Object.entries(groups);
  const runs = new Set((open ?? []).map((q) => q.run_id)).size;
  return (
    <div className="qx-page">
      <PageHeader
        icon={Inbox}
        title={t("qx.title")}
        subtitle={t("qx.subtitle")}
        crumbs={[[t("nav.overview"), "#/overview"], [t("qx.title")]]}
      />

      <div className="grid3 qx-stats">
        <StatCard
          icon={MessageCircleQuestion}
          tone="wait"
          label={t("qx.waiting")}
          value={open?.length ?? 0}
          hint={t("qx.blockedRuns", { n: runs })}
        />
        <StatCard
          icon={Layers}
          tone="run"
          label={t("qx.waitingSteps")}
          value={entries.length}
        />
        <StatCard
          icon={CircleCheck}
          tone="ok"
          label={t("qx.answeredStat")}
          value={history ? history.length : "—"}
          hint={
            history && history.length >= 100 ? t("qx.latest100") : undefined
          }
        />
      </div>

      {!entries.length ? (
        <div className="qx-empty">
          <EmptyState icon={CircleCheck} title={t("qx.emptyTitle")}>
            {t("qx.emptyBody")}
          </EmptyState>
        </div>
      ) : (
        <div className="qx-list">
          {entries.map(([k, qs]) => (
            <StepQuestionsCard
              key={k}
              qs={qs}
              onDone={() => (reload(), reloadHistory())}
            />
          ))}
        </div>
      )}

      <h3 className="qx-section">
        <History size={14} strokeWidth={2} /> {t("qx.history")}
      </h3>
      {!history?.length ? (
        <div className="card flat muted small">{t("qx.noneYet")}</div>
      ) : (
        <div className="table-wrap">
          <table className="qx-history">
            <thead>
              <tr>
                <th>Run</th>
                <th>{t("qx.step")}</th>
                <th>{t("qx.col.question")}</th>
                <th>{t("qx.col.answer")}</th>
                <th>{t("qx.col.stepNow")}</th>
                <th>{t("qx.col.when")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((q) => (
                <tr
                  key={q.id}
                  className="click"
                  tabIndex={0}
                  onClick={() => navigate(`/runs/${q.run_id}/${q.step_key}`)}
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    navigate(`/runs/${q.run_id}/${q.step_key}`)
                  }
                >
                  <td className="mono">#{q.run_id}</td>
                  <td>{q.step_name}</td>
                  <td className="qx-clip">{q.question}</td>
                  <td className="qx-clip">{q.answer}</td>
                  <td>
                    <Badge s={q.step_status} label />
                  </td>
                  <td className="muted small" style={{ whiteSpace: "nowrap" }}>
                    {time(q.answered_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
