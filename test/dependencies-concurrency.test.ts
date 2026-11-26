import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependencyStats,
  installNodeDependencies,
  nodeModulesReady,
  resetDependencyMetrics,
  withInstallLock,
} from "../src/git/nodeDependencies.ts";

/** Fake npm that records start/end so overlap between two installs in one directory is observable. */
async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "deps-concurrent-"));
  const evidenceDir = join(dir, "..", `evidence-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, "bin"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }),
  );
  await writeFile(
    join(dir, "bin", "npm"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 10; exit 0; fi
echo "start $$" >> "$LOG"
sleep 0.3
mkdir -p node_modules/left-pad
printf '{"name":"left-pad","version":"1.0.0"}' > node_modules/left-pad/package.json
echo "end $$" >> "$LOG"
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${previous}`;
  process.env.LOG = join(dir, "log");
  t.after(async () => {
    process.env.PATH = previous;
    delete process.env.LOG;
    await rm(dir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  });
  return { dir, evidenceDir };
}

test("concurrent requests for one directory share a single install", async (t) => {
  const { dir, evidenceDir } = await fixture(t);
  resetDependencyMetrics();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      installNodeDependencies(dir, join(dir, "cache"), { evidenceDir }),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1, "exactly one caller installed");
  assert.equal(dependencyStats.duplicatesAvoided, 5);
  const log = (await readFile(join(dir, "log"), "utf8")).split("\n").filter(Boolean);
  assert.equal(log.filter((l) => l.startsWith("start")).length, 1);
  assert.equal(await nodeModulesReady(dir, { evidenceDir }), true);
});

test("installs never overlap in one directory even when single-flight keys differ", async (t) => {
  const { dir, evidenceDir } = await fixture(t);
  const results = await Promise.all([
    installNodeDependencies(dir, join(dir, "cache"), { evidenceDir }),
    installNodeDependencies(dir, join(dir, "cache"), { evidenceDir, strict: true }),
    installNodeDependencies(dir, join(dir, "cache"), { evidenceDir }),
  ]);
  assert.equal(
    results.filter(Boolean).length,
    1,
    "the waiter re-validates under the lock and finds the finished install",
  );
  const log = (await readFile(join(dir, "log"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[0]);
  assert.deepEqual(log, ["start", "end"]);
});

test("a lock left by a dead process is taken over", async (t) => {
  const { dir, evidenceDir } = await fixture(t);
  const { realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const lock = join(
    evidenceDir,
    "locks",
    createHash("sha256")
      .update(await realpath(dir))
      .digest("hex"),
  );
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  assert.equal(await installNodeDependencies(dir, join(dir, "cache"), { evidenceDir }), true);
});

test("two waiters racing to take over one stale lock never hold it together", async (t) => {
  const { dir, evidenceDir } = await fixture(t);
  const { realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const real = await realpath(dir);
  const lock = join(evidenceDir, "locks", createHash("sha256").update(real).digest("hex"));
  const deadPid = spawnSync("true").pid!;
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner"),
    JSON.stringify({ pid: deadPid, token: "dead", at: Date.now() }),
  );
  let holders = 0,
    maxHolders = 0,
    entered = 0;
  const critical = async () => {
    holders++;
    entered++;
    maxHolders = Math.max(maxHolders, holders);
    await new Promise((done) => setTimeout(done, 40));
    holders--;
  };
  await Promise.all([
    withInstallLock(evidenceDir, real, critical),
    withInstallLock(evidenceDir, real, critical),
    withInstallLock(evidenceDir, real, critical),
  ]);
  assert.equal(entered, 3, "every taker eventually ran");
  assert.equal(maxHolders, 1, "never two holders at once");
});
