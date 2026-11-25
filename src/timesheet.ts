import { authStatus, workApi } from "./hasakiAuth.ts";
import { HttpError } from "./http/error.ts";
import { pool, q } from "./db/pool.ts";

/**
 * Monthly attendance of the signed-in user from Hasaki HR (wshr API, the user's own Hasaki Work token), with the
 * worked / required hours and the day classification of the hasagi timesheet tool.
 */

// Used only when a row has no staff_schedule; otherwise the required time is the shift span.
const TARGET_SECONDS_PER_DAY = 9 * 3600;
// The only leave shorter than a day is one session = half a shift (a 9h shift -> 4h30).
const HALF_SESSION_RATIO = 0.5;
// Missing at least 70% of a session counts as a half-day leave, not as late / left early.
const HALF_DETECT_RATIO = 0.7;
// "Left early" bit of status: (status & 128) <=> check_out < staffsche_time_out.
const STATUS_LEFT_EARLY = 128;

export type DayKind = "full" | "half_leave" | "missing_punch";

export interface TimesheetDay {
  date: string | null;
  shift: string | null;
  /** Seconds since midnight. */
  schedule_in: number | null;
  schedule_out: number | null;
  check_in: number | null;
  check_out: number | null;
  span_seconds: number;
  half_seconds: number;
  kind: DayKind;
  missing: "in" | "out" | "both" | "invalid" | null;
  session: "morning" | "afternoon" | null;
  late_by: number | null;
  early_by: number | null;
  left_early_flag: boolean;
  punched_seconds: number;
  worked_seconds: number;
  target_seconds: number;
  diff_seconds: number;
  /** Today before the shift ends: shown, but left out of the month totals until the day is over. */
  in_progress?: boolean;
  /** The classification the HR punches give; `kind` differs from it when the user corrected the day. */
  auto_kind: DayKind;
  overridden: boolean;
}

type Row = {
  date?: string;
  check_in?: number | null;
  check_out?: number | null;
  status?: number;
  staff_schedule?: {
    staffsche_time_in?: number;
    staffsche_time_out?: number;
    staffsche_shift?: string;
  } | null;
};

/** Raw facts of one attendance row, before worked / required hours. */
export function classifyDay(row: Row) {
  const schedule = row?.staff_schedule || {};
  const scheduleIn = Number(schedule.staffsche_time_in);
  const scheduleOut = Number(schedule.staffsche_time_out);
  const hasSchedule =
    Number.isFinite(scheduleIn) && Number.isFinite(scheduleOut) && scheduleOut > scheduleIn;
  const spanSeconds = hasSchedule ? scheduleOut - scheduleIn : TARGET_SECONDS_PER_DAY;
  const halfSeconds = Math.round(spanSeconds * HALF_SESSION_RATIO);
  const checkIn = Number(row?.check_in);
  const checkOut = Number(row?.check_out);
  const hasCheckIn = row?.check_in != null && Number.isFinite(checkIn) && checkIn > 0;
  const hasCheckOut = row?.check_out != null && Number.isFinite(checkOut) && checkOut > 0;
  const base = {
    date: row?.date ?? null,
    shift: schedule.staffsche_shift ?? null,
    schedule_in: hasSchedule ? scheduleIn : null,
    schedule_out: hasSchedule ? scheduleOut : null,
    span_seconds: spanSeconds,
    half_seconds: halfSeconds,
    check_in: hasCheckIn ? checkIn : null,
    check_out: hasCheckOut ? checkOut : null,
    left_early_flag: (Number(row?.status) & STATUS_LEFT_EARLY) !== 0,
  };
  // A missing (or impossible) punch needs a forgotten-attendance request.
  if (!hasCheckIn || !hasCheckOut || checkOut <= checkIn)
    return {
      ...base,
      kind: "missing_punch" as const,
      missing: (!hasCheckIn && !hasCheckOut
        ? "both"
        : !hasCheckIn
          ? "in"
          : !hasCheckOut
            ? "out"
            : "invalid") as "in" | "out" | "both" | "invalid",
      session: null,
      late_by: null,
      early_by: null,
      punched_seconds: 0,
    };
  const lateBy = hasSchedule ? Math.max(0, checkIn - scheduleIn) : 0;
  const earlyBy = hasSchedule ? Math.max(0, scheduleOut - checkOut) : 0;
  const detect = Math.round(halfSeconds * HALF_DETECT_RATIO);
  const halfLeave = hasSchedule && (lateBy >= detect || earlyBy >= detect);
  return {
    ...base,
    kind: (halfLeave ? "half_leave" : "full") as DayKind,
    missing: null,
    session: halfLeave
      ? ((lateBy >= earlyBy ? "morning" : "afternoon") as "morning" | "afternoon")
      : null,
    late_by: lateBy,
    early_by: earlyBy,
    punched_seconds: checkOut - checkIn,
  };
}

/** Worked / required / difference for a day of the given kind (an approved forgotten-attendance day counts in full). */
export function resolveDay(day: ReturnType<typeof classifyDay>, kind: DayKind = day.kind) {
  if (kind === "missing_punch")
    return {
      kind,
      worked_seconds: day.span_seconds,
      target_seconds: day.span_seconds,
      diff_seconds: 0,
    };
  const target = kind === "half_leave" ? day.span_seconds - day.half_seconds : day.span_seconds;
  return {
    kind,
    worked_seconds: day.punched_seconds,
    target_seconds: target,
    diff_seconds: day.punched_seconds - target,
  };
}

