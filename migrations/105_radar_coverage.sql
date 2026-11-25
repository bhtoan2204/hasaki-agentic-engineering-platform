-- Engineering Radar coverage (src/radar/scan.ts): what each pass actually evaluated — signatures in the newest
-- production-error scan vs evaluated (maxSeries cap), skipped ones (bounded sample), failure groups truncated, the age
-- of the newest successful scan, and how many quiet findings were NOT resolved because their source was not
-- evaluated. A pass over incomplete or stale data must not read as "all clear".
ALTER TABLE radar_scans ADD COLUMN coverage jsonb;
