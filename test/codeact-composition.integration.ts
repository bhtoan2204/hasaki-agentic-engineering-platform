/**
 * CodeAct unified read-only composition (M3): one program composes integration tools with code intelligence, LSP,
 * knowledge/memory and run context through the platform's real dispatchers (`dispatchPlatformTool` for workflows,
 * `executeChatTool` for Chat). Authorization, scope, freshness and provenance are the direct path's; the program can
 * neither widen them nor reach anything outside the allowlist. Fixture repositories, users and data are fake.
 */
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { startPlatformGo } from "./fixtures/platformGo.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, beginAttempt, cancelRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { makeContext } from "../src/workflow/executors/registry.ts";
import { workItems } from "../src/workitems/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { repositories } from "../src/repos/service.ts";
import { envFromExecution, dispatchPlatformTool } from "../src/agent/platformTools.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { registerIntegrationTool } from "../src/agent/toolRegistry.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { resolveCodeActEvidence } from "../src/codeact/surfaces.ts";
import { closeAllSessions } from "../src/codeIntelligence/lsp/sessions.ts";
import { probeIsolation } from "../src/agent/isolation.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const policy = {
  mode: "analysis" as const,
  workspaces: [],
  protectedRoots: [],
  baseBranch: "main",
};
const runs: number[] = [];
let a: PublicUser;
let b: PublicUser;
let platformGo: Awaited<ReturnType<typeof startPlatformGo>> | undefined;
let logsDown = false;
let questionsAsked = 0;
const GO_REPO = "compose-go";
const TS_REPO = "compose-ts";
const TS_A = "export function refundOrder(id: string) {\n  return `refund:${id}`;\n}\n";
const TS_B = 'import { refundOrder } from "./a";\nexport const r = refundOrder("ORD-1");\n';

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();
}
function repo(name: string, files: Record<string, string>) {
  const root = join(config.reposRoot, name);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  git(root, "init", "-q", "-b", config.baseBranch);
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  git(
    root,
    "update-ref",
    `refs/remotes/origin/${config.baseBranch}`,
    git(root, "rev-parse", "HEAD"),
  );
  return root;
}

