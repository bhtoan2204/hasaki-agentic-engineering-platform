import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, selectRepositories, beginAttempt, cancelRun } from "../src/workflow/engine.ts";
import { claimJob } from "../src/workflow/scheduler.ts";
import { makeContext } from "../src/workflow/executors/registry.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { dispatchPlatformTool, envFromExecution } from "../src/agent/platformTools.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { CONTEXT_TOOLS } from "../src/agent/contextToolSchemas.ts";
import { SUBAGENT_PLATFORM_TOOLS, decide, type PolicyContext } from "../src/agent/toolPolicy.ts";
import { bwrapAvailable } from "../src/platform/selfDevelopment.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const REPO = "assess-go";
const AWS_EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE";
let ownerId: number;
const runs: number[] = [];
const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  ownerId = (
    await createUser({
      username: "assess-tests-owner",
      password: "assess-tests-pw",
      role: "member",
    })
  ).id;
  const path = join(config.reposRoot, REPO);
  mkdirSync(join(path, "safe"), { recursive: true });
  mkdirSync(join(path, "leaky"), { recursive: true });
  writeFileSync(join(path, "go.mod"), "module example.com/assess\n\ngo 1.21\n");
  writeFileSync(
    join(path, "safe", "safe_test.go"),
    'package safe\nimport "testing"\nfunc TestSafe(t *testing.T) {}\n',
  );
  writeFileSync(
    join(path, "leaky", "leaky_test.go"),
    `package leaky\nimport "testing"\nconst accessKey = "${AWS_EXAMPLE_KEY}"\nfunc TestLeaky(t *testing.T) { t.Fatal("unsafe package executed") }\n`,
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
  git("init", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");
  await repositories.upsert(REPO, { projects: ["ASSESS"], default_branch: "main" });
  for (const type of ["coding_agent", "agent"] as const)
    await definitions.create({
      key: `assess-tests-${type}`,
      spec: {
        name: "Assessment test execution",
        steps: [{ key: "assess", type, config: { instructions: "Assess" } }],
      },
    });
});
afterEach(async () => {
  for (const id of runs.splice(0)) await cancelRun(id);
  await settleBackground();
});
after(async () => {
  await settleBackground();
  await pool.end();
});

async function live(mode: "coding" | "analysis") {
  const run = await startRun({
    definitionKey: `assess-tests-${mode === "coding" ? "coding_agent" : "agent"}`,
    ownerId,
    inputs: { project: "ASSESS" },
  });
  runs.push(run.id);
  await selectRepositories(run.id, [REPO]);
  const job = await claimJob("assess-tests-worker", 120);
  assert.ok(job);
  const begun = await beginAttempt(job, "assess-tests-worker");
  assert.ok(begun);
  const ctx = makeContext({ ...begun, signal: new AbortController().signal });
  const policy: PolicyContext = { mode, workspaces: [], baseBranch: "main" };
  return { env: envFromExecution(ctx, mode, policy, newMetrics("fixture"), () => {}), policy };
}

test("run_tests is a main-agent tool that is not read-only, so a test run is not cut off by the context-read deadline", () => {
  const tool = CONTEXT_TOOLS.find((t) => t.name === "run_tests");
  assert.ok(tool);
  assert.equal(tool.readOnly, false);
  assert.ok(!SUBAGENT_PLATFORM_TOOLS.includes("mcp__platform__run_tests"));
});

test("an analysis step runs tests only through run_tests: unsafe packages are skipped and reported, the log is stored as run evidence", async (t) => {
  if (!hasGo || !(await bwrapAvailable())) return t.skip("needs go and bubblewrap");
  const { env, policy } = await live("analysis");
  const raw = await dispatchPlatformTool("run_tests", { repository: REPO }, env);
  const out = JSON.parse(raw);
  const report = out.reports[0];
  assert.equal(report.repository, REPO);
  assert.equal(report.status, "incomplete");
  assert.deepEqual(
    report.modules.map((m: { exit_code: number }) => m.exit_code),
    [0],
  );
  assert.deepEqual(
    report.unsafe_packages.map((u: { package: string }) => u.package),
    ["leaky"],
  );
  assert.match(out.incomplete.join("\n"), /were NOT run/);
  assert.ok(!raw.includes(AWS_EXAMPLE_KEY) && !raw.includes("unsafe package executed"));

  const artifact = await one<{ run_id: number; kind: string; name: string; content: string }>(
    pool,
    "SELECT run_id, kind, name, content FROM workflow_artifacts WHERE id = $1",
    [report.evidence[0].artifact_id],
  );
  assert.ok(artifact);
  assert.equal(artifact.run_id, env.runId);
  assert.equal(artifact.kind, "log");
  assert.match(artifact.content, /exit 0, network none, repository read-only/);
  assert.match(artifact.content, /ok\s+example\.com\/assess\/safe/);
  assert.ok(!artifact.content.includes(AWS_EXAMPLE_KEY));

  const direct = decide("Bash", { command: "go test -short ./..." }, policy, config.reposRoot);
  assert.equal(direct.allow, false);
});

test("run_tests refuses coding steps and repositories outside the run", async () => {
  const { env } = await live("coding");
  assert.match(
    await dispatchPlatformTool("run_tests", { repository: REPO }, env),
    /^ERROR:.*analysis/,
  );
  const analysis = await live("analysis");
  assert.match(
    await dispatchPlatformTool("run_tests", { repository: "not-in-this-run" }, analysis.env),
    /^ERROR:/,
  );
});
