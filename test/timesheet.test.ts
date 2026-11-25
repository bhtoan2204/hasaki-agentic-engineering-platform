import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOverride,
  classifyDay,
  markInProgress,
  summarize,
  type TimesheetDay,
} from "../src/timesheet.ts";

// 2026-11-02 08:30 - 17:30 (+07:00) as epoch seconds: a 9h shift.
const IN = Date.UTC(2026, 10, 2, 1, 30) / 1000;
const OUT = IN + 9 * 3600;
const row = (checkIn: number | null, checkOut: number | null, extra = {}) => ({
  date: "2026-11-02",
  check_in: checkIn,
  check_out: checkOut,
  status: 0,
  staff_schedule: { staffsche_time_in: IN, staffsche_time_out: OUT, staffsche_shift: "HC 7" },
  ...extra,
});
const day = (r: ReturnType<typeof row>): TimesheetDay => applyOverride(classifyDay(r), undefined);

test("a regular day: worked minus the shift span, late and early measured against the schedule", () => {
  const d = day(row(IN + 600, OUT + 1800));
  assert.equal(d.kind, "full");
  assert.equal(d.late_by, 600);
  assert.equal(d.early_by, 0);
  assert.equal(d.target_seconds, 9 * 3600);
  assert.equal(d.diff_seconds, 1200);
});

test("missing 70% of a session is a half-day leave: half the shift is required", () => {
  const morning = day(row(IN + 4 * 3600, OUT));
  assert.equal(morning.kind, "half_leave");
  assert.equal(morning.session, "morning");
  assert.equal(morning.target_seconds, 4.5 * 3600);
  assert.equal(morning.diff_seconds, 5 * 3600 - 4.5 * 3600);
  const late = day(row(IN + 3600, OUT));
  assert.equal(late.kind, "full", "an hour late is not a leave");
  assert.equal(day(row(IN, OUT - 4 * 3600)).session, "afternoon");
});

test("a missing or impossible punch needs a request and counts the full shift", () => {
  for (const [r, missing] of [
    [row(null, OUT), "in"],
    [row(IN, null), "out"],
    [row(null, null), "both"],
    [row(OUT, IN), "invalid"],
  ] as const) {
    const d = day(r);
    assert.equal(d.kind, "missing_punch");
    assert.equal(d.missing, missing);
    assert.equal(d.worked_seconds, d.target_seconds);
    assert.equal(d.diff_seconds, 0);
  }
});

test("without a schedule the required time is 9 hours", () => {
  const d = day(row(IN, IN + 8 * 3600, { staff_schedule: null }));
  assert.equal(d.target_seconds, 9 * 3600);
  assert.equal(d.diff_seconds, -3600);
  assert.equal(d.late_by, 0);
});

test("today before the shift ends is shown but not counted; a finished day is counted", () => {
  const today = day(row(IN, IN + 3 * 3600));
  const earlier = { ...day(row(IN, OUT + 3600)), date: "2026-11-01" };
  const during = markInProgress([earlier, today], (IN + 4 * 3600) * 1000);
  assert.equal(during[1].in_progress, true);
  assert.equal(during[0].in_progress, undefined);
  const s = summarize(during);
  assert.equal(s.valid_days, 1);
  assert.equal(s.difference_seconds, 3600);
  assert.deepEqual(s.half_leave_days, []);
  const after = markInProgress([earlier, day(row(IN, OUT))], (OUT + 60) * 1000);
  assert.equal(summarize(after).valid_days, 2, "after the shift the day counts");
  const noCheckout = markInProgress([day(row(IN, null))], (OUT + 3600) * 1000);
  assert.equal(
    noCheckout[0].in_progress,
    true,
    "today without a check-out yet is not a forgotten punch",
  );
});

test("a day the user corrected is resolved as the chosen kind; the automatic kind stays visible", () => {
  const lateMorning = row(IN + 4 * 3600, OUT);
  const auto = day(lateMorning);
  assert.equal(auto.kind, "half_leave");
  assert.equal(auto.overridden, false);
  const late = applyOverride(classifyDay(lateMorning), "full");
  assert.equal(late.kind, "full", "the user was late, not on leave");
  assert.equal(late.auto_kind, "half_leave");
  assert.equal(late.overridden, true);
  assert.equal(late.session, null);
  assert.equal(late.target_seconds, 9 * 3600);
  assert.equal(late.diff_seconds, 5 * 3600 - 9 * 3600);
  const leave = applyOverride(classifyDay(row(IN + 3600, OUT)), "half_leave");
  assert.equal(leave.kind, "half_leave");
  assert.equal(leave.session, "morning");
  assert.equal(leave.target_seconds, 4.5 * 3600);
  assert.equal(
    applyOverride(classifyDay(row(IN, OUT - 4 * 3600)), "half_leave").session,
    "afternoon",
  );
  const same = applyOverride(classifyDay(lateMorning), "half_leave");
  assert.equal(same.overridden, false, "choosing what the punches already say is not a correction");
});

test("a correction never applies to a day with a missing punch, and the summary counts corrected days", () => {
  const missing = applyOverride(classifyDay(row(null, OUT)), "full");
  assert.equal(missing.kind, "missing_punch");
  assert.equal(missing.overridden, false);
  const corrected = applyOverride(classifyDay(row(IN + 4 * 3600, OUT)), "full");
  const s = summarize([corrected, day(row(IN, OUT))]);
  assert.deepEqual(s.day_counts, { full: 2, half_leave: 0, missing_punch: 0 });
  assert.deepEqual(s.overridden_days, ["2026-11-02"]);
  assert.equal(s.difference_seconds, 5 * 3600 - 9 * 3600);
});
