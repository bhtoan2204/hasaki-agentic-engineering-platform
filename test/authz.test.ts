import { config } from "../src/config.ts";
import { repositories } from "../src/repos/service.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { createUser, setActive, setPassword } from "../src/auth/users.ts";
import { claimLegacy } from "../src/auth/legacy.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { workItems } from "../src/workitems/service.ts";
import { startRun } from "../src/workflow/engine.ts";
import { putUserSecret, getUserSecret } from "../src/auth/secrets.ts";
import { sessionFromRequest } from "../src/auth/sessions.ts";

let server: Server;
let base = "";

function client() {
  let cookie = "";
  let csrf = "";
  return {
    cookie: () => cookie,
    async login(username: string, password: string) {
      const r = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") ?? ""];
      cookie = raw.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
      const body = await r.json();
      csrf = body.csrf ?? "";
      return { status: r.status, body };
    },
    async call(path: string, body?: unknown) {
      const headers: Record<string, string> = {};
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        if (csrf) headers["x-csrf-token"] = csrf;
      }
      const r = await fetch(base + path, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      return { status: r.status, body: parsed, text };
    },
  };
}

before(async () => {
  await migrate();
  await seedTemplates();
  await seedKnowledge();
  await createUser({ username: "admin", password: "admin-password", role: "admin" });
  await createUser({ username: "membera", password: "member-a-password", role: "member" });
  await createUser({ username: "memberb", password: "member-b-password", role: "member" });
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  server?.close();
  await pool.end();
});

test("anonymous callers cannot use protected APIs, downloads or the event stream", async () => {
  const anon = client();
  assert.equal((await anon.call("/api/health")).status, 200);
  assert.equal((await anon.call("/api/ui-messages")).status, 200);
  assert.equal((await anon.call("/api/work-items")).status, 401);
  assert.equal((await anon.call("/api/runs")).status, 401);
  assert.equal((await anon.call("/api/artifacts/1/raw")).status, 401);
  assert.equal((await anon.call("/api/stream")).status, 401);
  assert.equal((await anon.call("/api/auth/login", { username: "nobody", password: "wrong-password" })).status, 401);
});