before(async () => {
  await migrate();
  platformGo = await startPlatformGo();
  await shareAllRepositoriesForTests();
  a = await createUser({
    username: `cmp-a-${Date.now()}`,
    password: "compose-pass",
    role: "member",
  });
  b = await createUser({
    username: `cmp-b-${Date.now()}`,
    password: "compose-pass",
    role: "member",
  });
  repo(GO_REPO, {
    "refund/refund.go":
      "package refund\nfunc CallProvider() {}\nfunc RefundOrder() { CallProvider() }\n",
  });
  repo(TS_REPO, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
      },
    }),
    "src/a.ts": TS_A,
    "src/b.ts": TS_B,
  });
  for (const r of [GO_REPO, TS_REPO])
    await repositories.upsert(r, {
      projects: ["CMP"],
      description: "refund service",
      services: ["refund"],
    });
  config.codeIntelligence.enabled = true;
  const { indexRepository } = await import("../src/codeIntelligence/indexer.ts");
  await indexRepository(GO_REPO);
  config.lsp.enabled = true;
  if (!(await probeIsolation(true)).available) config.lsp.allowUnsandboxed = true;
  registerIntegrationTool({
    name: "cmp.logs",
    summary: "fixture refund logs",
    description: "Fake Splunk-style refund logs",
    input: z.object({ query: z.string() }),
    readOnly: true,
    available: () => true,
    handler: async () => {
      if (logsDown) throw new Error("Splunk unavailable (HTTP 503)");
      return { events: [{ order_id: "ORD-1", message: "refund timeout in RefundOrder" }] };
    },
  });
  registerIntegrationTool({
    name: "cmp.slow",
    summary: "fixture slow lookup",
    description: "Resolves after 2 s unless aborted",
    input: z.object({}),
    readOnly: true,
    available: () => true,
    handler: (_a, ctx) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve({ late: true }), 2000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve({ aborted: true });
        });
      }),
  });
  registerIntegrationTool({
    name: "cmp.publish",
    summary: "fixture mutation",
    description: "A mutating tool",
    input: z.object({ topic: z.string() }),
    readOnly: false,
    available: () => true,
    handler: async () => ({ published: true }),
  });
  await knowledge.create({
    key: "refund-rule",
    title: "Refund idempotency",
    category: "business_rule",
    content: "A refund must be idempotent per order.",
    scope_type: "PROJECT",
    scope_ref: "CMP",
    ownerId: a.id,
  });
  await knowledge.create({
    key: "foreign-refund-note",
    title: "Private refund note of another owner",
    category: "task_memory",
    content: "OTHER_OWNER_PRIVATE_MEMORY",
    scope_type: "GLOBAL",
    ownerId: b.id,
  });
  await definitions.create({
    key: "codeact-compose",
    spec: { name: "CodeAct compose", steps: [{ key: "investigate", type: "agent", config: {} }] },
  });
  setCodeActLauncherForTests(async (node, args) => ({
    command: node,
    args,
    env: { PATH: process.env.PATH ?? "" },
  }));
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
});
afterEach(async () => {
  config.codeAct.enabled = false;
  config.codeAct.maxCalls = 20;
  config.lsp.enabled = true;
  logsDown = false;
  for (const id of runs.splice(0)) {
    const r = await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [id]);
    if (!["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) await cancelRun(id);
  }
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await closeAllSessions();
  platformGo?.stop();
  await settleBackground();
  await pool.end();
});

async function attemptEnv(signal: AbortSignal = new AbortController().signal) {
  const item = await workItems.createManual({
    title: "Refund timeouts",
    description: "Investigate refund timeouts",
    project: "CMP",
    ownerId: a.id,
  });
  const run = await startRun({
    definitionKey: "codeact-compose",
    workItemId: item.id,
    ownerId: a.id,
  });
  runs.push(run.id);
  const job = (await claimJob("codeact-compose", 120))!;
  const begun = (await beginAttempt(job, "codeact-compose"))!;
  const env = envFromExecution(
    makeContext({ ...begun, signal }),
    "analysis",
    policy,
    newMetrics("fixture-model"),
    () => {},
  );
  const ask = env.ask;
  env.ask = async (qs) => {
    questionsAsked++;
    return ask(qs);
  };
  return env;
}
async function program(code: string, env?: Awaited<ReturnType<typeof attemptEnv>>) {
  config.codeAct.enabled = true;
  const e = env ?? (await attemptEnv());
  return {
    env: e,
    r: JSON.parse(await dispatchPlatformTool("platform.execute_code", { code }, e)),
  };
}
const tsPos = {
  repository: TS_REPO,
  path: "src/b.ts",
  operation: "definition",
  line: 2,
  character: 18,
};

test("integration + code intelligence: one program, real dispatch, provenance per source", async () => {
  const { env, r } = await program(`
    const logs = await platform.callTool("cmp.logs", { query: "refund timeout" });
    const fn = logs.events[0].message.match(/in (\\w+)/)[1];
    const sym = await platform.callTool("platform.get_symbol", { symbol: fn, repositories: ["${GO_REPO}"] });
    const deps = await platform.callTool("platform.find_dependencies", { symbol: sym.definitions[0].qualified_name ?? fn, repositories: ["${GO_REPO}"], depth: 1 });
    return { fn, defined_in: sym.definitions[0]?.file_path, snapshot: !!sym.definitions[0]?.snapshot?.commit,
             calls: JSON.stringify(deps).includes("CallProvider"), uncertainty: sym.uncertainty };`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.fn, "RefundOrder");
  assert.equal(r.value.defined_in, "refund/refund.go");
  assert.equal(r.value.snapshot, true);
  assert.equal(r.value.calls, true);
  assert.match(
    r.value.uncertainty,
    /syntax candidates/,
    "the tool's own caveat reaches the program",
  );
  assert.deepEqual(Object.keys(r.sources).sort(), ["code_intelligence", "integration"]);
  assert.equal(r.calls[1].source.trust, "indexed_syntax");
  assert.equal(r.evidence_status, "complete");
  // The nested reads took the direct path: journaled like a direct call of this attempt.
  const journal = await q<{ tool: string }>(
    pool,
    "SELECT tool FROM agent_context_tool_calls WHERE attempt_id = $1 ORDER BY id",
    [env.attemptId],
  );
  assert.deepEqual(
    journal.map((j) => j.tool),
    ["platform.get_symbol", "platform.find_dependencies", "platform.execute_code"],
  );
  const hit = await resolveCodeActEvidence({ ...a, active: true }, r.evidence[1]);
  assert.equal(hit?.tool, "platform.get_symbol");
});

test("integration + knowledge + memory: visibility and freshness are the registry's", async () => {
  const env = await attemptEnv();
  const foreign = await one(
    pool,
    "SELECT id FROM knowledge_items WHERE key = 'foreign-refund-note'",
  );
  // A forged snapshot entry for another owner's private memory: the dispatcher's visibility check drops it.
  env.knowledge.push({
    id: Number(foreign.id),
    key: "foreign-refund-note",
    owner_id: b.id,
    title: "Private refund note of another owner",
    version: 1,
    content: "OTHER_OWNER_PRIVATE_MEMORY",
    category: "task_memory",
  });
  const { r } = await program(
    `const [logs, rules, memory] = await Promise.all([
       platform.callTool("cmp.logs", { query: "refund" }),
       platform.callTool("platform.get_business_rules", { query: "refund" }),
       platform.callTool("platform.search_task_memory", { query: "refund" }),
     ]);
     return { events: logs.events.length, rules: rules.map((k) => k.key ?? k.title), memory: JSON.stringify(memory) };`,
    env,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(
    r.value.rules.some((k: string) => /refund/i.test(k)),
    JSON.stringify(r.value.rules),
  );
  assert.doesNotMatch(r.value.memory, /OTHER_OWNER_PRIVATE_MEMORY/);
  assert.deepEqual(Object.keys(r.sources).sort(), ["integration", "knowledge", "memory"]);
  assert.match(r.sources.memory.caveat, /FRESH/);
});

test("integration + LSP: semantic navigation of the current checkout, all three families combined", async () => {
  const { r } = await program(`
    const logs = await platform.callTool("cmp.logs", { query: "refund" });
    const [nav, code] = await Promise.all([
      platform.callTool("platform.navigate_code", ${JSON.stringify(tsPos)}),
      platform.callTool("platform.search_code", { query: "RefundOrder", repositories: ["${GO_REPO}"] }),
    ]);
    const rules = await platform.callTool("platform.get_business_rules", { query: "refund" });
    return { status: nav.status, at: nav.locations.map((l) => l.path + ":" + l.line), code_hits: code.hits.length,
             rules: rules.length, events: logs.events.length };`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.status, "ok");
  assert.deepEqual(r.value.at, ["src/a.ts:1"]);
  assert.ok(r.value.code_hits > 0);
  assert.deepEqual(Object.keys(r.sources).sort(), [
    "code_intelligence",
    "integration",
    "knowledge",
    "lsp",
  ]);
  assert.equal(r.missing_sources, undefined);
});

test("current worktree: an uncommitted edit is what LSP navigation answers from", async () => {
  const root = join(config.reposRoot, TS_REPO);
  writeFileSync(join(root, "src/b.ts"), `// moved down\n\n${TS_B}`);
  try {
    const { r } = await program(
      `return await platform.callTool("platform.navigate_code", ${JSON.stringify({ ...tsPos, line: 4 })});`,
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.status, "ok");
    assert.equal(r.value.locations[0].path, "src/a.ts");
  } finally {
    writeFileSync(join(root, "src/b.ts"), TS_B);
  }
});

test("stale code index: syntax fallbacks are labelled candidates, never resolved definitions", async () => {
  const root = join(config.reposRoot, GO_REPO);
  writeFileSync(join(root, "refund/extra.go"), "package refund\nfunc RetryRefund() {}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "newer than the index");
  git(
    root,
    "update-ref",
    `refs/remotes/origin/${config.baseBranch}`,
    git(root, "rev-parse", "HEAD"),
  );
  const { r } = await program(
    `return await platform.callTool("platform.get_symbol", { symbol: "RetryRefund", repositories: ["${GO_REPO}"] });`,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const text = JSON.stringify(r.value);
  assert.ok(
    /NOT resolved definitions|syntax candidates/.test(text),
    `the stale-index caveat survives composition: ${text.slice(0, 400)}`,
  );
});

test("missing language server: a typed unavailable answer; the other sources still answer", async () => {
  const old = config.lsp.gopls;
  config.lsp.gopls = "/nonexistent/gopls";
  await closeAllSessions();
  try {
    const goPos = { repository: GO_REPO, path: "refund/refund.go", operation: "document_symbols" };
    const { r } = await program(`
      const nav = await platform.callTool("platform.navigate_code", ${JSON.stringify(goPos)});
      const logs = await platform.callTool("cmp.logs", { query: "refund" });
      return { nav: nav.status, events: logs.events.length };`);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.value, { nav: "unavailable", events: 1 });
  } finally {
    config.lsp.gopls = old;
    await closeAllSessions();
  }
});

test("LSP disabled: navigate_code is not composable (as for direct calls)", async () => {
  config.lsp.enabled = false;
  const { r } = await program(`
    const names = (await platform.listTools()).map((t) => t.name);
    let err = null;
    try { await platform.callTool("platform.navigate_code", ${JSON.stringify(tsPos)}); } catch (e) { err = e.message; }
    return { listed: names.includes("platform.navigate_code"), err };`);
  assert.equal(r.value.listed, false);
  assert.match(r.value.err, /unknown tool/);
});

test("authorization: no repository widening, no mutation, no recursion, no clarification from a program", async () => {
  const before = questionsAsked;
  const { env, r } = await program(`
    const out = {};
    const tryCall = async (k, name, args) => { try { await platform.callTool(name, args); out[k] = "ran"; } catch (e) { out[k] = e.message; } };
    await tryCall("repo", "platform.search_code", { query: "RefundOrder", repositories: ["someone-elses-repo"] });
    await tryCall("mutation", "cmp.publish", { topic: "orders" });
    await tryCall("recursion", "platform.execute_code", { code: "return 1" });
    await tryCall("clarify", "platform.request_clarification", { question: "?" });
    await tryCall("submit", "platform.submit_result", {});
    return out;`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value.repo, /outside authorized run scope/);
  assert.match(r.value.mutation, /read-only/);
  for (const k of ["recursion", "clarify", "submit"]) assert.match(r.value[k], /unknown tool/, k);
  assert.equal(questionsAsked, before);
  const repoCall = r.calls.find((c: { tool: string }) => c.tool === "platform.search_code");
  const exec = await one(
    pool,
    "SELECT id FROM code_executions WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
    [env.runId],
  );
  const row = await one(
    pool,
    "SELECT status, error_category FROM code_execution_calls WHERE execution_id = $1 AND seq = $2",
    [exec.id, repoCall.seq],
  );
  assert.deepEqual([row.status, row.error_category], ["error", "unauthorized"]);
});

test("partial integration failure: the program returns what it has and the missing source is named", async () => {
  logsDown = true;
  const { r } = await program(`
    let events = null;
    try { events = (await platform.callTool("cmp.logs", { query: "refund" })).events; } catch {}
    const rules = await platform.callTool("platform.get_business_rules", { query: "refund" });
    return { events, rules: rules.length };`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.value, { events: null, rules: 1 });
  assert.deepEqual(r.missing_sources, ["integration"]);
  assert.equal(r.sources.knowledge.ok, 1);
});

test("shared budget: platform reads count against the same nested-call budget", async () => {
  config.codeAct.maxCalls = 2;
  const { r } = await program(`
    const out = [];
    for (const name of ["platform.get_business_rules", "cmp.logs", "platform.get_business_rules"]) {
      try { await platform.callTool(name, { query: "refund" }); out.push("ok"); } catch (e) { out.push(e.message); }
    }
    return out;`);
  assert.deepEqual(r.value.slice(0, 2), ["ok", "ok"]);
  assert.match(r.value[2], /call budget of 2/);
});

test("cancellation: aborting the attempt ends the program; no nested read starts afterwards", async () => {
  const ac = new AbortController();
  const env = await attemptEnv(ac.signal);
  config.codeAct.enabled = true;
  const pending = dispatchPlatformTool(
    "platform.execute_code",
    {
      code: `await platform.callTool("platform.get_business_rules", { query: "refund" });
             await platform.callTool("cmp.slow", {});
             await platform.callTool("platform.search_task_memory", { query: "refund" });
             return "finished";`,
    },
    env,
  );
  setTimeout(() => ac.abort("run canceled"), 400);
  const r = JSON.parse(await pending);
  assert.equal(r.category, "canceled");
  await new Promise((res) => setTimeout(res, 2200));
  const journal = await q<{ tool: string }>(
    pool,
    "SELECT tool FROM agent_context_tool_calls WHERE attempt_id = $1 AND tool = 'platform.search_task_memory'",
    [env.attemptId],
  );
  assert.equal(journal.length, 0);
});

test("stale memory: a past-task memory whose files changed is withheld and labelled STALE inside a program", async () => {
  const root = join(config.reposRoot, GO_REPO);
  const original = git(root, "rev-parse", "HEAD");
  const meta = {
    repo: GO_REPO,
    trust: "verified",
    commit_sha: original,
    base_branch: config.baseBranch,
    files: ["refund/refund.go"],
  };
  const item = await knowledge.create({
    key: "memory.refund.stale",
    title: "Refund memory",
    scope_type: "REPOSITORY",
    scope_ref: GO_REPO,
    category: "task_memory",
    content: "OLD_REFUND_ASSUMPTION",
    metadata: { memory: meta },
    ownerId: a.id,
  });
  writeFileSync(
    join(root, "refund/refund.go"),
    "package refund\nfunc CallProvider() {}\nfunc RefundOrder() { CallProvider() } // changed\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "changed after the memory");
  git(
    root,
    "update-ref",
    `refs/remotes/origin/${config.baseBranch}`,
    git(root, "rev-parse", "HEAD"),
  );
  const env = await attemptEnv();
  env.knowledge.push({
    id: item.id,
    key: "memory.refund.stale",
    owner_id: a.id,
    title: "Refund memory",
    version: 1,
    content: "OLD_REFUND_ASSUMPTION",
    category: "task_memory",
    metadata: { memory: meta },
  });
  const { r } = await program(
    `const m = await platform.callTool("platform.search_task_memory", { query: "refund" });
     return m.map((x) => ({ content: x.content, state: x.freshness?.state }));`,
    env,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const entry = r.value.find((x: { state?: string }) => x.state);
  assert.deepEqual(entry, { content: null, state: "STALE" });
  assert.doesNotMatch(JSON.stringify(r), /OLD_REFUND_ASSUMPTION/);
});

test("runtime: the real OS sandbox composes integration, code intelligence, LSP and knowledge in one execution", async (t) => {
  if (!(await probeIsolation()).available) return t.skip("OS isolation unavailable");
  setCodeActLauncherForTests(undefined);
  try {
    const { env, r } = await program(`
      const logs = await platform.callTool("cmp.logs", { query: "refund" });
      const [code, nav, rules] = await Promise.all([
        platform.callTool("platform.search_code", { query: "RefundOrder", repositories: ["${GO_REPO}"] }),
        platform.callTool("platform.navigate_code", ${JSON.stringify(tsPos)}),
        platform.callTool("platform.get_business_rules", { query: "refund" }),
      ]);
      return { events: logs.events.length, code_hits: code.hits.length, nav: nav.status, rules: rules.length };`);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.nav, "ok");
    assert.ok(r.value.code_hits > 0 && r.value.rules > 0);
    assert.equal(r.evidence_status, "complete");
    for (const ref of r.evidence)
      assert.ok(await resolveCodeActEvidence({ ...a, active: true }, ref), ref);
    console.log(
      `M3-SANDBOX ${JSON.stringify({ run_id: env.runId, value: r.value, evidence: r.evidence, sources: r.sources, stats: r.stats })}`,
    );
  } finally {
    setCodeActLauncherForTests(async (node, args) => ({
      command: node,
      args,
      env: { PATH: process.env.PATH ?? "" },
    }));
  }
});

test("chat: code.execute composes integration, code search and knowledge through executeChatTool", async () => {
  config.codeAct.enabled = true;
  const actor = { ...a, active: true };
  const c = await chat.create(actor, {
    mode: "INVESTIGATE",
    provider: "claude",
    repositories: [GO_REPO],
  });
  const code = `
    const logs = await platform.callTool("cmp.logs", { query: "refund" });
    const hits = await platform.callTool("platform.code.search", { query: "RefundOrder", repositories: ["${GO_REPO}"] });
    let recursion = null;
    try { await platform.callTool("platform.code.execute", { code: "return 1" }); } catch (e) { recursion = e.message; }
    return { events: logs.events.length, hits: JSON.stringify(hits).includes("RefundOrder"), recursion };`;
  let i = 0;
  const replies = [
    "```chat-tool\n" +
      JSON.stringify({ calls: [{ tool: "code.execute", arguments: { code } }] }) +
      "\n```",
    "Done.",
  ];
  const runner: CompletionRunner = async () => ({ text: replies[Math.min(i++, 1)], tokens: null });
  setChatProviders(
    Object.fromEntries(PROVIDERS.map((p) => [p, runner])) as Record<
      AgentProvider,
      CompletionRunner
    >,
  );
  await chat.postMessage(actor, c.id, {
    content: "refund timeouts: investigate",
    client_message_id: "compose-chat-1",
  });
  for (let n = 0; n < 200; n++) {
    const d = await chat.get(actor, c.id);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status))) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  const call = await one(
    pool,
    "SELECT status, result FROM chat_tool_calls WHERE conversation_id = $1 AND tool = 'code.execute'",
    [c.id],
  );
  assert.equal(call.status, "ok", JSON.stringify(call.result));
  const r = call.result;
  assert.equal(r.value.events, 1);
  assert.equal(r.value.hits, true, JSON.stringify(r));
  assert.match(r.value.recursion, /unknown tool/);
  assert.deepEqual(Object.keys(r.sources).sort(), ["code_intelligence", "integration"]);
});
