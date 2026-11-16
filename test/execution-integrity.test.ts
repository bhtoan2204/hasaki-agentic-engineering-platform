import { runVerificationCommand } from "../src/workflow/executors/builtin.ts";
import { buildExecutionContract } from "../src/agent/executionContract.ts";
import { validateSpec } from "../src/workflow/graph.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { requiredTestTargets, verifyWorkspaces } from "../src/agent/verify.ts";
import {
  installNodeDependencies,
  nodeModulesReady,
} from "../src/git/nodeDependencies.ts";
import { commandProcessEnv, setBwrapForTests } from "../src/platform/selfDevelopment.ts";
import { config } from "../src/config.ts";
import { implementationChanged } from "../src/agent/implementationEvidence.ts";

function fixture(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), "execution-integrity-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { stdio: "pipe" },
    );
  git("init", "-q");
  writeFileSync(join(path, "source.txt"), "initial");
  git("add", ".");
  git("commit", "-qm", "baseline");
  return { path, git };
}

test("approval validates executable selectors, owner ambiguity, future files, runner compatibility and symlink escape", async (t) => {
  const left = fixture(t),
    right = fixture(t);
  for (const f of [left, right]) {
    mkdirSync(join(f.path, "test"));
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
  }
  const workspaces = [
    { repo: "left", path: left.path },
    { repo: "right", path: right.path },
  ];
  assert.equal(
    (await requiredTestTargets(workspaces, ["left::test/future.test.ts"], true)).problems.length,
    0,
  );
  assert.ok(
    (await requiredTestTargets(workspaces, ["test/future.test.ts"], true)).problems.some((p) =>
      /ambiguous/.test(p),
    ),
  );
  for (const selector of [
    "test the positive case",
    "left::../escape.test.ts",
    "left::test/test.ts;id",
    "unknown::test/a.test.ts",
  ])
    assert.ok((await requiredTestTargets(workspaces, [selector], true)).problems.length, selector);
  symlinkSync(right.path, join(left.path, "external"));
  assert.ok(
    (await requiredTestTargets(workspaces, ["left::external/future.test.ts"], true)).problems
      .length,
  );
  writeFileSync(
    join(left.path, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  assert.ok(
    (await requiredTestTargets(workspaces, ["left::test/future.test.ts"], true)).problems.some(
      (p) => /incompatible/.test(p),
    ),
  );
});

test("mandatory verification fingerprints workspaces even without additional test selectors", async (t) => {
  const { path } = fixture(t);
  const cfg = {
    command: "trusted check",
    maxRepairs: 0,
    timeoutMs: 30000,
    baseline: null,
    allowTestWeakening: false,
  };
  const first = await verifyWorkspaces(
    [{ repo: "one", path }],
    [path],
    cfg,
    0,
    new AbortController().signal,
    {
      run: async () => ({ code: 0, timedOut: false, output: "passed" }),
      diffTests: async () => "",
    },
  );
  assert.equal(first.passed, true);
  assert.ok(first.repos[0].tested_state);
  const mutated = await verifyWorkspaces(
    [{ repo: "one", path }],
    [path],
    cfg,
    0,
    new AbortController().signal,
    {
      run: async () => {
        writeFileSync(join(path, "source.txt"), "mutated");
        return { code: 0, timedOut: false, output: "passed" };
      },
      diffTests: async () => "",
    },
  );
  assert.equal(mutated.passed, false);
});

test("implementation evidence compares content rather than branch history or index movement", () => {
  const original = {
    repo: { path: "/work", head: "first", fingerprint: "dirty", content: "same source" },
  };
  assert.equal(
    implementationChanged(original, {
      repo: { ...original.repo, head: "second", fingerprint: "clean" },
    }),
    false,
  );
  assert.equal(
    implementationChanged(original, { repo: { ...original.repo, content: "implementation edit" } }),
    true,
  );
  assert.equal(
    implementationChanged(original, {
      repo: { ...original.repo, path: "/other", content: "different" },
    }),
    false,
  );
});

test("dependency readiness rejects a forged presence marker, missing packages and modified installed code", async (t) => {
  const { path } = fixture(t);
  writeFileSync(join(path, "package.json"), JSON.stringify({ dependencies: { example: "1.0.0" } }));
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules", ".platform-ready"), "forged by the agent");
  assert.equal(await nodeModulesReady(path), false);
  const bin = join(path, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10; exit; fi\nmkdir -p node_modules/example\nprintf \'{"name":"example","version":"1.0.0"}\' > node_modules/example/package.json\nprintf \'module.exports = 1\' > node_modules/example/index.js\n',
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    await installNodeDependencies(path);
    assert.equal(await nodeModulesReady(path, { strict: true }), true);
    writeFileSync(join(path, "node_modules", "example", "index.js"), "module.exports = 999");
    assert.equal(await nodeModulesReady(path, { strict: true }), false);
    await installNodeDependencies(path);
    rmSync(join(path, "node_modules", "example"), { recursive: true });
    assert.equal(await nodeModulesReady(path, { strict: true }), false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("worker-controlled commands require OS isolation or the existing explicit trusted-operator policy", async (t) => {
  const { path } = fixture(t),
    prior = config.platform.trustedOperatorIsolation;
  setBwrapForTests(null);
  config.platform.trustedOperatorIsolation = false;
  try {
    await assert.rejects(commandProcessEnv(path, {}, true), /bubblewrap|trustedOperatorIsolation/);
    config.platform.trustedOperatorIsolation = true;
    assert.equal((await commandProcessEnv(path, {}, true)).isolation?.mode, "trusted");
  } finally {
    setBwrapForTests(undefined);
    config.platform.trustedOperatorIsolation = prior;
  }
});

test("graph bindings preserve every configured approval source and keep prose outside executable tests", () => {
  const graph = validateSpec({
    name: "Named by configuration",
    steps: [
      { key: "decisions", type: "agent" },
      { key: "tasks", type: "agent", depends_on: ["decisions"] },
      {
        key: "authorize",
        type: "human_approval",
        depends_on: ["tasks"],
        config: { show_outputs: ["decisions", "tasks"] },
      },
      { key: "code", type: "coding_agent", depends_on: ["authorize"] },
    ],
  });
  const sources = {
    decisions: {
      status: "COMPLETED",
      attempt_id: 1,
      output: { modules: ["existing transaction"], compatibility: ["Preserve callers"] },
    },
    tasks: {
      status: "COMPLETED",
      attempt_id: 2,
      output: {
        summary: "Implement",
        tests: ["Check compatibility"],
        regression_tests: ["Exercise prior behavior"],
        verification_strategy: ["Verify final integration"],
      },
    },
    authorize: { status: "COMPLETED", attempt_id: 3, output: { approved: true } },
  };
  const contract = buildExecutionContract(sources, ["repo"], null, {
    graph,
    step: graph.steps[3],
    definition_version_id: 17,
    request: { title: "Preserve behavior" },
  });
  assert.deepEqual(
    (contract.approved_plan as Record<string, unknown>).decisions,
    sources.decisions.output,
  );
  assert.deepEqual(contract.required_tests, []);
  assert.ok(contract.verification_strategy?.includes("Exercise prior behavior"));
  assert.equal(contract.authorization?.definition_version_id, 17);
  assert.ok((contract.verification as { command: string }).command);
});

test("worker verification cannot write a protected path outside its worktree", async (t) => {
  const { path } = fixture(t);
  // Any writable directory outside the verified worktree works. Prefer /var/tmp; verification sandboxes mount it read-only.
  const protectedRoot = (() => {
    for (const base of ["/var/tmp", join(homedir(), ".cache"), process.cwd()]) {
      try { mkdirSync(base, { recursive: true }); return mkdtempSync(join(base, "verification-protected-")); } catch { /* try the next location */ }
    }
    throw new Error("no writable directory outside the worktree for the protected-path check");
  })();
  t.after(() => rmSync(protectedRoot, { recursive: true, force: true }));
  const protectedFile = join(protectedRoot, "sentinel");
  writeFileSync(protectedFile, "protected");
  const command = `printf tampered > '${protectedFile}'`;
  const result = await runVerificationCommand(
    command,
    path,
    {},
    30000,
    new AbortController().signal,
  );
  assert.notEqual(result.code, 0);
  assert.equal(readFileSync(protectedFile, "utf8"), "protected");
});
