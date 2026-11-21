/**
 * CodeAct benchmark (P1-A, ADR 0008), no model calls: the payment-timeout fixture (spans → slow orders → logs →
 * timeout count) done the direct way (each tool result goes back to the model, capped as the surfaces cap it) and
 * as one CodeAct program. Measures the bytes the model would receive, the model turns the plan needs, and the real
 * wall time of the program in the OS sandbox (or a plain child process with --unsandboxed, for hosts without it).
 *
 *   node --disable-warning=ExperimentalWarning src/cli/benchCodeAct.ts [--runs 5] [--unsandboxed]
 */
import { config } from "../config.ts";
import { executeCode, type CodeActTool, type Launcher } from "../codeact/execute.ts";

const arg = (k: string) => process.argv.includes(k);
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 5;
const SPANS = Array.from({ length: 400 }, (_, i) => ({
  trace_id: `trace-${i}`,
  service: "payment-gateway",
  order_id: `ORD-${i % 80}`,
  duration_ms: i % 20 === 0 ? 9000 : 35,
  attributes: { "http.route": "/v1/pay", padding: "x".repeat(120) },
}));
const EVENTS = Array.from({ length: 600 }, (_, i) => ({
  _time: new Date(1_790_000_000_000 + i * 1000).toISOString(),
  order_id: `ORD-${i % 80}`,
  message: i % 4 === 0 ? "upstream timeout after 8s" : "payment accepted",
  raw: "y".repeat(160),
}));
const TOOLS: CodeActTool[] = [
  { name: "traces", summary: "", readOnly: true },
  { name: "logs", summary: "", readOnly: true },
];
const call = async (name: string, args: unknown) =>
  name === "traces"
    ? { ok: true, result: { spans: SPANS } }
    : {
        ok: true,
        result: {
          events: EVENTS.filter((e) =>
            (args as { order_ids: string[] }).order_ids.includes(e.order_id),
          ),
        },
      };
const PROGRAM = `
  const { spans } = await platform.callTool("traces", {});
  const slow = [...new Set(spans.filter((s) => s.duration_ms > 5000).map((s) => s.order_id))];
  const { events } = await platform.callTool("logs", { order_ids: slow });
  return { slow_orders: slow, timeouts: events.filter((e) => /timeout/.test(e.message)).length };`;

// Direct: the model receives each result (workflow caps a result at 40,000 chars; chat at 6,000 per call).
const slow = [...new Set(SPANS.filter((s) => s.duration_ms > 5000).map((s) => s.order_id))];
const direct = [
  JSON.stringify({ spans: SPANS }),
  JSON.stringify({ events: EVENTS.filter((e) => slow.includes(e.order_id)) }),
];
const cap = (n: number) => direct.reduce((a, t) => a + Math.min(t.length, n), 0);

const plain: Launcher = async (node, a) => ({
  command: node,
  args: a,
  env: { PATH: process.env.PATH ?? "" },
});
const times: number[] = [];
let answer = "";
for (let i = 0; i < runs; i++) {
  const r = await executeCode(
    { code: PROGRAM },
    { tools: () => TOOLS, call, ...(arg("--unsandboxed") ? { launch: plain } : {}) },
  );
  if (!r.ok) throw new Error(`${r.category}: ${r.error}`);
  times.push(r.stats.duration_ms);
  answer = JSON.stringify(r.value);
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      fixture: { spans: SPANS.length, events: EVENTS.length },
      direct: {
        tool_calls: 2,
        model_turns: 3,
        raw_result_bytes: direct.reduce((a, t) => a + t.length, 0),
        model_visible_bytes_workflow_cap: cap(40000),
        model_visible_bytes_chat_cap: cap(6000),
        note: "capped results are truncated: the direct path cannot see every span/event",
      },
      codeact: {
        tool_calls: 2,
        model_turns: 2,
        model_visible_bytes: answer.length,
        runtime: arg("--unsandboxed") ? "plain child process" : "OS sandbox",
        wall_ms: { p50: times[Math.floor(times.length / 2)], max: times.at(-1) },
        limits: config.codeAct,
      },
    },
    null,
    2,
  ),
);
