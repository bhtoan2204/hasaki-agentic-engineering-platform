import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { execution } from "../src/auth/execution.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  beginAttempt,
  cancelRun,
  finishAttempt,
  reexecuteStep,
} from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { makeContext } from "../src/workflow/executors/registry.ts";
import { workItems } from "../src/workitems/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { repositories } from "../src/repos/service.ts";
import {
  envFromExecution,
  envFromDatabase,
  dispatchPlatformTool,
} from "../src/agent/platformTools.ts";
import { CONTEXT_TOOLS } from "../src/agent/contextToolSchemas.ts";
import { bridgeToolsFor } from "../src/agent/mcpBridge.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import {
  ensureContextPack,
  budgetContextPack,
  ContextBudgetError,
  type ContextEntry,
} from "../src/context/pack.ts";
import { captureContextContinuity } from "../src/context/continuity.ts";
import { buildUserPrompt, buildSystemAppend } from "../src/agent/stepPrompt.ts";
import { startBroker } from "../src/agent/codex/broker.ts";
import { brokerRequest } from "../src/agent/codex/client.ts";
import { handle } from "../src/http/app.ts";
import { estimateTokens } from "../src/context/plan.ts";
import { source } from "../src/agent/contextTools.ts";
import { decide } from "../src/agent/toolPolicy.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

