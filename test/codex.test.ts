import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import {
  answerQuestions,
  getRun,
  retryStep,
  startPendingRun,
  startRun,
} from "../src/workflow/engine.ts";
import { recordWorkspace } from "../src/git/provider.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import {
  claudeExecutor,
  codexModelFor,
  rankRepositoriesWithClaude,
  resumableSession,
} from "../src/agent/claude.ts";
import { resolveAgentProvider } from "../src/agent/provider.ts";
import { classifyCodexError, JsonlStream } from "../src/agent/codex/stream.ts";
import { codexHookDecision, patchPaths, shellCommandText } from "../src/agent/codex/policy.ts";
import { startBroker } from "../src/agent/codex/broker.ts";
import {
  codexAgentTurn,
  codexArgs,
  codexCapabilities,
  codexEnv,
  checkModel,
  redact,
} from "../src/agent/codex/run.ts";
import { npmCacheDir } from "../src/git/provider.ts";
import { completeForRun } from "../src/agent/complete.ts";
import { contractKeys, missingContractKeys } from "../src/agent/contract.ts";
import { claudeTestFailureAdvisor } from "../src/workflow/executors/testFailure.ts";
import { newMetrics } from "../src/agent/claude.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const HOOK = join(import.meta.dirname, "..", "src", "agent", "codex", "hook.ts");
const BRIDGE = join(import.meta.dirname, "..", "src", "agent", "codex", "bridge.ts");
let logFile = "";
let defSeq = 0;

before(async () => {
  await migrate();
  await seedTemplates();
  chmodSync(FAKE, 0o755);
  process.env.CODEX_BIN = FAKE;
  registerExecutor("agent", claudeExecutor);
  registerExecutor("coding_agent", claudeExecutor);
});
beforeEach(() => {
  logFile = join(mkdtempSync(join(tmpdir(), "fake-codex-log-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_MODE = "ok";
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_REASONING_EFFORT;
  delete process.env.CODEX_TIMEOUT_MS;
});
after(async () => {
  for (const k of [
    "CODEX_BIN",
    "FAKE_CODEX_LOG",
    "FAKE_CODEX_MODE",
    "FAKE_CODEX_TEXT",
    "FAKE_CODEX_PIDFILE",
    "CODEX_TIMEOUT_MS",
  ])
    delete process.env[k];
  await pool.end();
});

const fakeLog = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function workflow(steps: unknown[]) {
  const key = `codex-wf-${++defSeq}`;
  await definitions.create({ key, spec: { name: key, steps } });
  return key;
}
const stepOf = (runId: number, key: string) =>
  one<any>(pool, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, key]);
const attemptsOf = (runId: number, key: string) =>
  q<any>(
    pool,
    "SELECT a.* FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = $2 ORDER BY a.number",
    [runId, key],
  );

// ------------------------------------------------------------------ provider, migration, defaults

test("codex is a valid provider; omitted stays claude; unknown values are rejected", () => {
  assert.equal(resolveAgentProvider("codex"), "codex");
  assert.equal(resolveAgentProvider(undefined), "claude");
  assert.throws(
    () => resolveAgentProvider("openai"),
    /agent_provider must be one of claude, cursor, codex/,
  );
});

test("migration 017 accepts codex on runs and sessions, keeps claude as default and still rejects junk", async () => {
  const legacy = await startRun({
    definitionKey: "feature-implementation",
    title: "legacy",
    start: false,
  });
  assert.equal((await getRun(legacy.id)).agent_provider, "claude");
  const def = await one<{ d: string }>(
    pool,
    "SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'workflow_runs' AND column_name = 'agent_provider'",
  );
  assert.match(def!.d, /claude/);
  const run = await startRun({
    definitionKey: "feature-implementation",
    title: "codex",
    start: false,
    agentProvider: "codex",
  });
  assert.equal((await getRun(run.id)).agent_provider, "codex");
  await assert.rejects(
    pool.query("UPDATE workflow_runs SET agent_provider = 'gpt' WHERE id = $1", [run.id]),
    /check constraint/,
  );
  const checks = await q<{ n: string }>(
    pool,
    "SELECT conname AS n FROM pg_constraint WHERE conname IN ('workflow_runs_agent_provider_check', 'agent_sessions_provider_check')",
  );
  assert.equal(checks.length, 2, "one constraint each, replaced in place");
});

// ------------------------------------------------------------------ stream parsing

test("JSONL parser survives split chunks, split UTF-8 characters, bad lines and unknown events", () => {
  const p = new JsonlStream();
  const line = Buffer.from(
    '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"Xin chào – ✓"}}\n',
    "utf8",
  );
  const cut = line.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte character
  const a = p.push(
    Buffer.concat([
      Buffer.from('{"type":"thread.started","thread_id":"t-1"}\n{"type":"turn.sta'),
      line.subarray(0, 0),
    ]),
  );
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].type, "thread.started");
  const b = p.push(Buffer.concat([Buffer.from('rted"}\n'), line.subarray(0, cut)]));
  assert.deepEqual(
    b.events.map((e) => e.type),
    ["turn.started"],
  );
  const c = p.push(
    Buffer.concat([
      line.subarray(cut),
      Buffer.from(
        'not json\n{"type":"new.kind"}\n{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":1,"reasoning_output_tokens":1}}',
      ),
    ]),
  );
  assert.equal(c.errors.length, 1);
  const msg = c.events[0] as any;
  assert.equal(msg.item.text, "Xin chào – ✓");
  assert.equal(c.events[1].type, "unknown");
  const tail = p.flush();
  assert.equal(tail.events[0].type, "turn.completed");
  assert.equal((tail.events[0] as any).usage.input_tokens, 5);
});

