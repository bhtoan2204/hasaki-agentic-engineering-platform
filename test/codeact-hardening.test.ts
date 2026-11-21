/**
 * CodeAct hardening: cancellation, bounded nested-call scheduling, IPC/memory budgets and structured overflow. The
 * broker is exercised with a plain child process as the launcher (test-only) — these tests are about the parent's
 * lifecycle and accounting, not about the OS sandbox (test/codeact-sandbox.integration.ts covers that).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { executeCode, type CodeActTool, type Launcher } from "../src/codeact/execute.ts";

const DEFAULTS = { ...config.codeAct };
afterEach(() => Object.assign(config.codeAct, DEFAULTS));

const plainNode: Launcher = async (node, args) => ({
  command: node,
  args,
  env: { PATH: process.env.PATH ?? "" },
});
const TOOLS: CodeActTool[] = [
  { name: "slow", summary: "", readOnly: true },
  { name: "echo", summary: "", readOnly: true },
  { name: "big", summary: "", readOnly: true },
  { name: "boom", summary: "", readOnly: true },
];
/** Escapes the vm context on purpose: the program can always reach its own process (the sandbox is the boundary). */
const ESCAPE = `const proc = platform.callTool.constructor("return process")();`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A call surface whose `slow` calls wait until released or aborted. */
function surface() {
  const started: string[] = [];
  const aborted: string[] = [];
  const releases: Array<() => void> = [];
  return {
    started,
    aborted,
    release: () => releases.splice(0).forEach((r) => r()),
    call: (name: string, args: unknown, signal: AbortSignal) => {
      const tag = `${name}:${JSON.stringify(args)}`;
      started.push(tag);
      if (name === "echo") return Promise.resolve({ ok: true, result: args });
      if (name === "big")
        return Promise.resolve({
          ok: true,
          result: { blob: "x".repeat((args as { n: number }).n) },
        });
      if (name === "boom") return Promise.reject(new Error("tool exploded"));
      return new Promise<{ ok: boolean; result?: unknown }>((resolve) => {
        releases.push(() => resolve({ ok: true, result: tag }));
        signal.addEventListener("abort", () => aborted.push(tag), { once: true });
      });
    },
  };
}
const run = (code: string, s = surface(), extra: Partial<Parameters<typeof executeCode>[1]> = {}) =>
  executeCode({ code }, { tools: () => TOOLS, call: s.call, launch: plainNode, ...extra });

// ---------------------------------------------------------------- cancellation

test("cancellation during sandbox startup: nothing is spawned and the result is canceled", async () => {
  const ac = new AbortController();
  let cleaned = false;
  const slowLaunch: Launcher = async (node, args) => {
    await sleep(200);
    return {
      command: node,
      args,
      env: { PATH: process.env.PATH ?? "" },
      cleanup: () => (cleaned = true),
    };
  };
  setTimeout(() => ac.abort(new Error("attempt canceled")), 30);
  const s = surface();
  const r = await run(`await platform.callTool("echo", {a: 1}); return 1;`, s, {
    launch: slowLaunch,
    signal: ac.signal,
  });
  assert.equal(r.ok, false);
  assert.equal(r.category, "canceled");
  assert.deepEqual(s.started, [], "the program never ran");
  assert.equal(cleaned, true, "the launcher's resources were released");
});

test("cancellation while a nested tool runs: the tool sees the abort, queued calls never start", async () => {
  config.codeAct.maxConcurrency = 2;
  const ac = new AbortController();
  const s = surface();
  const p = run(
    `await Promise.all([1, 2, 3, 4, 5].map((i) => platform.callTool("slow", { i }))); return "done";`,
    s,
    { signal: ac.signal },
  );
  for (let i = 0; i < 100 && s.started.length < 2; i++) await sleep(10);
  ac.abort(new Error("lease lost"));
  const r = await p;
  assert.equal(r.category, "canceled");
  assert.equal(r.ok, false, "a canceled execution never succeeds");
  assert.match(r.error ?? "", /lease lost/, "the cancellation reason is preserved");
  await sleep(100);
  assert.deepEqual(s.started, ['slow:{"i":1}', 'slow:{"i":2}'], "queued calls did not start");
  assert.deepEqual(
    s.aborted.sort(),
    ['slow:{"i":1}', 'slow:{"i":2}'],
    "running calls saw the abort",
  );
});

