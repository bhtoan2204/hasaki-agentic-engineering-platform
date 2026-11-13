import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import {
  NIX_POSTGRES_ARGS,
  resolvePostgresBin,
  setPostgresBinForTests,
  testPostgresEnv,
  type NixResult,
} from "../src/platform/postgresBinaries.ts";
import { runCommand } from "../src/workflow/executors/builtin.ts";
import {
  ENVIRONMENT_UNAVAILABLE_EXIT,
  FEATURE_REGRESSION_COMMAND,
  PLATFORM_REGRESSION_COMMAND,
  PLATFORM_TARGETED_COMMAND,
  FEATURE_TARGETED_COMMAND,
} from "../src/workflow/templates.ts";
import { environmentUnavailable } from "../src/agent/verify.ts";

after(() => pool.end());

const root = mkdtempSync(join(process.env.TEST_ROOT!, "pgbin-"));
let seq = 0;
const dir = (name: string) => {
  const d = join(root, `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
/** A directory that looks like a PostgreSQL install prefix: <prefix>/bin/initdb. */
const fakePrefix = (name: string) => {
  const prefix = dir(name);
  mkdirSync(join(prefix, "bin"));
  writeFileSync(join(prefix, "bin", "initdb"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(prefix, "bin", "initdb"), 0o755);
  return prefix;
};
const noNix = async (): Promise<NixResult> => {
  throw new Error("nix must not run");
};
const harness = (setup = 'spawnSync("initdb", []);\n') => {
  const repo = dir("repo");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "setup.ts"), setup);
  return repo;
};

test("postgres binaries: PATH first, then the cached store path, without running nix", async () => {
  const onPath = fakePrefix("path");
  const cacheFile = join(dir("cache"), "postgres-bin.json");
  assert.deepEqual(
    await resolvePostgresBin({
      pathEnv: `/nonexistent:${join(onPath, "bin")}`,
      cacheFile,
      nix: noNix,
    }),
    { dir: join(onPath, "bin"), source: "path" },
  );
  const cached = fakePrefix("cached");
  writeFileSync(cacheFile, JSON.stringify({ dir: join(cached, "bin") }));
  assert.deepEqual(await resolvePostgresBin({ pathEnv: "/nonexistent", cacheFile, nix: noNix }), {
    dir: join(cached, "bin"),
    source: "cache",
  });
});

test("postgres binaries: nix builds postgresql_17 once, picks the output with bin/initdb and caches it", async () => {
  const out = fakePrefix("store");
  const man = dir("store-man");
  const cacheFile = join(dir("cache"), "sub", "postgres-bin.json");
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const nix = async (args: string[], timeoutMs: number): Promise<NixResult> => (
    calls.push({ args, timeoutMs }),
    { code: 0, stdout: `${man}\n${out}\n`, stderr: "" }
  );
  // A stale cache entry (store path garbage-collected) is ignored.
  mkdirSync(join(cacheFile, ".."), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ dir: join(root, "gone", "bin") }));
  const r = await resolvePostgresBin({ pathEnv: "", cacheFile, nix, timeoutMs: 1234 });
  assert.deepEqual(r, { dir: join(out, "bin"), source: "nix" });
  assert.deepEqual(calls, [{ args: NIX_POSTGRES_ARGS, timeoutMs: 1234 }]);
  assert.ok(NIX_POSTGRES_ARGS.includes("nix-command flakes"), "works on stock nix installs");
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).dir, join(out, "bin"));
  assert.deepEqual(await resolvePostgresBin({ pathEnv: "", cacheFile, nix: noNix }), {
    dir: join(out, "bin"),
    source: "cache",
  });
});

test("postgres binaries: a nix failure yields null with its stderr, and is not cached", async () => {
  const cacheFile = join(dir("cache"), "postgres-bin.json");
  const failed = await resolvePostgresBin({
    pathEnv: "",
    cacheFile,
    nix: async () => ({
      code: 1,
      stdout: "",
      stderr: "error: unable to download 'https://cache.nixos.org': Could not resolve host\n",
      error: "Command failed",
    }),
  });
  assert.equal(failed.dir, null);
  assert.match(failed.dir === null ? failed.reason : "", /Could not resolve host/);
  assert.equal(existsSync(cacheFile), false);
  const missing = await resolvePostgresBin({
    pathEnv: "",
    cacheFile,
    nix: async () => ({ code: null, stdout: "", stderr: "", error: "spawn nix ENOENT" }),
  });
  assert.deepEqual(missing, {
    dir: null,
    reason: "initdb is not on PATH and nix is not installed",
  });
});

test("postgres env: only repositories whose test preload runs initdb get PATH or the unavailable reason", async () => {
  const store = fakePrefix("env-store");
  try {
    setPostgresBinForTests({ dir: join(store, "bin"), source: "nix" });
    assert.deepEqual(await testPostgresEnv(dir("plain"), "/usr/bin"), {});
    assert.deepEqual(await testPostgresEnv(harness("export {};\n"), "/usr/bin"), {});
    assert.deepEqual(await testPostgresEnv(harness(), "/usr/bin"), {
      PATH: `${join(store, "bin")}:/usr/bin`,
    });
    setPostgresBinForTests({ dir: "/usr/bin", source: "path" });
    assert.deepEqual(await testPostgresEnv(harness(), "/usr/bin"), {});
    setPostgresBinForTests({ dir: null, reason: "nix is not installed" });
    assert.deepEqual(await testPostgresEnv(harness(), "/usr/bin"), {
      PLATFORM_POSTGRES_UNAVAILABLE: "nix is not installed",
    });
  } finally {
    setPostgresBinForTests(undefined);
  }
});

test("runCommand: the resolved bin dir is on PATH for the test harness; without PostgreSQL the suite exits 78 with the reason", async () => {
  const store = fakePrefix("run-store");
  const repo = harness();
  const never = new AbortController().signal;
  try {
    setPostgresBinForTests({ dir: join(store, "bin"), source: "nix" });
    const ok = await runCommand("command -v initdb", repo, {}, 30_000, never);
    assert.equal(ok.code, 0, ok.output);
    assert.equal(ok.output.trim(), join(store, "bin", "initdb"));

    setPostgresBinForTests({ dir: null, reason: "nix build failed: boom" });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "echo SUITE-RAN" } }),
    );
    mkdirSync(join(repo, "node_modules", "x"), { recursive: true });
    const r = await runCommand(FEATURE_REGRESSION_COMMAND, repo, {}, 30_000, never);
    assert.equal(r.code, ENVIRONMENT_UNAVAILABLE_EXIT, r.output);
    assert.doesNotMatch(r.output, /SUITE-RAN/);
    assert.match(environmentUnavailable(r.code, r.output) ?? "", /nix build failed: boom/);
    assert.match(environmentUnavailable(r.code, r.output) ?? "", /no test ran/);
    assert.equal(environmentUnavailable(78, "exit 78 from a test"), null, "the marker is required");
  } finally {
    setPostgresBinForTests(undefined);
  }
  for (const command of [
    PLATFORM_TARGETED_COMMAND,
    PLATFORM_REGRESSION_COMMAND,
    FEATURE_TARGETED_COMMAND,
  ])
    assert.match(command, /PLATFORM_POSTGRES_UNAVAILABLE[\s\S]*exit 78/);
});
