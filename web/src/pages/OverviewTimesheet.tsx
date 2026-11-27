import { useState } from "react";
import { AlertTriangle, CalendarCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, ErrorBox, Skeleton } from "../ui.tsx";
import { uiLocale, useI18n } from "../i18n/index.tsx";

type Kind = "full" | "half_leave" | "missing_punch";
interface Day {
  date: string | null;
  shift: string | null;
  check_in: number | null;
  check_out: number | null;
  kind: Kind;
  auto_kind: Kind;
  overridden: boolean;
  missing: "in" | "out" | "both" | "invalid" | null;
  session: "morning" | "afternoon" | null;
  late_by: number | null;
  early_by: number | null;
  worked_seconds: number;
  target_seconds: number;
  diff_seconds: number;
  in_progress?: boolean;
}
interface Sheet {
  connected: boolean;
  days?: Day[];
  summary?: {
    valid_days: number;
    day_counts: Record<Kind, number>;
    missing_punch_days: string[];
    total_worked_seconds: number;
    total_target_seconds: number;
    difference_seconds: number;
  };
}

/** Today in Vietnam, as year and month (attendance is local). */
const thisMonth = () => {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

const hm = (epoch: number | null) =>
  epoch == null
    ? "—"
    : new Date(epoch * 1000).toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Ho_Chi_Minh",
      });

const dur = (seconds: number, signed = false) => {
  const s = Math.abs(Math.trunc(seconds));
  const text = `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return signed ? `${seconds < 0 ? "−" : "+"}${text}` : text;
};

const dayLabel = (date: string | null) => {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
};

/** Monthly attendance from Hasaki HR, read with the user's own Hasaki Work token. */
export function TimesheetCard() {
  const { t } = useI18n();
  const [at, setAt] = useState(thisMonth);
  const [saving, setSaving] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<Sheet>(
    `/api/timesheet?year=${at.year}&month=${at.month}`,
  );
  const shift = (delta: number) =>
    setAt(({ year, month }) => {
      const m = month - 1 + delta;
      return { year: year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 };
    });
  const current = thisMonth();
  const isCurrent = at.year === current.year && at.month === current.month;
  const s = data?.summary;
  const kindText = (d: Day) =>
    d.in_progress
      ? t("ts.inProgress")
      : d.kind === "missing_punch"
        ? t(`ts.missing.${d.missing ?? "both"}`)
        : d.kind === "half_leave"
          ? t(`ts.half.${d.session ?? "morning"}`)
          : t("ts.full");

  const setKind = async (date: string, kind: "auto" | "full" | "half_leave") => {
    setSaving(date);
    const ok = await act(() => api("/api/timesheet/day-kind", { date, kind }), t("ts.saved"));
    setSaving(null);
    if (ok) reload();
  };

  return (
    <section className="card ov-timesheet">
      <div className="card-head">
        <CalendarCheck size={18} color="var(--brand)" />
        <h4>{t("ts.title")}</h4>
        <div className="ts-month">
          <button
            type="button"
            className="ghost sm"
            aria-label={t("ts.prev")}
            onClick={() => shift(-1)}
          >
            <ChevronLeft size={15} />
          </button>
          <span className="small">
            {String(at.month).padStart(2, "0")}/{at.year}
          </span>
          <button
            type="button"
            className="ghost sm"
            aria-label={t("ts.next")}
            disabled={isCurrent}
            onClick={() => shift(1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !data && loading ? (
        <div className="stack" style={{ gap: 8 }}>
          <Skeleton h={48} r={12} />
          <Skeleton h={32} r={12} />
        </div>
      ) : data && !data.connected ? (
        <div className="ov-inbox-empty">
          {t("ts.connect")} <a href="#/work-items">{t("ts.connectLink")}</a>
        </div>
      ) : s ? (
        <>
          <div className="ts-summary">
            <div className={`ts-balance ${s.difference_seconds >= 0 ? "is-ok" : "is-short"}`}>
              <span className="small muted">
                {s.difference_seconds >= 0 ? t("ts.surplus") : t("ts.deficit")}
              </span>
              <b>{dur(s.difference_seconds, true)}</b>
            </div>
            <dl className="ts-figures small">
              <dt>{t("ts.days")}</dt>
              <dd>{s.valid_days}</dd>
              <dt>{t("ts.worked")}</dt>
              <dd>{dur(s.total_worked_seconds)}</dd>
              <dt>{t("ts.required")}</dt>
              <dd>{dur(s.total_target_seconds)}</dd>
              <dt>{t("ts.halfDays")}</dt>
              <dd>{s.day_counts.half_leave}</dd>
            </dl>
          </div>
          {s.missing_punch_days.length > 0 && (
            <div className="ts-alert small" role="alert">
              <AlertTriangle size={14} />
              <span>
                {t("ts.needRequest", {
                  days: s.missing_punch_days
                    .map((d) => d.slice(8, 10) + "/" + d.slice(5, 7))
                    .join(", "),
                })}
              </span>
            </div>
          )}
          <div className="table-wrap ts-days">
            <table>
              <thead>
                <tr>
                  <th>{t("ts.col.date")}</th>
                  <th>{t("ts.col.inOut")}</th>
                  <th>{t("ts.col.result")}</th>
                  <th>{t("ts.col.kind")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.days ?? []).map((d, i) => (
                  <tr key={d.date ?? i} className={d.in_progress ? "muted" : ""}>
                    <td title={d.shift ?? undefined}>{dayLabel(d.date)}</td>
                    <td>
                      {hm(d.check_in)} – {hm(d.check_out)}
                    </td>
                    <td
                      title={
                        d.in_progress ? undefined : `${t("ts.col.worked")} ${dur(d.worked_seconds)}`
                      }
                    >
                      {!d.in_progress && d.kind !== "missing_punch" && (
                        <b className={d.diff_seconds < 0 ? "is-short" : "is-ok"}>
                          {dur(d.diff_seconds, true)}
                        </b>
                      )}{" "}
                      {(d.in_progress || d.kind !== "full") && (
                        <span className={`ts-kind ts-${d.in_progress ? "progress" : d.kind}`}>
                          {kindText(d)}
                        </span>
                      )}
                    </td>
                    <td>
                      {d.date && !d.in_progress && d.auto_kind !== "missing_punch" ? (
                        <select
                          className={d.overridden ? "xs ts-edited" : "xs"}
                          aria-label={`${t("ts.col.kind")} ${dayLabel(d.date)}`}
                          title={
                            d.overridden
                              ? t("ts.editedHint", {
                                  auto: t(
                                    d.auto_kind === "half_leave"
                                      ? "ts.kind.half_leave"
                                      : "ts.kind.full",
                                  ),
                                })
                              : undefined
                          }
                          disabled={saving === d.date}
                          value={d.overridden ? d.kind : "auto"}
                          onChange={(e) =>
                            setKind(d.date!, e.target.value as "auto" | "full" | "half_leave")
                          }
                        >
                          <option value="auto">{t("ts.kind.auto")}</option>
                          <option value="full">{t("ts.kind.full")}</option>
                          <option value="half_leave">{t("ts.kind.half_leave")}</option>
                        </select>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small ts-hint">{t("ts.editHint")}</p>
          </div>
        </>
      ) : null}
    </section>
  );
}
