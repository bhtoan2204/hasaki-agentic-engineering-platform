-- A user's own classification of an attendance day, when the automatic one (a late arrival that looks like a half-day
-- leave, or the opposite) is wrong. Absence of a row = the automatic classification from the HR punches.
CREATE TABLE timesheet_day_overrides (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date  DATE NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('full', 'half_leave')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, work_date)
);
