import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { knowledge } from "../src/knowledge/service.ts";

let server: Server;
let base = "";
let ownerId = 0;
const NEW = { owner: "aging-api-owner", other: "aging-api-other", admin: "aging-api-admin" };

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
      cookie = r.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      csrf = ((await r.json()) as { csrf?: string }).csrf ?? "";
    },
    async call(path: string, body?: unknown) {
      const r = await fetch(base + path, {
        method: body !== undefined ? "POST" : "GET",
        headers: {
          cookie,
          ...(body !== undefined
            ? { "content-type": "application/json", "x-csrf-token": csrf }
            : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : {} };
    },
  };
}
const as = async (name: string) => {
  const c = client();
  await c.login(name, `${name}-password`);
  return c;
};

before(async () => {
  await migrate();
  ownerId = (
    await createUser({ username: NEW.owner, password: `${NEW.owner}-password`, role: "member" })
  ).id;
  await createUser({ username: NEW.other, password: `${NEW.other}-password`, role: "member" });
  await createUser({ username: NEW.admin, password: `${NEW.admin}-password`, role: "admin" });
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

let n = 0;
async function archivedItem(state = "archived") {
  const key = `memory.run-${9000 + ++n}.api-repo.facts`;
  await knowledge.create({
    key,
    category: "task_memory",
    scope_type: "GLOBAL",
    title: key,
    content: "facts",
    enabled: false,
    metadata: {
      load: "on_demand",
      memory: {
        run_id: 9000 + n,
        repo: "api-repo",
        trust: "verified",
        files: [],
        commit_sha: "abcdef1",
      },
    },
    ownerId,
  });
  await q(
    pool,
    `INSERT INTO knowledge_aging (item_id, state, policy, reason, replaced_by_key)
     SELECT id, $2, 'stale', 'changed on origin/main since the task: a.go', NULL FROM knowledge_items WHERE key = $1`,
    [key, state],
  );
  return key;
}
const row = (key: string) =>
  one<{ enabled: boolean; pinned: boolean | null; state: string | null }>(
    pool,
    "SELECT i.enabled, a.pinned, a.state FROM knowledge_items i LEFT JOIN knowledge_aging a ON a.item_id = i.id WHERE i.key = $1",
    [key],
  );

test("the Knowledge list hides archived task memory unless asked, and shows the reason", async () => {
  const key = await archivedItem();
  const owner = await as(NEW.owner);
  const url = (q: string) => `/api/knowledge?page=1&page_size=200&category=task_memory${q}`;
  const hidden = await owner.call(url(""));
  assert.equal(hidden.status, 200);
  assert.ok(!hidden.body.items.some((i: { key: string }) => i.key === key));
  const shown = await owner.call(url("&archived=1"));
  const item = shown.body.items.find((i: { key: string }) => i.key === key);
  assert.equal(item.aging.state, "archived");
  assert.match(item.aging.reason, /changed on origin\/main/);
  assert.equal(item.aging.policy, "stale");
  const detail = await owner.call(`/api/knowledge/${key}`);
  assert.equal(detail.body.aging.state, "archived");
  assert.equal(
    (await (await as(NEW.other)).call(`/api/knowledge/${key}`)).status,
    404,
    "another user does not even see it exists",
  );
});

test("the owner restores an archived item: enabled again, pinned, and a second restore is refused", async () => {
  const key = await archivedItem();
  const owner = await as(NEW.owner);
  const r = await owner.call(`/api/knowledge/${key}/restore`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.enabled, r.body.pinned], [true, true, true]);
  assert.deepEqual(await row(key), { enabled: true, pinned: true, state: "restored" });
  assert.equal((await owner.call(`/api/knowledge/${key}/restore`, {})).status, 409);
  const hiddenNow = await owner.call(
    "/api/knowledge?page=1&page_size=200&category=task_memory&archived=1",
  );
  assert.ok(
    !hiddenNow.body.items.some((i: { key: string }) => i.key === key),
    "no longer in the archive filter",
  );
  const unpinned = await owner.call(`/api/knowledge/${key}/unpin`, {});
  assert.equal(unpinned.status, 200);
  assert.equal((await row(key))!.pinned, false);
  assert.equal((await owner.call(`/api/knowledge/${key}/unpin`, {})).status, 409);
});

test("someone else cannot restore it; an admin can with support access to that owner", async () => {
  const key = await archivedItem("superseded");
  assert.equal((await (await as(NEW.other)).call(`/api/knowledge/${key}/restore`, {})).status, 404);
  assert.equal((await row(key))!.enabled, false);
  const admin = await as(NEW.admin);
  const plain = await admin.call(`/api/knowledge/${key}/restore`, {});
  assert.equal(plain.status, 404, "an admin's own namespace does not contain it");
  const support = await admin.call(`/api/knowledge/${key}/restore?owner=${ownerId}&scope=all`, {});
  assert.equal(support.status, 200);
  assert.equal((await row(key))!.enabled, true);
});

test("only task memory can be restored", async () => {
  await knowledge.create({
    key: "api-aging.rule",
    category: "business_rule",
    scope_type: "GLOBAL",
    title: "r",
    content: "c",
    ownerId,
  });
  const owner = await as(NEW.owner);
  assert.equal((await owner.call("/api/knowledge/api-aging.rule/restore", {})).status, 400);
  await knowledge.remove("api-aging.rule", { ownerId, by: "test" });
});
