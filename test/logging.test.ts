import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { currentLogContext, log, logError, runWithLogContext } from "../src/logging.ts";
import { ignoreError } from "../src/ignoreError.ts";
import { resetRuntimeMetrics, runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";

const saved = {
  env: process.env.NODE_ENV,
  level: process.env.LOG_LEVEL,
  format: process.env.LOG_FORMAT,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  restore("NODE_ENV", saved.env);
  restore("LOG_LEVEL", saved.level);
  restore("LOG_FORMAT", saved.format);
  resetRuntimeMetrics();
});

test("outside production the console receives exactly what a bare console call would", (t) => {
  delete process.env.LOG_FORMAT;
  process.env.NODE_ENV = "test";
  const out = t.mock.method(console, "log", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  const err = t.mock.method(console, "error", () => {});
  const cause = new Error("boom");
  log.info("started", 1);
  log.warn("careful");
  log.error("failed:", cause);
  assert.deepEqual(out.mock.calls[0].arguments, ["started", 1]);
  assert.deepEqual(warn.mock.calls[0].arguments, ["careful"]);
  assert.deepEqual(err.mock.calls[0].arguments, ["failed:", cause]);
});

test("LOG_LEVEL drops quieter messages; debug is off by default", (t) => {
  process.env.NODE_ENV = "test";
  const debug = t.mock.method(console, "debug", () => {});
  const out = t.mock.method(console, "log", () => {});
  delete process.env.LOG_LEVEL;
  log.debug("hidden");
  assert.equal(debug.mock.callCount(), 0);
  process.env.LOG_LEVEL = "debug";
  log.debug("shown");
  assert.equal(debug.mock.callCount(), 1);
  process.env.LOG_LEVEL = "warn";
  log.info("dropped");
  assert.equal(out.mock.callCount(), 0);
});

test("production writes one JSON line per message, redacted, with the request ids", (t) => {
  process.env.NODE_ENV = "production";
  const out = t.mock.method(console, "log", () => {});
  const err = t.mock.method(console, "error", () => {});
  runWithLogContext({ request_id: "req-1", correlation_id: "corr-9" }, () => {
    log.info("connected with Bearer abcdefghijklmnopqrstuvwxyz");
    log.error("token=supersecretvalue1234 failed", new Error("password=hunter2hunter2"));
  });
  const info = JSON.parse(out.mock.calls[0].arguments[0]);
  assert.equal(info.level, "INFO");
  assert.equal(info.request_id, "req-1");
  assert.equal(info.correlation_id, "corr-9");
  assert.ok(info.time);
  assert.doesNotMatch(info.msg, /abcdefghijklmnop/);
  const error = JSON.parse(err.mock.calls[0].arguments[0]);
  assert.equal(error.level, "ERROR");
  assert.doesNotMatch(JSON.stringify(error), /supersecretvalue1234|hunter2hunter2/);
  // Outside a request there are no ids.
  log.info("no request");
  assert.equal(JSON.parse(out.mock.calls[1].arguments[0]).request_id, undefined);
});

test("the log context follows awaits and does not leak to other work", async () => {
  await runWithLogContext({ request_id: "a" }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(currentLogContext().request_id, "a");
  });
  assert.deepEqual(currentLogContext(), {});
});

test("logError keeps its structured shape and now carries the request ids", (t) => {
  const err = t.mock.method(console, "error", () => {});
  runWithLogContext({ request_id: "r7" }, () =>
    logError("x.failed", "It failed", new Error("nope"), { path: "/a" }),
  );
  const line = JSON.parse(err.mock.calls[0].arguments[0]);
  assert.equal(line.event, "x.failed");
  assert.equal(line.error, "nope");
  assert.equal(line.path, "/a");
  assert.equal(line.request_id, "r7");
  assert.equal(line.level, "ERROR");
});

test("ignoreError swallows, counts per call site and logs at debug level", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "debug";
  const debug = t.mock.method(console, "debug", () => {});
  await Promise.reject(new Error("harmless")).catch(ignoreError("test.site"));
  await Promise.reject("not an Error").catch(ignoreError("test.site"));
  assert.equal(runtimeMetricsSnapshot().ignored_errors["test.site"], 2);
  assert.match(String(debug.mock.calls[0].arguments[0]), /ignored error \(test\.site\): harmless/);
});
