import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { getRun, startRun } from "../src/workflow/engine.ts";
import { resolveAgentProvider } from "../src/agent/provider.ts";
import { isDuplicateAssistant, NdjsonStream } from "../src/agent/cursor/stream.ts";
import { cursorToolDecision } from "../src/agent/cursor/policyWatch.ts";
import { cursorAgentTurn, cursorCapabilities } from "../src/agent/cursor/run.ts";
import { attemptIsLive, dispatchPlatformTool } from "../src/agent/platformTools.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";

before(async () => {
  await migrate();
  await seedTemplates();
});
after(() => {
  delete process.env.CURSOR_AGENT_BIN;
  delete process.env.CURSOR_AGENT_TIMEOUT_MS;
  delete process.env.FAKE_MODE;
  return pool.end();
});

test("agent provider defaults to claude and rejects unknown values", () => {
  assert.equal(resolveAgentProvider(undefined), "claude");
  assert.equal(resolveAgentProvider(""), "claude");
  assert.equal(resolveAgentProvider("cursor"), "cursor");
  assert.throws(
    () => resolveAgentProvider("openai"),
    /agent_provider must be one of claude, cursor, codex/,
  );
});

test("a new run stores the provider and legacy creates stay on claude", async () => {
  const claude = await startRun({
    definitionKey: "feature-implementation",
    title: "legacy provider",
    start: false,
  });
  assert.equal((await getRun(claude.id)).agent_provider, "claude");
  const cursor = await startRun({
    definitionKey: "feature-implementation",
    title: "cursor provider",
    start: false,
    agentProvider: "cursor",
  });
  assert.equal((await getRun(cursor.id)).agent_provider, "cursor");
  await assert.rejects(
    () =>
      startRun({
        definitionKey: "feature-implementation",
        agentProvider: "gpt" as "claude",
        start: false,
      }),
    /agent_provider must be one of claude, cursor, codex/,
  );
});

test("stream parser keeps a partial line and rejects a bad event", () => {
  const p = new NdjsonStream();
  const first = p.push('{"type":"system","subtype":"init","session_id":"abc"}\n{"type":"assi');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].session_id, "abc");
  const second = p.push(
    'stant","message":{"content":[{"type":"text","text":"hello"}]},"timestamp_ms":1}\n',
  );
  assert.equal(second.events[0].text, "hello");
  assert.equal(isDuplicateAssistant(second.events[0], true), false);
  assert.equal(
    isDuplicateAssistant({ ...second.events[0], model_call_id: "m1", raw: {} }, true),
    true,
  );
  const bad = p.push("not-json\n");
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.events.length, 0);
  const tail = p.flush();
  assert.equal(tail.events.length, 0);
});

test("cursor native shell and writes use the same deny rules as Claude", () => {
  const policy: PolicyContext = {
    mode: "coding",
    workspaces: ["/wt/app"],
    baseBranch: "release/prod",
    protectedRoots: ["/src"],
  };
  const push = cursorToolDecision(
    { shellToolCall: { args: { command: "git push origin HEAD" } } },
    policy,
    "/wt/app",
  );
  assert.equal(push.allow, false);
  const outside = cursorToolDecision(
    { writeToolCall: { args: { path: "/src/app/main.go" } } },
    policy,
    "/wt/app",
  );
  assert.equal(outside.allow, false);
  const inside = cursorToolDecision(
    { writeToolCall: { args: { path: "/wt/app/main.go" } } },
    policy,
    "/wt/app",
  );
  assert.equal(inside.allow, true);
});

test("a dead attempt cannot submit a result", async () => {
  const live = await attemptIsLive(0, null);
  assert.equal(live.ok, false);
  const text = await dispatchPlatformTool(
    "submit_result",
    { output: { ok: true } },
    {
      runId: 0,
      stepId: 0,
      attemptId: 0,
      fencingToken: null,
      mode: "analysis",
      branch: "x",
      allowed: [],
      selected: [],
      prose: "English",
      knowledge: [],
      disclosure: [],
      upstream: {},
      stepType: "agent",
      log: async () => {},
      ask: async () => 0,
    },
  );
  assert.match(text, /^ERROR: refused submit_result/);
});

