/**
 * Execution efficiency and budget reliability (Run #153 / REQ-126 follow-up), on the real Workflow Engine, Agent
 * Harness and PostgreSQL:
 *  - a stale checkout is refreshed before the first source step, which pins one base revision for the run; later
 *    steps and new worktrees use that revision; a checkout elsewhere is an explicit, recorded transition;
 *  - local work is never reset or discarded;
 *  - the cross-step file handoff includes read-only shell reads, is dropped when it was gathered at another revision,
 *    and never carries a withheld step's exploration;
 *  - cost budgets: "warn" never blocks, "pause" pauses until resumed, resuming acknowledges, a warning recorded under
 *    "warn" acknowledges nothing.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { getRun, resumeRun, startRun } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { registerExecutor, type StepExecutor } from "../src/workflow/executors/registry.ts";
import { integrationExecutor } from "../src/workflow/executors/builtin.ts";
import { agentExecutor } from "../src/agent/harness/executor.ts";
import { repositories } from "../src/repos/service.ts";
import { prepareWorkspace } from "../src/git/provider.ts";
import { shellReadPaths } from "../src/workflow/context.ts";
import { runCost } from "../src/report/cost.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const repo = `eff-src-${process.pid}`;
const root = process.env.TEST_ROOT!;
let owner: PublicUser;
let primary = "";
let upstream = "";
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const commitTo = (cwd: string, file: string, body: string, msg: string) => {
  writeFileSync(join(cwd, file), body);
  sh(cwd, "add", ".");
  sh(cwd, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", msg);
  return sh(cwd, "rev-parse", "HEAD");
};
async function drive(runId: number) {
  for (let i = 0; i < 2000; i++) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED", "PAUSED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error(`run ${runId} did not settle`);
}
let defs = 0;
async function workflow(steps: Array<Record<string, unknown>>) {
  const key = `eff-wf-${process.pid}-${++defs}`;
  await definitions.create({ key, spec: { name: key, steps } });
  return key;
}
const pinOf = async (runId: number) =>
  (await one<{ s: Record<string, Record<string, unknown>> | null }>(
    pool,
    "SELECT source_revisions AS s FROM workflow_runs WHERE id=$1",
    [runId],
  ))!.s;

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  owner = await createUser({
    username: `eff-${Date.now()}`,
    password: "efficiency-pass",
    role: "member",
  });
  // origin (bare) ← upstream clone pushes; primary is the platform's checkout of it.
  const origin = join(config.reposRoot, `${repo}.git`);
  primary = join(config.reposRoot, repo);
  upstream = join(root, "eff-upstream");
  mkdirSync(primary, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh(primary, "init", "-q", "-b", "main");
  commitTo(primary, "a.ts", "export const a = 1;\n", "c1");
  sh(primary, "remote", "add", "origin", origin);
  sh(primary, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, upstream]);
  await repositories.upsert(repo, { projects: ["Eff"], default_branch: "main" });
  registerExecutor("integration", integrationExecutor);
  const bin = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
  chmodSync(bin, 0o755);
  const script = join(root, "eff-agent.mjs");
  writeFileSync(script, `export default async () => ({ summary: "read the source" });`);
  Object.assign(process.env, {
    CODEX_BIN: bin,
    FAKE_CODEX_MODE: "script",
    FAKE_CODEX_SCRIPT: script,
    FAKE_CODEX_LOG: join(root, "eff-codex.jsonl"),
  });
});
after(() => pool.end());

// ---------------------------------------------------------------- source revision

let pinnedRun = 0;
let c2 = "";

test("a stale checkout is refreshed before the first source step, which pins one base revision for the run", async () => {
  registerExecutor("agent", agentExecutor);
  const c1 = sh(primary, "rev-parse", "HEAD");
  // The remote moves on after the platform's checkout was last fetched (Run #153: 56824d6 vs 38a8611).
  c2 = commitTo(upstream, "b.ts", "export const b = 2;\n", "c2 (feature on main)");
  sh(upstream, "push", "-q", "origin", "main");
  assert.equal(sh(primary, "rev-parse", "origin/main"), c1, "the checkout does not know c2 yet");
  // Uncommitted local work in the checkout must survive.
  writeFileSync(join(primary, "local-notes.txt"), "work in progress\n");
  const key = await workflow([
    { key: "analyze", type: "agent", config: { instructions: "Analyse." } },
    { key: "plan", type: "agent", depends_on: ["analyze"], config: { instructions: "Plan." } },
  ]);
  const run = await startRun({
    definitionKey: key,
    repositories: [repo],
    agentProvider: "codex",
    ownerId: owner.id,
  });
  pinnedRun = run.id;
  assert.equal(await drive(run.id), "COMPLETED");
  const pin = (await pinOf(run.id))![repo];
  assert.equal(pin.commit, c2, "pinned to the remote's current base, not the stale one");
  assert.equal(pin.freshness, "refreshed");
  assert.equal(pin.fetched, true);
  assert.equal(pin.step, "analyze");
  const decisions = await q<{ action: string; details: Record<string, unknown> }>(
    pool,
    "SELECT action, details FROM execution_decisions WHERE run_id=$1 AND kind='source_revision' ORDER BY id",
    [run.id],
  );
  assert.equal(
    decisions.filter((d) => d.action === "RECORD").length,
    1,
    "pinned once, by the first source step",
  );
  // The checkout itself was not moved (a local checkout is never reset); both steps were told, and it was recorded.
  assert.equal(sh(primary, "rev-parse", "HEAD"), c1);
  assert.equal(readFileSync(join(primary, "local-notes.txt"), "utf8"), "work in progress\n");
  assert.equal(decisions.filter((d) => d.action === "RECONCILE").length, 2);
  const prompts = await q<{ key: string; content: string }>(
    pool,
    "SELECT s.key, e.content FROM workflow_events e JOIN workflow_steps s ON s.id=e.step_id WHERE e.run_id=$1 AND e.kind='prompt'",
    [run.id],
  );
  for (const p of prompts) {
    assert.match(p.content, /Source revision for this run/, p.key);
    assert.ok(p.content.includes(`main@${c2.slice(0, 12)}`), p.key);
    assert.match(p.content, new RegExp(`Your checkout is at ${c1.slice(0, 12)}`), p.key);
  }
  const ev = await one<{
    data: { source_revisions: Array<Record<string, unknown>>; cost: Record<string, unknown> };
  }>(
    pool,
    "SELECT a.data FROM workflow_artifacts a JOIN workflow_steps s ON s.id=a.step_id WHERE a.run_id=$1 AND s.key='plan' AND a.kind='harness_evidence'",
    [run.id],
  );
  assert.equal(ev!.data.source_revisions[0].pinned, c2, "the pin is in the execution evidence");
  assert.equal(ev!.data.cost.provider_hard_limit, false);
});

test("a new run worktree starts from the pinned revision even after the remote moved again; local work survives recovery", async () => {
  const c3 = commitTo(upstream, "c.ts", "export const c = 3;\n", "c3 (after the plan)");
  sh(upstream, "push", "-q", "origin", "main");
  const run = await getRun(pinnedRun);
  const w = await prepareWorkspace(run, repo);
  assert.equal(
    sh(w.path, "rev-parse", "HEAD"),
    c2,
    "Implement starts where Analyze and Plan looked",
  );
  assert.equal(w.created_from, `origin/main@${c2.slice(0, 12)}`);
  assert.equal(
    sh(primary, "rev-parse", "origin/main"),
    c3,
    "the newer base is known, but not silently used",
  );
  // Recovery of an existing worktree keeps its uncommitted work.
  writeFileSync(join(w.path, "a.ts"), "export const a = 42; // edited\n");
  const again = await prepareWorkspace(run, repo);
  assert.equal(again.path, w.path);
  assert.equal(readFileSync(join(w.path, "a.ts"), "utf8"), "export const a = 42; // edited\n");
  assert.equal(sh(w.path, "rev-parse", "HEAD"), c2);
});

test("a run whose pinned base no longer exists fails clearly instead of inventing a source state", async () => {
  const run = await startRun({
    definitionKey: await workflow([
      { key: "noop", type: "integration", config: { action: "noop" } },
    ]),
    repositories: [repo],
    ownerId: owner.id,
    start: false,
  });
  await q(pool, "UPDATE workflow_runs SET source_revisions=$2 WHERE id=$1", [
    run.id,
    JSON.stringify({ [repo]: { branch: "main", commit: "f".repeat(40) } }),
  ]);
  await assert.rejects(
    prepareWorkspace(await getRun(run.id), repo),
    /pinned base ffffffffffff is not available/,
  );
});

// ---------------------------------------------------------------- cross-step handoff

test("read-only shell commands are handed on as file references; writes and other commands are not", () => {
  assert.deepEqual(
    shellReadPaths(
      "cd /w/x && sed -n '1,80p' src/workflow/engine.ts && grep -n foo web/src/App.tsx | head; git show 38a8611:migrations/094_bug_hunts.sql",
      ["/w/x"],
    ).sort(),
    ["migrations/094_bug_hunts.sql", "src/workflow/engine.ts", "web/src/App.tsx"],
  );
  assert.deepEqual(
    shellReadPaths("npm test -- test/a.test.ts; rm src/x.ts; echo hi > src/y.ts"),
    [],
  );
  assert.deepEqual(shellReadPaths("cat /w/x/src/a.ts", ["/w/x"]), ["src/a.ts"]);
});

/** Stub agents (engine only): `explore` reads through Bash at a revision; the others report what they were handed. */
function handoffAgents(readRevision: () => string): StepExecutor {
  return {
    async execute(ctx) {
      if (ctx.step.key === "explore") {
        await ctx.recordMetrics({
          source_revision: { [repo]: { pinned: readRevision(), read: readRevision() } },
        });
        for (const command of [
          "sed -n '1,40p' src/workflow/engine.ts",
          "grep -n contract src/agent/contract.ts",
          "cat src/workflow/engine.ts",
        ])
          await ctx.log("tool", `Bash ${command}`, { name: "Bash", input: { command } });
        return { kind: "completed", output: { summary: "explored" } };
      }
      // Reported in metrics, not the output: an output naming paths would itself be a handoff to later steps.
      await ctx.recordMetrics({ handed_file_refs: ctx.context.fileRefs.map((f) => f.path) });
      return { kind: "completed", output: { summary: "planned" } };
    },
  };
}

