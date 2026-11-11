import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one, withTx } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { handle } from "../src/http/app.ts";
import { createUser, setActive } from "../src/auth/users.ts";
import { runEvents } from "../src/workflow/events.ts";
import { runDetail, startRun } from "../src/workflow/engine.ts";
import { workItems } from "../src/workitems/service.ts";

/**
 * Round-trip savings (remote database) must not change behaviour: idempotent create POSTs, buffered event inserts,
 * session cache invalidation and the parallel run detail.
 */

let server: Server;
let base = "";

function client() {
  let cookie = "";
  let csrf = "";
  return {
    async login(username: string, password: string) {
      const r = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      cookie = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""])
        .map((c) => c.split(";")[0])
        .filter(Boolean)
        .join("; ");
      csrf = (await r.json()).csrf ?? "";
      return r.status;
    },
    async call(path: string, body?: unknown, key?: string) {
      const headers: Record<string, string> = { cookie };
      if (body !== undefined)
        Object.assign(
          headers,
          { "content-type": "application/json", "x-csrf-token": csrf },
          key ? { "idempotency-key": key } : {},
        );
      const r = await fetch(base + path, {
        method: body !== undefined ? "POST" : "GET",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return {
        status: r.status,
        body: text ? JSON.parse(text) : null,
        replayed: r.headers.get("idempotent-replayed") === "true",
      };
    },
  };
}

