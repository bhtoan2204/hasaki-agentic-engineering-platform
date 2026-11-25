/**
 * Knowledge import publication across processes (ADR 0007): serialized by an advisory lock on a dedicated connection,
 * also with a one-connection pool; a process killed mid-publication releases the lock and leaves only complete items;
 * an import that loses its lock connection stops writing.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { one, pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { repositories } from "../src/repos/service.ts";
import {
  importFromRepositories,
  importGuard,
  serializedImport,
} from "../src/knowledge/importer.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { startPlatformGo } from "./fixtures/platformGo.ts";

const child = resolve(import.meta.dirname, "fixtures/knowledgeImportChild.ts");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const start = (mode: string, extra: Record<string, string> = {}) => {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", child, mode], {
    // The discovery runs in platform-go: the children reach the same instance.
    env: { ...process.env, RETRIEVAL_SEMANTIC_URL: config.retrieval.semantic.url, ...extra },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: p.stdout! });
  const next = () =>
    new Promise<string>((r, j) => {
      lines.once("line", r);
      p.once("exit", (code) => j(new Error(`child exited ${code}`)));
    });
  const exit = new Promise<number | null>((r) => p.once("exit", (code) => r(code)));
  return { p, next, exit };
};
const versions = async () =>
  Number((await q(pool, "SELECT count(*)::int AS n FROM knowledge_versions"))[0].n);

// pg_locks is cluster-wide. The same advisory key can be held independently by another test database.
const publicationLocks = `FROM pg_locks
  WHERE locktype='advisory' AND classid=0 AND objid=727007 AND objsubid=1
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;

let go: Awaited<ReturnType<typeof startPlatformGo>>;
before(async () => {
  await migrate();
  go = await startPlatformGo();
  await shareAllRepositoriesForTests();
  for (const name of ["kc-one", "kc-two"]) {
    const root = join(config.reposRoot, name);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), `# ${name}\n\nRules of ${name}.\n`);
    for (let i = 0; i < 20; i++)
      writeFileSync(join(root, "docs", `c${i}-convention.md`), `# C${i}\n\n${name} ${i}\n`);
    execFileSync("git", ["-C", root, "init", "-q"], { env });
    await repositories.upsert(name, { projects: ["KC"] });
  }
});
after(async () => {
  go?.stop();
  await pool.end();
});

test("two processes with a one-connection pool import at once: serialized, each item created once", async () => {
  const a = start("import", { DATABASE_POOL_MAX: "1" });
  const b = start("import", { DATABASE_POOL_MAX: "1" });
  const [ra, rb] = (await Promise.all([a.next(), b.next()])).map((l) => JSON.parse(l));
  assert.equal(await a.exit, 0);
  assert.equal(await b.exit, 0);
  assert.equal(ra.created + rb.created, 42, "every item created exactly once");
  assert.ok(ra.created === 0 || rb.created === 0, "the second import found the first one's items");
  const dup = await q(pool, "SELECT key FROM knowledge_items GROUP BY key HAVING count(*) > 1");
  assert.deepEqual(dup, []);
  const multi = await q(
    pool,
    "SELECT item_id FROM knowledge_versions GROUP BY item_id HAVING count(*) > 1",
  );
  assert.deepEqual(multi, [], "no duplicate versions");
});

test("a process killed while holding the lock: the lock is released, its complete items remain, nothing half-written", async () => {
  const holder = start("hold");
  assert.equal(await holder.next(), "locked");
  writeFileSync(
    join(config.reposRoot, "kc-one", "docs", "c0-convention.md"),
    "# C0\n\nedited while locked\n",
  );
  const before = await versions();
  const waiting = importFromRepositories();
  void waiting.catch(() => {}); // The result is asserted after releasing the lock.
  try {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const blocked = await one(pool, `SELECT pid ${publicationLocks} AND NOT granted`);
      if (blocked) break;
      assert.ok(
        performance.now() < deadline,
        "the second import must wait on the publication lock",
      );
      await sleep(10);
    }
  } finally {
    holder.p.kill("SIGKILL");
    await holder.exit;
  }
  const r = await waiting;
  assert.equal(r.updated, 1);
  assert.equal(await versions(), before + 1);
  const item = await knowledge.get("crash.half-published");
  assert.equal(item?.versions.length, 1, "the item written before the crash is complete");
  const orphans = await q(
    pool,
    "SELECT i.key FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE v.id IS NULL",
  );
  assert.deepEqual(orphans, [], "no item without its current version");
});

test("an import that loses its lock connection stops writing", async ({ mock }) => {
  await assert.rejects(
    serializedImport(false, async () => {
      await importGuard(); // held
      assert.deepEqual(
        await q(
          pool,
          `SELECT pg_terminate_backend(pid, 5000) AS terminated ${publicationLocks} AND granted`,
        ),
        [{ terminated: true }],
      );
      const nextProbe = Date.now() + 1_000;
      const clock = mock.method(Date, "now", () => nextProbe);
      try {
        await importGuard();
      } finally {
        clock.mock.restore();
      }
      assert.fail("wrote without its lock");
    }),
    /publication lock was lost/,
  );
  // The next import takes a new lock and works.
  const r = await importFromRepositories();
  assert.equal(r.created + r.updated, 0);
});
