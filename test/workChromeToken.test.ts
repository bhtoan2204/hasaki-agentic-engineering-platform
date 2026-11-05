import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { setToken } from "../src/hasakiAuth.ts";
import { getUserSecret } from "../src/auth/secrets.ts";
after(() => pool.end());
test("verified candidate belongs only to actor; failed and cancelled candidates preserve existing secret", async () => {
  await migrate();
  const a = await createUser({ username: "chrome-a", password: "isolated-test-password", role: "member" });
  const b = await createUser({ username: "chrome-b", password: "isolated-test-password", role: "member" });
  const previous = globalThis.fetch;
  const token = (n: string) => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600, n })).toString("base64url")}.signature`;
  try {
    globalThis.fetch = async () => new Response('{"data":[]}', { headers: { "content-type": "application/json" } });
    await setToken(token("a"), a.id);
    assert.equal(await getUserSecret(a.id, "hasaki_token"), token("a"));
    assert.equal(await getUserSecret(b.id, "hasaki_token"), null);
    await setToken(token("cancelled"), a.id, () => false);
    assert.equal(await getUserSecret(a.id, "hasaki_token"), token("a"));
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(setToken(token("bad"), a.id), /chrome_verification/);
    assert.equal(await getUserSecret(a.id, "hasaki_token"), token("a"));
  } finally { globalThis.fetch = previous; }
});
