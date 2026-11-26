import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { config } from "../src/config.ts";
import { systemdLiteral } from "../src/agent/process/scope.ts";

test("a failed systemd-run probe is cached: later calls do not spawn it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-probe-"));
  const log = join(dir, "calls");
  writeFileSync(join(dir, "systemd-run"), `#!/bin/sh\necho x >> '${log}'\nexit 1\n`);
  chmodSync(join(dir, "systemd-run"), 0o755);
  const saved = config.system.path;
  config.system.path = dir;
  try {
    assert.deepEqual(systemdLiteral(["a$b"]), ["a$$b"]);
    assert.deepEqual(systemdLiteral(["a$b"]), ["a$$b"]);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  } finally {
    config.system.path = saved;
  }
});
