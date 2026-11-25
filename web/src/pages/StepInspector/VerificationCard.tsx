import {
  Check,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  ShieldAlert,
  Timer,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { Badge, dur } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { TONE_STATUS, VF_TONE, type Verification, arr, num } from "./shared.tsx";

/** Harness verification-and-repair result (attempt metrics / output `verification`). Renders only the fields present. */
export function VerificationCard({ v }: { v: Verification }) {
  const { t } = useI18n();
  if (!v || typeof v !== "object") return null;
  const outcome =
    typeof v.outcome === "string"
      ? v.outcome
      : v.passed === true
        ? "passed"
        : v.passed === false
          ? "failed"
          : "";
  const tone = VF_TONE[outcome] ?? (v.passed === true ? "ok" : v.passed === false ? "err" : "idle");
  const label = VF_TONE[outcome] ? t(`si.vf.${outcome}`) : outcome || t("si.unknown");
  const rounds = num(v.rounds);
  const repairs = num(v.repairs);
  const maxRepairs = num(v.max_repairs);
  const sigs = arr(v.failure_signatures);
  const last = arr(v.last);
  return (
    <section className={`vf tone-${tone}`} aria-label={t("si.verify")}>
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4>
          <FlaskConical size={16} /> {t("si.verify")}
        </h4>
        <Badge s={TONE_STATUS[tone]}>{label}</Badge>
        {num(v.duration_ms) != null && (
          <span
            className="muted small"
            style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
          >
            <Timer size={12} />
            {dur(v.duration_ms)}
          </span>
        )}
      </div>
      {v.reason && <div className="muted small">{String(v.reason)}</div>}
      {rounds != null && rounds > 0 && (
        <div className="vf-steps" role="list" aria-label={t("si.rounds")}>
          {Array.from({ length: rounds }, (_, i) => {
            const state =
              i < sigs.length ? "fail" : v.passed === true && i === rounds - 1 ? "pass" : "unknown";
            return (
              <div key={i} style={{ display: "contents" }}>
                {i > 0 && <span className="vf-link" aria-hidden />}
                <div
                  className="vf-step"
                  role="listitem"
                  title={state === "fail" ? String(sigs[i]) : undefined}
                >
                  <span className={`vf-dot ${state}`}>
                    {state === "pass" ? (
                      <Check size={13} strokeWidth={3} />
                    ) : state === "fail" ? (
                      <X size={13} strokeWidth={3} />
                    ) : (
                      <CircleDashed size={13} />
                    )}
                  </span>
                  <span>{i === 0 ? t("si.check") : t("si.repairN", { n: i })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(repairs != null || rounds != null) && (
        <div className="vf-budget" style={{ marginTop: 6, flexWrap: "wrap" }}>
          {rounds != null && <span>{t("si.roundN", { n: rounds })}</span>}
          {repairs != null && (
            <>
              <span>
                · {t("si.repairs", { n: repairs })}
                {maxRepairs != null ? ` / ${maxRepairs}` : ""}
              </span>
              {maxRepairs != null && maxRepairs > 0 && (
                <span className="progress" aria-hidden>
                  <span
                    style={{
                      width: `${Math.min(100, (repairs / maxRepairs) * 100)}%`,
                      background: repairs >= maxRepairs ? "var(--st-err)" : "var(--brand)",
                    }}
                  />
                </span>
              )}
            </>
          )}
        </div>
      )}
      {last.map((r, i) => {
        const regs = arr(r?.regressions);
        const weakened = arr(r?.weakened);
        const pre = num(r?.pre_existing);
        return (
          <div key={`${r?.repo ?? i}`} className="vf-repo">
            <div className="vf-repo-head">
              {r?.passed ? (
                <CheckCircle2 size={15} color="var(--st-ok)" />
              ) : r?.passed === false ? (
                <XCircle size={15} color="var(--st-err)" />
              ) : (
                <CircleDashed size={15} color="var(--muted)" />
              )}
              <b className="grow">{r?.repo ?? "—"}</b>
              {r?.timed_out ? (
                <Badge s="FAILED">{t("si.timeout")}</Badge>
              ) : (
                r?.exit_code != null && (
                  <span className="mono muted small">
                    {t("si.exit", { code: String(r.exit_code) })}
                  </span>
                )
              )}
              {r?.artifact_id != null && (
                <a
                  className="small"
                  href={`/api/artifacts/${r.artifact_id}/raw`}
                  target="_blank"
                  rel="noopener"
                >
                  {t("si.log")}
                </a>
              )}
            </div>
            {regs.length > 0 && (
              <ul className="vf-list">
                {regs.map((g, j) => (
                  <li key={j} style={{ flexDirection: "column", gap: 1 }}>
                    <span className="mono" style={{ color: "var(--st-err)", fontWeight: 600 }}>
                      {g?.package}
                    </span>
                    {arr(g?.tests).map((t: string) => (
                      <span key={t} className="mono" style={{ marginLeft: 12 }}>
                        <X size={10} style={{ verticalAlign: -1 }} /> {t}
                      </span>
                    ))}
                    {arr(g?.build_errors).map((e: string) => (
                      <span key={e} className="mono" style={{ marginLeft: 12 }}>
                        <Wrench size={10} style={{ verticalAlign: -1 }} /> {e}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {weakened.length > 0 && (
              <div
                className="vf-list"
                style={{
                  color: "var(--st-err)",
                  display: "flex",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                <ShieldAlert size={13} style={{ flex: "none", marginTop: 2 }} />
                <span>{t("si.weakened", { list: weakened.join(", ") })}</span>
              </div>
            )}
            {r?.slop && (
              <div className="muted small" style={{ marginTop: 4 }}>
                {t("si.slop")}:{" "}
                {t("si.slopLine", {
                  mode: String(r.slop.mode ?? "—"),
                  status: String(r.slop.status ?? "—"),
                  new: num(r.slop.counts?.new) ?? 0,
                  worsened: num(r.slop.counts?.worsened) ?? 0,
                  existing: num(r.slop.counts?.existing) ?? 0,
                  resolved: num(r.slop.counts?.resolved) ?? 0,
                  blocking: arr(r.slop.blocking).length,
                  ms: num(r.slop.detector_ms) ?? 0,
                })}
              </div>
            )}
            {pre != null && pre > 0 && (
              <div className="muted small" style={{ marginTop: 4 }}>
                {t("si.preexisting", { n: pre })}
              </div>
            )}
            {r?.note && (
              <div className="muted small" style={{ marginTop: 4 }}>
                {String(r.note)}
              </div>
            )}
          </div>
        );
      })}
      {sigs.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>{t("si.signatures", { n: sigs.length })}</summary>
          {sigs.map((s: unknown, i: number) => (
            <div
              key={i}
              className="mono small"
              style={{ overflowWrap: "anywhere", padding: "2px 0" }}
            >
              {i + 1}. {String(s)}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