test("error classification separates quota, auth and model failures", () => {
  assert.equal(classifyCodexError("You've hit your usage limit. Upgrade to Pro"), "quota");
  assert.equal(classifyCodexError("stream error: 429 Too Many Requests"), "quota");
  assert.equal(classifyCodexError("401 Unauthorized: please log in again"), "auth");
  assert.equal(
    classifyCodexError("The model `gpt-x` does not exist or you do not have access"),
    "model",
  );
  assert.equal(classifyCodexError("sandbox: command failed"), "error");
  assert.equal(
    redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"),
    "Authorization: Bearer [redacted]",
  );
});

// ------------------------------------------------------------------ pre-execution policy

const coding: PolicyContext = {
  mode: "coding",
  workspaces: ["/data/worktrees/u1-REQ-1/oms-api"],
  baseBranch: "release/prod",
  protectedRoots: ["/src"],
};
const analysis: PolicyContext = { ...coding, mode: "analysis" };

test("hook policy blocks forbidden commands, edits outside worktrees, secrets, unknown tools and escalation", () => {
  const cwd = "/data/worktrees/u1-REQ-1";
  const pre = (tool_name: string, tool_input: unknown, policy = coding) =>
    codexHookDecision({ hook_event_name: "PreToolUse", tool_name, tool_input }, policy, cwd);
  assert.equal(pre("Bash", { command: "git push origin HEAD" }).allow, false);
  assert.equal(
    pre("exec_command", { cmd: ["bash", "-lc", "git reset --hard HEAD~1"] }).allow,
    false,
  );
  assert.equal(pre("Bash", { command: "cat ~/.codex/auth.json" }).allow, false);
  assert.equal(pre("Bash", { command: "cat .env" }).allow, false);
  assert.equal(pre("Bash", { command: "go test ./...", workdir: "oms-api" }).allow, true);
  const inside = "*** Begin Patch\n*** Update File: oms-api/main.go\n@@\n-a\n+b\n*** End Patch";
  const outside = "*** Begin Patch\n*** Add File: /src/oms-api/main.go\n+x\n*** End Patch";
  assert.equal(pre("apply_patch", { command: inside }).allow, true);
  assert.equal(pre("apply_patch", { command: outside }).allow, false);
  assert.equal(
    pre("apply_patch", { command: inside }, analysis).allow,
    false,
    "analysis is read-only",
  );
  assert.equal(pre("Bash", { command: "rm -rf oms-api" }, analysis).allow, false);
  assert.equal(pre("Bash", { command: "rg refund oms-api" }, analysis).allow, true);
  assert.equal(pre("mcp__platform__submit_result", { output: {} }).allow, true);
  assert.equal(pre("mcp__github__create_pr", {}).allow, false);
  assert.equal(pre("spawn_agent", {}).allow, false);
  assert.equal(pre("some_future_tool", {}).allow, false, "unknown tools fail closed");
  assert.equal(
    codexHookDecision({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, coding, cwd)
      .allow,
    false,
  );
  assert.deepEqual(patchPaths(inside, cwd), ["/data/worktrees/u1-REQ-1/oms-api/main.go"]);
  assert.equal(shellCommandText({ command: ["bash", "-lc", "ls -la"] }), "ls -la");
});

test("hook process denies before execution, and fails closed when the broker is unreachable", async () => {
  const broker = await startBroker({
    policy: coding,
    cwd: "/data/worktrees/u1-REQ-1",
    dispatch: async () => "ok",
  });
  try {
    const push = await runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push origin HEAD" },
      },
      { PLATFORM_BROKER_SOCKET: broker.socketPath, PLATFORM_BROKER_TOKEN: broker.token },
    );
    assert.equal(push.code, 2);
    assert.equal(JSON.parse(push.stdout).hookSpecificOutput.permissionDecision, "deny");
    const ok = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
      { PLATFORM_BROKER_SOCKET: broker.socketPath, PLATFORM_BROKER_TOKEN: broker.token },
    );
    assert.equal(ok.code, 0);
    const forged = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
      { PLATFORM_BROKER_SOCKET: broker.socketPath, PLATFORM_BROKER_TOKEN: "wrong" },
    );
    assert.equal(forged.code, 2, "a wrong token is denied");
  } finally {
    await broker.close();
  }
  const none = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    {},
  );
  assert.equal(none.code, 2);
  assert.match(none.stderr, /platform policy unavailable/);
});