async function handoffRun(read: string) {
  const key = await workflow([
    { key: "explore", type: "agent" },
    { key: "plan", type: "agent", depends_on: ["explore"] },
    { key: "verify", type: "agent", depends_on: ["plan"], config: { withhold: ["explore"] } },
  ]);
  const run = await startRun({
    definitionKey: key,
    repositories: [repo],
    ownerId: owner.id,
    start: false,
  });
  await q(pool, "UPDATE workflow_runs SET source_revisions=$2 WHERE id=$1", [
    run.id,
    JSON.stringify({ [repo]: { branch: "main", commit: c2 } }),
  ]);
  registerExecutor(
    "agent",
    handoffAgents(() => read),
  );
  const { startPendingRun } = await import("../src/workflow/engine.ts");
  await startPendingRun(run.id);
  assert.equal(await drive(run.id), "COMPLETED");
  const out = async (k: string) =>
    (await one<{ refs: string[] }>(
      pool,
      "SELECT a.metrics->'handed_file_refs' AS refs FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE s.run_id=$1 AND s.key=$2",
      [run.id, k],
    ))!.refs;
  return { runId: run.id, plan: await out("plan"), verify: await out("verify") };
}

test("the file handoff is reused at the same revision, dropped when gathered at another, and never crosses a withhold", async () => {
  const same = await handoffRun(c2);
  assert.deepEqual(same.plan.sort(), ["src/agent/contract.ts", "src/workflow/engine.ts"]);
  assert.deepEqual(
    same.verify,
    [],
    "the verifier withholds the explorer: none of its exploration reaches it",
  );

  const other = await handoffRun("0".repeat(40));
  assert.deepEqual(other.plan, [], "exploration at another revision is not handed on");
  const snap = await one<{ content: { prompt_plan: { file_refs_stale_attempts?: number[] } } }>(
    pool,
    `SELECT c.content FROM context_snapshots c JOIN workflow_step_attempts a ON a.context_snapshot_id = c.id
       JOIN workflow_steps s ON s.id = a.step_id WHERE s.run_id=$1 AND s.key='plan'`,
    [other.runId],
  );
  assert.equal(
    snap!.content.prompt_plan.file_refs_stale_attempts?.length,
    1,
    "the exclusion is recorded",
  );
});

