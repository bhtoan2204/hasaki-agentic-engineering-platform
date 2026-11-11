/** Deleting a repository from the registry: admin only, refused while in use, never re-added by config discovery. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { config } from "../src/config.ts";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories, syncRepositoriesFromConfig } from "../src/repos/service.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

let server: Server;
let base = "";

async function login(username: string, password: string) {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { csrf } = await r.json();
  return async (path: string, body?: unknown) => {
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
}

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  await seedTemplates();
  await seedKnowledge();
  await createUser({ username: "repo-admin", password: "repo-admin-password", role: "admin" });
  await createUser({ username: "repo-member", password: "repo-member-password", role: "member" });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

const register = (name: string) =>
  repositories.upsert(name, {
    repository_url: `https://bitbucket.org/hasaki/${name}.git`,
    projects: ["DEL"],
  });

test("an admin deletes a registered repository; it disappears from the list and the audit log records it", async () => {
  const admin = await login("repo-admin", "repo-admin-password");
  await register("to-delete");
  const r = await admin("/api/repositories/to-delete/delete", {});
  assert.equal(r.status, 200);
  assert.equal(await repositories.get("to-delete"), undefined);
  assert.ok(!(await admin("/api/repositories")).body.some((x: any) => x.name === "to-delete"));
  assert.ok(
    await one(
      pool,
      "SELECT 1 FROM audit_log WHERE action = 'repository.delete' AND resource_id = 'to-delete'",
    ),
  );
  assert.equal((await admin("/api/repositories/to-delete/delete", {})).status, 404, "already gone");
  // the name can be registered again
  assert.equal(
    (
      await admin("/api/repositories/to-delete", {
        repository_url: "https://bitbucket.org/hasaki/to-delete.git",
      })
    ).status,
    200,
  );
});

test("a member cannot delete a repository", async () => {
  const member = await login("repo-member", "repo-member-password");
  await register("kept-by-member");
  assert.equal((await member("/api/repositories/kept-by-member/delete", {})).status, 403);
  assert.ok(await repositories.get("kept-by-member"));
});

test("a repository used by an unfinished run cannot be deleted until the run finishes", async () => {
  const admin = await login("repo-admin", "repo-admin-password");
  await register("in-use");
  const wi = (await admin("/api/work-items", { title: "uses repo", project: "DEL" })).body;
  const run = (
    await admin("/api/runs", {
      workflow: "bug-investigation",
      work_item_id: wi.id,
      start: false,
      repositories: ["in-use"],
    })
  ).body;
  await pool.query(
    "UPDATE workflow_runs SET allowed_repositories = ARRAY['in-use'], status = 'RUNNING' WHERE id = $1",
    [run.id],
  );
  const refused = await admin("/api/repositories/in-use/delete", {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, new RegExp(`#${run.id}`));
  assert.ok(await repositories.get("in-use"));
  await pool.query("UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [run.id]);
  assert.equal((await admin("/api/repositories/in-use/delete", {})).status, 200);
});

test("a repository discovered from a config.json group folder stays deleted across the startup sync", async () => {
  const admin = await login("repo-admin", "repo-admin-password");
  // test config: Payment → payment-src, a group folder; every git checkout inside it is registered on boot
  mkdirSync(join(config.reposRoot, "payment-src", "side-project", ".git"), { recursive: true });
  await syncRepositoriesFromConfig();
  assert.ok(await repositories.get("side-project"), "discovered on boot");
  const r = await admin("/api/repositories/side-project/delete", {});
  assert.equal(r.status, 200);
  await syncRepositoriesFromConfig(); // what the next restart does
  assert.equal(await repositories.get("side-project"), undefined, "not registered again");
  // an explicit registration lifts the exclusion
  assert.equal(
    (
      await admin("/api/repositories/side-project", {
        repository_url: "https://bitbucket.org/hasaki/side-project.git",
      })
    ).status,
    200,
  );
  assert.equal(
    await one(pool, "SELECT 1 FROM repository_exclusions WHERE name = 'side-project'"),
    undefined,
  );
  assert.equal((await admin("/api/repositories/side-project/delete", {})).status, 200);
});
