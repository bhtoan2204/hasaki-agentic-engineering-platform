/** Phase 1 hardening of the production error scan (docs/prod-errors-hardening/PLAN.md §4): pure parts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.ts";
import * as scan from "../src/prodErrors/scan.ts";
import type { SourceRow } from "../src/prodErrors/scan.ts";
const { assess, buildScanSpl, dayWindow } = scan;

const NS = [{ namespace: "oms-prod", project: "OMS" }];
const window = () => dayWindow(new Date("2026-11-02T10:00:00Z"));
const spl = (extraLevels?: boolean) =>
  (buildScanSpl as (...a: unknown[]) => string)(window(), NS, { extraLevels });

/** The `rex` pattern of the SPL as a JavaScript regular expression (the SPL string is escaped once). */
function rexOf(text: string) {
  const m = /rex field=msg "((?:[^"\\]|\\.)*)"/.exec(text);
  assert.ok(m, "the SPL has a rex for plain text levels");
  // PCRE inline (?i) becomes the i flag; the SPL string escapes each backslash once.
  return new RegExp(m[1].replace(/^\(\?i\)/, "").replace(/\\\\/g, "\\"), "i");
}

test("T1: plain text log lines with a level are matched when extra levels are on", () => {
  const re = rexOf(spl(true));
  const level = (line: string) => re.exec(line)?.groups?.tl?.toUpperCase() ?? null;
  assert.equal(level("2026-11-27 10:00:01,123 ERROR order failed id=123"), "ERROR");
  assert.equal(level("2026-11-27T10:00:01Z [ERROR] consumer stopped"), "ERROR");
  assert.equal(level("ERROR: connection refused"), "ERROR");
  assert.equal(level("FATAL could not start"), "FATAL");
  assert.equal(level("2026-11-27 10:00:01 WARN slow query"), null);
  assert.equal(level("2026-11-27 10:00:01 INFO user said ERROR in a form"), null);
});

test("T2: severity, lvl and log.level are read as the level when extra levels are on", () => {
  assert.match(spl(true), /coalesce\(level,LEVEL,severity,lvl,'log\.level'\)/);
  assert.doesNotMatch(spl(false), /severity|lvl|log\.level/);
});

test("T13: with extra levels off the level handling is exactly what it was", () => {
  const lines = spl(false).split(" | ");
  assert.ok(lines.includes("spath input=log"));
  assert.ok(
    lines.some((l) =>
      l.startsWith(
        "eval lv=upper(coalesce(level,LEVEL)), msg=coalesce(message,MESSAGE,msg,log,_raw), err=coalesce(error,err), ns='kubernetes.namespace_name', svc='kubernetes.container_name'",
      ),
    ),
  );
  assert.ok(
    lines.includes(
      'where lv IN ("ERROR","FATAL","PANIC","DPANIC","CRITICAL") OR (isnull(lv) AND match(msg,"^(panic:|fatal error:)"))',
    ),
  );
  assert.doesNotMatch(spl(false), /rex field=msg/);
});

test("T3: crash groups are ranked first and the search asks for one row more than the cap", () => {
  const text = spl(false);
  assert.match(text, /max\(crash\) as is_crash/);
  assert.match(text, /eval rank=is_crash\*1000000000\+today \| sort - rank \| head 301$/);
});

test("T3: the cap keeps a crash group with a tiny count and reports the cut", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    ns: "oms-prod",
    svc: "oms-api",
    lv: "ERROR",
    sig: `sig ${i}`,
    today: String(1000 - i),
  })) as unknown as SourceRow[];
  rows.push({
    ns: "oms-prod",
    svc: "oms-api",
    lv: "ERROR",
    sig: "rare",
    today: "1",
    is_crash: "1",
  } as unknown as SourceRow);
  const capped = (
    scan as unknown as {
      capSourceRows: (r: SourceRow[], n: number) => { rows: SourceRow[]; truncated: boolean };
    }
  ).capSourceRows(rows, 300);
  assert.equal(capped.truncated, true);
  assert.equal(capped.rows.length, 300);
  assert.ok(capped.rows.some((r) => r.sig === "rare"));
  const small = (
    scan as unknown as {
      capSourceRows: (r: SourceRow[], n: number) => { rows: SourceRow[]; truncated: boolean };
    }
  ).capSourceRows(rows.slice(0, 10), 300);
  assert.equal(small.truncated, false);
  assert.equal(small.rows.length, 10);
});

const sev = (o: Partial<Parameters<typeof assess>[0]>) =>
  assess({ level: "ERROR", signature: "", sample: "", today: 5, yesterday: 5, ...o });

test("T7: a retryable MySQL deadlock is not a crash", () => {
  const sample =
    "Error 1213 (40001): Deadlock found when trying to get lock; try restarting transaction";
  const r = sev({ signature: sample, sample });
  assert.notEqual(r.severity, "critical");
  assert.ok(!r.reasons.includes("panic"));
  assert.equal(
    sev({ signature: "fatal error: all goroutines are asleep - deadlock!" }).severity,
    "critical",
  );
});

test("T8: a recovered panic is not a crash unless the level says so", () => {
  const sample =
    "recovered from panic: runtime error: invalid memory address or nil pointer dereference";
  assert.notEqual(sev({ signature: sample, sample }).severity, "critical");
  assert.equal(sev({ level: "PANIC", signature: sample, sample }).severity, "critical");
  assert.equal(sev({ level: "FATAL", signature: sample, sample }).severity, "critical");
  assert.equal(sev({ signature: "panic: boom [recovered]\n\tpanic: boom" }).severity, "critical");
});

test("T9: bare duplicate, double and callback are not money; the same words with context are", () => {
  const spike = { today: 60, yesterday: 0 };
  for (const text of [
    "Duplicate entry '1' for key 'PRIMARY'",
    "double click detected",
    "callback timeout",
  ]) {
    const r = sev({ signature: text, sample: text, ...spike });
    assert.ok(!r.reasons.includes("money"), text);
    assert.equal(r.severity, "high", text);
  }
  for (const text of [
    "duplicate payment callback received",
    "double charge detected",
    "failed to check sign, err=sign not match",
  ]) {
    const r = sev({ signature: text, sample: text, ...spike });
    assert.ok(r.reasons.includes("money"), text);
    assert.equal(r.severity, "critical", text);
  }
});

test("the new flags exist and extra levels are off by default", () => {
  const pe = config.prodErrors as unknown as {
    extraLevels: boolean;
    renotifyDays: number;
    ignoreTtl: { days: number; wakeMinRate: number; wakeRatio: number; wakeMinCount: number };
  };
  assert.equal(pe.extraLevels, false);
  assert.equal(pe.ignoreTtl.days, 14);
  assert.equal(pe.ignoreTtl.wakeMinRate, 20);
  assert.equal(pe.ignoreTtl.wakeRatio, 5);
  assert.equal(pe.ignoreTtl.wakeMinCount, 50);
  assert.equal(pe.renotifyDays, 0);
});