let a: PublicUser, b: PublicUser, admin: PublicUser, server: Server, base: string;
const runs: number[] = [];
const policy = {
  mode: "analysis" as const,
  workspaces: [],
  protectedRoots: [],
  baseBranch: "main",
};
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  a = await createUser({ username: "context-a", password: "context-password", role: "member" });
  b = await createUser({ username: "context-b", password: "context-password", role: "member" });
  admin = await createUser({
    username: "context-admin",
    password: "context-password",
    role: "admin",
  });
  await repositories.upsert("oms-api", {
    projects: ["OMS"],
    description: "stock refund service",
    services: ["stock"],
  });
  await knowledge.create({
    key: "stock-rule",
    title: "Stock refund safety",
    category: "business_rule",
    content: "Never duplicate stock events. Preserve idempotency.",
    scope_type: "PROJECT",
    scope_ref: "OMS",
    enforced: true,
    ownerId: a.id,
  });
  await knowledge.create({
    key: "foreign-rule",
    title: "Private other owner",
    category: "agent_skill",
    content: "OTHER_OWNER_SECRET",
    scope_type: "GLOBAL",
    ownerId: b.id,
  });
  await knowledge.create({
    key: "stock-on-demand",
    title: "Stock on-demand guide",
    category: "agent_skill",
    content: "ON_DEMAND_SECRET_BODY " + "token ".repeat(4000),
    scope_type: "PROJECT",
    scope_ref: "OMS",
    metadata: { load: "on_demand", description: "Load only when editing stock refunds" },
    ownerId: a.id,
  });
  await definitions.create({
    key: "context-native",
    spec: {
      name: "Context native fixture",
      steps: [
        {
          key: "inspect",
          type: "agent",
          config: { instructions: "Inspect stock refund requirements" },
        },
      ],
    },
  });
  await definitions.create({
    key: "context-budget",
    spec: {
      name: "Context budget fixture",
      steps: [
        { key: "investigate", type: "agent", config: { instructions: "Investigate" } },
        { key: "notes", type: "agent", config: { instructions: "Notes" } },
        {
          key: "fix",
          type: "agent",
          depends_on: ["investigate", "notes"],
          max_attempts: 2,
          config: { instructions: "Fix", knowledge_index_size: 0, upstream_tokens: 64 },
        },
      ],
    },
  });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  for (const id of runs.splice(0)) {
    const r = await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [id]);
    if (!["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) await cancelRun(id);
  }
  await settleBackground();
});
after(async () => {
  server?.close();
  await settleBackground();
  await pool.end();
});
async function live(
  provider: "claude" | "codex" | "cursor" | "antigravity" = "claude",
  pending?: unknown,
) {
  const item = await workItems.createManual({
    title: "Prevent duplicate stock refund events",
    description: "Keep refunds idempotent. api_key=supersecretvalue",
    project: "OMS",
    ownerId: a.id,
  });
  const run = await startRun({
    definitionKey: "context-native",
    workItemId: item.id,
    ownerId: a.id,
    agentProvider: provider,
  });
  runs.push(run.id);
  if (pending)
    await q(pool, "UPDATE workflow_steps SET pending_input=$2 WHERE run_id=$1", [
      run.id,
      JSON.stringify(pending),
    ]);
  const job = (await claimJob("context-test", 120))!;
  const begun = (await beginAttempt(job, "context-test"))!;
  const ctx = makeContext({ ...begun, signal: new AbortController().signal });
  const metrics = newMetrics("fixture-model");
  const env = envFromExecution(ctx, "analysis", policy, metrics, () => {});
  return { ctx, env, metrics, job };
}
test("owned context pack persists source versions, requirements and explicit unknown capabilities within budget", async () => {
  const { ctx, metrics } = await live();
  const pack = await ensureContextPack(ctx, metrics, policy);
  ctx.context.contextPack = pack;
  assert.ok(pack.id);
  assert.ok(pack.estimated_tokens <= pack.budget_tokens);
  assert.ok(estimateTokens(JSON.stringify(pack)) <= pack.budget_tokens);
  assert.ok(
    pack.entries.some(
      (e) => e.id.startsWith("knowledge:") && e.required && e.provenance.visibility === "owner",
    ),
  );
  const text = JSON.stringify(pack);
  assert.ok(text.includes("Never duplicate stock events"));
  assert.ok(!text.includes("OTHER_OWNER_SECRET"));
  assert.ok(!text.includes("supersecretvalue"));
  assert.ok(text.includes("Code intelligence disabled"));
  const prompt = buildUserPrompt(
    ctx.input,
    [],
    [],
    ctx.context.upstream,
    ctx.context.fileRefs,
    [],
    pack,
  );
  assert.match(prompt, /platform_context_pack/);
  assert.match(prompt, /idempotent/);
  const system = buildSystemAppend(ctx.run, ctx.step, ctx.context, "analysis");
  assert.match(system, /platform.search_code/);
  assert.match(system, /Never duplicate stock events/);
  const second = await ensureContextPack(ctx, metrics, policy);
  assert.equal(second.id, pack.id);
  assert.equal(
    (
      await one(pool, "SELECT count(*)::int AS n FROM agent_context_packs WHERE attempt_id=$1", [
        ctx.attempt.id,
      ])
    ).n,
    1,
  );
  await assert.rejects(
    pool.query("UPDATE agent_context_packs SET content='{}' WHERE id=$1", [pack.id]),
    /immutable/,
  );
});
test("mandatory constraints cannot be silently shortened when budget is exhausted", () => {
  const entry: ContextEntry = {
    id: "safety",
    section: "requirements",
    trust: "platform_constraint",
    required: true,
    priority: 1000,
    body: "CRITICAL ".repeat(2000),
    provenance: source("policy", 1, null, "shared", "mandatory"),
  };
  const base = {
    version: 1 as const,
    run_id: 1,
    step_id: 1,
    attempt_id: 1,
    owner_id: 1,
    snapshot_id: 1,
    created_at: new Date().toISOString(),
    budget_tokens: 2000,
    token_measurement: "character_estimate_not_provider_usage" as const,
    parent_pack_ids: [],
    retrieval_calls: 0,
    retrieval_failures: 0,
    preparation_ms: 0,
  };
  assert.throws(() => budgetContextPack(base, [entry]), ContextBudgetError);
});
test("many omitted optional entries never push a small required set over the budget", () => {
  // Regression: the omitted index was trimmed to <= budget, then +8 was added and the pack was rejected.
  const optional: ContextEntry[] = Array.from({ length: 60 }, (_, i) => ({
    id: `knowledge:doc-${i}:v1`,
    section: "knowledge",
    trust: "curated_rule",
    required: false,
    priority: 80,
    body: JSON.stringify({ content: "lorem ipsum ".repeat(2000 + i) }),
    provenance: source(`knowledge:doc-${i}`, 1, null, "shared", "GLOBAL scope; relevance"),
  }));
  const request: ContextEntry = {
    id: "request",
    section: "requirements",
    trust: "untrusted_evidence",
    required: true,
    priority: 1000,
    body: JSON.stringify({ title: "Small request" }),
    provenance: source("snapshot:1:request", "h", null, "owner", "exact run request"),
  };
  for (let budget = 2000; budget <= 2600; budget++) {
    const pack = budgetContextPack(
      {
        version: 1,
        run_id: 1,
        step_id: 1,
        attempt_id: 1,
        owner_id: 1,
        snapshot_id: 1,
        created_at: new Date().toISOString(),
        budget_tokens: budget,
        token_measurement: "character_estimate_not_provider_usage",
        parent_pack_ids: [],
        retrieval_calls: 0,
        retrieval_failures: 0,
        preparation_ms: 0,
      },
      [request, ...optional],
    );
    assert.ok(pack.estimated_tokens <= budget, `budget ${budget}: ${pack.estimated_tokens}`);
    assert.ok(pack.entries.some((e) => e.id === "request"));
  }
});
test("pinned private knowledge from another owner is not resolved on reexecution", async () => {
  const { ctx } = await live("claude", {
    reexecute: { skills: [{ key: "foreign-rule", version: 1 }] },
  });
  assert.ok(!ctx.context.knowledge.some((k) => k.key === "foreign-rule"));
  const snapshot = await one(pool, "SELECT content FROM context_snapshots WHERE id=$1", [
    ctx.context.snapshot_id,
  ]);
  assert.ok(!JSON.stringify(snapshot).includes("OTHER_OWNER_SECRET"));
});
test("strict schemas, repository scope and authenticated identity reject forged access", async () => {
  const { ctx, env } = await live();
  for (const bad of [
    { ...env, ownerId: b.id },
    { ...env, runId: env.runId + 999 },
    { ...env, stepId: env.stepId + 999 },
    { ...env, mode: "coding" as const },
    { ...env, allowed: ["foreign"] },
    { ...env, selected: ["foreign"] },
  ])
    assert.match(await dispatchPlatformTool("platform.get_work_item", {}, bad), /^ERROR:/);
  assert.match(
    await execution.run({ userId: b.id, kind: "user" }, () =>
      dispatchPlatformTool("platform.get_work_item", {}, env),
    ),
    /^ERROR:/,
  );
  assert.match(
    await dispatchPlatformTool("platform.get_work_item", { run_id: 999 }, env),
    /ERROR:.*[Uu]nrecognized/,
  );
  assert.match(
    await dispatchPlatformTool(
      "platform.search_code",
      { query: "refund", repositories: ["foreign"] },
      env,
    ),
    /ERROR:.*authorized/,
  );
  assert.match(
    await dispatchPlatformTool("platform.start_workflow", {}, env),
    /ERROR:.*(Unsupported|Unknown tool)/,
  );
  await q(pool, "UPDATE workflow_steps SET generation=generation+1 WHERE id=$1", [ctx.step.id]);
  assert.match(await dispatchPlatformTool("platform.get_work_item", {}, env), /^ERROR:/);
});
test("native knowledge and memory tools retain provenance and withhold stale bodies", async () => {
  const { env } = await live();
  const rules = JSON.parse(await dispatchPlatformTool("platform.get_business_rules", {}, env));
  assert.equal(rules[0].provenance.visibility, "owner");
  assert.ok(rules[0].content.includes("idempotency"));
  const forged = {
    ...env,
    knowledge: [
      ...env.knowledge,
      {
        key: "foreign-rule",
        title: "foreign",
        version: 1,
        content: "OTHER_OWNER_SECRET",
        category: "agent_skill",
      },
    ],
  };
  assert.ok(
    !(
      await dispatchPlatformTool("platform.search_knowledge", { query: "foreign" }, forged)
    ).includes("OTHER_OWNER_SECRET"),
  );
  const unknown = await dispatchPlatformTool(
    "platform.search_task_memory",
    { query: "stock" },
    env,
  );
  assert.deepEqual(JSON.parse(unknown), []);
});
test("live timeout is bounded and late read completion is not counted twice", async () => {
  const { ctx, env } = await live();
  const client = await pool.connect();
  const old = config.agent.contextToolTimeoutMs;
  config.agent.contextToolTimeoutMs = 1000;
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE work_items IN ACCESS EXCLUSIVE MODE");
    const started = Date.now();
    const result = await dispatchPlatformTool("platform.get_work_item", {}, env);
    assert.match(result, /deadline/);
    assert.ok(Date.now() - started < 2500);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    config.agent.contextToolTimeoutMs = old;
  }
  const row = await one(
    pool,
    "SELECT count(*)::int AS n,min(status) AS status FROM agent_context_tool_calls WHERE attempt_id=$1",
    [ctx.attempt.id],
  );
  assert.equal(row.n, 1);
  assert.equal(row.status, "timeout");
});
test("clarification uses workflow questions, is idempotent, and blocks later mutations", async () => {
  const { ctx, env } = await live();
  const args = {
    questions: [{ question: "Should a repeated refund be ignored?", options: ["Yes", "No"] }],
  };
  const answer = JSON.parse(
    await dispatchPlatformTool("platform.request_clarification", args, env),
  );
  assert.equal(answer.questions, 1);
  await dispatchPlatformTool("platform.request_clarification", args, env);
  assert.equal(
    (
      await one(pool, "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id=$1", [
        ctx.attempt.id,
      ])
    ).n,
    1,
  );
  assert.match(
    await dispatchPlatformTool("submit_result", { output: { summary: "done" } }, env),
    /waiting for answers/,
  );
  assert.equal(
    decide("mcp__platform__request_clarification", args, policy, process.cwd(), "subagent").allow,
    false,
  );
});
test("provider-neutral context and unfinished work can be reconstructed from database alone", async () => {
  const { ctx, env, metrics } = await live("codex");
  const pack = await ensureContextPack(ctx, metrics, policy);
  ctx.context.contextPack = pack;
  await dispatchPlatformTool(
    "post_update",
    { message: "Inspected stock handler; refund edge case remains unfinished" },
    env,
  );
  await captureContextContinuity(ctx, {
    kind: "waiting_input",
    checkpoint: { unfinished: "Need a business decision" },
  });
  const rebuilt = await envFromDatabase({
    runId: ctx.run.id,
    stepId: ctx.step.id,
    attemptId: ctx.attempt.id,
  });
  const content = JSON.parse(
    await dispatchPlatformTool("platform.get_run_context", { section: "requirements" }, rebuilt),
  );
  assert.equal(content.pack_id, pack.id);
  assert.match(JSON.stringify(content), /idempotent/);
  const saved = await one(
    pool,
    "SELECT content FROM agent_context_continuity WHERE attempt_id=$1",
    [ctx.attempt.id],
  );
  assert.equal(saved.content.pack_id, pack.id);
  assert.ok(saved.content.unfinished.checkpoint.includes("business decision"));
  await finishAttempt(ctx.attempt.job_id!, ctx.attempt.fencing_token!, ctx.attempt.id, {
    kind: "completed",
    output: { summary: "done" },
  });
  assert.match(await dispatchPlatformTool("platform.get_run_context", {}, env), /^ERROR:/);
});