test("member A cannot read or mutate member B by id, and a mixed answer batch writes nothing", async () => {
  const a = client();
  const b = client();
  assert.equal((await a.login("membera", "member-a-password")).status, 200);
  assert.equal((await b.login("memberb", "member-b-password")).status, 200);
  const itemA = await (await a.call("/api/work-items", { title: "A only", project: "OMS" })).body;
  const itemB = await (await b.call("/api/work-items", { title: "B only", project: "OMS" })).body;
  assert.equal((await a.call(`/api/work-items/${itemB.id}`)).status, 404);
  assert.equal((await b.call(`/api/work-items/${itemA.id}`)).status, 404);
  assert.equal((await a.call(`/api/work-items/${itemB.id}`, { title: "stolen" })).status, 404);
  const runA = await (await a.call("/api/runs", { workflow: "bug-investigation", work_item_id: itemA.id, start: false })).body;
  const runB = await (await b.call("/api/runs", { workflow: "bug-investigation", work_item_id: itemB.id, start: false })).body;
  assert.equal((await a.call(`/api/runs/${runB.id}`)).status, 404);
  assert.equal((await a.call(`/api/runs/${runB.id}/pause`, {})).status, 404);
  assert.equal((await a.call(`/api/runs/${runB.id}/cancel`, {})).status, 404);
  const stepA = (await q<{ id: number }>(pool, "SELECT id FROM workflow_steps WHERE run_id = $1 ORDER BY position LIMIT 1", [runA.id]))[0];
  const stepB = (await q<{ id: number }>(pool, "SELECT id FROM workflow_steps WHERE run_id = $1 ORDER BY position LIMIT 1", [runB.id]))[0];
  const qa = await one<{ id: number }>(pool, "INSERT INTO workflow_questions (run_id, step_id, question, status) VALUES ($1, $2, 'a?', 'open') RETURNING id", [runA.id, stepA.id]);
  const qb = await one<{ id: number }>(pool, "INSERT INTO workflow_questions (run_id, step_id, question, status) VALUES ($1, $2, 'b?', 'open') RETURNING id", [runB.id, stepB.id]);
  const mixed = await a.call("/api/questions/answers", { answers: { [qa!.id]: "yes", [qb!.id]: "no" } });
  assert.equal(mixed.status, 404);
  const still = await one<{ status: string }>(pool, "SELECT status FROM workflow_questions WHERE id = $1", [qa!.id]);
  assert.equal(still?.status, "open");
  assert.equal(runA.owner_id, (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'membera'"))!.id);
  assert.equal(runA.agent_provider, "claude");
  const cursor = await (await a.call("/api/runs", { workflow: "bug-investigation", title: "cursor", start: false, agent_provider: "cursor" })).body;
  assert.equal(cursor.agent_provider, "cursor");
  assert.equal(cursor.owner_id, runA.owner_id);
});

test("two members import the same external task as separate private rows", async () => {
  const ua = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'membera'"))!;
  const ub = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'memberb'"))!;
  const first = await workItems.upsertImported({ source: "hasaki_work", code: "HSK-SAME", title: "A copy", ownerId: ua.id });
  const again = await workItems.upsertImported({ source: "hasaki_work", code: "HSK-SAME", title: "A again", ownerId: ua.id });
  const other = await workItems.upsertImported({ source: "hasaki_work", code: "HSK-SAME", title: "B copy", ownerId: ub.id });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(other.created, true);
  assert.notEqual(other.item.id, first.item.id);
  const run = await startRun({ definitionKey: "bug-investigation", workItemId: first.item.id, start: false });
  assert.equal(run.owner_id, ua.id);
  assert.equal(run.inputs.task_code, "HSK-SAME");
  assert.equal(run.branch, `u${ua.id}-HSK-SAME`);
});

test("shared templates are usable by members and writable only by an admin", async () => {
  const a = client();
  const admin = client();
  await a.login("membera", "member-a-password");
  await admin.login("admin", "admin-password");
  assert.equal((await a.call("/api/workflows/bug-investigation")).status, 200);
  assert.equal((await a.call("/api/workflows/bug-investigation/draft", { spec: { name: "x", steps: [] } })).status, 403);
  const cloned = await a.call("/api/workflows/bug-investigation/clone", {});
  assert.equal(cloned.status, 200);
  assert.equal(cloned.body.owner_id, (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'membera'"))!.id);
  const priv = await knowledge.create({
    key: "private-note-a", category: "business_rule", scope_type: "GLOBAL", title: "A note", content: "only A", ownerId: cloned.body.owner_id,
  });
  const ownerB = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'memberb'"))!.id;
  const seenByB = (await knowledge.candidates(pool, ownerB)).some((k) => k.key === "private-note-a");
  const seenByA = (await knowledge.candidates(pool, Number(priv.owner_id))).some((k) => k.key === "private-note-a");
  assert.equal(seenByB, false);
  assert.equal(seenByA, true);
});

test("secrets stay on the owning account, and logout, reset and deactivation revoke the session", async () => {
  const a = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'membera'"))!;
  const b = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'memberb'"))!;
  await Promise.all([putUserSecret(a.id, "hasaki_token", "aaa.bbb.ccc"), putUserSecret(b.id, "hasaki_token", "ddd.eee.fff")]);
  assert.equal(await getUserSecret(a.id, "hasaki_token"), "aaa.bbb.ccc");
  assert.equal(await getUserSecret(b.id, "hasaki_token"), "ddd.eee.fff");
  const member = client();
  await member.login("membera", "member-a-password");
  assert.equal((await member.call("/api/auth/logout", {})).status, 200);
  assert.equal((await member.call("/api/work-items")).status, 401);
  await member.login("membera", "member-a-password");
  await setPassword(a.id, "member-a-password");
  assert.equal((await member.call("/api/work-items")).status, 401);
  await member.login("membera", "member-a-password");
  await setActive(a.id, false);
  assert.equal((await member.call("/api/work-items")).status, 401);
  await assert.rejects(startRun({ definitionKey: "bug-investigation", title: "inactive", ownerId: a.id, start: false }), /not active/);
  await setActive(a.id, true);
});

test("unassigned legacy rows stay hidden until an admin claims them", async () => {
  await q(pool, "INSERT INTO work_items (code, source, title, owner_id) VALUES ('LEGACY-1', 'manual', 'old', NULL)");
  const member = client();
  const admin = client();
  await member.login("memberb", "member-b-password");
  await admin.login("admin", "admin-password");
  const listed = await member.call("/api/work-items");
  assert.equal(listed.body.some((w: { code: string }) => w.code === "LEGACY-1"), false);
  const id = (await one<{ id: number }>(pool, "SELECT id FROM work_items WHERE code = 'LEGACY-1' AND owner_id IS NULL"))!.id;
  assert.equal((await admin.call(`/api/work-items/${id}`)).status, 404);
  const adminId = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'admin'"))!.id;
  const ownedBefore = (await pool.query("SELECT id, owner_id FROM work_items WHERE owner_id IS NOT NULL ORDER BY id")).rows;
  const sharedBefore = (await pool.query("SELECT id FROM knowledge_items WHERE owner_id IS NULL ORDER BY id")).rows;
  const claimed = await claimLegacy(adminId);
  assert.deepEqual((await pool.query("SELECT id, owner_id FROM work_items WHERE id = ANY($1::bigint[]) ORDER BY id", [ownedBefore.map((r) => r.id)])).rows, ownedBefore);
  assert.deepEqual((await pool.query("SELECT id FROM knowledge_items WHERE owner_id IS NULL ORDER BY id")).rows, sharedBefore);
  assert.ok(claimed.work_items >= 1);
  assert.equal((await admin.call(`/api/work-items/${id}`)).status, 200);
  assert.equal((await member.call(`/api/work-items/${id}`)).status, 404);
  const shared = await one<{ owner_id: number | null }>(pool, "SELECT owner_id FROM workflow_definitions WHERE key = 'bug-investigation' AND owner_id IS NULL");
  assert.ok(shared);
  assert.equal(shared.owner_id, null);
});

test("a resumed run keeps the owner stored on the row", async () => {
  const a = (await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = 'membera'"))!;
  const run = await startRun({ definitionKey: "bug-investigation", title: "resume owner", ownerId: a.id, start: false, agentProvider: "cursor" });
  const again = await one<{ owner_id: number; agent_provider: string }>(pool, "SELECT owner_id, agent_provider FROM workflow_runs WHERE id = $1", [run.id]);
  assert.equal(again?.owner_id, a.id);
  assert.equal(again?.agent_provider, "cursor");
  const req = { headers: { cookie: "" }, socket: {} } as any;
  assert.equal(await sessionFromRequest(req), null);
});

 test("Chrome hosted endpoint stays authenticated, CSRF protected and cannot be enabled by client input", async () => {
  const member = client();
  await member.login("memberb", "member-b-password");
  const result = await member.call("/api/work/login-window", { userId: 1, browserMode: "local" });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "chrome_hosted");
  assert.equal((await member.call("/api/work/status")).body.browserMode, "hosted");
});

test("personal Chrome endpoint rejects another member even with a forged owner in the body", async () => {
  const previous = { mode: process.env.HASAKI_WORK_BROWSER_MODE, profile: process.env.HASAKI_WORK_CHROME_PROFILE, owner: process.env.HASAKI_WORK_EXISTING_CHROME_USER, host: process.env.HOST };
  try {
    process.env.HASAKI_WORK_BROWSER_MODE = "local";
    process.env.HASAKI_WORK_CHROME_PROFILE = "existing";
    process.env.HASAKI_WORK_EXISTING_CHROME_USER = "toan";
    process.env.HOST = "127.0.0.1";
    const member = client();
    await member.login("memberb", "member-b-password");
    const result = await member.call("/api/work/login-window", { username: "toan", userId: 1 });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "chrome_existing_owner");
  } finally {
    for (const [k,v] of Object.entries({ HASAKI_WORK_BROWSER_MODE: previous.mode, HASAKI_WORK_CHROME_PROFILE: previous.profile, HASAKI_WORK_EXISTING_CHROME_USER: previous.owner, HOST: previous.host })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});


test("P1 status is authenticated; reindex and cancellation require an administrator; disabling is reversible", async () => {
  const previous = config.codeIntelligence.enabled;
  try {
    config.codeIntelligence.enabled = true;
    const admin = client(), member = client();
    await admin.login("admin", "admin-password");
    await member.login("membera", "member-a-password");
    await repositories.upsert("p1-api-status", { projects: ["P1"] });
    assert.equal((await client().call("/api/repositories/index-status")).status, 401);
    assert.equal((await member.call("/api/repositories/p1-api-status/reindex", {})).status, 403);
    const queued = await admin.call("/api/repositories/p1-api-status/reindex", {});
    assert.equal(queued.status, 200); assert.equal(queued.body.job.status, "queued");
    const status = await member.call("/api/repositories/index-status");
    assert.equal(status.status, 200); assert.equal(status.body.repositories.find((r: any) => r.name === "p1-api-status").status, "queued");
    assert.equal((await member.call(`/api/repositories/index-runs/${queued.body.job.id}/cancel`, {})).status, 403);
    assert.equal((await admin.call(`/api/repositories/index-runs/${queued.body.job.id}/cancel`, {})).status, 200);
    config.codeIntelligence.enabled = false;
    assert.deepEqual((await admin.call("/api/repositories/index-status")).body, { enabled: false, repositories: [] });
  } finally { config.codeIntelligence.enabled = previous; }
});

test("P2 suites and evaluation results require authentication and preserve evaluation ownership",async()=>{
 const previous=config.evaluation.enabled;config.evaluation.enabled=true;
 try{
  const admin=client(),a=client(),b=client();await admin.login('admin','admin-password');await a.login('membera','member-a-password');await b.login('memberb','member-b-password');
  assert.equal((await client().call('/api/benchmark-suites')).status,401);
  assert.equal((await a.call('/api/benchmark-suites/publish',{})).status,403);
  const suite=await admin.call('/api/benchmark-suites/publish',{});assert.equal(suite.status,200);
  const evaluation=await a.call('/api/evaluation-runs',{suite_id:suite.body.id,request_key:'http-evaluation',configuration:{mode:'dry_run',case_limit:1}});assert.equal(evaluation.status,200);
  assert.equal((await b.call(`/api/evaluation-runs/${evaluation.body.id}`)).status,404);
  assert.equal((await b.call(`/api/evaluation-runs/${evaluation.body.id}/start`,{})).status,404);
  assert.equal((await b.call(`/api/evaluation-runs/${evaluation.body.id}/cancel`,{})).status,404);
  assert.equal((await a.call(`/api/evaluation-runs/${evaluation.body.id}`)).status,200);
  assert.equal((await a.call('/api/evaluation-runs',{suite_id:suite.body.id,request_key:'http-live',configuration:{mode:'live',provider:'claude'}})).status,403);
  assert.equal((await a.call(`/api/evaluation-runs/${evaluation.body.id}/cancel`,{})).status,200);
 }finally{config.evaluation.enabled=previous;}
});
