import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyConfig, verifyWorkspaces } from "../src/agent/verify.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" });

async function nodeRepo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "no-runner-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  for (const [f, content] of Object.entries(files)) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

// `npm test --if-present` in a repository without a test script prints nothing and exits 0.
async function regression(dir: string, staticChecksPassed?: string[]) {
  const cfg = {
    ...verifyConfig({ verify: { command: "npm test --if-present" } }, "x")!,
    baseline: null as null,
  };
  if (staticChecksPassed) cfg.staticChecksPassed = staticChecksPassed;
  const round = await verifyWorkspaces(
    [{ repo: "web", path: dir }],
    [dir],
    cfg,
    0,
    new AbortController().signal,
    {
      run: async () => ({ code: 0, output: "", timedOut: false }),
    },
  );
  return round.repos[0];
}

test("a regression command without a test runner is not applicable only when this gate passed the static checks", async () => {
  const dir = await nodeRepo({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "src/a.ts": "",
  });
  try {
    const gated = await regression(dir, ["web"]);
    assert.equal(gated.status, "not_applicable");
    assert.equal(gated.passed, true);
    assert.match(gated.note ?? "", /publication gate/);
    assert.equal((await regression(dir)).status, "not_executed", "no static checks in this gate");
    assert.equal(
      (await regression(dir, ["other"])).status,
      "not_executed",
      "static checks of another repository",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a repository with a test script or a test file still needs evidence that tests ran", async () => {
  const script = await nodeRepo({
    "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
  });
  const file = await nodeRepo({ "package.json": "{}", "src/a.test.ts": "" });
  try {
    assert.equal((await regression(script, ["web"])).status, "not_executed");
    assert.equal((await regression(file, ["web"])).status, "not_executed");
  } finally {
    await rm(script, { recursive: true });
    await rm(file, { recursive: true });
  }
});
