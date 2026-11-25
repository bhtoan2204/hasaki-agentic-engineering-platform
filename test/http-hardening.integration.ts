import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createUser } from "../src/auth/users.ts";
import { pruneLoginAttempts } from "../src/auth/sessions.ts";
import { config } from "../src/config.ts";
import { one, pool, q } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";

let server: Server;
let base: string;
let session: { cookie: string; "x-csrf-token": string };
const username = "http-hardening-admin";
const password = "test-hardening-password";

const post = (path: string, body: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { ...session, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

before(async () => {
  await createUser({ username, password, role: "admin" });
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  session = { cookie: "", "x-csrf-token": "" };
  const login = await post("/api/auth/login", JSON.stringify({ username, password }));
  assert.equal(login.status, 200);
  session = {
    cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
    "x-csrf-token": (await login.json()).csrf,
  };
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("an ordinary route refuses a body over 1 MiB with a 413", async () => {
  const r = await post(
    "/api/chat/conversations",
    JSON.stringify({ title: "x".repeat(1024 * 1024) }),
  );
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "Body too large" });
});

test("routes with an explicit larger limit still accept a body over 1 MiB", async () => {
  // impact analysis: a diff of 1.5 MiB is read (the analysis then rejects it as too large, not the HTTP layer).
  const r = await post("/api/impact/analyze", JSON.stringify({ diff: "x".repeat(1_500_000) }));
  assert.notEqual(r.status, 413);
  await r.arrayBuffer();
});

test("a body under the limit still works on an ordinary route", async () => {
  const r = await post("/api/chat/conversations", JSON.stringify({ title: "ok" }));
  assert.notEqual(r.status, 413);
  await r.arrayBuffer();
});

test("login throttling keys on the socket address unless proxies are trusted", async () => {
  const attempt = (forwarded: string) =>
    fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
      body: JSON.stringify({ username: "nobody", password: "wrong" }),
    }).then(async (r) => (await r.arrayBuffer(), r.status));
  const before = config.http.trustedProxyHops;
  try {
    await q(
      pool,
      "DELETE FROM login_attempts WHERE ip IN ('127.0.0.1','::1','::ffff:127.0.0.1','9.9.9.9')",
    );
    config.http.trustedProxyHops = 0;
    await attempt("9.9.9.9");
    const spoofed = await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM login_attempts WHERE ip = '9.9.9.9'",
    );
    assert.equal(spoofed?.n, 0, "an untrusted X-Forwarded-For is not recorded as the client");
    config.http.trustedProxyHops = 1;
    await attempt("9.9.9.9");
    const trusted = await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM login_attempts WHERE ip = '9.9.9.9'",
    );
    assert.equal(trusted?.n, 1, "with one trusted hop the proxy-reported client is recorded");
  } finally {
    config.http.trustedProxyHops = before;
  }
});

test("pruneLoginAttempts deletes old rows in bounded batches and keeps recent ones", async () => {
  await q(pool, "DELETE FROM login_attempts WHERE username LIKE 'prune-%'");
  await q(
    pool,
    "INSERT INTO login_attempts(username, ip, success, created_at) SELECT 'prune-old', 'x', false, now() - interval '40 days' FROM generate_series(1,5)",
  );
  await q(
    pool,
    "INSERT INTO login_attempts(username, ip, success) VALUES ('prune-new', 'x', false)",
  );
  assert.equal(await pruneLoginAttempts(3), 3);
  assert.equal(await pruneLoginAttempts(3), 2);
  assert.equal(await pruneLoginAttempts(3), 0);
  const left = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM login_attempts WHERE username = 'prune-new'",
  );
  assert.equal(left?.n, 1);
});
