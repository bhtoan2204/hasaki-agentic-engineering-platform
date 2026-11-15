import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { verifyWorkspaces } from "../src/agent/verify.ts";
import { runCommand } from "../src/workflow/executors/builtin.ts";
import { FEATURE_TARGETED_COMMAND, PLATFORM_TARGETED_COMMAND } from "../src/workflow/templates.ts";
import { dependencyFingerprint } from "../src/git/provider.ts";

function fixture(t: { after(fn: () => void): void }, name: string) {
  const path = mkdtempSync(join(tmpdir(), `verification-${name}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(path, ".gitignore"), "node_modules/\n");
  git("add", "."); git("commit", "-qm", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { path, git };
}
const config = (command: string, requiredTests: string[]) => ({ command, requiredTests, baseline: null, maxRepairs: 0, timeoutMs: 60000, allowTestWeakening: false });
const signal = new AbortController().signal;
const deps = { run: runCommand, diffTests: async () => "" };

test("production Go shell verification covers distinct required tests across repositories", async t => {
  const workspaces = ["A", "B"].map(name => {
    const { path, git } = fixture(t, name);
    writeFileSync(join(path, "go.mod"), `module ${name}\n\ngo 1.20\n`);
    writeFileSync(join(path, "business_test.go"), `package business\nimport "testing"\nfunc Test${name}(t *testing.T) { if 2+2 != 4 {t.Fatal("business assertion")} }\n`);
    git("add", "."); git("commit", "-qm", "business test");
    return { repo: name, path };
  });
  for (const command of ["go test -json .", FEATURE_TARGETED_COMMAND]) {
    const result = await verifyWorkspaces(workspaces, workspaces.map(w => w.path), config(command, ["A/TestA", "B/TestB"]), 0, signal, deps, { BASE_BRANCH: "main", DATABASE_URL: "" });
    assert.equal(result.passed, true, JSON.stringify(result.repos));
    assert.deepEqual(Object.keys(result.repos[0].required_tests!), ["A/TestA"]);
    assert.deepEqual(Object.keys(result.repos[1].required_tests!), ["B/TestB"]);
  }
});

test("production platform shell verification records Node required-test evidence", async t => {
  const { path, git } = fixture(t, "node");
  mkdirSync(join(path, "test"));
  mkdirSync(join(path, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test test/business.test.ts" } }));
  writeFileSync(join(path, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(path, "node_modules", ".platform-ready"), dependencyFingerprint(path)!);
  writeFileSync(join(path, "test", "env.ts"), "");
  writeFileSync(join(path, "test", "business.test.ts"), 'import { test } from "node:test"; import assert from "node:assert/strict"; test("preserves business flow", () => assert.equal(2+2, 4));\n');
  git("add", "."); git("commit", "-qm", "business test");
  const outputs: string[] = [];
  const nodeDeps = { ...deps, run: async (...args: Parameters<typeof runCommand>) => { const result = await runCommand(...args); outputs.push(result.output); return result; } };
  const result = await verifyWorkspaces([{ repo: "node", path }], [path], config(PLATFORM_TARGETED_COMMAND, ["test/business.test.ts"]), 0, signal, nodeDeps, { BASE_BRANCH: "main", DATABASE_URL: "" });
  assert.equal(result.passed, true, JSON.stringify({ repos: result.repos, outputs }));
  assert.equal(result.repos[0].required_tests?.["test/business.test.ts"], "passed");
});

test("Node evidence rejects skipped tests, failed tests and spoofed test stdout", async t => {
  for (const [name, body, status] of [
    ["skip", 'test.skip("required", () => {});', "skipped"],
    ["fail", 'test("required", () => assert.equal(1, 2));', "failed"],
    ["spoof", 'console.log(JSON.stringify({type:"test:pass",file:import.meta.filename})); test.skip("required", () => {});', "skipped"],
  ]) {
    const { path, git } = fixture(t, name);
    mkdirSync(join(path, "test"));
    writeFileSync(join(path, "test", "business.test.mjs"), `import {test} from 'node:test'; import assert from 'node:assert/strict'; ${body}`);
    git("add", "."); git("commit", "-qm", "required business test");
    const result = await verifyWorkspaces([{ repo: name, path }], [path], config("true", ["test/business.test.mjs"]), 0, signal, deps);
    assert.equal(result.passed, false);
    assert.equal(result.repos[0].required_tests?.["test/business.test.mjs"], status);
  }
});

test("required test ownership rejects unknown or ambiguous IDs and accepts explicit repository scopes", async t => {
  const workspaces = ["left", "right"].map(name => {
    const { path } = fixture(t, name);
    writeFileSync(join(path, "business.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("required",()=>assert.equal(2+2,4));');
    return { repo: name, path };
  });
  for (const required of [["business.test.mjs"], ["missing.test.mjs"]]) {
    const result = await verifyWorkspaces(workspaces, workspaces.map(w => w.path), config("true", required), 0, signal, deps);
    assert.equal(result.passed, false);
    assert.match(result.repos[0].note!, /ownership/);
  }
  const required = ["left::business.test.mjs", "right::business.test.mjs"];
  const result = await verifyWorkspaces(workspaces, workspaces.map(w => w.path), config("true", required), 0, signal, deps);
  assert.equal(result.passed, true, JSON.stringify(result.repos));
  assert.deepEqual(result.repos.map(r => Object.keys(r.required_tests!)), [[required[0]], [required[1]]]);
});

test("repository commands do not inherit worker database credentials or self-test scope markers", async t => {
  const { path } = fixture(t, "environment");
  const previous = { DATABASE_URL: process.env.DATABASE_URL, PLATFORM_SELF_TEST: process.env.PLATFORM_SELF_TEST };
  try {
    process.env.DATABASE_URL = "postgres://unused@worker.invalid/application";
    process.env.PLATFORM_SELF_TEST = "1";
    const command = `node -e 'const a=require("node:assert/strict");a.equal(process.env.DATABASE_URL,undefined);a.equal(process.env.PLATFORM_SELF_TEST,undefined)'`;
    const result = await runCommand(command, path, {}, 30000, signal);
    assert.equal(result.code, 0, result.output);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