async function stdioCall(bridge: "codex" | "cursor", env: ReturnType<typeof envFromExecution>) {
  const broker = await startBroker({
    policy,
    cwd: process.cwd(),
    requireHooks: bridge === "codex",
    dispatch: (name, args) => dispatchPlatformTool(name, args, env),
  });
  if (bridge === "codex")
    await brokerRequest(broker.socketPath, {
      token: broker.token,
      kind: "hook",
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__platform__get_work_item",
        tool_input: {},
        cwd: process.cwd(),
      },
    });
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", `src/agent/${bridge}/bridge.ts`],
    {
      env: {
        PATH: process.env.PATH,
        PLATFORM_BROKER_SOCKET: broker.socketPath,
        PLATFORM_BROKER_TOKEN: broker.token,
        PLATFORM_MODE: "analysis",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buf = Buffer.alloc(0);
  const replies = new Map<number, any>();
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge deadline")), 5000);
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let body: string;
        if (buf.subarray(0, 15).toString().startsWith("Content-Length")) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const n = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, end).toString())?.[1]);
          if (buf.length < end + 4 + n) return;
          body = buf.subarray(end + 4, end + 4 + n).toString();
          buf = buf.subarray(end + 4 + n);
        } else {
          const end = buf.indexOf("\n");
          if (end < 0) return;
          body = buf.subarray(0, end).toString();
          buf = buf.subarray(end + 1);
        }
        const reply = JSON.parse(body);
        replies.set(reply.id, reply);
        if (replies.size === 2) {
          clearTimeout(timer);
          resolve();
          return;
        }
      }
    });
  });
  try {
    for (const [id, method, params] of [
      [1, "tools/list", {}],
      [2, "tools/call", { name: "get_work_item", arguments: {} }],
    ] as const)
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await done;
    return replies;
  } finally {
    child.kill();
    await broker.close();
  }
}
test("Claude dispatch and real Codex/Cursor stdio bridges expose the same bound logical capabilities", async () => {
  for (const provider of ["claude", "codex", "cursor"] as const) {
    const { env } = await live(provider);
    const direct = JSON.parse(await dispatchPlatformTool("platform.get_work_item", {}, env));
    assert.match(direct.description, /idempotent/);
    if (provider !== "claude") {
      const replies = await stdioCall(provider, env);
      const names = replies.get(1).result.tools.map((t: any) => t.name);
      for (const t of CONTEXT_TOOLS) assert.ok(names.includes(t.name));
      assert.ok(!names.includes("prepare_branch"));
      assert.match(replies.get(2).result.content[0].text, /idempotent/);
    }
  }
  for (const t of CONTEXT_TOOLS)
    assert.ok(bridgeToolsFor("analysis").some((b) => b.name === t.name));
});
async function client(user: string) {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: "context-password" }),
  });
  return response.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
}
test("context/evidence inspection uses owner isolation and audited explicit admin access", async () => {
  const { ctx, metrics } = await live();
  await ensureContextPack(ctx, metrics, policy);
  const path = `/api/attempts/${ctx.attempt.id}/context`;
  assert.equal((await fetch(base + path)).status, 401);
  const other = await client(b.username);
  assert.equal((await fetch(base + path, { headers: { cookie: other } })).status, 404);
  const owner = await client(a.username);
  assert.equal((await fetch(base + path, { headers: { cookie: owner } })).status, 200);
  const adminCookie = await client(admin.username);
  assert.equal((await fetch(base + path, { headers: { cookie: adminCookie } })).status, 404);
  assert.equal(
    (await fetch(base + path + "?scope=all", { headers: { cookie: adminCookie } })).status,
    200,
  );
  assert.equal(
    (
      await one(
        pool,
        "SELECT count(*)::int AS n FROM audit_log WHERE action='support.access' AND resource_type='run'",
      )
    ).n,
    1,
  );
});

