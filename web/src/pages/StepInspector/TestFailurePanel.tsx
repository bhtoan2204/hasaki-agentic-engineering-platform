import {
  AlertTriangle,
  ChevronRight,
  FlaskConical,
  MessageCircleQuestion,
  MessagesSquare,
} from "lucide-react";
import { explainedByAi } from "../../agentMetrics.ts";
import { Badge } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type AttemptRow, CAT_STATUS, type QuestionRow, type StepRow } from "./shared.tsx";

/** Test failure diagnosis (real output + baseline), AI explanation, and the exchange/decision history of this step. */
export function TestFailurePanel({
  attempts,
  questions,
  current,
  step,
}: {
  attempts: AttemptRow[];
  questions: QuestionRow[];
  current: AttemptRow;
  step: StepRow;
}) {
  const { t } = useI18n();
  const payload = (a?: AttemptRow) => a?.output ?? a?.error?.details;
  const withDiag = [...attempts].reverse().find((a) => payload(a)?.diagnosis);
  const d = payload(current)?.diagnosis ?? payload(withDiag)?.diagnosis;
  const decisions = attempts
    .filter((a) => payload(a)?.decision)
    .map((a) => ({ n: a.number, ...payload(a)?.decision }));
  const exception = step.output?.accepted_exception;
  if (!d && !decisions.length) return null;
  const groups = (["new", "pre_existing", "environment", "insufficient"] as const).filter((k) =>
    d?.failures.some((f) => f.category === k),
  );
  return (
    <div
      className={step.status === "WAITING_INPUT" ? "rv-attn" : "rv-card"}
      style={step.status === "WAITING_INPUT" ? { boxShadow: "none" } : undefined}
    >
      <div className="rv-card-head">
        <h4>
          <FlaskConical size={16} /> {t("si.diagnosis")}
        </h4>
        {step.output?.test_status === "FAILED" && <Badge s="FAILED">{t("si.testFailed")}</Badge>}
      </div>
      {d && (
        <>
          <div style={{ margin: "4px 0", fontWeight: 600 }}>{d.summary}</div>
          <div
            className="mono small"
            style={{
              wordBreak: "break-all",
              background: "var(--code)",
              padding: "6px 9px",
              borderRadius: "var(--r-sm)",
              margin: "6px 0",
            }}
          >
            {d.command.split("\n").find((l: string) => l.includes("go test")) ??
              d.command.split("\n")[0]}
          </div>
          <div className="muted small">
            {d.results
              .map(
                (r) =>
                  `${r.repo}: ${t("si.exit", { code: r.timed_out ? t("si.timeout") : r.exit_code })}`,
              )
              .join(" · ")}{" "}
            · baseline{" "}
            {d.baseline_available ? (
              <span className="mono">{String(d.base_sha).slice(0, 9)}</span>
            ) : (
              t("si.noBaseline")
            )}
          </div>
          {d.explanation && (
            <div style={{ paddingTop: "10px", borderTop: "1px solid var(--line)" }}>
              <div className="small">
                <b>{explainedByAi(d.explanation.by) ? t("si.ai") : t("si.brief")}:</b>{" "}
                {d.explanation.text}
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                <b>{t("si.proposal")}:</b> {d.explanation.suggestion}
              </div>
            </div>
          )}
          {groups.map((g) => (
            <div key={g} style={{ marginTop: 8 }}>
              <Badge s={CAT_STATUS[g]}>
                {t(`si.cat.${g}`)} · {d.failures.filter((f) => f.category === g).length}
              </Badge>
              {d.failures
                .filter((f) => f.category === g)
                .map((f, i) => (
                  <details key={i} style={{ marginLeft: 8 }}>
                    <summary style={{ color: "var(--ink)" }}>
                      <span className="mono small">
                        {f.repo} {f.package?.split("/").slice(-2).join("/")}{" "}
                        {f.test ?? f.build_error ?? ""}
                      </span>{" "}
                      <span className="muted small">
                        — {f.reason}
                        {f.env_signal && g !== "environment" ? ` ${t("si.envHint")}` : ""}
                      </span>
                    </summary>
                    <pre>{f.log}</pre>
                  </details>
                ))}
            </div>
          ))}
        </>
      )}
      {exception && (
        <div className="rv-note" style={{ color: "var(--st-wait)" }}>
          <AlertTriangle size={14} />
          {t("si.acceptedBaseline", { n: exception.failures.length })}
        </div>
      )}
      {(questions.length > 0 || decisions.length > 0) && (
        <div style={{ marginTop: 10 }}>
          <b className="small">{t("si.exchange")}</b>
          {attempts.map((a) => {
            const qs = questions.filter((q) => q.attempt_id === a.id);
            const dec = payload(a)?.decision;
            if (!qs.length && !dec) return null;
            return (
              <div
                key={a.id}
                className="small"
                style={{
                  margin: "6px 0",
                  paddingLeft: 10,
                  borderLeft: "2px solid var(--line-strong)",
                }}
              >
                <span className="muted">
                  attempt #{a.number} · {a.status}
                </span>
                {dec && (
                  <div>
                    <ChevronRight size={12} style={{ verticalAlign: -2 }} />{" "}
                    {t("si.decision", {
                      kind:
                        t(`si.dec.${dec.kind}`) === `si.dec.${dec.kind}`
                          ? dec.kind
                          : t(`si.dec.${dec.kind}`),
                    })}
                    {dec.target ? ` (${dec.target})` : ""}
                    {dec.instructions ? ` — “${dec.instructions}”` : ""}
                  </div>
                )}
                {qs.map((q) => (
                  <div key={q.id}>
                    <MessageCircleQuestion
                      size={12}
                      style={{ verticalAlign: -2, color: "var(--st-wait)" }}
                    />{" "}
                    {q.question}
                    {q.answer ? (
                      <>
                        {" "}
                        <br />
                        <MessagesSquare
                          size={12}
                          style={{ verticalAlign: -2, color: "var(--st-ok)" }}
                        />{" "}
                        <b>{q.answer}</b>
                      </>
                    ) : q.status === "open" ? (
                      <span className="muted"> ({t("si.waiting")})</span>
                    ) : (
                      <span className="muted"> ({q.status})</span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