function runHook(
  payload: unknown,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOOK], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (b) => (stdout += b));
    c.stderr.on("data", (b) => (stderr += b));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
    c.stdin.end(JSON.stringify(payload));
  });
}

test("broker: tools are refused until hooks ran; after ask_user, edits and mutations are blocked", async () => {
  let paused = false;
  const calls: string[] = [];
  const policy = new Proxy(coding, {
    get: (t, k) => (k === "mode" && paused ? "analysis" : (t as any)[k]),
  });
  const broker = await startBroker({
    policy,
    cwd: "/data/worktrees/u1-REQ-1",
    async dispatch(name) {
      calls.push(name);
      if (name === "ask_user") paused = true;
      return "ok";
    },
  });
  const { brokerRequest } = await import("../src/agent/codex/client.ts");
  try {
    const early = await brokerRequest(broker.socketPath, {
      token: broker.token,
      kind: "tool",
      name: "post_update",
      args: {},
    });
    assert.match(early.text, /hooks are not active/);
    await brokerRequest(broker.socketPath, {
      token: broker.token,
      kind: "hook",
      payload: { hook_event_name: "SessionStart" },
    });
    assert.equal(
      (
        await brokerRequest(broker.socketPath, {
          token: broker.token,
          kind: "tool",
          name: "ask_user",
          args: {},
        })
      ).text,
      "ok",
    );
    const edit = await brokerRequest(broker.socketPath, {
      token: broker.token,
      kind: "hook",
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: oms-api/x.go\n+x\n*** End Patch" },
      },
    });
    assert.equal(edit.decision.allow, false);
    const prep = await brokerRequest(broker.socketPath, {
      token: broker.token,
      kind: "tool",
      name: "prepare_branch",
      args: { repo: "oms-api" },
    });
    assert.match(prep.text, /only available in coding steps/);
    const bad = await brokerRequest(broker.socketPath, {
      token: "x",
      kind: "tool",
      name: "submit_result",
      args: {},
    });
    assert.equal(bad.ok, false);
    assert.deepEqual(calls, ["ask_user"]);
  } finally {
    await broker.close();
  }
});

test("MCP bridge lists mode-scoped tools and relays calls only through the broker", async () => {
  const seen: string[] = [];
  const broker = await startBroker({
    policy: analysis,
    cwd: "/tmp",
    dispatch: async (n) => (seen.push(n), `did ${n}`),
  });
  await (
    await import("../src/agent/codex/client.ts")
  ).brokerRequest(broker.socketPath, {
    token: broker.token,
    kind: "hook",
    payload: { hook_event_name: "SessionStart" },
  });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BRIDGE], {
    env: {
      PATH: process.env.PATH,
      PLATFORM_MODE: "analysis",
      PLATFORM_BROKER_SOCKET: broker.socketPath,
      PLATFORM_BROKER_TOKEN: broker.token,
    },
  });
  const replies: any[] = [];
  let buf = "";
  child.stdout.on("data", (b) => {
    buf += b;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0)
      (replies.push(JSON.parse(buf.slice(0, nl))), (buf = buf.slice(nl + 1)));
  });
  const send = (id: number, method: string, params: unknown) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  send(1, "initialize", {});
  send(2, "tools/list", {});
  send(3, "tools/call", { name: "post_update", arguments: { message: "hi" } });
  send(4, "tools/call", { name: "commit_changes", arguments: { repo: "x", message: "m" } });
  for (let i = 0; i < 100 && replies.length < 4; i++) await new Promise((r) => setTimeout(r, 30));
  child.kill();
  await broker.close();
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  const names = byId[2].result.tools.map((t: any) => t.name);
  assert.ok(
    names.includes("submit_result") &&
      !names.includes("prepare_branch") &&
      !names.includes("commit_changes"),
  );
  assert.equal(byId[3].result.content[0].text, "did post_update");
  assert.equal(byId[4].result.isError, true, "coding-only tool is not offered in analysis");
  assert.deepEqual(seen, ["post_update"]);
});