test("a late nested result after cancellation is discarded and never recorded", async () => {
  const ac = new AbortController();
  const s = surface();
  const recorded: number[] = [];
  const p = run(`return await platform.callTool("slow", { i: 1 });`, s, {
    signal: ac.signal,
    record: (c) => void recorded.push(c.seq),
  });
  for (let i = 0; i < 100 && !s.started.length; i++) await sleep(10);
  ac.abort();
  const r = await p;
  s.release(); // the tool finishes anyway, too late
  await sleep(50);
  assert.equal(r.category, "canceled");
  assert.equal(r.value, undefined);
  assert.deepEqual(recorded, [], "no record for a call that completed after the end");
});

test("timeout and cancellation are distinct from an internal failure", async () => {
  config.codeAct.callTimeoutMs = 100;
  const t = await run(
    `return await platform.callTool("slow", {}).then(() => "ok", (e) => e.message);`,
  );
  assert.equal(t.ok, true);
  assert.match(String(t.value), /exceeded 100 ms/);
  assert.equal(t.calls[0].status, "timeout");
  const whole = await executeCode(
    { code: "while (true) {}", timeoutMs: 300 },
    { tools: () => TOOLS, call: surface().call, launch: plainNode },
  );
  assert.equal(whole.category, "timeout");
});

// ---------------------------------------------------------------- nested-call scheduling

test("concurrency is enforced strictly and queued calls start in FIFO order", async () => {
  config.codeAct.maxConcurrency = 2;
  const s = surface();
  let peak = 0;
  let live = 0;
  const call = async (_name: string, args: unknown, signal: AbortSignal) => {
    live++;
    peak = Math.max(peak, live);
    await sleep(30);
    live--;
    return s.call("echo", args, signal);
  };
  const r = await executeCode(
    {
      code: `return await Promise.all([1,2,3,4,5,6].map((i) => platform.callTool("slow", { i })));`,
    },
    { tools: () => TOOLS, call, launch: plainNode },
  );
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(peak, 2);
  assert.deepEqual(
    s.started,
    [1, 2, 3, 4, 5, 6].map((i) => `echo:{"i":${i}}`),
  );
});

test("the waiting queue is bounded: overflow is refused at once, not buffered", async () => {
  Object.assign(config.codeAct, { maxConcurrency: 1, maxQueuedCalls: 2, maxCalls: 50 });
  const s = surface();
  const p = run(
    `const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => platform.callTool("slow", { i })));
     return r.map((x) => x.status === "fulfilled" ? "ok" : x.reason.message);`,
    s,
  );
  for (let i = 0; i < 100 && !s.started.length; i++) await sleep(10);
  await sleep(50);
  for (let i = 0; i < 20; i++) {
    s.release();
    await sleep(10);
  }
  const r = await p;
  const value = r.value as string[];
  assert.equal(value.filter((v) => v === "ok").length, 3, "1 running + 2 queued");
  assert.equal(value.filter((v) => /queue/.test(v)).length, 5);
  assert.equal(r.calls.filter((c) => c.category === "budget_exceeded").length, 5);
});

test("time spent waiting for a slot counts toward a call's deadline", async () => {
  Object.assign(config.codeAct, { maxConcurrency: 1, callTimeoutMs: 300 });
  const s = surface();
  const r = await run(
    `const later = platform.callTool.constructor("return setTimeout")();
     const first = platform.callTool("slow", { i: 1 });
     await new Promise((ok) => later(ok, 150));
     const second = platform.callTool("slow", { i: 2 });
     const out = await Promise.allSettled([first, second]);
     return out.map((x) => x.status);`,
    s,
  );
  assert.deepEqual(r.value, ["rejected", "rejected"]);
  const [first, second] = r.calls;
  assert.equal(second.status, "timeout");
  assert.ok(first.ms >= 250, `first ran ${first.ms} ms`);
  assert.ok(second.ms < 250, `second only had what was left of its deadline: ran ${second.ms} ms`);
});

test("a rejecting tool frees its slot: later calls still run", async () => {
  config.codeAct.maxConcurrency = 1;
  const r = await run(`
    const a = await platform.callTool("boom", {}).catch((e) => e.message);
    const b = await platform.callTool("echo", { n: 2 });
    const c = await platform.callTool("echo", { n: 3 });
    return [a, b, c];`);
  assert.deepEqual(r.value, ["tool exploded", { n: 2 }, { n: 3 }]);
});

// ---------------------------------------------------------------- IPC and memory budgets

test("listTools is bounded and concurrent listTools calls all resolve", async () => {
  const r = await run(`
    const first = await Promise.all([platform.listTools(), platform.listTools()]);
    let refused = 0;
    for (let i = 0; i < 50; i++) await platform.listTools().catch(() => refused++);
    return { first: first.map((l) => l.length), refused };`);
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual((r.value as { first: number[] }).first, [4, 4]);
  assert.ok((r.value as { refused: number }).refused >= 40, JSON.stringify(r.value));
});

