import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { pool } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
import { cookieSecure, readCookie } from "../src/auth/sessions.ts";

const password = randomBytes(24).toString("hex");
function bootstrap(username = "toan") {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn("npm", ["run", "admin:bootstrap", "--", "--username", username, "--claim-legacy"], {
      env: { ...process.env, ADMIN_PASSWORD: password }, stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
}
after(() => pool.end());

test("bootstrap script migrates an empty database, preserves existing admin, and HTTP sessions enforce CSRF", async () => {
  assert.equal((await pool.query("SELECT to_regclass('public.users') AS t")).rows[0].t, null);
  assert.equal(await bootstrap(), 0);
  const original = (await pool.query("SELECT id, password_hash, role FROM users WHERE username = 'toan'")).rows[0];
  assert.equal(original.role, "admin");
  assert.equal(await bootstrap(), 0);
  assert.deepEqual((await pool.query("SELECT id, password_hash, role FROM users WHERE username = 'toan'")).rows[0], original);
  assert.equal(await bootstrap("another"), 1);
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await (await fetch(base + "/api/auth/status")).json()).bootstrapRequired, false);
    for (const path of ["/", "/classic"]) assert.equal((await fetch(base + path)).status, 200);
    const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "toan", password }) });
    assert.equal(login.status, 200);
    const rawCookie = login.headers.get("set-cookie")!;
    assert.ok(rawCookie.includes("HttpOnly") && rawCookie.includes("SameSite=Lax"));
    assert.ok(!rawCookie.includes("Secure"));
    const cookie = rawCookie.split(";")[0];
    const { csrf } = await login.json();
    assert.equal((await fetch(base + "/api/auth/me", { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + "/api/auth/logout", { method: "POST", headers: { cookie } })).status, 403);
    assert.equal((await fetch(base + "/api/auth/logout", { method: "POST", headers: { cookie, "x-csrf-token": csrf } })).status, 200);
    assert.equal((await fetch(base + "/api/auth/me", { headers: { cookie } })).status, 401);
    assert.equal((await fetch(base + "/api/work-items", { headers: { cookie } })).status, 401);
    await pool.query("UPDATE users SET active = false");
    assert.equal((await (await fetch(base + "/api/auth/status")).json()).bootstrapRequired, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  // Exercise the real server entrypoint (migrations, shared seeds, workers, static serving)
  // using only the temporary test config/database from setup.ts.
  const child = spawn("npm", ["run", "serve"], {
    env: { ...process.env, PORT: new URL(base).port, HOST: "127.0.0.1" }, stdio: "ignore", detached: true,
  });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await fetch(base + "/api/health")).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "real server becomes healthy on the test database");
  } finally {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("cookie policy supports localhost and enforces production Secure; malformed cookies are anonymous", () => {
  const prev = process.env.COOKIE_SECURE;
  const nodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.COOKIE_SECURE;
    delete process.env.NODE_ENV;
    assert.equal(cookieSecure({ headers: { host: "localhost:4545" }, socket: {} } as any), false);
    assert.equal(cookieSecure({ headers: { host: "app.example.com" }, socket: {} } as any), true);
    process.env.COOKIE_SECURE = "0";
    process.env.NODE_ENV = "production";
    assert.equal(cookieSecure({ headers: { host: "localhost" }, socket: {} } as any), true);
    assert.equal(readCookie({ headers: { cookie: "sid=%invalid" } } as any), null);
  } finally {
    if (prev === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = prev;
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
});