// ------------------------------------------------------------------ invocation

test("codex argv: per-invocation config, sandbox by mode, no bypass flags, resume by explicit id", () => {
  const a = codexArgs({ mode: "analysis", cwd: "/w", scratch: "/tmp/s" });
  const c = codexArgs({
    mode: "coding",
    cwd: "/w",
    scratch: "/tmp/s",
    model: "gpt-test",
    effort: "high",
    resumeId: "th-9",
  });
  for (const args of [a, c]) {
    for (const f of ["--json", "--strict-config", "--ignore-user-config", "--ignore-rules"])
      assert.ok(args.includes(f), f);
    assert.ok(!args.includes("--last"));
    assert.ok(
      !args.some(
        (x) => x === "--dangerously-bypass-approvals-and-sandbox" || x === "--full-auto",
      ),
    );
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.some((x) => x.startsWith("hooks.PreToolUse=")));
    assert.ok(args.includes("multi_agent"), "subagents disabled");
    assert.ok(!args.join(" ").includes("DATABASE_URL="), "no secrets on the command line");
  }
  assert.ok(a.includes('sandbox_mode="read-only"'));
  assert.ok(!a.some((x) => x.includes("danger-full-access")));
  assert.ok(c.includes('sandbox_mode="danger-full-access"'));
  assert.ok(!c.some((x) => x.includes("sandbox_workspace_write")));
  const cache = JSON.stringify(npmCacheDir());
  assert.ok(c.some((x) => x.includes(`npm_config_cache=${cache}`)));
  assert.ok(!c.some((x) => x.includes("ctp-agent-tmp") && x.includes("npm_config_cache")));
  assert.deepEqual(c.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(c.slice(-2), ["th-9", "-"]);
  assert.ok(c.includes('model="gpt-test"') && c.includes('model_reasoning_effort="high"'));
  const env = codexEnv({
    PATH: "/bin",
    DATABASE_URL: "postgres://x",
    AUTH_SECRET: "s",
    OPENAI_API_KEY: "sk",
    CODEX_API_KEY: "k",
    BITBUCKET_TOKEN: "t",
    HOME: "/h",
    CODEX_HOME: "/h/.codex",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "HOME", "PATH"]);
});

test("Codex model routing never uses the Claude model; effort is separate", () => {
  process.env.CODEX_MODEL = "gpt-test";
  process.env.CODEX_REASONING_EFFORT = "high";
  const r = codexModelFor({ type: "agent", config: { model: "claude-opus-5-5" } });
  assert.deepEqual(r, { model: "gpt-test", source: "agent.codex.model", effort: "high" });
  assert.equal(
    codexModelFor({
      type: "agent",
      config: { codex_model: "gpt-x", codex_reasoning_effort: "low" },
    }).model,
    "gpt-x",
  );
  assert.equal(
    checkModel([{ slug: "gpt-test", efforts: ["low"] }], "gpt-test", "high")?.includes(
      "does not support reasoning effort",
    ),
    true,
  );
  assert.match(
    checkModel([{ slug: "gpt-test", efforts: ["low"] }], "claude-opus-5-5", "") ?? "",
    /not available/,
  );
});

test("probe reports missing CLI, old CLI, logged-out and unsupported model without calling a model", async () => {
  process.env.CODEX_BIN = "/nonexistent/codex";
  assert.equal((await codexCapabilities(true)).kind, "missing");
  process.env.CODEX_BIN = FAKE;
  process.env.FAKE_CODEX_MODE = "old-cli";
  assert.equal((await codexCapabilities(true)).kind, "unsupported");
  process.env.FAKE_CODEX_MODE = "logged-out";
  const lo = await codexCapabilities(true);
  assert.equal(lo.kind, "auth");
  assert.match(lo.error!, /codex login/);
  process.env.FAKE_CODEX_MODE = "ok";
  process.env.CODEX_MODEL = "gpt-missing";
  assert.equal((await codexCapabilities(true)).kind, "model");
  delete process.env.CODEX_MODEL;
  const ok = await codexCapabilities(true);
  assert.equal(ok.ok, true);
  assert.equal(ok.auth, "ChatGPT");
  assert.equal(fakeLog().length, 0, "no turn was started by the probe");
});