before(async () => {
  await migrate();
  await seedTemplates();
  await createUser({ username: "lat", password: "latency-password", role: "admin" });
  await createUser({ username: "lat2", password: "latency-password", role: "member" });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
after(async () => {
  server?.close();
  await pool.end();
});

const workItemCount = async (title: string) =>
  (await one(pool, "SELECT count(*)::int AS n FROM work_items WHERE title = $1", [title])).n;

test("Idempotency-Key: a repeated create replays the first response; no key keeps the old behaviour", async () => {
  const c = client();
  assert.equal(await c.login("lat", "latency-password"), 200);
  const body = { title: "idem: refund fix", project: "Payment" };
  const first = await c.call("/api/work-items", body, "key-0001-aaaa");
  const again = await c.call("/api/work-items", body, "key-0001-aaaa");
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.replayed, true);
  assert.equal(again.body.id, first.body.id, "same response, not a second item");
  assert.equal(await workItemCount(body.title), 1);
  // The same key with another body is refused; a key is one request.
  assert.equal(
    (await c.call("/api/work-items", { ...body, title: "other" }, "key-0001-aaaa")).status,
    422,
  );
  // Concurrent duplicates (double click before the first answer): exactly one item.
  const conc = { title: "idem: concurrent", project: "Payment" };
  const rs = await Promise.all([
    c.call("/api/work-items", conc, "key-0002-bbbb"),
    c.call("/api/work-items", conc, "key-0002-bbbb"),
    c.call("/api/work-items", conc, "key-0002-bbbb"),
  ]);
  assert.equal(await workItemCount(conc.title), 1);
  assert.ok(
    rs.every((r) => r.status === 200 || r.status === 409),
    JSON.stringify(rs.map((r) => r.status)),
  );
  // A 4xx outcome is stored and replayed too (same input, same answer).
  const bad = await c.call("/api/work-items", { title: "" }, "key-0003-cccc");
  const badAgain = await c.call("/api/work-items", { title: "" }, "key-0003-cccc");
  assert.equal(bad.status, 400);
  assert.equal(badAgain.status, 400);
  assert.equal(badAgain.replayed, true);
  // Keys are per user: another user's identical key is independent.
  const other = client();
  await other.login("lat2", "latency-password");
  assert.equal((await other.call("/api/work-items", body, "key-0001-aaaa")).replayed, false);
  // Without a key (old clients) every POST creates.
  await c.call("/api/work-items", { title: "idem: no key" });
  await c.call("/api/work-items", { title: "idem: no key" });
  assert.equal(await workItemCount("idem: no key"), 2);
  // Routes that are not create-type ignore the key (state transitions are guarded by status checks).
  assert.equal(
    (await c.call("/api/knowledge-proposals/999/reject", {}, "key-0004-dddd")).status,
    404,
  );
  assert.equal(
    (await c.call("/api/knowledge-proposals/999/reject", {}, "key-0004-dddd")).replayed,
    false,
  );
});

test("events written inside a transaction are flushed once at COMMIT, in order, and vanish on rollback", async () => {
  const wi = await workItems.createManual({ title: "events batching" });
  const run = await startRun({
    definitionKey: "work-item-analysis",
    workItemId: wi.id,
    start: false,
  });
  const before = (
    await one(pool, "SELECT count(*)::int AS n FROM workflow_events WHERE run_id = $1", [run.id])
  ).n;
  await withTx(async (c) => {
    for (const n of [1, 2, 3]) await runEvents.add(c, run.id, "note", `batched ${n}`);
    // Not visible to other connections before COMMIT (and not yet written on this one either).
    assert.equal(
      (
        await one(pool, "SELECT count(*)::int AS n FROM workflow_events WHERE run_id = $1", [
          run.id,
        ])
      ).n,
      before,
    );
  });
  const rows = await q(
    pool,
    "SELECT content FROM workflow_events WHERE run_id = $1 AND content LIKE 'batched %' ORDER BY id",
    [run.id],
  );
  assert.deepEqual(
    rows.map((r) => r.content),
    ["batched 1", "batched 2", "batched 3"],
  );
  await assert.rejects(
    withTx(async (c) => {
      await runEvents.add(c, run.id, "note", "rolled back");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(
    (
      await one(
        pool,
        "SELECT count(*)::int AS n FROM workflow_events WHERE content = 'rolled back'",
      )
    ).n,
    0,
  );
  // Outside a transaction: written immediately.
  await runEvents.add(pool, run.id, "note", "immediate");
  assert.equal(
    (await one(pool, "SELECT count(*)::int AS n FROM workflow_events WHERE content = 'immediate'"))
      .n,
    1,
  );
});

test("session cache never outlives logout or deactivation in this process", async () => {
  await createUser({ username: "lat3", password: "latency-password", role: "member" });
  const c = client();
  await c.login("lat3", "latency-password");
  assert.equal((await c.call("/api/auth/me")).status, 200);
  assert.equal((await c.call("/api/auth/me")).status, 200, "served from cache");
  await c.call("/api/auth/logout", {});
  assert.equal((await c.call("/api/auth/me")).status, 401, "logout is immediate");
  await c.login("lat3", "latency-password");
  assert.equal((await c.call("/api/auth/me")).status, 200);
  const id = (await one(pool, "SELECT id FROM users WHERE username = 'lat3'")).id;
  await setActive(Number(id), false);
  assert.equal((await c.call("/api/auth/me")).status, 401, "deactivation is immediate");
});

test("run detail (parallel reads) keeps its shape", async () => {
  const wi = await workItems.createManual({ title: "detail shape", project: "OMS" });
  const run = await startRun({
    definitionKey: "work-item-analysis",
    workItemId: wi.id,
    start: false,
  });
  const d = await runDetail(run.id);
  assert.equal(d.id, run.id);
  assert.ok(Array.isArray(d.steps) && d.steps.length > 0);
  assert.equal(typeof d.definition_version, "number");
  assert.deepEqual(Object.keys(d.work_item!).sort(), ["code", "id", "project", "source", "title"]);
  assert.equal(d.work_item!.code, wi.code);
  assert.ok(!("wi_code" in d), "join helper columns are not leaked");
  for (const k of [
    "attempts",
    "questions",
    "artifacts",
    "pull_requests",
    "workspaces",
    "checkpoints",
  ])
    assert.ok(Array.isArray((d as any)[k]), k);
  await assert.rejects(runDetail(9_999_999), /not found/);
});
