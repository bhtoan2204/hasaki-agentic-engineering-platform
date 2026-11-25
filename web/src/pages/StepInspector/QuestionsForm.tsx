import { useState } from "react";
import { agentKey, type AgentProvider } from "../../agentProvider.tsx";
import { Check, Info, MessageCircleQuestion, Send, Sparkles } from "lucide-react";
import { api } from "../../api.ts";
import { act, Copy } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type QuestionRow } from "./shared.tsx";

export function QuestionsForm({
  questions,
  onDone,
  provider = "claude",
}: {
  questions: QuestionRow[];
  onDone: () => void | Promise<unknown>;
  provider?: AgentProvider;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  if (!questions.length) return null;
  const submit = async () => {
    setBusy(true);
    const r = await act(async () => {
      const result = await api("/api/questions/answers", { answers });
      if (result) await onDone();
      return result;
    });
    setBusy(false);
    if (r) setAnswers({});
  };
  return (
    <section className="rv-attn" aria-label={t("si.questionsWaiting")}>
      <div className="rv-attn-head">
        <span className="rv-attn-icon">
          <MessageCircleQuestion size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>
            {t("si.waitingAnswers", {
              n: questions.length,
              name: t(agentKey(provider, true)),
            })}
          </h4>
          <div className="rv-attn-sub">{t("si.pausedUntil")}</div>
        </div>
      </div>
      {questions.map((q) => (
        <div key={q.id} className="q">
          <div className="row tight" style={{ alignItems: "flex-start" }}>
            <b className="grow">{q.question}</b>
            <Copy text={q.question} />
          </div>
          {q.context && (
            <div className="muted small" style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>
              {q.context}
            </div>
          )}
          {!!q.options?.length && (
            <div className="rv-option-row">
              {q.options.map((o: string, i: number) => (
                <button
                  type="button"
                  key={o}
                  className={answers[q.id] === o ? "sm" : "ghost sm"}
                  aria-pressed={answers[q.id] === o}
                  onClick={() => setAnswers({ ...answers, [q.id]: o })}
                  title={i === 0 ? t("si.suggested") : undefined}
                >
                  {answers[q.id] === o ? (
                    <Check size={13} />
                  ) : i === 0 ? (
                    <Sparkles size={13} />
                  ) : null}
                  {o}
                </button>
              ))}
            </div>
          )}
          <textarea
            rows={2}
            placeholder={
              q.suggested_answer
                ? t("si.suggestion", { text: q.suggested_answer })
                : t("si.answerPh")
            }
            value={answers[q.id] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
          />
        </div>
      ))}
      <div className="rv-attn-actions">
        <button
          type="button"
          className="big"
          disabled={busy || !Object.values(answers).some((a) => a.trim())}
          onClick={submit}
        >
          <Send size={15} />
          {busy ? t("si.sending") : t("si.sendContinue")}
        </button>
      </div>
      <div className="rv-note" style={{ marginBottom: 0 }}>
        <Info size={13} />
        {t("si.savedNote")}
      </div>
    </section>
  );
}