// ---------------------------------------------------------------- cost budget policy

function spendingAgents(cost: number, seen: string[]): StepExecutor {
  return {
    async execute(ctx) {
      seen.push(ctx.step.key);
      await ctx.recordMetrics({ provider: "claude", model: "m", cost_usd: cost });
      return { kind: "completed", output: { summary: "ok" } };
    },
  };
}
async function budgetRun(action: "warn" | "pause", seen: string[]) {
  const saved = { ...config.costBudget };
  config.costBudget.action = action;
  registerExecutor("agent", spendingAgents(0.7, seen));
  const key = await workflow([
    { key: "one", type: "agent" },
    { key: "two", type: "agent", depends_on: ["one"] },
    { key: "three", type: "agent", depends_on: ["two"] },
  ]);
  const run = await startRun({ definitionKey: key, ownerId: owner.id, start: false });
  await q(pool, "UPDATE workflow_runs SET budget_usd = 1 WHERE id=$1", [run.id]);
  const { startPendingRun } = await import("../src/workflow/engine.ts");
  await startPendingRun(run.id);
  return { run, restore: () => Object.assign(config.costBudget, saved) };
}
const budgetEvents = (runId: number) =>
  q<{ content: string; data: Record<string, unknown> }>(
    pool,
    "SELECT content, data FROM workflow_events WHERE run_id=$1 AND kind='budget' ORDER BY id",
    [runId],
  );