function fakeAgent(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-agent-"));
  const file = join(dir, "agent.js");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || ${JSON.stringify(mode)};
if (mode === "missing-flag") { process.stdout.write("--print\\n"); process.exit(0); }
if (args[0] === "--help" || args.includes("--help")) {
  process.stdout.write("--print --output-format --resume --mode --approve-mcps --trust --sandbox --force\\n");
  process.exit(0);
}
if (args[0] === "status") { process.stdout.write("Logged in as test\\n"); process.exit(0); }
if (mode === "no-result") { process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\\n'); process.exit(0); }
if (mode === "fail") { process.stderr.write("boom\\n"); process.exit(3); }
if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "partial") {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"sid-1","model":"Auto"}\\n');
  process.stdout.write('{"type":"assi');
  process.stdout.write('stant","message":{"content":[{"type":"text","text":"hello"}]},"timestamp_ms":1}\\n');
  process.stdout.write('{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"git push origin HEAD"}}}}\\n');
  process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"should not count","duration_ms":4}\\n');
  process.exit(0);
} else {
process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s","duration_ms":3}\\n');
process.exit(0);
}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function fakeCtx(signal: AbortSignal) {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      run: {
        id: 0,
        branch: "t",
        allowed_repositories: [],
        selected_repositories: [],
        output_locale: "en",
      },
      step: { id: 0, type: "agent", config: {}, key: "analyze" },
      attempt: { id: 0, fencing_token: null },
      signal,
      log: async (_k: string, content: string) => {
        logs.push(content);
      },
      recordSession: async () => {},
      recordMetrics: async () => {},
    } as any,
  };
}

test("missing CLI capability is reported and does not pretend to be Claude", async () => {
  process.env.CURSOR_AGENT_BIN = fakeAgent("missing-flag");
  const cap = await cursorCapabilities(true);
  assert.equal(cap.ok, false);
  assert.match(cap.error || "", /does not advertise --output-format/);
  assert.match(cap.error || "", /will not fall back to Claude/);
});

test("zero exit without a result event fails the turn", async () => {
  process.env.CURSOR_AGENT_BIN = fakeAgent("no-result");
  const ac = new AbortController();
  const { ctx } = fakeCtx(ac.signal);
  const dir = mkdtempSync(join(tmpdir(), "cursor-turn-"));
  const result = await cursorAgentTurn({
    ctx,
    mode: "analysis",
    policy: { mode: "analysis", workspaces: [], baseBranch: "release/prod", protectedRoots: [] },
    cwd: dir,
    prompt: "hi",
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /without a result event/);
});

test("nonzero exit and a denied git push are failures", async () => {
  process.env.CURSOR_AGENT_BIN = fakeAgent("fail");
  const ac = new AbortController();
  const dir = mkdtempSync(join(tmpdir(), "cursor-turn-"));
  const failed = await cursorAgentTurn({
    ctx: fakeCtx(ac.signal).ctx,
    mode: "analysis",
    policy: { mode: "analysis", workspaces: [dir], baseBranch: "release/prod", protectedRoots: [] },
    cwd: dir,
    prompt: "hi",
  });
  assert.equal(failed.isError, true);
  process.env.CURSOR_AGENT_BIN = fakeAgent("partial");
  const dir2 = mkdtempSync(join(tmpdir(), "cursor-turn-"));
  const blocked = await cursorAgentTurn({
    ctx: fakeCtx(ac.signal).ctx,
    mode: "coding",
    policy: {
      mode: "coding",
      workspaces: [dir2],
      baseBranch: "release/prod",
      protectedRoots: ["/src"],
    },
    cwd: dir2,
    prompt: "edit",
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /platform policy|git push|pushing/);
});

test("cancellation kills a hung Cursor process", async () => {
  process.env.CURSOR_AGENT_BIN = fakeAgent("hang");
  process.env.CURSOR_AGENT_TIMEOUT_MS = "300";
  const ac = new AbortController();
  const dir = mkdtempSync(join(tmpdir(), "cursor-turn-"));
  const started = Date.now();
  const result = await cursorAgentTurn({
    ctx: fakeCtx(ac.signal).ctx,
    mode: "analysis",
    policy: { mode: "analysis", workspaces: [], baseBranch: "release/prod", protectedRoots: [] },
    cwd: dir,
    prompt: "wait",
  });
  assert.equal(result.isError, true);
  assert.ok(Date.now() - started < 5000);
});

test("Cursor shares the attempt collector across invocations without overwriting tools or inventing usage", async () => {
  const { newMetrics } = await import("../src/agent/metrics.ts");
  const metrics = newMetrics("");
  metrics.provider = "cursor";
  process.env.CURSOR_AGENT_BIN = fakeAgent("partial");
  delete process.env.CURSOR_AGENT_TIMEOUT_MS;
  for (let i = 0; i < 2; i++) {
    const dir = mkdtempSync(join(tmpdir(), "cursor-metrics-"));
    await cursorAgentTurn({
      ctx: fakeCtx(new AbortController().signal).ctx,
      metrics,
      invocationId: `invocation-${i}`,
      mode: "coding",
      policy: { mode: "coding", workspaces: [dir], baseBranch: "release/prod", protectedRoots: [] },
      cwd: dir,
      prompt: "work",
    });
  }
  assert.equal(metrics.provider, "cursor");
  assert.equal(metrics.model, "Auto");
  assert.equal(metrics.sessions, 2);
  assert.equal(metrics.denied.length, 2);
  assert.equal(
    Object.values(metrics.tool_calls).reduce((a, b) => a + b, 0),
    2,
  );
  assert.equal(metrics.tokens, null);
  assert.equal(metrics.cost_usd, null);
});