// ------------------------------------------------------------------ turn lifecycle (direct)

function fakeCtx(signal: AbortSignal) {
  const logs: Array<{ kind: string; content: string }> = [];
  return {
    logs,
    ctx: {
      run: {
        id: 0,
        branch: "t",
        allowed_repositories: [],
        selected_repositories: [],
        output_locale: "en",
        agent_provider: "codex",
      },
      step: { id: 0, type: "agent", config: {}, key: "analyze" },
      attempt: { id: 0, fencing_token: null },
      input: { upstream: {} },
      context: { knowledge: [], disclosure: [] },
      signal,
      log: async (kind: string, content: string) => void logs.push({ kind, content }),
      ask: async () => 0,
      recordSession: async () => {},
      recordMetrics: async () => {},
    } as any,
  };
}
const turn = (mode: "analysis" | "coding", signal = new AbortController().signal) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-turn-"));
  const f = fakeCtx(signal);
  const metrics = newMetrics("");
  return {
    f,
    metrics,
    run: () =>
      codexAgentTurn({
        ctx: f.ctx,
        mode,
        policy: { mode, workspaces: [], baseBranch: "release/prod", protectedRoots: [] },
        cwd: dir,
        prompt: "hi",
        metrics,
      }),
  };
};

test("missing turn.completed, process error after submit, and quota are failures (never success)", async () => {
  process.env.FAKE_CODEX_MODE = "incomplete";
  const inc = await turn("analysis").run();
  assert.equal(inc.isError, true);
  assert.equal(inc.failure, "incomplete");
  process.env.FAKE_CODEX_MODE = "fail-after-submit";
  const fas = await turn("analysis").run();
  assert.equal(fas.isError, true, "exit 1 after submit_result still fails");
  process.env.FAKE_CODEX_MODE = "quota";
  const qt = await turn("analysis").run();
  assert.equal(qt.failure, "quota");
  assert.match(qt.text, /does not switch to an API key/);
});

test("a tool that bypassed the hook stops the run", async () => {
  process.env.FAKE_CODEX_MODE = "nohook";
  const t = turn("coding");
  const r = await t.run();
  assert.equal(r.failure, "policy");
  assert.match(r.text, /pre-execution hook/);
});

test("hook denies git push and escalation in a real turn; secrets stay out of the CLI env; tokens are real and cost is null", async () => {
  process.env.FAKE_CODEX_MODE = "push";
  process.env.DATABASE_URL_BACKUP = process.env.DATABASE_URL;
  const t = turn("coding");
  const r = await t.run();
  const log = fakeLog();
  assert.equal(log.find((l) => "push" in l).push, 2);
  assert.equal(log.find((l) => "escalation" in l).escalation, 2);
  const start = log.find((l) => l.argv);
  assert.deepEqual(start.env, {
    DATABASE_URL: false,
    AUTH_SECRET: false,
    OPENAI_API_KEY: false,
    BROKER: true,
  });
  assert.equal(r.isError, false);
  assert.equal(t.metrics.cost_usd, null);
  assert.equal(t.metrics.tokens?.input, 120);
  assert.equal(t.metrics.tokens?.reasoning_output, 3);
  assert.ok(t.metrics.denied.some((d) => /pushing/.test(d.reason)));
  assert.equal(t.metrics.model, "gpt-test", "actual model from the hook payload");
  delete process.env.DATABASE_URL_BACKUP;
});

test("cancellation and timeout kill the Codex process tree, including detached children", async () => {
  for (const how of ["cancel", "timeout"] as const) {
    process.env.FAKE_CODEX_MODE = "hang";
    const pidFile = join(mkdtempSync(join(tmpdir(), "codex-pid-")), "pid");
    process.env.FAKE_CODEX_PIDFILE = pidFile;
    const ac = new AbortController();
    if (how === "timeout") process.env.CODEX_TIMEOUT_MS = "800";
    const t = turn("analysis", ac.signal);
    const started = Date.now();
    const p = t.run();
    for (let i = 0; i < 100 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 30));
    if (how === "cancel") ac.abort();
    const r = await p;
    delete process.env.CODEX_TIMEOUT_MS;
    assert.equal(r.failure, how === "cancel" ? "canceled" : "timeout");
    assert.ok(Date.now() - started < 8000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `${how}: grandchild ${pid} was killed`);
  }
});