test("budget 'warn' never blocks, and says so in the events and the cost API", async () => {
  const seen: string[] = [];
  const { run, restore } = await budgetRun("warn", seen);
  try {
    assert.equal(await drive(run.id), "COMPLETED");
    assert.deepEqual(seen, ["one", "two", "three"]);
    const ev = await budgetEvents(run.id);
    const exceeded = ev.find((e) => e.data.level === "exceeded")!;
    assert.match(exceeded.content, /warning only \(cost policy: warn\)/);
    assert.deepEqual([exceeded.data.action, exceeded.data.provider_hard_limit], ["warn", false]);
    const cost = (await runCost(run.id)) as unknown as {
      policy: { action: string; acknowledged: string[] };
    };
    assert.deepEqual([cost.policy.action, cost.policy.acknowledged], ["warn", []]);
  } finally {
    restore();
  }
});

test("budget 'pause' pauses before the next attempt until resumed; resuming acknowledges it (not paused again)", async () => {
  const seen: string[] = [];
  const { run, restore } = await budgetRun("pause", seen);
  try {
    assert.equal(await drive(run.id), "PAUSED");
    assert.deepEqual(seen, ["one", "two"], "the overrun (0.7 + 0.7 > 1) pauses before step three");
    const exceeded = (await budgetEvents(run.id)).find((e) => e.data.level === "exceeded")!;
    assert.match(exceeded.content, /run paused; resume to continue/);
    assert.equal(exceeded.data.action, "pause");
    // Nothing runs while paused, even when the scheduler is asked.
    await runOnce();
    assert.deepEqual(seen, ["one", "two"]);
    await resumeRun(run.id);
    assert.equal(await drive(run.id), "COMPLETED", "resume is the acknowledgement");
    assert.deepEqual(seen, ["one", "two", "three"]);
    const cost = (await runCost(run.id)) as unknown as { policy: { acknowledged: string[] } };
    assert.deepEqual(cost.policy.acknowledged, ["run"]);
  } finally {
    restore();
  }
});

test("a warning recorded under 'warn' is not an acknowledgement: after switching to 'pause' a retry pauses", async () => {
  const saved = { ...config.costBudget };
  config.costBudget.action = "warn";
  let attempts = 0;
  registerExecutor("agent", {
    async execute(ctx) {
      attempts++;
      await ctx.recordMetrics({ provider: "claude", model: "m", cost_usd: 0.7 });
      return attempts < 3
        ? { kind: "failed", error: "ECONNRESET while calling the provider" }
        : { kind: "completed", output: { summary: "ok" } };
    },
  });
  try {
    const key = await workflow([
      { key: "work", type: "agent", max_attempts: 3, retry_backoff_seconds: 0 },
    ]);
    const run = await startRun({ definitionKey: key, ownerId: owner.id, start: false });
    await q(pool, "UPDATE workflow_runs SET budget_usd = 0.5 WHERE id=$1", [run.id]);
    const { startPendingRun } = await import("../src/workflow/engine.ts");
    await startPendingRun(run.id);
    // Attempt 1 under "warn": the overrun and the projected retry are recorded as warnings, nothing pauses.
    for (let i = 0; i < 200 && attempts < 1; i++)
      if (!(await runOnce())) await new Promise((r) => setTimeout(r, 30));
    const warned = await budgetEvents(run.id);
    assert.ok(warned.some((e) => e.data.level === "exceeded" && e.data.action === "warn"));
    assert.ok(
      warned.some((e) => e.data.level === "preflight_projected" && e.data.action === "warn"),
    );
    // An admin switches to "pause". Attempt 2 was already queued; the projected overrun before attempt 3 must pause.
    config.costBudget.action = "pause";
    assert.equal(
      await drive(run.id),
      "PAUSED",
      "the earlier warnings did not count as the developer's acknowledgement",
    );
    assert.equal(attempts, 2);
    await resumeRun(run.id);
    assert.equal(await drive(run.id), "COMPLETED");
    assert.equal(attempts, 3);
  } finally {
    Object.assign(config.costBudget, saved);
  }
});

test("fixture repository state is untouched by the suite", () => {
  assert.ok(existsSync(join(primary, "local-notes.txt")));
});