test("provider environments keep only their own configured authentication and no platform secrets", async () => {
  const { agentEnvironment } = await import("../src/agent/environment.ts");
  const input = {
    PATH: "/bin",
    HOME: "/tmp/account",
    DATABASE_URL: "database-private",
    AUTH_SECRET: "auth-private",
    AWS_SECRET_ACCESS_KEY: "aws-private",
    ANTHROPIC_API_KEY: "claude-auth",
    CURSOR_API_KEY: "cursor-auth",
    OPENAI_API_KEY: "do-not-switch-codex-billing",
    PLATFORM_CONFIG: "private-config.json",
  };
  for (const provider of ["claude", "codex", "cursor", "antigravity"] as const) {
    const env = agentEnvironment(input, provider);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.AUTH_SECRET, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.PLATFORM_CONFIG, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.PATH, "/bin");
    assert.equal(env.ANTHROPIC_API_KEY, provider === "claude" ? "claude-auth" : undefined);
    assert.equal(env.CURSOR_API_KEY, provider === "cursor" ? "cursor-auth" : undefined);
  }
});

test("native code adapters use the existing symbol/dependency index and label stale task memory", async () => {
  const old = config.codeIntelligence.enabled;
  config.codeIntelligence.enabled = true;
  const root = join(config.reposRoot, "oms-api");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  try {
    git("init", "-q", "-b", config.baseBranch);
    writeFileSync(
      join(root, "stock.go"),
      "package stock\nfunc ApplyRefund() {}\nfunc StockRefund() { ApplyRefund() }\n",
    );
    git("add", ".");
    git("commit", "-qm", "fixture stock symbols");
    const original = git("rev-parse", "HEAD");
    git("update-ref", `refs/remotes/origin/${config.baseBranch}`, original);
    const { indexRepository } = await import("../src/codeIntelligence/indexer.ts");
    await indexRepository("oms-api");
    const { ctx, env } = await live();
    const result = JSON.parse(
      await dispatchPlatformTool(
        "platform.search_code",
        { query: "StockRefund", repositories: ["oms-api"] },
        env,
      ),
    );
    assert.ok(result.hits.some((h: any) => h.symbol_name === "StockRefund"));
    assert.ok(result.hits[0].snapshot.commit);
    const symbol = JSON.parse(
      await dispatchPlatformTool(
        "platform.get_symbol",
        { symbol: "StockRefund", repositories: ["oms-api"] },
        env,
      ),
    );
    assert.ok(symbol.definitions.length > 0);
    const dependencies = JSON.parse(
      await dispatchPlatformTool(
        "platform.find_dependencies",
        {
          symbol: symbol.definitions[0].qualified_name ?? "StockRefund",
          repositories: ["oms-api"],
          depth: 1,
        },
        env,
      ),
    );
    assert.ok(JSON.stringify(dependencies).includes("ApplyRefund"));
    writeFileSync(
      join(root, "stock.go"),
      "package stock\nfunc ApplyRefund() {}\nfunc StockRefund() { /* changed */ }\n",
    );
    git("add", ".");
    git("commit", "-qm", "base changed after memory");
    git("update-ref", `refs/remotes/origin/${config.baseBranch}`, git("rev-parse", "HEAD"));
    const meta = {
      repo: "oms-api",
      trust: "verified",
      commit_sha: original,
      base_branch: config.baseBranch,
      files: ["stock.go"],
    };
    const item = await knowledge.create({
      key: "memory.stock.stale",
      title: "Stock memory",
      scope_type: "REPOSITORY",
      scope_ref: "oms-api",
      category: "task_memory",
      content: "Old stock assumption",
      metadata: { memory: meta },
      ownerId: a.id,
    });
    env.knowledge.push({
      id: item.id,
      key: "memory.stock.stale",
      owner_id: a.id,
      title: "Stock memory",
      version: 1,
      content: "Old stock assumption",
      category: "task_memory",
      metadata: { memory: meta },
    });
    const memory = JSON.parse(
      await dispatchPlatformTool("platform.search_task_memory", { query: "stock" }, env),
    );
    assert.equal(memory[0].content, null);
    assert.equal(memory[0].freshness.state, "STALE");
    assert.equal(
      (
        await one(
          pool,
          "SELECT count(*)::int AS n FROM agent_context_tool_calls WHERE attempt_id=$1 AND status='ok'",
          [ctx.attempt.id],
        )
      ).n,
      4,
    );
  } finally {
    config.codeIntelligence.enabled = old;
  }
});