// ------------------------------------------------------------------ through the engine

test("a Codex run completes through MCP submit_result, records codex session/metrics and keeps owner + provider", async () => {
  const key = await workflow([
    {
      key: "analyze",
      type: "agent",
      config: { output_contract: "{ goal, requirements: string[] }" },
    },
  ]);
  const owner = await one<{ id: number }>(pool, "SELECT id FROM users ORDER BY id LIMIT 1");
  const run = await startRun({
    definitionKey: key,
    title: "codex e2e",
    agentProvider: "codex",
    ownerId: owner?.id,
  });
  await drain();
  const step = await stepOf(run.id, "analyze");
  assert.equal(
    step.status,
    "COMPLETED",
    JSON.stringify((await attemptsOf(run.id, "analyze")).map((a) => a.error)),
  );
  assert.equal(step.output.goal, "from codex");
  const [a] = await attemptsOf(run.id, "analyze");
  assert.equal(a.metrics.provider, "codex");
  assert.equal(a.metrics.cost_usd, null);
  assert.equal(a.metrics.tokens.input, 120);
  const s = await one<any>(pool, "SELECT * FROM agent_sessions WHERE attempt_id = $1", [a.id]);
  assert.equal(s.provider, "codex");
  assert.equal(s.session_id, "th-1");
  const events = await q<any>(
    pool,
    "SELECT content FROM workflow_events WHERE attempt_id = $1 AND kind = 'agent'",
    [a.id],
  );
  assert.ok(
    events.some((e) => e.content === "Xong – kết quả ✓"),
    "multi-byte text intact across chunks",
  );
  const log = fakeLog();
  assert.ok(
    log.find((l) => l.argv).argv.includes('sandbox_mode="read-only"'),
    "analysis runs read-only",
  );
  assert.ok(!log.find((l) => l.tools).tools.includes("prepare_branch"));
  const reloaded = await getRun(run.id);
  assert.equal(reloaded.agent_provider, "codex");
  assert.equal(reloaded.owner_id, owner?.id ?? null);
});

test("Codex ask_user pauses the step, blocks edits while waiting, then resumes the SAME thread with the answer", async () => {
  const key = await workflow([
    {
      key: "plan",
      type: "coding_agent",
      config: { verify: false, output_contract: "{ goal, requirements }" },
    },
  ]);
  process.env.FAKE_CODEX_MODE = "ask";
  process.env.FAKE_CODEX_THREAD = "th-ask";
  const run = await startRun({ definitionKey: key, title: "codex ask", agentProvider: "codex" });
  await drain();
  assert.equal((await stepOf(run.id, "plan")).status, "WAITING_INPUT");
  assert.equal(
    fakeLog().find((l) => "editAfterAsk" in l).editAfterAsk,
    2,
    "edit denied while waiting for answers",
  );
  const qs = await q<any>(pool, "SELECT * FROM workflow_questions WHERE run_id = $1", [run.id]);
  process.env.FAKE_CODEX_MODE = "ok";
  delete process.env.FAKE_CODEX_THREAD;
  await answerQuestions({ [qs[0].id]: "Không" }, "dev");
  await drain();
  const step = await stepOf(run.id, "plan");
  assert.equal(
    step.status,
    "COMPLETED",
    JSON.stringify((await attemptsOf(run.id, "plan")).map((a) => a.error)),
  );
  assert.equal(step.output.goal, "resumed");
  assert.equal(step.output.answer_seen, true, "the developer's answer reached Codex");
  const resumed = fakeLog().find((l) => l.argv && l.resumeId);
  assert.equal(resumed.resumeId, "th-ask");
  assert.ok(!resumed.argv.includes("--last"));
  assert.ok(resumed.argv.includes('sandbox_mode="danger-full-access"'));
  assert.equal((await getRun(run.id)).agent_provider, "codex");
});

