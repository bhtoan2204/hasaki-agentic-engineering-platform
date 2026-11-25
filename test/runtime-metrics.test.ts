import { test } from "node:test";
import assert from "node:assert/strict";
import {
  count,
  countDecision,
  observe,
  registerGauge,
  resetRuntimeMetrics,
  runtimeMetricsSnapshot,
} from "../src/runtimeMetrics.ts";
import { pickEncoding } from "../src/http/compression.ts";
import { config } from "../src/config.ts";

test("runtime metrics: fixed names and labels, bucketed quantiles, gauges read at snapshot time", () => {
  resetRuntimeMetrics();
  count("db.statements", 3);
  for (const v of [1, 3, 3, 40, 900]) observe("db.transaction_ms", v);
  countDecision("REUSE");
  countDecision("run-42 secret label"); // not a known action: dropped, the label set stays fixed
  let busy = 2;
  registerGauge("test.busy", () => busy);
  busy = 5;
  const s = runtimeMetricsSnapshot();
  assert.equal(s.counters["db.statements"], 3);
  assert.deepEqual(s.histograms["db.transaction_ms"], {
    count: 5,
    avg: 189.4,
    p50_le: 5,
    p95_le: 1000,
    p99_le: 1000,
    max: 900,
  });
  assert.equal(s.replay_decisions.REUSE, 1);
  assert.equal(Object.keys(s.replay_decisions).includes("run-42 secret label"), false);
  assert.equal(s.gauges["test.busy"], 5);
  assert.ok(s.event_loop_ms.max >= 0);
});

test("compression negotiation: best accepted encoding, q=0 refuses, off switch", () => {
  assert.equal(pickEncoding("gzip, deflate, br"), "br");
  assert.equal(pickEncoding("gzip"), "gzip");
  assert.equal(pickEncoding("br;q=0, gzip;q=0.5"), "gzip");
  assert.equal(pickEncoding("br;q=0, gzip;q=0"), null);
  assert.equal(pickEncoding("*"), "br");
  assert.equal(pickEncoding("identity"), null);
  assert.equal(pickEncoding(undefined), null);
  config.server.compression = "off";
  try {
    assert.equal(pickEncoding("br"), null);
  } finally {
    config.server.compression = undefined;
  }
});

test("static compression: a fresh precompressed sibling is served as built, a stale one is ignored", async () => {
  const { mkdtempSync, writeFileSync, utimesSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { brotliDecompressSync } = await import("node:zlib");
  const { compressedStatic, compress } = await import("../src/http/compression.ts");
  const dir = mkdtempSync(join(tmpdir(), "precompress-"));
  const file = join(dir, "app.js");
  const body = Buffer.from("console.log('bundle');\n".repeat(200));
  writeFileSync(file, body);
  const sibling = await compress(Buffer.from("// precompressed\n"), "br");
  writeFileSync(`${file}.br`, sibling);
  const fresh = await compressedStatic(file, statSync(file).mtimeMs, body, "br");
  assert.deepEqual(fresh, sibling, "the build's copy, not a new compression");
  // The file changed after the build: its sibling is older and must not be served.
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  const rebuilt = await compressedStatic(file, statSync(file).mtimeMs, body, "br");
  assert.deepEqual(brotliDecompressSync(rebuilt), body);
});
