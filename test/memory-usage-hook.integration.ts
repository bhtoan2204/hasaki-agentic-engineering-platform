import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, beginAttempt } from "../src/workflow/engine.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { repositories } from "../src/repos/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const REPO = "usage-svc";
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: ENV }).trim();

let owner = 0;
let sha = "";
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  owner = (
    await createUser({ username: "usage-owner", password: "usage-owner-password", role: "member" })
  ).id;
  const origin = join(mkdtempSync(join(tmpdir(), "usage-")), "o.git");
  const clone = join(config.reposRoot, REPO);
  mkdirSync(config.reposRoot, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "release/prod", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, clone], { env: ENV });
  sh(clone, "checkout", "-qb", "release/prod");
  writeFileSync(join(clone, "a.go"), "package a\n");
  sh(clone, "add", ".");
  sh(clone, "commit", "-qm", "base");
  sh(clone, "push", "-q", "origin", "release/prod");
  sha = sh(clone, "rev-parse", "HEAD");
  sh(clone, "fetch", "-q", "origin");
  await repositories.upsert(REPO, { projects: ["USAGE"] });
});
after(async () => {
  await settleBackground();
  await pool.end();
});

test("loading task memory into a step records usage after the step transaction commits, never inside it", async () => {
  const key = `memory.run-4242.${REPO}.facts`;
  await knowledge.create({
    key,
    category: "task_memory",
    scope_type: "REPOSITORY",
    scope_ref: REPO,
    title: key,
    content: "facts of an earlier run",
    applicability: { repos: [REPO] },
    metadata: {
      load: "on_demand",
      memory: {
        run_id: 4242,
        repo: REPO,
        commit_sha: sha,
        base_branch: "release/prod",
        files: ["a.go"],
        trust: "verified",
        extracted_at: new Date().toISOString(),
        sources: [],
        confidence: "high",
      },
    },
    ownerId: owner,
  });
  const id = (await one<{ id: number }>(pool, "SELECT id FROM knowledge_items WHERE key = $1", [
    key,
  ]))!.id;
  await q(
    pool,
    "INSERT INTO knowledge_usage (item_id, last_loaded_at, loads) VALUES ($1, now() - interval '1 day', 5)",
    [id],
  );

  await definitions.create({
    key: "usage-fixture",
    spec: { name: "usage", steps: [{ key: "run", type: "command", config: { command: "true" } }] },
  });
  await startRun({
    definitionKey: "usage-fixture",
    ownerId: owner,
    repositories: [REPO],
    title: "usage",
  });
  const job = (await claimJob("usage-test", 30, ["command"]))!;
  assert.ok(job, "a job is queued");

  // Another session holds the usage row: a write inside beginAttempt's transaction would wait for it forever.
  const other = new pg.Client({ connectionString: config.databaseUrl });
  await other.connect();
  await other.query("BEGIN");
  await other.query("SELECT 1 FROM knowledge_usage WHERE item_id = $1 FOR UPDATE", [id]);
  try {
    const begun = await Promise.race([
      beginAttempt(job, "usage-test"),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 8000)),
    ]);
    assert.notEqual(begun, "stuck", "beginAttempt must not wait for the usage row");
    assert.ok(begun, "the attempt began");
    const applied = (
      begun as { context: { knowledge: Array<{ key: string }> } }
    ).context.knowledge.map((k) => k.key);
    assert.ok(applied.includes(key), "the fresh memory item was loaded into the step");
  } finally {
    await other.query("COMMIT");
    await other.end();
  }
  await settleBackground();
  const usage = await one<{ loads: number; recent: boolean }>(
    pool,
    "SELECT loads, last_loaded_at > now() - interval '1 minute' AS recent FROM knowledge_usage WHERE item_id = $1",
    [id],
  );
  assert.deepEqual(
    [usage!.loads, usage!.recent],
    [6, true],
    "recorded once the lock was gone, in the background",
  );
});
