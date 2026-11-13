import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FEATURE_REGRESSION_COMMAND,
  PLATFORM_REGRESSION_COMMAND,
  PLATFORM_TARGETED_COMMAND,
} from "../src/workflow/templates.ts";

/** A git repo whose node/npm/npx only log their arguments (`node -e` still runs for real). */
function repo(t: { after: (fn: () => void) => void }, scripts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "verify-cmd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, ".calls");
  const bin = join(dir, ".bin");
  mkdirSync(bin);
  for (const name of ["node", "npm", "npx"]) {
    const real = name === "node" ? `[ "$1" = "-e" ] && exec "${process.execPath}" "$@"\n` : "";
    writeFileSync(join(bin, name), `#!/bin/sh\n${real}echo "${name} $*" >> "${log}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const write = (file: string, body = "") => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  };
  write("package.json", JSON.stringify({ scripts }));
  write("node_modules/.bin/tsc", "");
  chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
  write("node_modules/x/index.js");
  write(".gitignore", ".bin\n.calls\nnode_modules\n");
  for (const f of [
    "src/a.ts",
    "test/a.test.ts",
    "test/env.ts",
    "src/workflow/engine.ts",
    "test/engine.integration.ts",
    "test/live.integration.ts",
    "test/run-integration.ts",
  ])
    write(f);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const run = (command: string) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BASE_BRANCH: "main",
    };
    delete env.DATABASE_URL;
    delete env.TEST_DATABASE_ADMIN_URL;
    rmSync(log, { force: true });
    const r = spawnSync("bash", ["-c", command], { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      // no stubbed call
    }
    return { stdout: r.stdout, calls: calls.trim().split("\n").filter(Boolean) };
  };
  const change = (...files: string[]) => {
    for (const f of files) write(f, "// changed\n");
    git("add", "-A");
    git("commit", "-qm", "change");
  };
  return { run, change };
}

const unit = (files: string) =>
  `node --disable-warning=ExperimentalWarning --import ./test/env.ts --test ${files}`;
const integration = (files: string) =>
  `node --disable-warning=ExperimentalWarning test/run-integration.ts ${files}`;

test("platform targeted command: unit-only diffs never start the integration harness", (t) => {
  const r = repo(t, { test: "x" });
  r.change("src/a.ts");
  assert.deepEqual(r.run(PLATFORM_TARGETED_COMMAND).calls, [
    "npx --no-install tsc -p . --pretty false --noEmit --incremental false",
    unit("test/a.test.ts"),
  ]);
});

test("platform targeted command: core modules and edited integration files run through one shared cluster", (t) => {
  const r = repo(t, { test: "x" });
  r.change("src/a.ts", "src/workflow/engine.ts", "test/live.integration.ts");
  assert.deepEqual(r.run(PLATFORM_TARGETED_COMMAND).calls.slice(1), [
    unit("test/a.test.ts"),
    integration("test/engine.integration.ts test/live.integration.ts"),
  ]);
});

test("platform regression falls back to npm test on checkouts without test:all", (t) => {
  assert.deepEqual(repo(t, { test: "x", "test:all": "y" }).run(PLATFORM_REGRESSION_COMMAND).calls, [
    "npm run test:all",
  ]);
  assert.deepEqual(repo(t, { test: "x" }).run(PLATFORM_REGRESSION_COMMAND).calls, ["npm test"]);
});

test("feature regression runs the target repository's own npm test", (t) => {
  assert.deepEqual(repo(t, { test: "x", "test:all": "y" }).run(FEATURE_REGRESSION_COMMAND).calls, [
    "npm test --if-present",
  ]);
});
