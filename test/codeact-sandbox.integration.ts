/**
 * CodeAct in the real OS sandbox (P1-A). The program deliberately escapes the vm context (through a host function's
 * constructor) to get the real `process`: the boundary under test is the sandbox, not vm. Skipped, with the probe's
 * reason, on a host without the isolation runtime (CodeAct is then unavailable there too).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { probeIsolation } from "../src/agent/isolation.ts";
import { codeActAvailability, executeCode, type CodeActTool } from "../src/codeact/execute.ts";

const runtime = await probeIsolation(true);
const skip = runtime.available ? false : `OS isolation unavailable: ${runtime.problems.join("; ")}`;
const TOOLS: CodeActTool[] = [{ name: "echo", summary: "echo", readOnly: true }];
const call = async (_n: string, args: unknown) => ({ ok: true, result: args });
const ESCAPE = `const proc = platform.callTool.constructor("return process")();`;

test("availability is fail-closed: disabled flag, then the probe", { skip }, async () => {
  const old = config.codeAct.enabled;
  try {
    config.codeAct.enabled = false;
    assert.match(String(await codeActAvailability()), /disabled/);
    config.codeAct.enabled = true;
    assert.equal(await codeActAvailability(), true);
  } finally {
    config.codeAct.enabled = old;
  }
});

test(
  "secrets, credentials, the data directory and the network are unreachable",
  { skip },
  async () => {
    process.env.CODEACT_TEST_SECRET = "s3cr3t-value";
    const r = await executeCode(
      {
        code: `${ESCAPE}
        const fs = proc.getBuiltinModule("node:fs");
        const tryRead = (p) => { try { fs.readdirSync(p); return "readable"; } catch (e) { return e.code; } };
        const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); return "written"; } catch (e) { return e.code; } };
        let net;
        try { await fetch("http://1.1.1.1/"); net = "reachable"; } catch (e) { net = "blocked"; }
        return {
          secret: proc.env.CODEACT_TEST_SECRET ?? null,
          database: proc.env.DATABASE_URL ?? null,
          home: tryRead(${JSON.stringify(process.env.HOME ?? "/root")}),
          data: tryRead(${JSON.stringify(config.dataDir)}),
          write: tryWrite("/tmp/codeact-probe"),
          spawn: (() => { try { proc.getBuiltinModule("node:child_process").execSync("id"); return "spawned"; } catch (e) { return "refused"; } })(),
          net,
        };`,
      },
      { tools: () => TOOLS, call },
    );
    delete process.env.CODEACT_TEST_SECRET;
    assert.equal(r.ok, true, r.error ?? "");
    const v = r.value as Record<string, string | null>;
    assert.equal(v.secret, null, "the worker environment is not inherited");
    assert.equal(v.database, null);
    assert.notEqual(v.home, "readable", "HOME is masked / not permitted");
    assert.notEqual(v.data, "readable", "the platform data directory is not visible");
    assert.notEqual(v.write, "written", "no file system writes");
    assert.equal(v.spawn, "refused", "no child processes");
    assert.equal(v.net, "blocked", "no network");
  },
);

test("concurrent executions share nothing", { skip }, async () => {
  const program = (tag: string) => `${ESCAPE}
    proc.__mark ??= ${JSON.stringify(tag)};
    await platform.callTool("echo", { tag: ${JSON.stringify(tag)} });
    return proc.__mark;`;
  const [a, b] = await Promise.all([
    executeCode({ code: program("A") }, { tools: () => TOOLS, call }),
    executeCode({ code: program("B") }, { tools: () => TOOLS, call }),
  ]);
  assert.deepEqual([a.value, b.value], ["A", "B"]);
});

test("a timed-out program leaves no process behind", { skip }, async () => {
  const r = await executeCode(
    { code: "while (true) {}", timeoutMs: 1500 },
    { tools: () => TOOLS, call },
  );
  assert.equal(r.category, "timeout");
  await new Promise((res) => setTimeout(res, 500));
  let left = "";
  try {
    left = execFileSync("pgrep", ["-af", "codeact/runner\\.mjs"], { encoding: "utf8" });
  } catch {
    left = ""; // pgrep exits 1 when nothing matches
  }
  assert.equal(left.trim(), "", "no runner process survives");
});

const runnerProcesses = () => {
  try {
    return execFileSync("pgrep", ["-af", "codeact/runner\\.mjs"], { encoding: "utf8" }).trim();
  } catch {
    return ""; // pgrep exits 1 when nothing matches
  }
};

test("cancelling a sandboxed program mid-call kills it: no process is left", { skip }, async () => {
  const ac = new AbortController();
  let started = false;
  const pending = executeCode(
    { code: `await platform.callTool("echo", {}); while (true) {}` },
    {
      tools: () => TOOLS,
      signal: ac.signal,
      call: async (_n, args) => {
        started = true;
        return { ok: true, result: args };
      },
    },
  );
  for (let i = 0; i < 300 && !started; i++) await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  ac.abort(new Error("attempt canceled"));
  const r = await pending;
  assert.equal(r.category, "canceled");
  assert.ok(Date.now() - t0 < 1000, "cancellation is prompt");
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(runnerProcesses(), "");
});

test(
  "an IPC flood from inside the sandbox is cut off and leaves no process",
  { skip },
  async () => {
    const r = await executeCode(
      {
        code: `${ESCAPE} for (let i = 0; i < 50000; i++) proc.stdout.write("{}\\n"); await new Promise(() => {});`,
      },
      { tools: () => TOOLS, call },
    );
    assert.equal(r.category, "budget_exceeded");
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(runnerProcesses(), "");
  },
);