test("context pack singleflight never substitutes an authenticated owner's pack for another identity", async () => {
  const { ctx, metrics } = await live();
  const owned = ensureContextPack(ctx, metrics, policy);
  const forged = ensureContextPack(
    { ...ctx, run: { ...ctx.run, owner_id: b.id } },
    newMetrics("fixture"),
    policy,
  );
  await assert.rejects(forged, /owner mismatch/);
  assert.equal((await owned).owner_id, a.id);
});

test("context pack follows the disclosure plan instead of repeating full knowledge and upstream output", async () => {
  const narrative = "HUGE_NARRATIVE_" + "n".repeat(8000);
  const notes = "NOTES_FLOOD_" + "z".repeat(8000);
  const item = await workItems.createManual({
    title: "Prevent duplicate stock refund events",
    description: "Keep refunds idempotent",
    project: "OMS",
    ownerId: a.id,
  });
  const run = await startRun({
    definitionKey: "context-budget",
    workItemId: item.id,
    ownerId: a.id,
    agentProvider: "claude",
  });
  runs.push(run.id);
  const outputFor = (key: string) =>
    key === "investigate"
      ? { claims: ["refunds can be applied twice"], narrative, note: "see src/stock/refund.go:12" }
      : { essay: notes };
  for (let i = 0; i < 2; i++) {
    const job = (await claimJob("context-budget", 120))!;
    const begun = (await beginAttempt(job, "context-budget"))!;
    assert.equal(
      (
        await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
          kind: "completed",
          output: outputFor(begun.step.key),
        })
      ).applied,
      true,
    );
  }
  const job = (await claimJob("context-budget", 120))!;
  const begun = (await beginAttempt(job, "context-budget"))!;
  assert.equal(begun.step.key, "fix");
  const ctx = makeContext({ ...begun, signal: new AbortController().signal });
  const metrics = newMetrics("fixture-model");
  const pack = await ensureContextPack(ctx, metrics, policy);
  const skill = ctx.context.knowledge.find((k) => k.key === "stock-on-demand");
  assert.ok(skill, "on-demand skill was resolved");
  assert.equal(
    ctx.context.disclosure.find((d) => d.key === "stock-on-demand")?.disclosure,
    "search",
  );
  const fullSkillTokens = estimateTokens(skill!.content);
  const narrativeTokens = estimateTokens(narrative);
  const notesTokens = estimateTokens(notes);
  assert.ok(fullSkillTokens > 4000, `on-demand body is ${fullSkillTokens} estimated tokens`);
  assert.ok(narrativeTokens > 2000 && notesTokens > 2000);
  const packed = JSON.stringify(pack);
  assert.ok(!packed.includes("ON_DEMAND_SECRET_BODY"), "search-tier skill body is not in the pack");
  assert.ok(
    !packed.includes("HUGE_NARRATIVE_"),
    "investigation output covered by the evidence digest is not packed again",
  );
  assert.ok(!packed.includes("z".repeat(500)), "oversized ancestor output is summarized");
  assert.match(packed, /Never duplicate stock events/);
  assert.ok(pack.entries.some((e) => e.id === "evidence_summary"));
  assert.ok(pack.entries.some((e) => e.id === "file_refs"));
  assert.match(packed, /src\/stock\/refund\.go/);
  const notesEntry = pack.entries.find((e) => e.id === "upstream:notes");
  assert.ok(
    notesEntry && notesEntry.body.length < 2000,
    `summarized notes are ${notesEntry?.body.length} chars against ${notes.length}`,
  );
  assert.ok(pack.omitted.some((o) => o.reason.includes("search")));
  const env = envFromExecution(ctx, "analysis", policy, metrics, () => {});
  assert.match(
    await dispatchPlatformTool("read_knowledge", { key: "stock-on-demand" }, env),
    /ON_DEMAND_SECRET_BODY/,
  );
  assert.match(
    await dispatchPlatformTool("platform.get_step_output", { step_key: "investigate" }, env),
    /HUGE_NARRATIVE_/,
  );
  assert.equal(
    (
      await finishAttempt(job.id, job.fencing_token, begun.attempt.id, {
        kind: "failed",
        error: "PREVIOUS_ATTEMPT_MARKER revise refund.go",
        retryable: false,
      })
    ).applied,
    true,
  );
  await reexecuteStep(run.id, "fix", { feedback: "revise the refund path" });
  const again = (await claimJob("context-budget", 120))!;
  const next = (await beginAttempt(again, "context-budget"))!;
  const revised = await ensureContextPack(
    makeContext({ ...next, signal: new AbortController().signal }),
    newMetrics("fixture-model"),
    policy,
  );
  const revisedText = JSON.stringify(revised);
  assert.match(revisedText, /PREVIOUS_ATTEMPT_MARKER/);
  assert.match(revisedText, /revise the refund path/);
  assert.ok(!revisedText.includes("ON_DEMAND_SECRET_BODY"));
  console.log(
    `context pack budget: omitted ${fullSkillTokens}+${narrativeTokens}+${notesTokens} estimated tokens; notes entry ${notesEntry!.body.length} chars`,
  );
});

