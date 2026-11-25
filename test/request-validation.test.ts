import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handle } from "../src/http/app.ts";
import { parseBody, ValidationError } from "../src/http/validate.ts";
import {
  CreateUserBody,
  CreateWorkflowBody,
  LoginBody,
  SetActiveBody,
  TokenBody,
} from "../src/http/schemas.ts";

const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('missing text fields default to the empty string, like String(body.x ?? "")', () => {
  assert.deepEqual(parseBody(LoginBody, {}), { username: "", password: "" });
  assert.equal(parseBody(TokenBody, {}).token, "");
  assert.equal(parseBody(CreateUserBody, { username: "a", password: "b" }).role, "member");
  assert.equal(parseBody(SetActiveBody, {}).active, true);
});

test("unknown fields pass through untouched", () => {
  const out = parseBody(TokenBody, { token: "t", extra: { a: 1 } }) as Record<string, unknown>;
  assert.deepEqual(out.extra, { a: 1 });
});

test("wrong types and oversized values are rejected with field-level details", () => {
  const failure = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof ValidationError);
      assert.equal(e.status, 400);
      return e.errors;
    }
    assert.fail("expected a ValidationError");
  };
  assert.match(failure(() => parseBody(LoginBody, { username: 42 }))[0], /^username: /);
  assert.match(failure(() => parseBody(LoginBody, null))[0], /^\(body\): /);
  assert.match(
    failure(() => parseBody(TokenBody, { token: "x".repeat(16 * 1024 + 1) }))[0],
    /^token: /,
  );
  assert.match(failure(() => parseBody(CreateUserBody, { role: "root" }))[0], /^role: /);
  assert.match(failure(() => parseBody(SetActiveBody, { active: "false" }))[0], /^active: /);
  assert.match(failure(() => parseBody(CreateWorkflowBody, { publish: "yes" }))[0], /^publish: /);
  assert.equal(failure(() => parseBody(LoginBody, { username: 1, password: 2 })).length, 2);
});

test("a login with the wrong field types is a 400 with the HttpError envelope and details", async () => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: { $ne: "" }, password: ["x"] }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "Invalid request body");
  assert.ok(Array.isArray(body.details) && body.details.length === 2, JSON.stringify(body));
  assert.match(body.details.join("\n"), /username:/);
  assert.match(body.details.join("\n"), /password:/);
});