/**
 * The user's own classification of a day with both punches (late arrival vs. half-day leave): the day is resolved as that
 * kind. A day with a missing punch has its own flow (a forgotten-attendance request), so a correction never applies to it.
 */
export function applyOverride(
  facts: ReturnType<typeof classifyDay>,
  override: Exclude<DayKind, "missing_punch"> | undefined,
): Omit<TimesheetDay, "in_progress"> {
  const auto = facts.kind;
  if (!override || auto === "missing_punch" || override === auto)
    return { ...facts, ...resolveDay(facts), auto_kind: auto, overridden: false };
  const session =
    override === "half_leave"
      ? (facts.late_by ?? 0) >= (facts.early_by ?? 0)
        ? "morning"
        : "afternoon"
      : null;
  return {
    ...facts,
    ...resolveDay(facts, override),
    session,
    auto_kind: auto,
    overridden: true,
  };
}

export const DAY_KINDS = ["full", "half_leave"] as const;

async function dayOverrides(userId: number, fromDate: string, toDate: string) {
  const rows = await q<{ work_date: string; kind: "full" | "half_leave" }>(
    pool,
    "SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, kind FROM timesheet_day_overrides WHERE user_id = $1 AND work_date BETWEEN $2 AND $3",
    [userId, fromDate, toDate],
  );
  return new Map(rows.map((r) => [r.work_date, r.kind]));
}

/** Corrects the classification of one day; `auto` removes the correction. */
export async function setDayKind(userId: number, date: unknown, kind: unknown) {
  const day = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  if (
    !day ||
    Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    throw new HttpError(400, "invalid date");
  if (kind === "auto") {
    await q(pool, "DELETE FROM timesheet_day_overrides WHERE user_id = $1 AND work_date = $2", [
      userId,
      day,
    ]);
    return { date: day, kind: "auto" as const };
  }
  if (kind !== "full" && kind !== "half_leave") throw new HttpError(400, "invalid kind");
  await q(
    pool,
    `INSERT INTO timesheet_day_overrides (user_id, work_date, kind) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, work_date) DO UPDATE SET kind = excluded.kind, updated_at = now()`,
    [userId, day, kind],
  );
  return { date: day, kind };
}

export function summarize(all: TimesheetDay[]) {
  const days = all.filter((d) => !d.in_progress);
  const counts = { full: 0, half_leave: 0, missing_punch: 0 };
  let worked = 0;
  let target = 0;
  for (const d of days) {
    counts[d.kind]++;
    worked += d.worked_seconds;
    target += d.target_seconds;
  }
  return {
    valid_days: days.length,
    day_counts: counts,
    half_leave_days: days.filter((d) => d.kind === "half_leave").map((d) => d.date),
    overridden_days: days.filter((d) => d.overridden).map((d) => d.date),
    missing_punch_days: days.filter((d) => d.kind === "missing_punch").map((d) => d.date),
    total_worked_seconds: worked,
    total_target_seconds: target,
    difference_seconds: worked - target,
  };
}

/** Calendar date in Vietnam (attendance dates are local). */
const localDate = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);

/** Today's row while its shift is still running (or without a check-out yet) is not a finished day. */
export function markInProgress(days: TimesheetDay[], nowMs = Date.now()) {
  const today = localDate(nowMs);
  const now = Math.floor(nowMs / 1000);
  return days.map((d) =>
    d.date === today && (d.check_out == null || (d.schedule_out != null && now < d.schedule_out))
      ? { ...d, in_progress: true }
      : d,
  );
}

export async function myTimesheet(userId: number, year: number, month: number, nowMs = Date.now()) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new HttpError(400, "invalid year");
  if (!Number.isInteger(month) || month < 1 || month > 12)
    throw new HttpError(400, "invalid month");
  if (!(await authStatus(userId)).loggedIn) return { connected: false as const };
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  const fromDate = `${year}-${mm}-01`;
  const toDate = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  const profile = await workApi<{
    data?: {
      staff_info?: {
        code?: unknown;
        staff_name?: string;
        staff_loc_id?: unknown;
        staff_dept_id?: unknown;
      };
    };
  }>(userId, "GET", "setting/user/profile", { employee: 1 });
  const staff = profile?.data?.staff_info;
  if (!staff?.code) throw new HttpError(502, "Hasaki HR profile has no staff code");
  const sheet = await workApi<{ data?: { rows?: unknown } }>(userId, "GET", "v2/timesheet", {
    location_id: String(staff.staff_loc_id ?? ""),
    department_id: String(staff.staff_dept_id ?? ""),
    staff_code: String(staff.code),
    from_date: fromDate,
    to_date: toDate,
    limit: Math.max(lastDay + 5, 35),
    page: 1,
  });
  const rows: Row[] = Array.isArray(sheet?.data?.rows) ? sheet.data.rows : [];
  const overrides = await dayOverrides(userId, fromDate, toDate);
  const days = markInProgress(
    rows
      .map((row): TimesheetDay => {
        const facts = classifyDay(row);
        return applyOverride(facts, overrides.get(String(facts.date)));
      })
      .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? ""))),
    nowMs,
  );
  return {
    connected: true as const,
    from_date: fromDate,
    to_date: toDate,
    staff: { code: String(staff.code), name: staff.staff_name ?? null },
    days,
    summary: summarize(days),
  };
}
