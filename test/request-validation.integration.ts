import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createUser } from "../src/auth/users.ts";
import { pool } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";

let server: Server;
let base: string;
let session: Record<string, string>;
let runId: number;
const username = "validation-admin";
const password = "validation-test-password";

const post = (path: string, body: unknown, headers: Record<string, string> = session) =>
  fetch(base + path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

before(async () => {
  const owner = await createUser({ username, password, role: "admin" });
  await definitions.create({
    key: "validation-flow",
    spec: { name: "Validation", steps: [{ key: "input", type: "human_input" }] },
  });
  runId = (await startRun({ definitionKey: "validation-flow", ownerId: owner.id })).id;
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await post("/api/auth/login", { username, password }, {});
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

async function assertInvalid(path: string, body: unknown, field: RegExp) {
  const r = await post(path, body);
  assert.equal(r.status, 400, path);
  const json = await r.json();
  assert.equal(json.error, "Invalid request body", path);
  assert.match((json.details ?? []).join("\n"), field, path);
}

test("account endpoints refuse wrong types", async () => {
  await assertInvalid("/api/users", { username: "x", password: "y", role: "root" }, /^role:/);
  await assertInvalid("/api/users", { username: ["a"], password: "y" }, /username:/);
  await assertInvalid("/api/users/1/password", { password: 12345678 }, /password:/);
  await assertInvalid("/api/users/999/active", { active: "false" }, /active:/);
  await assertInvalid("/api/auth/password", { password: { a: 1 } }, /password:/);
});

test("credential endpoints refuse wrong types and oversized values", async () => {
  for (const path of [
    "/api/work/token",
    "/api/integrations/argocd/token",
    "/api/integrations/splunk/token",
    "/api/integrations/vault/token",
    "/api/integrations/github",
  ])
    await assertInvalid(path, { token: { not: "a string" } }, /token:/);
  await assertInvalid("/api/integrations/kafka/cookie", { cookie: 7 }, /cookie:/);
  await assertInvalid(
    "/api/integrations/splunk/cookie",
    { cookie: "c".repeat(65 * 1024) },
    /cookie:/,
  );
  await assertInvalid("/api/integrations/bitbucket", { user: "u", token: ["t"] }, /token:/);
  await assertInvalid("/api/integrations/gitlab", { host: 5, token: "t" }, /host:/);
  await assertInvalid("/api/integrations/gitlab/ssh-key", { ssh_key: {} }, /ssh_key:/);
});

test("upload endpoints refuse wrong types", async () => {
  await assertInvalid("/api/chat/conversations/1/attachments", { data: 12345 }, /data:/);
  await assertInvalid(
    "/api/chat/conversations/1/attachments",
    { data: "AAAA", filename: {} },
    /filename:/,
  );
  await assertInvalid(
    `/api/runs/${runId}/steps/report/evidence`,
    { data_base64: 5 },
    /data_base64:/,
  );
  await assertInvalid(`/api/runs/${runId}/steps/report/evidence`, { note: ["a"] }, /note:/);
});

test("workflow endpoints refuse a malformed envelope", async () => {
  await assertInvalid("/api/workflows", { key: "k", spec: {}, publish: "yes" }, /publish:/);
  await assertInvalid("/api/workflows", { key: 5, spec: {} }, /key:/);
  await assertInvalid(
    "/api/workflows/some-flow/publish",
    { change_note: { a: 1 } },
    /change_note:/,
  );
});

test("valid requests keep their response shape", async () => {
  const created = await post("/api/users", {
    username: "validation-member",
    password: "a-long-enough-password",
    role: "member",
  });
  assert.equal(created.status, 200);
  const user = await created.json();
  assert.equal(user.username, "validation-member");
  assert.equal(user.role, "member");

  // The wrong-credentials path still answers 401 with the same message (and a missing password defaults to "").
  const bad = await post("/api/auth/login", { username: "nobody" }, {});
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: "Invalid username or password" });

  const deactivated = await post(`/api/users/${user.id}/active`, { active: false });
  assert.equal(deactivated.status, 200);
  assert.deepEqual(await deactivated.json(), { ok: true });
});
