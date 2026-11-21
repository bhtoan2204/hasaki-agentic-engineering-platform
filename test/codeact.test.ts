/**
 * CodeAct (P1-A): read-only programmatic tool calling. The broker and limits are exercised here with a plain child
 * process as the launcher (test-only); the real OS sandbox is covered by test/codeact-sandbox.integration.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";

test("config defaults keep CodeAct off with the documented limits", () => {
  assert.deepEqual(config.codeAct, {
    enabled: false,
    timeoutMs: 20000,
    maxCodeBytes: 16384,
    maxOutputBytes: 16000,
    maxCalls: 20,
    maxResultBytes: 2000000,
    maxConcurrency: 4,
    callTimeoutMs: 15000,
    memoryMb: 256,
  });
});

// ---------------------------------------------------------------- executor and broker (test launcher: plain node)

import { executeCode, type CodeActTool, type Launcher } from "../src/codeact/execute.ts";

const plainNode: Launcher = async (node, args) => ({
  command: node,
  args,
  env: { PATH: process.env.PATH ?? "" },
});
const TOOLS: CodeActTool[] = [
  { name: "signoz_search_traces", summary: "traces", readOnly: true },
  { name: "splunk_search", summary: "logs", readOnly: true },
  { name: "kafka.publish", summary: "publish", readOnly: false },
];
const traces = Array.from({ length: 200 }, (_, i) => ({
  trace_id: `t${i}`,
  order_id: `O${i % 50}`,
  duration_ms: i % 10 === 0 ? 5000 : 40,
}));
const logs = Array.from({ length: 300 }, (_, i) => ({
  order_id: `O${i % 50}`,
  message: i % 3 ? "ok" : "gateway timeout",
}));
function fakeCalls() {
  const seen: string[] = [];
  return {
    seen,
    call: async (name: string, args: unknown) => {
      seen.push(name);
      if (name === "signoz_search_traces") return { ok: true, result: { spans: traces } };
      if (name === "splunk_search") {
        const ids = (args as { order_ids: string[] }).order_ids;
        return { ok: true, result: { events: logs.filter((l) => ids.includes(l.order_id)) } };
      }
      return { ok: false, error: "not a test tool" };
    },
  };
}
const run = (code: string, extra: Partial<Parameters<typeof executeCode>[1]> = {}) => {
  const f = fakeCalls();
  return executeCode(
    { code },
    { tools: () => TOOLS, call: f.call, launch: plainNode, ...extra },
  ).then((r) => ({ ...r, seen: f.seen }));
};

test("multiple read-only calls are correlated and only the returned value reaches the caller", async () => {
  const r = await run(`
    const { spans } = await platform.callTool("signoz_search_traces", { service: "payment" });
    const slow = [...new Set(spans.filter((s) => s.duration_ms > 1000).map((s) => s.order_id))];
    const { events } = await platform.callTool("splunk_search", { order_ids: slow });
    const timeouts = events.filter((e) => e.message === "gateway timeout");
    return { slow_orders: slow.length, timeouts: timeouts.length };
  `);
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(r.value, { slow_orders: 5, timeouts: 10 });
  assert.deepEqual(r.seen, ["signoz_search_traces", "splunk_search"]);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every((c) => c.status === "ok" && /^[0-9a-f]{64}$/.test(c.input_sha256)));
  assert.ok(
    r.stats.result_bytes > JSON.stringify(r.value).length * 50,
    "raw results stay out of the answer",
  );
});

test("a mutating or unknown tool is denied by the broker without being called", async () => {
  const r = await run(`
    const a = await platform.callTool("kafka.publish", { topic: "x", value: "y" }).catch((e) => e.message);
    const b = await platform.callTool("nope", {}).catch((e) => e.message);
    return { a, b };
  `);
  assert.equal(r.ok, true, r.error ?? "");
  assert.match(String((r.value as { a: string }).a), /read-only/);
  assert.match(String((r.value as { b: string }).b), /unknown tool/);
  assert.deepEqual(r.seen, [], "the surface never saw a denied call");
  assert.deepEqual(
    r.calls.map((c) => c.status),
    ["denied", "denied"],
  );
});

test("name variants never resolve to another tool", async () => {
  const r = await run(`
    const out = [];
    for (const n of ["Kafka.publish", "kafka.publish ", "mcp__platform__call_tool", "SPLUNK_SEARCH", "splunk_search\\u0000"])
      out.push(await platform.callTool(n, {}).then(() => "called", (e) => "denied"));
    return out;
  `);
  assert.deepEqual(r.value, ["denied", "denied", "denied", "denied", "denied"]);
  assert.deepEqual(r.seen, []);
});

test("listTools shows read-only tools only", async () => {
  const r = await run(`return (await platform.listTools()).map((t) => t.name);`);
  assert.deepEqual(r.value, ["signoz_search_traces", "splunk_search"]);
});

test("oversized code is rejected before anything is launched", async () => {
  let launched = false;
  const r = await executeCode(
    { code: "x".repeat(16385) },
    {
      tools: () => TOOLS,
      call: fakeCalls().call,
      launch: async (n, a) => ((launched = true), plainNode(n, a)),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.category, "invalid_input");
  assert.equal(launched, false);
});

test("an infinite loop is killed at the timeout", async () => {
  const started = Date.now();
  const r = await executeCode(
    { code: "while (true) {}", timeoutMs: 1500 },
    { tools: () => TOOLS, call: fakeCalls().call, launch: plainNode },
  );
  assert.equal(r.ok, false);
  assert.equal(r.category, "timeout");
  assert.ok(Date.now() - started < 6000);
});

test("aborting cancels a pending nested call and kills the program", async () => {
  const ac = new AbortController();
  let nestedSignal: AbortSignal | undefined;
  const p = executeCode(
    { code: `await platform.callTool("splunk_search", { order_ids: [] }); return 1;` },
    {
      tools: () => TOOLS,
      launch: plainNode,
      signal: ac.signal,
      call: (_n, _a, signal) => {
        nestedSignal = signal;
        setTimeout(() => ac.abort(), 50);
        return new Promise(() => {});
      },
    },
  );
  const r = await p;
  assert.equal(r.category, "canceled");
  assert.equal(nestedSignal?.aborted, true, "the nested call saw the cancellation");
});

test("output above maxOutputBytes is truncated, not dropped", async () => {
  const r = await run(`return "a".repeat(20000);`);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(JSON.stringify(r.value).length <= 16000 + 200);
});

test("the call budget stops further calls", async () => {
  const r = await run(`
    let denied = 0;
    for (let i = 0; i < 25; i++)
      await platform.callTool("splunk_search", { order_ids: [] }).catch(() => denied++);
    return denied;
  `);
  assert.equal(r.value, 5);
  assert.equal(r.seen.length, 20);
});

test("a program that throws or returns a non-serializable value fails cleanly", async () => {
  const thrown = await run(`throw new Error("boom")`);
  assert.equal(thrown.ok, false);
  assert.match(thrown.error ?? "", /boom/);
  const weird = await run(`return { n: 10n };`);
  assert.equal(weird.ok, false);
  assert.equal(weird.category, "internal");
});

test("stray stdout from the program does not break the protocol", async () => {
  const r = await run(`console.log("hello"); return 7;`);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.value, 7);
});
