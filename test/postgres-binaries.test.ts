import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import {
  buildPostgresBin,
  installedPostgresBin,
  nixPostgresArgs,
  postgresBinDir,
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
  TEST_POSTGRES_GUARD,
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
/** Behaves like `nix build --out-link <link> --print-out-paths`: links the store path, prints it. */
const fakeNix =
  (store: string, calls: Array<{ args: string[]; timeoutMs: number }> = []) =>
  async (args: string[], timeoutMs: number): Promise<NixResult> => {
    calls.push({ args, timeoutMs });
    symlinkSync(store, args[args.indexOf("--out-link") + 1]);
    return { code: 0, stdout: `${store}\n`, stderr: "" };
  };
const failingNix =
  (calls: string[][] = []) =>
  async (args: string[]): Promise<NixResult> => {
    calls.push(args);
    return {
      code: 1,
      stdout: "",
      stderr: "error: unable to download 'https://cache.nixos.org': Could not resolve host\n",
      error: "Command failed",
    };
  };
const harness = (setup = 'spawnSync("initdb", []);\n') => {
  const repo = dir("repo");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "setup.ts"), setup);
  return repo;
};

test("postgres binaries: PATH first, then the nix out-link, without running nix", () => {
  const onPath = fakePrefix("path");
  const outLink = join(dir("data"), "postgres-17");
  assert.deepEqual(
    installedPostgresBin({ pathEnv: `/nonexistent:${join(onPath, "bin")}`, outLink }),
    {
      dir: join(onPath, "bin"),
      source: "path",
    },
  );
  assert.equal(installedPostgresBin({ pathEnv: "/nonexistent", outLink }), null);
  const store = fakePrefix("store");
  symlinkSync(store, outLink);
  assert.deepEqual(installedPostgresBin({ pathEnv: "/nonexistent", outLink }), {
    dir: join(store, "bin"),
    source: "cache",
  });
});

test("postgres binaries: nix builds postgresql_17 into a GC-rooted out-link, validated on every use", async () => {
  const store = fakePrefix("store");
  const outLink = join(dir("data"), "postgres-17");
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const r = await buildPostgresBin({ outLink, nix: fakeNix(store, calls), timeoutMs: 1234 });
  assert.deepEqual(r, { dir: join(store, "bin"), source: "nix" });
  assert.deepEqual(calls, [{ args: nixPostgresArgs(outLink), timeoutMs: 1234 }]);
  assert.ok(calls[0].args.includes("nix-command flakes"), "works on stock nix installs");
  assert.ok(!calls[0].args.includes("--no-link"), "the out-link is the GC root");
  assert.deepEqual(installedPostgresBin({ pathEnv: "", outLink }), {
    dir: join(store, "bin"),
    source: "cache",
  });
  rmSync(join(store, "bin", "initdb"));
  assert.equal(
    installedPostgresBin({ pathEnv: "", outLink }),
    null,
    "a collected store path is not used",
  );
  const empty = await buildPostgresBin({
    outLink: join(dir("data"), "postgres-17"),
    nix: async () => ({ code: 0, stdout: "/nix/store/x-postgresql-17\n", stderr: "" }),
  });
  assert.match(empty.dir === null ? empty.reason : "", /left no bin\/initdb at .*postgres-17/);
});

test("postgres binaries: a nix failure yields null with its stderr", async () => {
  const outLink = join(dir("data"), "postgres-17");
  const failed = await buildPostgresBin({ outLink, nix: failingNix() });
  assert.equal(failed.dir, null);
  assert.match(failed.dir === null ? failed.reason : "", /Could not resolve host/);
  const missing = await buildPostgresBin({
    outLink,
    nix: async () => ({ code: null, stdout: "", stderr: "", error: "spawn nix ENOENT" }),
  });
  assert.deepEqual(missing, {
    dir: null,
    reason: "initdb is not on PATH and nix is not installed",
  });
});

test("postgres binaries: after a nix failure a fixed environment is used at once; only nix is throttled", async () => {
  setPostgresBinForTests(undefined);
  const outLink = join(dir("data"), "postgres-17");
  const calls: string[][] = [];
  try {
    const first = await postgresBinDir({ pathEnv: "", outLink, nix: failingNix(calls) });
    assert.match(first.dir === null ? first.reason : "", /Could not resolve host/);
    const again = await postgresBinDir({ pathEnv: "", outLink, nix: failingNix(calls) });
    assert.match(
      again.dir === null ? again.reason : "",
      /Could not resolve host.*last nix attempt at \d{4}-\d\d-\d\dT/,
    );
    assert.equal(calls.length, 1, "nix is not re-run within the throttle");
    const onPath = fakePrefix("fixed");
    assert.deepEqual(
      await postgresBinDir({ pathEnv: join(onPath, "bin"), outLink, nix: noNix }),
      { dir: join(onPath, "bin"), source: "path" },
      "installing PostgreSQL and retrying works without waiting",
    );
    const store = fakePrefix("store");
    symlinkSync(store, outLink);
    assert.deepEqual(await postgresBinDir({ pathEnv: "", outLink, nix: noNix }), {
      dir: join(store, "bin"),
      source: "cache",
    });
  } finally {
    setPostgresBinForTests(undefined);
  }
});

test("postgres env: only repositories whose test preload runs initdb get the bin dir or the unavailable reason", async () => {
  const store = fakePrefix("env-store");
  try {
    setPostgresBinForTests({ dir: join(store, "bin"), source: "nix" });
    assert.deepEqual(await testPostgresEnv(dir("plain")), {});
    assert.deepEqual(await testPostgresEnv(harness("export {};\n")), {});
    assert.deepEqual(await testPostgresEnv(harness()), {
      PLATFORM_TEST_POSTGRES_BIN: join(store, "bin"),
    });
    setPostgresBinForTests({ dir: "/usr/bin", source: "path" });
    assert.deepEqual(await testPostgresEnv(harness()), { PLATFORM_TEST_POSTGRES_BIN: "/usr/bin" });
    setPostgresBinForTests({ dir: null, reason: "nix is not installed" });
    assert.deepEqual(await testPostgresEnv(harness()), {
      PLATFORM_POSTGRES_UNAVAILABLE: "nix is not installed",
    });
    assert.equal(
      await testPostgresEnv(harness(), AbortSignal.abort()),
      null,
      "a canceled step does not wait",
    );
  } finally {
    setPostgresBinForTests(undefined);
  }
});

test("runCommand: the guard puts the bin dir on PATH after a login profile reset it; without PostgreSQL the suite exits 78", async () => {
  const store = fakePrefix("run-store");
  const repo = harness();
  const never = new AbortController().signal;
  try {
    setPostgresBinForTests({ dir: join(store, "bin"), source: "nix" });
    // What Debian/Ubuntu /etc/profile does under bash -l.
    const ok = await runCommand(
      `PATH=/usr/bin:/bin\n${TEST_POSTGRES_GUARD}\ncommand -v initdb`,
      repo,
      {},
      30_000,
      never,
    );
    assert.equal(ok.code, 0, ok.output);
    assert.equal(ok.output.trim(), join(store, "bin", "initdb"));
    const unrelated = await runCommand(
      "printenv | grep -c '^PLATFORM_TEST_POSTGRES_BI[N]=' || true",
      repo,
      {},
      30_000,
      never,
    );
    assert.equal(unrelated.output.trim(), "0", "commands without the guard skip the resolution");

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
    assert.match(
      command,
      /PLATFORM_POSTGRES_UNAVAILABLE[\s\S]*exit 78[\s\S]*PLATFORM_TEST_POSTGRES_BIN/,
    );
});
