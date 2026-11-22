/**
 * Agent Harness efficiency (no wasted verification): a repair that changed nothing in the worktree cannot change a
 * deterministic verification result, so the loop stops as "no progress" without running the verification command
 * again. A repair that changed anything — or a workspace whose state cannot be established — is always re-verified.
 * Real git worktrees and the real verifyWorkspaces; only the verification command is a counting fake.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  sourceUnchangedSince,
  verificationLoop,
  verificationSummary,
  verifyWorkspaces,
  type VerifyConfig,
  type VerifyDeps,
} from "../src/agent/verify.ts";

before(() => migrate());
after(() => pool.end());

const CFG: VerifyConfig = {
  command: "make verify",
  maxRepairs: 3,
  timeoutMs: 60_000,
  baseline: null,
  allowTestWeakening: false,
};
const never = new AbortController().signal;
function worktree() {
  const wt = mkdtempSync(join(tmpdir(), "harness-eff-"));
  execFileSync("git", ["-C", wt, "init", "-q"]);
  writeFileSync(join(wt, "value.go"), "package v\nfunc Value() int { return 1 }\n");
  execFileSync("git", ["-C", wt, "add", "."]);
  execFileSync("git", [
    "-C",
    wt,
    "-c",
    "user.name=F",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  return wt;
}
const FAIL =
  "--- FAIL: TestValue (0.01s)\n    v_test.go:4: got 1 want 2\nFAIL\nFAIL\texample.com/v\t0.01s\n";
function counting(): { run: VerifyDeps["run"]; calls: () => number } {
  let n = 0;
  return { run: async () => (n++, { code: 1, output: FAIL, timedOut: false }), calls: () => n };
}

test("a repair that changed nothing stops as no progress without re-running the verification", async () => {
  const wt = worktree();
  const ws = [{ repo: "svc", path: wt }];
  const c = counting();
  let repairs = 0;
  const res = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) => verifyWorkspaces(ws, [wt], CFG, n, never, { run: c.run }),
    repair: async () => void repairs++, // the agent "repaired" without editing anything
    unchanged: (failed) => sourceUnchangedSince(ws, failed),
  });
  assert.equal(res.outcome, "no_progress");
  assert.equal(res.reason, "unchanged_source");
  assert.equal(repairs, 1);
  assert.equal(c.calls(), 1, "the verification command ran once, not again on identical source");
  const summary = verificationSummary(CFG, res);
  assert.equal(summary.passed, false, "a failure stays a failure");
  assert.equal(summary.stop_reason, "unchanged_source");
  console.log(
    `EFF-UNCHANGED ${JSON.stringify({ runs: c.calls(), outcome: res.outcome, reason: res.reason })}`,
  );
});

test("baseline behaviour without the check: the identical source is verified a second time", async () => {
  const wt = worktree();
  const ws = [{ repo: "svc", path: wt }];
  const c = counting();
  const res = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) => verifyWorkspaces(ws, [wt], CFG, n, never, { run: c.run }),
    repair: async () => undefined,
  });
  assert.equal(res.outcome, "no_progress");
  assert.equal(c.calls(), 2);
});

test("a repair that changed the source is always re-verified", async () => {
  const wt = worktree();
  const ws = [{ repo: "svc", path: wt }];
  const c = counting();
  let edit = 0;
  const res = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) => verifyWorkspaces(ws, [wt], CFG, n, never, { run: c.run }),
    repair: async () => {
      writeFileSync(join(wt, "value.go"), `package v\nfunc Value() int { return ${++edit + 1} }\n`);
      return undefined;
    },
    unchanged: (failed) => sourceUnchangedSince(ws, failed),
  });
  assert.equal(c.calls(), 2, "the changed source was verified again");
  assert.equal(res.outcome, "no_progress", "same failure signature after a real change");
  assert.equal(res.reason, undefined);
});

test("an untracked file counts as a change; an unknown tested state fails closed (re-verify)", async () => {
  const wt = worktree();
  const ws = [{ repo: "svc", path: wt }];
  const c = counting();
  const first = await verifyWorkspaces(ws, [wt], CFG, 1, never, { run: c.run });
  assert.equal(await sourceUnchangedSince(ws, first), true);
  writeFileSync(join(wt, "new_test.go"), "package v\n");
  assert.equal(await sourceUnchangedSince(ws, first), false);
  const unknown = { ...first, repos: first.repos.map((r) => ({ ...r, tested_state: undefined })) };
  assert.equal(await sourceUnchangedSince(ws, unknown), false);
  assert.equal(await sourceUnchangedSince([{ repo: "svc", path: join(wt, "gone") }], first), false);
});

// ---------------------------------------------------------------- rejected submissions (real engine + harness)

test("a submission rejected by the output contract is reported as CONTRACT_INVALID with the reason, not as 'never submitted'", async () => {
  const { chmodSync } = await import("node:fs");
  const { createUser } = await import("../src/auth/users.ts");
  const { definitions } = await import("../src/workflow/definitions.ts");
  const { startRun, getRun } = await import("../src/workflow/engine.ts");
  const { runOnce } = await import("../src/workflow/scheduler.ts");
  const { registerExecutor } = await import("../src/workflow/executors/registry.ts");
  const { agentExecutor } = await import("../src/agent/harness/executor.ts");
  const { one, q } = await import("../src/db/pool.ts");
  const root = process.env.TEST_ROOT!;
  const bin = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
  chmodSync(bin, 0o755);
  const script = join(root, "submit-invalid.mjs");
  writeFileSync(
    script,
    `export default async ({ call }) => {
  const r = await call("submit_result", { output: { summary: "done" } });
  if (!/output contract validation failed/.test(r)) throw new Error("expected a rejection: " + r);
  return null; // ends the turn without a valid submission
};`,
  );
  Object.assign(process.env, {
    CODEX_BIN: bin,
    FAKE_CODEX_MODE: "script",
    FAKE_CODEX_SCRIPT: script,
    FAKE_CODEX_LOG: join(root, "submit-invalid.jsonl"),
  });
  registerExecutor("agent", agentExecutor);
  const owner = await createUser({
    username: `eff-${Date.now()}`,
    password: "efficiency-pass",
    role: "member",
  });
  await definitions.create({
    key: "eff-contract",
    spec: {
      name: "contract",
      steps: [
        {
          key: "analyze",
          type: "agent",
          max_attempts: 2,
          config: { output_contract: "{ summary, hypotheses }" },
        },
      ],
    },
  });
  const run = await startRun({
    definitionKey: "eff-contract",
    agentProvider: "codex",
    ownerId: owner.id,
  });
  for (let i = 0; i < 40 && !["FAILED", "COMPLETED"].includes((await getRun(run.id)).status); i++)
    if (!(await runOnce())) await new Promise((r) => setTimeout(r, 100));
  const attempts = await q<{
    error: { message: string; details?: { failure_code?: string }; failure?: { class?: string } };
  }>(
    pool,
    "SELECT a.error FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE s.run_id = $1 ORDER BY a.id",
    [run.id],
  );
  assert.ok(attempts.length >= 1);
  const first = attempts[0].error;
  assert.equal(first.details?.failure_code, "CONTRACT_INVALID", JSON.stringify(first));
  assert.match(first.message, /hypotheses/);
  assert.doesNotMatch(first.message, /without calling submit_result/);
  const rejected = await one(
    pool,
    "SELECT data FROM workflow_checkpoints WHERE run_id = $1 AND reason = 'submit_rejected'",
    [run.id],
  );
  assert.ok(rejected, "the rejection is a durable checkpoint");
  assert.ok(
    !JSON.stringify(rejected).includes('"done"'),
    "the rejected output itself is not stored",
  );
  console.log(
    `EFF-CONTRACT ${JSON.stringify(attempts.map((a) => ({ code: a.error.details?.failure_code, class: a.error.failure?.class, message: a.error.message.slice(0, 160) })))}`,
  );
  for (const k of ["CODEX_BIN", "FAKE_CODEX_MODE", "FAKE_CODEX_SCRIPT", "FAKE_CODEX_LOG"])
    delete process.env[k];
});

// ---------------------------------------------------------------- Run #153: environment failures are not code failures

const NPM_CRASH =
  "npm error Exit handler never called!\nnpm error This is an error with npm itself. Please report this error at:\n";
function scripted(outputs: Array<{ code: number; output: string }>) {
  let n = 0;
  return {
    run: (async () => {
      const o = outputs[Math.min(n, outputs.length - 1)];
      n++;
      return { code: o.code, output: o.output, timedOut: false };
    }) as VerifyDeps["run"],
    calls: () => n,
  };
}

test("an unchanged repair still re-runs verification when the failure was not a parseable test failure", async () => {
  const wt = worktree();
  const ws = [{ repo: "svc", path: wt }];
  // A build/script failure without a recognisable test result, then a pass: e.g. a flaky install, now healthy.
  const c = scripted([
    { code: 1, output: "Error: Command failed: make build\n" },
    { code: 0, output: "ok  \texample.com/v\t0.01s\n" },
  ]);
  const res = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) => verifyWorkspaces(ws, [wt], CFG, n, never, { run: c.run }),
    repair: async () => undefined, // the agent changed nothing and resubmitted
    unchanged: (failed) => sourceUnchangedSince(ws, failed),
  });
  assert.equal(c.calls(), 2, "the gate ran again instead of stopping as 'no progress'");
  assert.equal(res.outcome, "passed");
});

test("Run #153: a crashed `npm ci` is retried once inside the round; never handed to the agent as a code failure", async () => {
  const wt = worktree();
  const ws = [{ repo: "svc", path: wt }];
  const logs: string[] = [];
  const once = scripted([
    { code: 1, output: NPM_CRASH },
    { code: 0, output: "ok  \texample.com/v\t0.01s\n" },
  ]);
  let repairs = 0;
  const healed = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) =>
      verifyWorkspaces(ws, [wt], CFG, n, never, {
        run: once.run,
        log: async (m) => void logs.push(m),
      }),
    repair: async () => void repairs++,
    unchanged: (failed) => sourceUnchangedSince(ws, failed),
  });
  assert.equal(healed.outcome, "passed");
  assert.equal(once.calls(), 2);
  assert.equal(repairs, 0, "no repair round was spent on the environment");
  assert.ok(
    logs.some((l) => /verification environment failed .*Exit handler never called/.test(l)),
  );

  const twice = scripted([{ code: 1, output: NPM_CRASH }]);
  const broken = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) => verifyWorkspaces(ws, [wt], CFG, n, never, { run: twice.run }),
    repair: async () => void repairs++,
    unchanged: (failed) => sourceUnchangedSince(ws, failed),
  });
  assert.equal(broken.outcome, "error", "an environment error, not a failure of the change");
  assert.equal(repairs, 0);
  assert.equal(twice.calls(), 2);
  assert.match(
    String(broken.rounds[0].repos[0].error),
    /verification environment failed twice .*not a code failure/,
  );
});
