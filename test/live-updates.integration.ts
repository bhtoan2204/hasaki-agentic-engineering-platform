/**
 * Live updates over SSE: cursor replay after reconnection, no duplicates, several tabs, owner isolation, completed
 * runs, oversized gaps and a LISTEN outage. Real HTTP server, real PostgreSQL LISTEN/NOTIFY.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { runEvents } from "../src/workflow/events.ts";
import {
  startEventStream,
  stopEventStream,
  streamClientCount,
  REPLAY_LIMIT,
} from "../src/api/stream.ts";
import { isStateChange } from "../web/src/api.ts";

let server: Server;
let base = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(username: string, password: string) {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { csrf } = await r.json();
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrf }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { cookie, call };
}

type Frame = { event: string; id?: number; data: any };
/** A minimal EventSource: collects frames until closed. */
async function stream(cookie: string, query = "", headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream${query}`, {
    headers: { cookie, ...headers },
    signal: ctrl.signal,
  });
  const frames: Frame[] = [];
  const done = (async () => {
    if (!res.body) return;
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f: Frame = { event: "message", data: null };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("id: ")) f.id = Number(line.slice(4));
            else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
          }
          if (f.data !== null) frames.push(f);
        }
      }
    } catch {
      // aborted
    }
  })();
  const changes = () => frames.filter((f) => f.event === "change");
  return {
    status: res.status,
    frames,
    changes,
    ids: () => changes().map((f) => f.id!),
    hello: () => frames.filter((f) => f.event === "hello"),
    async until(pred: () => boolean, ms = 5000) {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
        await sleep(20);
      }
    },
    async close() {
      ctrl.abort();
      await done;
    },
  };
}

async function newRun(
  call: (p: string, b?: unknown) => Promise<{ status: number; body: any }>,
  title: string,
) {
  const wi = (await call("/api/work-items", { title, project: "OMS" })).body;
  const run = (
    await call("/api/runs", { workflow: "bug-investigation", work_item_id: wi.id, start: false })
  ).body;
  const step = (await one<{ id: number }>(
    pool,
    "SELECT id FROM workflow_steps WHERE run_id = $1 ORDER BY position LIMIT 1",
    [run.id],
  ))!;
  return { runId: Number(run.id), stepId: Number(step.id) };
}
const emit = (runId: number, kind = "tool", stepId: number | null = null) =>
  runEvents.add(pool, runId, kind, `${kind} line`, stepId);
const lastEventId = async () =>
  Number(
    (await one<{ id: string }>(pool, "SELECT COALESCE(max(id), 0) AS id FROM workflow_events"))!.id,
  );

let A: Awaited<ReturnType<typeof login>>;
let B: Awaited<ReturnType<typeof login>>;
let admin: Awaited<ReturnType<typeof login>>;

before(async () => {
  await migrate();
  await seedTemplates();
  await seedKnowledge();
  await createUser({ username: "live-admin", password: "live-admin-password", role: "admin" });
  await createUser({ username: "live-a", password: "live-a-password", role: "member" });
  await createUser({ username: "live-b", password: "live-b-password", role: "member" });
  await startEventStream();
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  A = await login("live-a", "live-a-password");
  B = await login("live-b", "live-b-password");
  admin = await login("live-admin", "live-admin-password");
});

after(async () => {
  await stopEventStream();
  server.closeAllConnections();
  server.close();
  await pool.end();
});

test("every live event carries its workflow_events id and only ids, never content", async () => {
  const { runId, stepId } = await newRun(A.call, "ids");
  const s = await stream(A.cookie);
  await s.until(() => s.hello().length === 1);
  assert.equal(s.hello()[0].data.live, true);
  assert.equal(typeof s.hello()[0].data.cursor, "number");
  await emit(runId, "status", stepId);
  await s.until(() => s.changes().length === 1);
  const f = s.changes()[0];
  assert.equal(f.id, f.data.id);
  assert.deepEqual(Object.keys(f.data).sort(), ["attempt_id", "id", "kind", "run_id", "step_id"]);
  assert.equal(f.data.run_id, runId);
  await s.close();
});

test("reconnection with Last-Event-ID or ?after= replays the missed events once, then continues live", async () => {
  const { runId } = await newRun(A.call, "reconnect");
  const first = await stream(A.cookie);
  await first.until(() => first.hello().length === 1);
  await emit(runId);
  await first.until(() => first.changes().length === 1);
  let seen = first.ids()[0];
  await first.close();

  for (const how of ["header", "query"] as const) {
    // missed while disconnected
    await emit(runId, "tool");
    await emit(runId, "status");
    await emit(runId, "agent");
    const s =
      how === "header"
        ? await stream(A.cookie, "", { "last-event-id": String(seen) })
        : await stream(A.cookie, `?after=${seen}`);
    await s.until(() => s.hello().length === 1);
    assert.equal(s.hello()[0].data.replayed, 3, how);
    assert.equal(s.hello()[0].data.reset, false, how);
    assert.deepEqual(
      s.changes().map((f) => f.data.kind),
      ["tool", "status", "agent"],
      how,
    );
    // replay frames precede hello; live continues afterwards
    await emit(runId, "status");
    await s.until(() => s.changes().length === 4);
    const ids = s.ids();
    assert.equal(new Set(ids).size, ids.length, `${how}: no duplicates`);
    assert.ok(
      ids.every((id, i) => i === 0 || id > ids[i - 1]),
      `${how}: in order`,
    );
    seen = ids.at(-1)!;
    await s.close();
  }
});

test("events committed while a replay is running are delivered exactly once", async () => {
  const { runId } = await newRun(A.call, "race");
  const from = await lastEventId();
  for (let i = 0; i < 40; i++) await emit(runId);
  // more events race with the replay query
  const writer = (async () => {
    for (let i = 0; i < 40; i++) await emit(runId);
  })();
  const s = await stream(A.cookie, `?after=${from}`);
  await writer;
  await s.until(() => s.changes().length >= 80);
  await sleep(200);
  const ids = s.ids();
  assert.equal(ids.length, 80);
  assert.equal(new Set(ids).size, 80);
  await s.close();
});

test("several tabs of one user each get every event, with independent cursors", async () => {
  const { runId } = await newRun(A.call, "tabs");
  const tab1 = await stream(A.cookie);
  const tab2 = await stream(A.cookie, `?run_id=${runId}`);
  await tab1.until(() => tab1.hello().length === 1);
  await tab2.until(() => tab2.hello().length === 1);
  await emit(runId, "status");
  await emit(runId, "tool");
  await tab1.until(() => tab1.changes().length === 2);
  await tab2.until(() => tab2.changes().length === 2);
  assert.deepEqual(tab1.ids(), tab2.ids());
  const cut = tab1.ids()[0];
  await tab1.close();
  await emit(runId, "agent");
  await tab2.until(() => tab2.changes().length === 3);
  // tab1 comes back from its own cursor; tab2 was never interrupted
  const back = await stream(A.cookie, `?after=${cut}`);
  await back.until(() => back.hello().length === 1);
  assert.deepEqual(back.ids(), tab2.ids().slice(1));
  await Promise.all([tab2.close(), back.close()]);
});

test("owner isolation: another member sees no event live, in replay or in the polling fallback", async () => {
  const { runId: runA } = await newRun(A.call, "private A");
  const { runId: runB } = await newRun(B.call, "private B");
  const from = await lastEventId();
  const sb = await stream(B.cookie);
  const adminOwn = await stream(admin.cookie);
  const adminAll = await stream(admin.cookie, "?scope=all");
  await Promise.all([sb, adminOwn, adminAll].map((s) => s.until(() => s.hello().length === 1)));
  await emit(runA, "status");
  await emit(runB, "status");
  await sb.until(() => sb.changes().length >= 1);
  await adminAll.until(() => adminAll.changes().length >= 2);
  await sleep(300);
  assert.deepEqual(
    sb.changes().map((f) => f.data.run_id),
    [runB],
  );
  assert.equal(
    adminOwn.changes().length,
    0,
    "an admin sees other members' runs only in the audited support view",
  );
  assert.deepEqual(
    adminAll
      .changes()
      .map((f) => f.data.run_id)
      .sort(),
    [runA, runB].sort(),
  );

  const replay = await stream(B.cookie, `?after=${from}`);
  await replay.until(() => replay.hello().length === 1);
  assert.deepEqual(
    replay.changes().map((f) => f.data.run_id),
    [runB],
  );

  const polled = await B.call(`/api/events?after=${from}`);
  assert.equal(polled.status, 200);
  assert.deepEqual(
    polled.body.events.map((e: any) => e.run_id),
    [runB],
  );

  assert.equal((await stream(B.cookie, `?run_id=${runA}`)).status, 404);
  assert.equal((await B.call(`/api/events?after=0&run_id=${runA}`)).status, 404);
  const anon = await fetch(`${base}/api/events?after=0`);
  assert.equal(anon.status, 401);

  // an ownerless (unclaimed legacy) run is visible to nobody
  await pool.query("UPDATE workflow_runs SET owner_id = NULL WHERE id = $1", [runB]);
  const orphanFrom = await lastEventId();
  await emit(runB, "status");
  const orphan = await admin.call(`/api/events?after=${orphanFrom}&scope=all`);
  assert.deepEqual(orphan.body.events, []);
  await Promise.all([sb, adminOwn, adminAll, replay].map((s) => s.close()));
});

test("a completed run replays its history and its stream simply stays quiet", async () => {
  const { runId } = await newRun(A.call, "done");
  const from = await lastEventId();
  await emit(runId, "status");
  await emit(runId, "tool");
  await pool.query(
    "UPDATE workflow_runs SET status = 'COMPLETED', finished_at = now() WHERE id = $1",
    [runId],
  );
  await runEvents.add(pool, runId, "status", "run: RUNNING → COMPLETED");
  const s = await stream(A.cookie, `?run_id=${runId}&after=${from}`);
  await s.until(() => s.hello().length === 1);
  assert.deepEqual(
    s.changes().map((f) => f.data.kind),
    ["status", "tool", "status"],
  );
  const polled = await A.call(`/api/events?after=${s.hello()[0].data.cursor}&run_id=${runId}`);
  assert.deepEqual(polled.body, { events: [], reset: false, cursor: s.hello()[0].data.cursor });
  await s.close();
});

test("a gap larger than the replay limit asks the client to reload instead of streaming it", async () => {
  const { runId, stepId } = await newRun(A.call, "big gap");
  const from = await lastEventId();
  await pool.query(
    "INSERT INTO workflow_events (run_id, step_id, kind, content) SELECT $1, $2, 'tool', 'x' FROM generate_series(1, $3)",
    [runId, stepId, REPLAY_LIMIT + 1],
  );
  const s = await stream(A.cookie, `?after=${from}`);
  await s.until(() => s.hello().length === 1);
  assert.equal(s.hello()[0].data.reset, true);
  assert.equal(s.changes().length, 0);
  const polled = await A.call(`/api/events?after=${from}`);
  assert.equal(polled.body.reset, true);
  assert.equal(polled.body.events.length, 0);
  // no cursor at all: reset, but the answer carries one to continue from
  const fresh = await A.call("/api/events");
  assert.equal(fresh.body.reset, true);
  assert.ok(fresh.body.cursor >= from + REPLAY_LIMIT + 1);
  await s.close();
});

test("a LISTEN outage switches clients to the fallback and replays what was missed when it comes back", async () => {
  const { runId } = await newRun(A.call, "outage");
  const s = await stream(A.cookie);
  await s.until(() => s.hello().length === 1);
  await pool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN workflow_events' AND pid <> pg_backend_pid()",
  );
  await s.until(() => s.hello().some((h) => h.data.live === false));
  await emit(runId, "status"); // no listener: this NOTIFY reaches nobody
  await s.until(() => s.hello().at(-1)!.data.live === true, 10_000);
  await s.until(() => s.changes().length === 1);
  assert.equal(s.changes()[0].data.kind, "status");
  // and live again
  await emit(runId, "tool");
  await s.until(() => s.changes().length === 2);
  await s.close();
});

test("closed streams are released", async () => {
  await sleep(100);
  const before = streamClientCount();
  const s = await stream(A.cookie);
  await s.until(() => s.hello().length === 1);
  assert.equal(streamClientCount(), before + 1);
  await s.close();
  const end = Date.now() + 2000;
  while (streamClientCount() !== before && Date.now() < end) await sleep(20);
  assert.equal(streamClientCount(), before);
});

test("client classification: transcript lines are activity, everything else may change state", () => {
  const p = (kind: string, attempt_id: number | null = 1) => ({
    id: 1,
    run_id: 1,
    step_id: 1,
    attempt_id,
    kind,
  });
  for (const k of [
    "tool",
    "tool_result",
    "agent",
    "thinking",
    "prompt",
    "system_prompt",
    "result",
    "log",
  ])
    assert.equal(isStateChange(p(k)), false, k);
  for (const k of ["status", "user", "provider_handoff", "something_new"])
    assert.equal(isStateChange(p(k)), true, k);
  assert.equal(isStateChange(p("system", 1)), false, "attempt-level narration");
  assert.equal(
    isStateChange(p("system", null)),
    true,
    "run-level note (selected repositories, branch directive)",
  );
  assert.equal(isStateChange(undefined), true, "catch-up without a payload");
});