test("an oversized protocol line ends the execution as a budget violation", async () => {
  const r = await run(
    `${ESCAPE} proc.stdout.write("x".repeat(3_000_000)); await new Promise(() => {});`,
  );
  assert.equal(r.category, "budget_exceeded");
});

test("a flood of malformed protocol lines is cut off", async () => {
  const r = await run(
    `${ESCAPE} for (let i = 0; i < 20000; i++) proc.stdout.write("{not json\\n"); await new Promise(() => {});`,
  );
  assert.equal(r.category, "budget_exceeded");
});

test("a duplicate or invalid request id is a protocol violation", async () => {
  const r = await run(`${ESCAPE}
    proc.stdout.write(JSON.stringify({ t: "call", id: 7, name: "slow", args: {} }) + "\\n");
    proc.stdout.write(JSON.stringify({ t: "call", id: 7, name: "slow", args: {} }) + "\\n");
    await new Promise(() => {});`);
  assert.equal(r.category, "invalid_input");
  assert.match(r.error ?? "", /protocol/);
  const bad = await run(
    `${ESCAPE} proc.stdout.write(JSON.stringify({ t: "call", id: "x", name: "echo" }) + "\\n"); await new Promise(() => {});`,
  );
  assert.equal(bad.category, "invalid_input");
});

test("a single oversized tool result is refused, not forwarded", async () => {
  config.codeAct.maxCallResultBytes = 10_000;
  const r = await run(
    `return await platform.callTool("big", { n: 50_000 }).then(() => "forwarded", (e) => e.message);`,
  );
  assert.match(String(r.value), /result of big is \d+ bytes/);
  assert.equal(r.calls[0].category, "budget_exceeded");
  assert.ok(r.stats.result_bytes < 10_000, "an refused result is not counted as delivered");
});

test("parallel large results cannot push the delivered total past the budget", async () => {
  Object.assign(config.codeAct, {
    maxResultBytes: 100_000,
    maxCallResultBytes: 60_000,
    maxConcurrency: 4,
  });
  const r = await run(`
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => platform.callTool("big", { n: 40_000 })));
    return r.map((x) => x.status);`);
  const value = r.value as string[];
  assert.equal(value.filter((v) => v === "fulfilled").length, 2);
  assert.ok(r.stats.result_bytes <= 100_000, String(r.stats.result_bytes));
});

// ---------------------------------------------------------------- structured results

const value = async (expr: string, maxOutputBytes = 16000) => {
  config.codeAct.maxOutputBytes = maxOutputBytes;
  return run(`return ${expr};`);
};

test("bounded results keep their exact JSON value", async () => {
  for (const [expr, expected] of [
    ["{ a: 1, b: { c: [1, 2, { d: null }] } }", { a: 1, b: { c: [1, 2, { d: null }] } }],
    ["[1, 'two', [3]]", [1, "two", [3]]],
    ["null", null],
    ["undefined", null],
  ] as const) {
    const r = await value(expr);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, expected);
    assert.equal(r.truncated, undefined);
  }
});

test("an oversized result becomes a valid JSON preview with its original size, never broken JSON", async () => {
  for (const expr of [
    `"s".repeat(50000)`,
    `{ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, text: "row ".repeat(10) })), total: 2000 }`,
    `Array.from({ length: 5000 }, (_, i) => i)`,
  ]) {
    const r = await value(expr, 2000);
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.truncated, true, expr);
    assert.ok((r.original_bytes ?? 0) > 2000);
    const text = JSON.stringify(r.value);
    assert.ok(text.length <= 2000, `${expr}: preview ${text.length} bytes`);
    assert.deepEqual(JSON.parse(text), r.value, "the preview is real JSON");
  }
  const obj = await value(
    `{ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i })), total: 2000 }`,
    2000,
  );
  assert.equal((obj.value as { total: number }).total, 2000, "small fields survive in the preview");
});

test("non-serializable and cyclic results fail as internal errors", async () => {
  const big = await value("{ n: 10n }");
  assert.deepEqual([big.ok, big.category], [false, "internal"]);
  const cyclic = await run(`const a = {}; a.self = a; return a;`);
  assert.deepEqual([cyclic.ok, cyclic.category], [false, "internal"]);
});

test("a forged oversized preview from the program is rejected rather than trusted", async () => {
  config.codeAct.maxOutputBytes = 1000;
  const r = await run(`${ESCAPE}
    proc.stdout.write(JSON.stringify({ t: "done", truncated: true, original_bytes: 5, value: "y".repeat(5000) }) + "\\n");
    await new Promise(() => {});`);
  assert.equal(r.ok, false);
  assert.equal(r.category, "budget_exceeded");
});
