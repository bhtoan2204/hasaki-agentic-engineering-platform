/**
 * CodeAct failure diagnostics: every failed execution carries a sanitized `failure` (category, phase, and the nested
 * tool involved when there is one) that tells a syntax error from a runtime error, a sandbox problem from a tool
 * problem, and a nested-tool failure from the program's own bug. No program text or tool payload is in it.
 * Plain child process as the launcher (test-only); the real OS sandbox is covered by the integration tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  CodeActError,
  executeCode,
  recoveryAdvice,
  type CodeActCall,
  type CodeActTool,
  type Launcher,
} from "../src/codeact/execute.ts";

const plainNode: Launcher = async (node, args) => ({
  command: node,
  args,
  env: { PATH: process.env.PATH ?? "" },
});
const TOOLS: CodeActTool[] = [
  { name: "traces", summary: "traces", readOnly: true },
  { name: "kafka.publish", summary: "publish", readOnly: false },
];
const okCall: CodeActCall = async () => ({ ok: true, result: { spans: [1, 2] } });
const run = (code: string, call: CodeActCall = okCall, extra = {}) =>
  executeCode({ code }, { tools: () => TOOLS, call, launch: plainNode, ...extra });

async function withLimits<T>(limits: Partial<typeof config.codeAct>, fn: () => Promise<T>) {
  const saved = { ...config.codeAct };
  Object.assign(config.codeAct, limits);
  try {
    return await fn();
  } finally {
    Object.assign(config.codeAct, saved);
  }
}

test("a syntax error is a compile-phase failure, distinct from a runtime error", async () => {
  const syntax = await run(`return {;`);
  assert.equal(syntax.ok, false);
  assert.deepEqual(syntax.failure, { category: "program_syntax_error", phase: "program_compile" });
  const runtime = await run(`const x = null; return x.y;`);
  assert.deepEqual(runtime.failure, { category: "program_runtime_error", phase: "program_run" });
});

test("an uncaught nested-tool failure names the tool and its category, never its payload", async () => {
  const r = await run(
    `const a = await platform.callTool("traces", {}); const b = await platform.callTool("traces", { service: "refund-worker" }); return 1;`,
    async (_n, args) =>
      (args as { service?: string }).service
        ? { ok: false, error: "SigNoz unavailable for refund-worker (HTTP 503) token=abc" }
        : { ok: true, result: { spans: [] } },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.failure, {
    category: "program_runtime_error",
    phase: "program_run",
    last_nested_failure: { seq: 2, tool: "traces", category: "tool_invocation_failed" },
  });
  assert.ok(!JSON.stringify(r.failure).includes("503"), "no tool payload in the diagnosis");
  assert.equal(r.calls[1].failure, "tool_invocation_failed");
});

test("unknown, unauthorized and invalid-argument nested calls are told apart", async () => {
  const unknown = await run(`return await platform.callTool("nope", {});`);
  assert.deepEqual(unknown.failure?.last_nested_failure, {
    seq: 1,
    tool: null,
    category: "unknown_tool",
  });
  const mutating = await run(`return await platform.callTool("kafka.publish", {});`);
  assert.deepEqual(mutating.failure?.last_nested_failure, {
    seq: 1,
    tool: "kafka.publish",
    category: "unauthorized_tool",
  });
  const invalid = await run(`return await platform.callTool("traces", { x: 1 });`, async () => ({
    ok: false,
    error: "invalid arguments: service required",
    category: "invalid_input",
  }));
  assert.equal(invalid.failure?.last_nested_failure?.category, "invalid_tool_arguments");
  const denied = await run(`return await platform.callTool("traces", {});`, async () => ({
    ok: false,
    error: "denied: excluded",
    category: "unauthorized",
  }));
  assert.equal(denied.failure?.last_nested_failure?.category, "unauthorized_tool");
});

test("nested timeout, oversized nested result and exhausted call budget have their own categories", async () => {
  await withLimits({ callTimeoutMs: 100 }, async () => {
    const r = await run(
      `return await platform.callTool("traces", {});`,
      () => new Promise(() => {}),
    );
    assert.equal(r.failure?.last_nested_failure?.category, "nested_tool_timeout");
  });
  await withLimits({ maxCallResultBytes: 1000 }, async () => {
    const r = await run(`return await platform.callTool("traces", {});`, async () => ({
      ok: true,
      result: "x".repeat(5000),
    }));
    assert.equal(r.failure?.last_nested_failure?.category, "tool_output_too_large");
  });
  await withLimits({ maxCalls: 1 }, async () => {
    const r = await run(
      `await platform.callTool("traces", {}); return await platform.callTool("traces", {});`,
    );
    assert.equal(r.failure?.last_nested_failure?.category, "resource_budget_exceeded");
  });
});

test("a program that recovers from a nested failure succeeds, and the failure stays visible on its call", async () => {
  const r = await run(
    `let n = 0; try { await platform.callTool("traces", {}); } catch { n = -1; } return n;`,
    async () => ({ ok: false, error: "503" }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.failure, undefined);
  assert.equal(r.calls[0].status, "error");
  assert.equal(r.calls[0].failure, "tool_invocation_failed");
});

test("sandbox unavailable, sandbox startup failure and a runner that dies silently are told apart", async () => {
  const unavailable = await run(`return 1`, okCall, {
    launch: async () => {
      throw new CodeActError("dependency_unavailable", "bwrap missing");
    },
  });
  assert.deepEqual(unavailable.failure, {
    category: "sandbox_unavailable",
    phase: "sandbox_launch",
  });
  const broken = await run(`return 1`, okCall, {
    launch: async () => {
      throw new Error("mkdtemp failed");
    },
  });
  assert.deepEqual(broken.failure, { category: "sandbox_startup_failed", phase: "sandbox_launch" });
  const silent = await run(`return 1`, okCall, {
    launch: async (node: string) => ({ command: node, args: ["-e", "process.exit(3)"], env: {} }),
  });
  assert.deepEqual(silent.failure, { category: "sandbox_startup_failed", phase: "sandbox_start" });
  const killed = await run(`return 1`, okCall, {
    launch: async (node: string) => ({
      command: node,
      args: ["-e", `process.stdout.write(JSON.stringify({t:"started"})+"\\n"); process.exit(9)`],
      env: {},
    }),
  });
  assert.deepEqual(killed.failure, { category: "process_terminated", phase: "program_run" });
});

test("protocol violations, timeouts, cancellation and invalid programs are categorized", async () => {
  const violation = await run(`return 1`, okCall, {
    launch: async (node: string) => ({
      command: node,
      args: [
        "-e",
        `process.stdout.write(JSON.stringify({t:"call",id:-1,name:"traces"})+"\\n"); setTimeout(()=>{},5000)`,
      ],
      env: {},
    }),
  });
  assert.deepEqual(violation.failure, { category: "ipc_protocol_error", phase: "program_run" });
  const slow = await executeCode(
    { code: "while (true) {}", timeoutMs: 300 },
    { tools: () => TOOLS, call: okCall, launch: plainNode },
  );
  assert.deepEqual(slow.failure, { category: "execution_timeout", phase: "program_run" });
  const ac = new AbortController();
  const p = executeCode(
    { code: `await platform.callTool("traces", {}); return 1;` },
    {
      tools: () => TOOLS,
      launch: plainNode,
      signal: ac.signal,
      call: () => {
        setTimeout(() => ac.abort(), 20);
        return new Promise(() => {});
      },
    },
  );
  assert.equal((await p).failure?.category, "canceled");
  const empty = await run("   ");
  assert.deepEqual(empty.failure, { category: "invalid_program", phase: "validate" });
});

test("recovery advice: retry only what a corrected program can fix; never retry unavailable or unauthorized", () => {
  assert.equal(
    recoveryAdvice({ category: "program_syntax_error", phase: "program_compile" }).retry,
    "fix_program",
  );
  assert.equal(
    recoveryAdvice({
      category: "program_runtime_error",
      phase: "program_run",
      last_nested_failure: { seq: 1, tool: "traces", category: "invalid_tool_arguments" },
    }).retry,
    "fix_arguments",
  );
  assert.equal(
    recoveryAdvice({
      category: "program_runtime_error",
      phase: "program_run",
      last_nested_failure: { seq: 1, tool: "traces", category: "tool_invocation_failed" },
    }).retry,
    "handle_partial_failure",
  );
  assert.equal(recoveryAdvice({ category: "output_too_large", phase: "result" }).retry, "narrow");
  for (const category of ["sandbox_unavailable", "canceled"] as const)
    assert.equal(recoveryAdvice({ category, phase: "sandbox_launch" }).retry, "no");
  assert.equal(
    recoveryAdvice({
      category: "program_runtime_error",
      phase: "program_run",
      last_nested_failure: { seq: 1, tool: null, category: "unauthorized_tool" },
    }).retry,
    "no",
  );
});
