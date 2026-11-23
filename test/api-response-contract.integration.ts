import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createUser } from "../src/auth/users.ts";
import { config } from "../src/config.ts";
import { one, pool, q } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
import { registerInstance } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { beginAttempt, startRun } from "../src/workflow/engine.ts";
import { claimJob } from "../src/workflow/scheduler.ts";

let server: Server;
let base: string;
let session: { cookie: string; "x-csrf-token": string };
let runId: number;
let attemptId: number;
const username = "api-contract-admin";
const password = "test-contract-password";

function post(path: string, body?: string, headers?: Record<string, string>) {
  return fetch(base + path, {
    method: "POST",
    headers: { ...session, "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

function get(path: string) {
  return fetch(base + path, { headers: session, signal: AbortSignal.timeout(5000) });
}

async function assertError(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { error });
}

before(async () => {
  await registerInstance();
  const owner = await createUser({ username, password, role: "admin" });
  await definitions.create({
    key: "api-contract",
    spec: { name: "API contract", steps: [{ key: "input", type: "human_input" }] },
  });
  const run = await startRun({ definitionKey: "api-contract", ownerId: owner.id });
  runId = run.id;
  const worker = "api-contract-worker";
  const job = await claimJob(worker, 180);
  assert.ok(job);
  const begun = await beginAttempt(job, worker);
  assert.ok(begun);
  attemptId = begun.attempt.id;
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const login = await post("/api/auth/login", JSON.stringify({ username, password }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const { csrf } = await login.json();
  assert.ok(cookie && typeof csrf === "string");
  session = { cookie, "x-csrf-token": csrf };
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("JSON writes validate the envelope while keeping empty bodies and budget clearing", async () => {
  for (const payload of ["null", "[]", "42", '"text"']) {
    await assertError(
      await post("/api/chat/conversations", payload),
      400,
      "JSON body must be an object",
    );
  }
  await assertError(await post("/api/auth/login", "{}{"), 400, "invalid JSON body");
  await assertError(await post("/api/auth/login", "null"), 400, "JSON body must be an object");
  await assertError(
    await post("/api/auth/login", JSON.stringify({ username: "?", password: "wrong" })),
    401,
    "Invalid username or password",
  );
  const created = await post("/api/chat/conversations");
  assert.equal(created.status, 200);
  assert.ok(Number.isSafeInteger((await created.json()).id));

  const budget = `/api/runs/${runId}/budget`;
  assert.equal((await post(budget, JSON.stringify({ budget_usd: 12 }))).status, 200);
  assert.equal((await post(budget, "null")).status, 200);
  assert.equal(
    (await one(pool, "SELECT budget_usd FROM workflow_runs WHERE id=$1", [runId]))?.budget_usd,
    null,
  );
});

test("pagination rejects invalid integers and preserves list, log and polling payloads", async () => {
  const timeline = `/api/runs/${runId}/events`;
  const transcript = `/api/attempts/${attemptId}/transcript`;
  const logs = `/api/runs/${runId}/logs`;
  for (const path of [timeline, transcript, logs]) {
    for (const after of ["abc", "-1", "1.5", "9007199254740992"]) {
      await assertError(await get(`${path}?after=${after}`), 400, "invalid after");
    }
  }
  const events = await get(timeline + "?after=0");
  assert.equal(events.status, 200);
  const page = await events.json();
  assert.ok(Array.isArray(page) && page.length > 0);
  const next = await get(`${timeline}?after=${page.at(-1).id}`);
  assert.deepEqual(await next.json(), []);
  assert.ok(Array.isArray(await (await get(transcript)).json()));
  const logPage = await get(logs + "?limit=1");
  assert.equal(logPage.status, 200);
  const logRows = await logPage.json();
  assert.ok(Array.isArray(logRows) && logRows.length <= 1);

  for (const path of ["/api/chat/conversations", "/api/radar/findings", logs])
    await assertError(await get(`${path}?limit=2.5`), 400, "invalid limit");
  const chats = await get("/api/chat/conversations?limit=1");
  assert.equal(chats.status, 200);
  assert.equal((await chats.json()).length, 1);
  for (const path of ["/api/events", "/api/stream"]) {
    await assertError(await get(`${path}?run_id=invalid`), 400, "invalid run_id");
    await assertError(await get(`${path}?run_id=9007199254740991`), 404, "not found");
  }
  await assertError(
    await get("/api/chat/conversations/9007199254740992/stream"),
    400,
    'invalid id "9007199254740992"',
  );
  await assertError(await get("/api/runs?work_item_id=invalid"), 400, "invalid work_item_id");
  const reset = await get("/api/events?after=invalid");
  assert.equal(reset.headers.get("cache-control"), "no-store");
  const poll = await reset.json();
  assert.deepEqual(poll, { events: [], reset: true, cursor: poll.cursor });
  assert.ok(Number.isSafeInteger(poll.cursor));
});

test("radar updates return JSON 404 for a missing finding and preserve successful writes", async () => {
  const missing = await post("/api/radar/findings/1/status", '{"status":"resolved"}');
  await assertError(missing, 404, "radar finding not found");
  const finding = await one<{ id: number }>(
    pool,
    "INSERT INTO radar_findings(fingerprint,kinds,severity,confidence) VALUES('api-contract','{}','low','low') RETURNING id",
  );
  assert.ok(finding);
  const updated = await post(`/api/radar/findings/${finding.id}/status`, '{"status":"resolved"}');
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { ok: true });
});

test("workflow validation preserves its diagnostic shape and string error details", async () => {
  const diagnostic = await post("/api/workflows/validate", '{"spec":{}}');
  assert.equal(diagnostic.status, 200);
  const { valid, errors } = await diagnostic.json();
  assert.equal(valid, false);
  assert.ok(
    Array.isArray(errors) && errors.length && errors.every((item) => typeof item === "string"),
  );
  const failed = await post("/api/workflows", '{"key":"invalid-spec","spec":{}}');
  assert.equal(failed.status, 400);
  const body = await failed.json();
  assert.match(body.error, /^invalid workflow definition/);
  assert.deepEqual(body.details, errors);
});

test("a database disconnect after a write preserves the error on idempotent replay", async (t) => {
  const query = pool.query;
  const failure = t.mock.method(pool, "query", async (...args: unknown[]) => {
    const result = await Reflect.apply(query, pool, args);
    if (String(args[0]).includes("INSERT INTO chat_conversations"))
      throw Object.assign(new Error("private connection details"), { code: "57P01" });
    return result;
  });
  const key = { "Idempotency-Key": "api-contract-outage" };
  const path = "/api/chat/conversations";
  const payload = '{"title":"Response lost after insert","provider":"claude"}';
  await assertError(await post(path, payload, key), 503, "Database temporarily unavailable");
  failure.mock.restore();
  const replay = await post(path, payload, key);
  assert.equal(replay.headers.get("Idempotent-Replayed"), "true");
  await assertError(replay, 503, "Database temporarily unavailable");
  const count = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM chat_conversations WHERE title='Response lost after insert'",
  );
  assert.equal(count?.n, 1);
});

test("a database disconnect during credential lookup is reported as a JSON 503", async (t) => {
  const query = pool.query;
  t.mock.method(pool, "query", (...args: unknown[]) => {
    if (String(args[0]).includes("FROM users WHERE username"))
      throw Object.assign(new Error("private connection details"), { code: "57P01" });
    return Reflect.apply(query, pool, args);
  });
  const unavailable = await post("/api/auth/login", JSON.stringify({ username, password }));
  assert.equal(unavailable.headers.get("set-cookie"), null);
  await assertError(unavailable, 503, "Database temporarily unavailable");
});

test("the Telegram webhook returns a JSON 413 for an authenticated oversized request", async (t) => {
  const original = config.telegram.webhookSecret;
  config.telegram.webhookSecret = "api-contract-secret";
  t.after(() => {
    config.telegram.webhookSecret = original;
  });
  const path = "/api/telegram/webhook";
  const payload = JSON.stringify({ text: "x".repeat(262_144) });
  await assertError(await post(path, payload), 403, "Invalid Telegram webhook authentication");
  const response = await post(path, payload, {
    "x-telegram-bot-api-secret-token": config.telegram.webhookSecret,
  });
  await assertError(response, 413, "Body too large");
});

test("rate-limited login retains the credential error shape", async () => {
  await q(
    pool,
    "INSERT INTO login_attempts(username,ip,success) SELECT 'blocked-user','fixture',false FROM generate_series(1,8)",
  );
  await assertError(
    await post("/api/auth/login", '{"username":"blocked-user","password":"wrong"}'),
    429,
    "Invalid username or password",
  );
});
