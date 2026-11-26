import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import {
  delegatedScopeAvailable,
  superviseSpawn,
  supervisionRuntime,
} from "../src/agent/process/supervisor.ts";

// A fake systemd-run on PATH: logs every probe, answers slowly, exits with the status in `status`.
const dir = mkdtempSync(join(tmpdir(), "scope-delegate-"));
const calls = join(dir, "calls");
const status = join(dir, "status");
writeFileSync(
  join(dir, "systemd-run"),
  `#!/bin/sh\necho probe >> '${calls}'\nsleep 0.2\necho 'no user bus' >&2\nexit $(cat '${status}')\n`,
);
chmodSync(join(dir, "systemd-run"), 0o755);
config.system.path = `${dir}:/usr/bin:/bin`;
const probes = () =>
  existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
const reset = () => writeFileSync(calls, "");

test("concurrent callers share one probe", async () => {
  writeFileSync(status, "0");
  reset();
  const results = await Promise.all(Array.from({ length: 5 }, () => delegatedScopeAvailable()));
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(probes(), 1);
});

test("force bypasses the cache; a forced call during a probe joins it", async () => {
  writeFileSync(status, "0");
  reset();
  assert.equal(await delegatedScopeAvailable(), true);
  assert.equal(probes(), 0, "cached");
  writeFileSync(status, "1");
  assert.deepEqual(
    await Promise.all([delegatedScopeAvailable(true), delegatedScopeAvailable(true)]),
    [false, false],
  );
  assert.equal(probes(), 1);
  const rt = await supervisionRuntime();
  assert.equal(rt.delegated_cgroup, false);
  assert.match(rt.cgroup_problem!, /no user bus/);
});

test("the cache lasts 5 minutes; expiry triggers exactly one re-probe", async () => {
  writeFileSync(status, "0");
  await delegatedScopeAvailable(true);
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    reset();
    mock.timers.tick(299_000);
    assert.equal(await delegatedScopeAvailable(), true);
    assert.equal(probes(), 0);
    mock.timers.tick(2_000);
    await Promise.all([
      delegatedScopeAvailable(),
      delegatedScopeAvailable(),
      delegatedScopeAvailable(),
    ]);
    assert.equal(probes(), 1);
    assert.equal(await delegatedScopeAvailable(), true);
    assert.equal(probes(), 1);
  } finally {
    mock.timers.reset();
  }
});

test("enforced isolation without a delegated cgroup fails closed before anything runs", async () => {
  const marker = join(dir, "ran");
  const launcher = join(dir, "launcher");
  writeFileSync(launcher, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(launcher, 0o755);
  const saved = {
    engine: config.supervision.engine,
    bin: config.binaries.superviseBin,
    mode: config.isolation.mode,
  };
  config.supervision.engine = "go";
  config.binaries.superviseBin = launcher;
  config.isolation.mode = "enforce";
  writeFileSync(status, "1");
  try {
    await delegatedScopeAvailable(true);
    await assert.rejects(
      superviseSpawn({ command: "true", args: [], cwd: dir, env: {}, class: "agent", graceMs: 0 }),
      /delegated cgroup while isolation is enforced: no user bus/,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    config.supervision.engine = saved.engine;
    config.binaries.superviseBin = saved.bin;
    config.isolation.mode = saved.mode;
  }
});