test("missing provider session rebuilds from durable answers without restarting the completed upstream step", async () => {
  const key = await workflow([
    { key: "before", type: "agent", config: { output_contract: "{ goal, requirements }" } },
    {
      key: "plan",
      type: "agent",
      depends_on: ["before"],
      config: { output_contract: "{ goal, requirements }" },
    },
  ]);
  const run = await startRun({ definitionKey: key, agentProvider: "codex" });
  // Execute only the upstream step before selecting ask behavior.
  const { runOnce } = await import("../src/workflow/scheduler.ts");
  await runOnce();
  process.env.FAKE_CODEX_MODE = "ask";
  process.env.FAKE_CODEX_THREAD = "th-missing";
  await drain();
  delete process.env.FAKE_CODEX_THREAD;
  const question = await one(
    pool,
    "SELECT id FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [run.id],
  );
  assert.ok(question);
  process.env.FAKE_CODEX_MODE = "resume-missing";
  await answerQuestions({ [question.id]: "Không" }, "dev");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal((await attemptsOf(run.id, "before")).length, 1);
  const attempts = await attemptsOf(run.id, "plan");
  assert.deepEqual(
    attempts.map((a) => a.status),
    ["WAITING_INPUT", "COMPLETED"],
  );
  const oldSession = await one(
    pool,
    "SELECT resumable FROM agent_sessions WHERE session_id='th-missing' AND provider='codex' ORDER BY id LIMIT 1",
  );
  assert.equal(oldSession.resumable, false);
  const logs = fakeLog().filter((l) => l.argv);
  assert.equal(logs.at(-2).resumeId, "th-missing");
  assert.equal(logs.at(-1).resumeId, null);
  assert.ok(logs.at(-1).prompt.includes("Không"), "fresh session receives stored answer");
  assert.ok(
    (
      await q(pool, "SELECT content FROM workflow_events WHERE run_id=$1 AND kind='system'", [
        run.id,
      ])
    ).some((e) => e.content.includes("rebuilding context from persisted step history")),
  );
});

test("no submit_result or output missing contract keys fails the step; retry keeps provider", async () => {
  const key = await workflow([
    {
      key: "analyze",
      type: "agent",
      config: { output_contract: "{ goal, requirements: string[] }" },
    },
  ]);
  process.env.FAKE_CODEX_MODE = "no-submit";
  const run = await startRun({ definitionKey: key, title: "no submit", agentProvider: "codex" });
  await drain();
  let atts = await attemptsOf(run.id, "analyze");
  assert.ok(atts.every((a) => a.status === "FAILED"));
  assert.match(atts[0].error.message, /without calling submit_result/);
  process.env.FAKE_CODEX_MODE = "bad-contract";
  await retryStep(run.id, "analyze").catch(() => {});
  await drain();
  atts = await attemptsOf(run.id, "analyze");
  assert.match(atts.at(-1).error?.message ?? "", /missing: goal, requirements/);
  assert.equal((await getRun(run.id)).agent_provider, "codex");
});

