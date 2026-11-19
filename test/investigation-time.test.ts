import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assertTimezone,
  coarser,
  formatDuration,
  parseObservedTime,
  parseTimeModifier,
  splunkTimeText,
} from "../src/investigation/time.ts";

const TZ = "Asia/Ho_Chi_Minh";

describe("assertTimezone", () => {
  test("accepts valid IANA timezones without throwing", () => {
    assert.doesNotThrow(() => assertTimezone("UTC"));
    assert.doesNotThrow(() => assertTimezone("Asia/Ho_Chi_Minh"));
    assert.doesNotThrow(() => assertTimezone("America/New_York"));
  });

  test("throws error for unknown or invalid timezones", () => {
    assert.throws(() => assertTimezone("Invalid/Zone"), /unknown timezone "Invalid\/Zone"/);
    assert.throws(() => assertTimezone(""), /unknown timezone ""/);
    assert.throws(() => assertTimezone("Mars/Curiosity"), /unknown timezone "Mars\/Curiosity"/);
  });
});

describe("coarser", () => {
  test("returns the coarser of two precisions", () => {
    assert.equal(coarser("s", "s"), "s");
    assert.equal(coarser("s", "ms"), "s");
    assert.equal(coarser("ms", "s"), "s");
    assert.equal(coarser("s", "us"), "s");
    assert.equal(coarser("us", "s"), "s");
    assert.equal(coarser("ms", "ms"), "ms");
    assert.equal(coarser("ms", "us"), "ms");
    assert.equal(coarser("us", "ms"), "ms");
    assert.equal(coarser("us", "us"), "us");
  });
});

describe("splunkTimeText", () => {
  test("formats epoch ms in target timezone as %m/%d/%Y:%H:%M:%S", () => {
    // 2026-11-10T01:48:00Z -> 08:48:00 in +07:00
    const epochMs = Date.parse("2026-11-10T01:48:00.000Z");
    const text = splunkTimeText(epochMs, TZ);
    assert.equal(text, "11/10/2026:08:48:00");

    const utcText = splunkTimeText(epochMs, "UTC");
    assert.equal(utcText, "11/10/2026:01:48:00");
  });
});

describe("parseObservedTime", () => {
  test("returns null for empty, null, undefined, or unparseable input", () => {
    assert.equal(parseObservedTime(null, TZ), null);
    assert.equal(parseObservedTime(undefined, TZ), null);
    assert.equal(parseObservedTime("", TZ), null);
    assert.equal(parseObservedTime("   ", TZ), null);
    assert.equal(parseObservedTime("not-a-timestamp", TZ), null);
  });

  test("parses ISO timestamps with timezone offset or Z", () => {
    const withOffset = parseObservedTime("2026-11-10T08:48:00.123+07:00", TZ)!;
    assert.ok(withOffset);
    assert.equal(withOffset.precision, "ms");
    assert.equal(withOffset.assumed_timezone, false);
    assert.equal(withOffset.timezone, TZ);

    const withZ = parseObservedTime("2026-11-10T01:48:00.123456Z", TZ)!;
    assert.ok(withZ);
    assert.equal(withZ.precision, "us");
    assert.equal(withZ.assumed_timezone, false);
  });

  test("parses ISO timestamps without offset, flagging assumed_timezone", () => {
    const noOffset = parseObservedTime("2026-11-10 08:48:00", TZ)!;
    assert.ok(noOffset);
    assert.equal(noOffset.assumed_timezone, true);
    assert.equal(noOffset.precision, "s");
  });

  test("parses ISO timestamps with comma fractional separator", () => {
    const withComma = parseObservedTime("2026-11-10T08:48:00,500+07:00", TZ)!;
    assert.ok(withComma);
    assert.equal(withComma.precision, "ms");
  });

  test("parses raw epoch seconds with and without fractions", () => {
    const epochWithFrac = parseObservedTime("1762739280.123456", TZ)!;
    assert.ok(epochWithFrac);
    assert.equal(epochWithFrac.precision, "us");
    assert.equal(epochWithFrac.assumed_timezone, false);

    const epochNoFrac = parseObservedTime("1762739280", TZ)!;
    assert.ok(epochNoFrac);
    assert.equal(epochNoFrac.precision, "s");
  });

  test("parses Splunk date-time syntax", () => {
    const splunk = parseObservedTime("11/10/2026:08:48:00.123", TZ)!;
    assert.ok(splunk);
    assert.equal(splunk.precision, "ms");
    assert.equal(splunk.assumed_timezone, true);
  });
});

describe("parseTimeModifier", () => {
  const baseNow = Date.parse("2026-11-10T03:00:30.000Z");

  test("handles now and empty strings", () => {
    assert.equal(parseTimeModifier("now", TZ, baseNow), baseNow);
    assert.equal(parseTimeModifier("now()", TZ, baseNow), baseNow);
    assert.equal(parseTimeModifier("", TZ, baseNow), baseNow);
    assert.equal(parseTimeModifier(' "now" ', TZ, baseNow), baseNow);
  });

  test("handles relative time offsets with different units", () => {
    assert.equal(parseTimeModifier("-30s", TZ, baseNow), baseNow - 30_000);
    assert.equal(parseTimeModifier("+15m", TZ, baseNow), baseNow + 15 * 60_000);
    assert.equal(parseTimeModifier("-2h", TZ, baseNow), baseNow - 2 * 3600_000);
    assert.equal(parseTimeModifier("+1d", TZ, baseNow), baseNow + 86_400_000);
    assert.equal(parseTimeModifier("-1w", TZ, baseNow), baseNow - 604_800_000);
  });

  test("handles snap-to modifiers", () => {
    const snapped = parseTimeModifier("-10m@h", TZ, baseNow);
    assert.equal(typeof snapped, "number");
  });

  test("throws error for unsupported modifiers", () => {
    assert.throws(
      () => parseTimeModifier("invalid-time-mod", TZ, baseNow),
      /unsupported time modifier "invalid-time-mod"/,
    );
  });
});

describe("formatDuration", () => {
  test("formats 0 us", () => {
    assert.equal(formatDuration(0, "ms"), "0 ms");
    assert.equal(formatDuration(0, "s"), "0 s");
  });

  test("formats negative durations with minus sign", () => {
    assert.equal(formatDuration(-1_267_000, "ms"), "-1.267 s");
    assert.equal(formatDuration(-500_000, "ms"), "-500 ms");
  });

  test("formats under 1000 ms with ms and us precision", () => {
    assert.equal(formatDuration(250_000, "ms"), "250 ms");
    assert.equal(formatDuration(250_123, "us"), "250.123 ms");
  });

  test("formats durations under 60 seconds", () => {
    assert.equal(formatDuration(15_500_000, "s"), "16 s"); // rounded
    assert.equal(formatDuration(15_500_000, "ms"), "15.500 s");
    assert.equal(formatDuration(15_500_123, "us"), "15.500123 s");
  });

  test("formats durations between 1 minute and 1 hour", () => {
    const dur = 125_000_000; // 125 seconds = 2 min 5 sec
    assert.equal(formatDuration(dur, "s"), "2 min 5 s");
    assert.equal(formatDuration(dur, "ms"), "2 min 5.000 s");
  });

  test("formats durations over 1 hour", () => {
    const dur = 3_725_000_000; // 1 hour, 2 min, 5 sec
    assert.equal(formatDuration(dur, "s"), "1 h 2 min 5 s");
    assert.equal(formatDuration(dur, "ms"), "1 h 2 min 5.000 s");
  });
});
