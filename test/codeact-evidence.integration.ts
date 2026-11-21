/**
 * CodeAct evidence integrity (M1) through the real surfaces and PostgreSQL: a `codeact:<execution>:<seq>` reference is
 * emitted only for a nested call whose row was durably written by a finalized execution, and it resolves only inside
 * the caller's authorization scope. Failures are injected in the database itself (triggers on the private test
 * cluster), not by mocking the recorder. Fixture tools and data are fake.
 */
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
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
import { envFromExecution, dispatchPlatformTool } from "../src/agent/platformTools.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { registerIntegrationTool } from "../src/agent/toolRegistry.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { resolveCodeActEvidence, recordCodeActCallForTests } from "../src/codeact/surfaces.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import type { Actor } from "../src/authz/access.ts";
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
let owner: PublicUser;
let stranger: PublicUser;
let admin: PublicUser;
const actorOf = (u: PublicUser): Actor => ({ ...u, active: true });

const tool = (name: string, handler: (args: { i?: number }) => unknown) =>
  registerIntegrationTool({
    name,
    summary: name,
    description: `M1 fixture ${name}`,
    input: z.object({ i: z.number().optional() }),
    readOnly: true,
    available: () => true,
    handler: async (args) => handler(args),
  });

before(async () => {
  await migrate();
  const stamp = Date.now();
  owner = await createUser({
    username: `evi-o-${stamp}`,
    password: "evidence-pass",
    role: "member",
  });
  stranger = await createUser({
    username: `evi-s-${stamp}`,
    password: "evidence-pass",
    role: "member",
  });
  admin = await createUser({
    username: `evi-a-${stamp}`,
    password: "evidence-pass",
    role: "admin",
  });
  tool("evi.orders", (a) => ({ order: `ORD-${a.i ?? 0}`, status: "timeout" }));
  tool("evi.unrecordable", () => ({ secret_free: true }));
  tool("evi.slowrecord", () => ({ slow: true }));
  // Database-level failure injection: the recorder's real INSERT fails or stalls for these tools.
  await q(
    pool,
    `CREATE TABLE IF NOT EXISTS codeact_fault_flags (name TEXT PRIMARY KEY);
     CREATE OR REPLACE FUNCTION codeact_fault_calls() RETURNS trigger AS $$
     BEGIN
       IF NEW.tool = 'evi.unrecordable' THEN RAISE EXCEPTION 'injected insert failure'; END IF;
       IF NEW.tool = 'evi.slowrecord' THEN PERFORM pg_sleep(0.8); END IF;
       RETURN NEW;
     END $$ LANGUAGE plpgsql;
     DROP TRIGGER IF EXISTS codeact_fault_calls ON code_execution_calls;
     CREATE TRIGGER codeact_fault_calls BEFORE INSERT ON code_execution_calls
       FOR EACH ROW EXECUTE FUNCTION codeact_fault_calls();
     CREATE OR REPLACE FUNCTION codeact_fault_finalize() RETURNS trigger AS $$
     BEGIN
       IF NEW.status <> 'running' AND EXISTS (SELECT 1 FROM codeact_fault_flags WHERE name = 'finalize')
         THEN RAISE EXCEPTION 'injected finalize failure'; END IF;
       RETURN NEW;
     END $$ LANGUAGE plpgsql;
     DROP TRIGGER IF EXISTS codeact_fault_finalize ON code_executions;
     CREATE TRIGGER codeact_fault_finalize BEFORE UPDATE ON code_executions
       FOR EACH ROW EXECUTE FUNCTION codeact_fault_finalize();`,
  );
  await definitions.create({
    key: "codeact-evidence",
    spec: { name: "CodeAct evidence", steps: [{ key: "investigate", type: "agent", config: {} }] },
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
  Object.assign(config.codeAct, { enabled: false, persistTimeoutMs: 10000 });
  await q(pool, "DELETE FROM codeact_fault_flags");
  for (const id of runs.splice(0)) {
    const r = await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [id]);
    if (!["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) await cancelRun(id);
  }
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

async function attemptEnv(signal: AbortSignal = new AbortController().signal) {
  const item = await workItems.createManual({
    title: "Refund timeouts",
    description: "Investigate refund timeouts",
    project: "OMS",
    ownerId: owner.id,
  });
  const run = await startRun({
    definitionKey: "codeact-evidence",
    workItemId: item.id,
    ownerId: owner.id,
  });
  runs.push(run.id);
  const job = (await claimJob("codeact-evidence", 120))!;
  const begun = (await beginAttempt(job, "codeact-evidence"))!;
  return envFromExecution(
    makeContext({ ...begun, signal }),
    "analysis",
    policy,
    newMetrics("fixture-model"),
    () => {},
  );
}
const execute = async (code: string, signal?: AbortSignal) => {
  config.codeAct.enabled = true;
  const env = await attemptEnv(signal);
  return {
    env,
    answer: JSON.parse(await dispatchPlatformTool("platform.execute_code", { code }, env)),
  };
};
const rowsOf = (executionId: number) =>
  q<{ seq: number; tool: string; status: string; result: unknown }>(
    pool,
    "SELECT seq, tool, status, result FROM code_execution_calls WHERE execution_id = $1 ORDER BY seq",
    [executionId],
  );
const executionOf = (ref: string) => Number(ref.split(":")[1]);

test("workflow: every emitted reference resolves to its persisted row for the owner", async () => {
  const { env, answer } = await execute(
    `return [await platform.callTool("evi.orders", {i: 1}), await platform.callTool("evi.orders", {i: 2})]`,
  );
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.evidence_status, "complete");
  assert.equal(answer.evidence.length, 2);
  const id = executionOf(answer.evidence[0]);
  const exec = await one(pool, "SELECT run_id, status, calls FROM code_executions WHERE id = $1", [
    id,
  ]);
  assert.deepEqual([Number(exec.run_id), exec.status, exec.calls], [env.runId, "ok", 2]);
  const rows = await rowsOf(id);
  assert.deepEqual(
    rows.map((r) => [r.seq, r.tool, r.status]),
    [
      [1, "evi.orders", "ok"],
      [2, "evi.orders", "ok"],
    ],
  );
  for (const ref of answer.evidence) {
    const hit = await resolveCodeActEvidence(actorOf(owner), ref);
    assert.ok(hit, `${ref} resolves`);
    assert.equal(hit.tool, "evi.orders");
    assert.equal(hit.run_id, env.runId);
  }
  const first = await resolveCodeActEvidence(actorOf(owner), answer.evidence[0]);
  assert.deepEqual(first?.result, { result: { order: "ORD-1", status: "timeout" } });
  console.log(`M1-EVIDENCE ${JSON.stringify({ execution_id: id, refs: answer.evidence, rows })}`);
});

test("workflow: a PostgreSQL insert failure emits no reference for that call and says so", async () => {
  const { answer } = await execute(
    `const a = await platform.callTool("evi.orders", {i: 1});
     const b = await platform.callTool("evi.unrecordable", {});
     const c = await platform.callTool("evi.orders", {i: 3});
     return { a, b, c };`,
  );
  assert.equal(answer.ok, true, "the program's value is still returned");
  assert.equal(answer.evidence_status, "partial");
  assert.equal(answer.evidence.length, 2);
  const id = executionOf(answer.evidence[0]);
  assert.deepEqual(answer.evidence, [`codeact:${id}:1`, `codeact:${id}:3`]);
  const missing = answer.calls.find((c: { seq: number }) => c.seq === 2);
  assert.deepEqual([missing.status, missing.ref, missing.recorded], ["ok", undefined, false]);
  assert.ok(
    answer.warnings.some((w: string) => /not recorded/.test(w) && /evi\.unrecordable/.test(w)),
  );
  assert.deepEqual(
    (await rowsOf(id)).map((r) => r.seq),
    [1, 3],
    "no row, no reference",
  );
  assert.equal(await resolveCodeActEvidence(actorOf(owner), `codeact:${id}:2`), null);
  console.log(
    `M1-FAILURE-INJECTION ${JSON.stringify({ execution_id: id, emitted: answer.evidence, warnings: answer.warnings })}`,
  );
});

test("workflow: when every recording fails no evidence is claimed", async () => {
  const { answer } = await execute(`return await platform.callTool("evi.unrecordable", {})`);
  assert.equal(answer.ok, true);
  assert.equal(answer.evidence_status, "none");
  assert.deepEqual(answer.evidence, []);
});

test("workflow: a recording slower than persistTimeoutMs is not cited, even if the row lands later", async () => {
  config.codeAct.persistTimeoutMs = 200;
  const { answer } = await execute(
    `return [await platform.callTool("evi.orders", {i: 1}), await platform.callTool("evi.slowrecord", {})]`,
  );
  assert.equal(answer.ok, true);
  assert.equal(answer.evidence.length, 1);
  assert.match(answer.evidence[0], /:1$/);
  assert.ok(answer.warnings.some((w: string) => /timed out/.test(w)));
});

test("workflow: cancellation while a row is being written: only rows that landed are cited, all resolve", async () => {
  const ac = new AbortController();
  config.codeAct.enabled = true;
  const env = await attemptEnv(ac.signal);
  const pending = dispatchPlatformTool(
    "platform.execute_code",
    {
      code: `await platform.callTool("evi.orders", {i: 1});
             await platform.callTool("evi.slowrecord", {});
             await new Promise(() => {});`,
    },
    env,
  );
  setTimeout(() => ac.abort("run canceled"), 300);
  const answer = JSON.parse(await pending);
  assert.equal(answer.ok, false);
  assert.equal(answer.category, "canceled");
  const exec = await one(
    pool,
    "SELECT id, status FROM code_executions WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
    [env.runId],
  );
  assert.equal(exec.status, "error");
  const rows = await rowsOf(Number(exec.id));
  for (const ref of answer.evidence) {
    assert.ok(
      rows.some((r) => `codeact:${exec.id}:${r.seq}` === ref),
      `${ref} has a row`,
    );
    assert.ok(await resolveCodeActEvidence(actorOf(owner), ref));
  }
  assert.ok(answer.evidence.includes(`codeact:${exec.id}:1`));
});

test("workflow: an execution that cannot be finalized cites nothing", async () => {
  await q(pool, "INSERT INTO codeact_fault_flags VALUES ('finalize')");
  const { env, answer } = await execute(`return await platform.callTool("evi.orders", {i: 1})`);
  assert.deepEqual(answer.evidence, []);
  assert.equal(answer.evidence_status, "none");
  assert.ok(answer.warnings.some((w: string) => /finaliz/.test(w)));
  const exec = await one(pool, "SELECT id, status FROM code_executions WHERE run_id = $1", [
    env.runId,
  ]);
  assert.equal(exec.status, "running", "left for the stale-execution reconciler");
  assert.equal(
    await resolveCodeActEvidence(actorOf(owner), `codeact:${exec.id}:1`),
    null,
    "a running execution's rows are not evidence",
  );
});

test("persistence: a duplicate (execution, seq) is refused by the database; one row remains", async () => {
  const { answer } = await execute(`return await platform.callTool("evi.orders", {i: 1})`);
  const id = executionOf(answer.evidence[0]);
  await assert.rejects(
    recordCodeActCallForTests(id, {
      seq: 1,
      tool: "evi.orders",
      status: "ok",
      ms: 1,
      input_sha256: "0".repeat(64),
      bytes: 2,
      read_only: true,
    }),
    /duplicate key|unique/,
  );
  assert.equal((await rowsOf(id)).length, 1);
});

test("recovery: an interrupted execution's rows resolve only after it is reconciled as finished", async () => {
  const { env } = await execute(`return 1`);
  const stale = await one(
    pool,
    `INSERT INTO code_executions (owner_id, surface, run_id, status, code_sha256, created_at)
     VALUES ($1, 'workflow', $2, 'running', repeat('0', 64), now() - interval '1 hour') RETURNING id`,
    [owner.id, env.runId],
  );
  await q(
    pool,
    `INSERT INTO code_execution_calls (execution_id, seq, tool, read_only, status, duration_ms, input_sha256, result)
     VALUES ($1, 1, 'evi.orders', true, 'ok', 1, repeat('0', 64), '{"result":{"order":"ORD-9"}}')`,
    [stale.id],
  );
  assert.equal(await resolveCodeActEvidence(actorOf(owner), `codeact:${stale.id}:1`), null);
  await execute(`return 2`); // a new execution reconciles stale ones first
  const row = await one(pool, "SELECT status, error_category FROM code_executions WHERE id = $1", [
    stale.id,
  ]);
  assert.deepEqual([row.status, row.error_category], ["error", "internal"]);
  assert.equal(
    (await resolveCodeActEvidence(actorOf(owner), `codeact:${stale.id}:1`))?.tool,
    "evi.orders",
  );
});

test("isolation: another member cannot resolve the owner's references; an admin only in support mode", async () => {
  const { answer } = await execute(`return await platform.callTool("evi.orders", {i: 7})`);
  const ref = answer.evidence[0];
  assert.equal(await resolveCodeActEvidence(actorOf(stranger), ref), null);
  assert.equal(await resolveCodeActEvidence(actorOf(admin), ref), null);
  const viaSupport = await resolveCodeActEvidence(actorOf(admin), ref, { support: true });
  assert.equal(viaSupport?.tool, "evi.orders");
  const audited = await one(
    pool,
    "SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'support.access' AND resource_type = 'code_execution'",
    [admin.id],
  );
  assert.ok(audited.n >= 1);
  for (const bad of [
    "codeact:abc:1",
    "codeact:1",
    "integration:1:1",
    `codeact:${executionOf(ref)}:99`,
  ])
    assert.equal(await resolveCodeActEvidence(actorOf(owner), bad), null, bad);
});

test("chat: code.execute cites only recorded calls and its references resolve for the owner only", async () => {
  config.codeAct.enabled = true;
  const actor = actorOf(owner);
  const c = await chat.create(actor, { mode: "INVESTIGATE", provider: "claude" });
  const program = `return [await platform.callTool("evi.orders", {i: 4}), await platform.callTool("evi.unrecordable", {})]`;
  let i = 0;
  const replies = [
    "```chat-tool\n" +
      JSON.stringify({ calls: [{ tool: "code.execute", arguments: { code: program } }] }) +
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
    content: "refund timeouts?",
    client_message_id: "evidence-chat-1",
  });
  for (let n = 0; n < 200; n++) {
    const d = await chat.get(actor, c.id);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status))) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const call = await one(
    pool,
    "SELECT result FROM chat_tool_calls WHERE conversation_id = $1 AND tool = 'code.execute'",
    [c.id],
  );
  const answer = call.result;
  assert.equal(answer.evidence_status, "partial");
  assert.equal(answer.evidence.length, 1);
  const hit = await resolveCodeActEvidence(actor, answer.evidence[0]);
  assert.equal(hit?.surface, "chat");
  assert.equal(hit?.conversation_id, c.id);
  assert.equal(await resolveCodeActEvidence(actorOf(stranger), answer.evidence[0]), null);
});

test("runtime: through the real OS sandbox, emitted references resolve to persisted rows", async (t) => {
  const { probeIsolation } = await import("../src/agent/isolation.ts");
  const runtime = await probeIsolation();
  if (!runtime.available) return t.skip(`OS isolation unavailable: ${runtime.problems.join("; ")}`);
  setCodeActLauncherForTests(undefined);
  try {
    const { answer } = await execute(
      `const r = await Promise.all([1, 2, 3].map((i) => platform.callTool("evi.orders", { i })));
       return r.map((x) => x.order);`,
    );
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.value, ["ORD-1", "ORD-2", "ORD-3"]);
    assert.equal(answer.evidence_status, "complete");
    for (const ref of answer.evidence)
      assert.equal((await resolveCodeActEvidence(actorOf(owner), ref))?.tool, "evi.orders");
    console.log(`M1-SANDBOX ${JSON.stringify({ refs: answer.evidence, stats: answer.stats })}`);
  } finally {
    setCodeActLauncherForTests(async (node, args) => ({
      command: node,
      args,
      env: { PATH: process.env.PATH ?? "" },
    }));
  }
});