test("commit_changes commits inside the run worktree only, with repository hooks disabled", async () => {
  const key = await workflow([
    {
      key: "implement",
      type: "coding_agent",
      config: { verify: false, output_contract: "{ goal, requirements }" },
    },
  ]);
  const run = await startRun({
    definitionKey: key,
    title: "codex commit",
    agentProvider: "codex",
    start: false,
  });
  const ws = join(mkdtempSync(join(tmpdir(), "codex-wt-")), "oms-api");
  execFileSync("git", ["init", "-q", "-b", run.branch, ws]);
  execFileSync("git", [
    "-C",
    ws,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  writeFileSync(
    join(ws, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\ntouch " + join(ws, "HOOK_RAN") + "\nexit 1\n",
  );
  chmodSync(join(ws, ".git", "hooks", "pre-commit"), 0o755);
  await recordWorkspace(run.id, {
    repo: "oms-api",
    branch: run.branch,
    path: ws,
    created_from: "test",
  });
  process.env.FAKE_CODEX_MODE = "commit";
  process.env.FAKE_CODEX_WS = ws;
  await startPendingRun(run.id);
  await drain();
  delete process.env.FAKE_CODEX_WS;
  const entry = fakeLog().find((l) => "commit" in l);
  assert.match(entry.outside, /outside the worktree/);
  assert.match(entry.commit, /Committed \w+ feat: add feature/);
  assert.equal(
    execFileSync("git", ["-C", ws, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
    "feat: add feature",
  );
  assert.equal(
    existsSync(join(ws, "HOOK_RAN")),
    false,
    "repository hooks never run outside the sandbox",
  );
  assert.equal((await stepOf(run.id, "implement")).status, "COMPLETED");
});

test("delegation is rejected before Codex starts", async () => {
  const key = await workflow([
    { key: "analyze", type: "agent", config: { delegation: { enabled: true } } },
  ]);
  const run = await startRun({ definitionKey: key, title: "delegation", agentProvider: "codex" });
  await drain();
  const [a] = await attemptsOf(run.id, "analyze");
  assert.match(a.error.message, /delegation is unsupported/);
  assert.equal(fakeLog().filter((l) => l.argv).length, 0, "no Codex turn ran");
});

test("session lookup never crosses provider, step or user", async () => {
  const key = await workflow([{ key: "plan", type: "agent" }]);
  const users = await q<{ id: number }>(pool, "SELECT id FROM users ORDER BY id LIMIT 2");
  const a = await startRun({
    definitionKey: key,
    title: "a",
    agentProvider: "codex",
    start: false,
    ownerId: users[0]?.id,
  });
  const b = await startRun({
    definitionKey: key,
    title: "b",
    agentProvider: "codex",
    start: false,
    ownerId: users[1]?.id ?? users[0]?.id,
  });
  const stepA = await stepOf(a.id, "plan");
  const stepB = await stepOf(b.id, "plan");
  const att = await one<{ id: number }>(
    pool,
    "INSERT INTO workflow_step_attempts (run_id, step_id, number, status, generation) VALUES ($1, $2, 1, 'COMPLETED', $3) RETURNING id",
    [a.id, stepA.id, stepA.generation],
  );
  await pool.query(
    "INSERT INTO agent_sessions (attempt_id, session_id, cwd, model, provider) VALUES ($1, 'claude-sess', '/cwd', '', 'claude'), ($1, 'codex-sess', '/cwd', '', 'codex')",
    [att!.id],
  );
  const ctx = (step: any, _provider: string) =>
    ({ step, input: { pending: { feedback: "again" } }, context: { snapshot_id: null } }) as any;
  assert.equal(
    (await resumableSession(ctx(stepA, "codex"), "/cwd", "codex"))?.sessionId,
    "codex-sess",
  );
  assert.equal(
    (await resumableSession(ctx(stepA, "claude"), "/cwd", "claude"))?.sessionId,
    "claude-sess",
  );
  assert.equal(
    await resumableSession(ctx(stepB, "codex"), "/cwd", "codex"),
    null,
    "another run (another user) never sees it",
  );
  assert.equal(
    await resumableSession(ctx(stepA, "codex"), "/other", "codex"),
    null,
    "another workspace never sees it",
  );
});

// ------------------------------------------------------------------ auxiliary AI calls

test("auxiliary calls of a Codex run go to Codex, not Claude (ranking, test-failure advisor, completion)", async () => {
  process.env.FAKE_CODEX_MODE = "complete";
  process.env.FAKE_CODEX_TEXT = '[{"repo":"oms-api","score":9,"reasons":["refund flow"]}]';
  const recorded: any[] = [];
  const ctx = {
    run: { id: 0, title: "x", agent_provider: "codex", output_locale: "en" },
    input: { upstream: {}, work_item: { title: "refund" } },
    signal: new AbortController().signal,
    recordMetrics: async (m: any) => void recorded.push(m),
  } as any;
  const ranked = await rankRepositoriesWithClaude(
    ctx,
    [],
    [
      {
        name: "oms-api",
        description: "",
        services: [],
        tags: [],
        projects: [],
        dependencies: [],
      } as any,
    ],
  );
  assert.equal(ranked[0].repo, "oms-api");
  assert.equal(recorded[0].ranking.provider, "codex");
  assert.equal(recorded[0].ranking.cost_usd, null);
  process.env.FAKE_CODEX_TEXT = '{"text":"build failed","suggestion":"fix import"}';
  const ex = await claudeTestFailureAdvisor.explain(
    { command: "go test", base_sha: "", failures: [] } as any,
    "en",
    "codex",
  );
  assert.equal(ex.suggestion, "fix import");
  const c = await completeForRun({ agent_provider: "codex" }, "hi");
  assert.equal(c.provider, "codex");
  assert.ok(
    fakeLog().every((l) => !l.argv || l.argv.includes("--ephemeral")),
    "aux calls are ephemeral read-only sessions",
  );
  assert.ok(fakeLog().every((l) => !l.argv || l.argv.includes('sandbox_mode="read-only"')));
  delete process.env.FAKE_CODEX_TEXT;
});

test("output contract keys", () => {
  assert.deepEqual(
    contractKeys(
      "{ goal, requirements: string[], pull_requests: { [repo]: { title } }, verification }",
    ),
    ["goal", "requirements", "pull_requests", "verification"],
  );
  assert.deepEqual(missingContractKeys("{ a, b }", { a: 1 }), ["b"]);
  assert.deepEqual(contractKeys("free text"), []);
});