test("all provider bridges preserve skill read and structured activation evidence", async () => {
  const { selectedSkills, injectSkills, deriveSkillActivation } =
    await import("../src/agent/skillTracing.ts");
  for (const provider of ["claude", "codex", "cursor", "antigravity"] as const) {
    const { ctx, env } = await live(provider);
    const traces = selectedSkills(ctx.context);
    injectSkills(traces, ctx.context);
    await dispatchPlatformTool("read_knowledge", { key: "stock-on-demand", limit: 24000 }, env);
    const body = ctx.context.knowledge.find((k) => k.key === "stock-on-demand")!;
    if (body.content.length > 24000)
      await dispatchPlatformTool(
        "read_knowledge",
        { key: body.key, offset: 24000, limit: 24000 },
        env,
      );
    assert.match(
      await dispatchPlatformTool(
        "submit_result",
        { output: { summary: "applied guide" }, skills_applied: [body.key] },
        env,
      ),
      /Result recorded/,
    );
    const rows = await q(
      pool,
      "SELECT reason,data FROM workflow_checkpoints WHERE attempt_id=$1 AND reason IN ('skill_read','submit_result') ORDER BY id",
      [ctx.attempt.id],
    );
    const reads = rows.filter((r) => r.reason === "skill_read").map((r) => r.data);
    const declaration = rows.filter((r) => r.reason === "submit_result").at(-1)!.data
      .skills_applied;
    const skill = deriveSkillActivation(traces, ctx.context.knowledge, reads, declaration).find(
      (k) => k.key === body.key,
    )!;
    assert.deepEqual(skill.states, ["selected", "injected", "loaded", "activated"], provider);
  }
});

test("Ponytail step keeps legacy codebase map knowledge when no generated map is available", async () => {
  const { ctx, metrics } = await live();
  const base = ctx.context.knowledge[0];
  ctx.context.knowledge = [
    ...ctx.context.knowledge,
    {
      ...base,
      id: undefined,
      key: "skill.ext.ponytail",
      title: "Ponytail",
      category: "agent_skill",
      enforced: false,
      content: "Ponytail body",
      metadata: { pilot: "ponytail" },
      reason: "assigned to step",
    },
    {
      ...base,
      id: undefined,
      key: "legacy-codebase-map",
      title: "Codebase map",
      category: "repository_convention",
      enforced: false,
      content: "LEGACY_MAP_BODY",
      metadata: {},
      reason: "GLOBAL scope",
    },
  ];
  const pack = await ensureContextPack(ctx, metrics, policy);
  assert.ok(!pack.entries.some((e) => e.id === "codebase-map"));
  assert.ok(pack.entries.some((e) => e.id.startsWith("knowledge:legacy-codebase-map")));
});
