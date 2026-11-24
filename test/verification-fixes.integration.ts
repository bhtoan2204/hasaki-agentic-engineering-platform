import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlatformGo } from "./fixtures/platformGo.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { config } from "../src/config.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { repositories } from "../src/repos/service.ts";
import { createUser } from "../src/auth/users.ts";
import { startRun, approveStep, cancelRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { agentExecutor as codingExecutor } from "../src/agent/harness/executor.ts";
import {
  commandExecutor,
  humanApprovalExecutor,
  integrationExecutor,
  prDescription,
  verificationNotesOf,
} from "../src/workflow/executors/builtin.ts";
import type { StepRow } from "../src/workflow/types.ts";

/**
 * The real engine and verification harness with a scripted agent (fake codex CLI, no model call) on a real Go
 * repository: root-cause verification sees a worktree the agent creates during its turn, a fix's regression test
 * goes through the required-test and repair-loop mechanisms, and the PR notes say when a fix was not proven.
 */
const repo = "verify-fixes";
const BASE = `package fixfix

const MaxRetries = 3

func Retries(n int) int {
	if n > MaxRetries {
		return MaxRetries
	}
	return n
}
`;
const FIXED = BASE.replace("= 3", "= 5");
const FIX_TEST = `package fixfix

import "testing"

func TestRetriesCapped(t *testing.T) {
	if Retries(10) != 5 {
		t.Fatal("retries are capped at five")
	}
}
`;
let ownerId: number;
let root: string;
let sequence = 0;
const runs: number[] = [];
const git = (path: string, ...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
let platformGo: Awaited<ReturnType<typeof startPlatformGo>> | undefined;

before(async () => {
  await migrate();
  platformGo = await startPlatformGo();
  await shareAllRepositoriesForTests();
  await seedTemplates();
  ownerId = (
    await createUser({ username: "verify-fixes", password: "test-password", role: "member" })
  ).id;
  root = mkdtempSync(join(tmpdir(), "verify-fixes-"));
  const primary = join(config.reposRoot, repo),
    origin = join(config.reposRoot, `${repo}.git`);
  mkdirSync(primary);
  git(primary, "init", "--bare", origin);
  git(primary, "init", "-b", "main");
  writeFileSync(join(primary, "go.mod"), "module fixfix\n\ngo 1.20\n");
  writeFileSync(join(primary, "retry.go"), BASE);
  writeFileSync(
    join(primary, "retry_test.go"),
    'package fixfix\n\nimport "testing"\n\nfunc TestSmall(t *testing.T) {\n\tif Retries(1) != 1 {\n\t\tt.Fatal("small values pass through")\n\t}\n}\n',
  );
  git(primary, "add", ".");
  git(primary, "commit", "-qm", "baseline");
  git(primary, "remote", "add", "origin", origin);
  git(primary, "push", "-u", "origin", "main");
  await repositories.upsert(repo, { projects: ["Runtime"], default_branch: "main" });
  Object.assign(process.env, {
    CODEX_BIN: join(import.meta.dirname, "fixtures", "fake-codex.mjs"),
    FAKE_CODEX_MODE: "script",
  });
  registerExecutor("coding_agent", codingExecutor);
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("integration", integrationExecutor);
  registerExecutor("command", commandExecutor);
  registerExecutor("agent", {
    async execute() {
      return {
        kind: "completed",
        output: {
          summary: "Cap the retries",
          changes: [{ repo, files: ["retry.go"], description: "Raise the cap" }],
          acceptance_criteria: ["Retries are capped at five"],
          tests: ["Exercise the cap"],
          required_tests: [],
          risks: [],
          alternatives: [],
        },
      };
    },
  });
});
after(async () => {
  platformGo?.stop();
  for (const id of runs) await cancelRun(id).catch(() => {});
  await settleBackground();
  for (const key of ["CODEX_BIN", "FAKE_CODEX_MODE", "FAKE_CODEX_SCRIPT"]) delete process.env[key];
  await pool.end();
});

interface Scenario {
  /** Regression test id on the first submission (undefined: none named). */
  test?: string;
  /** Regression test id after a repair prompt. */
  repairTest?: string;
  limitation?: string;
  depth?: "light" | "standard";
}
/** One agent turn: prepare_branch (the worktree appears now), commit the fix once, submit the remediation. */
function agent(s: Scenario, log: string) {
  const path = join(root, `agent-${++sequence}.mjs`);
  writeFileSync(
    path,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
export default async ({ call, prompt }) => {
  const prepared = await call("prepare_branch", { repo: ${JSON.stringify(repo)} });
  const path = /Work ONLY in: ([^\\n]+)/.exec(prepared)?.[1];
  if (!path) throw new Error(prepared);
  const repair = prompt.includes("## Verification failed");
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ repair, prompt }) + "\\n");
  if (!existsSync(path + "/fix_test.go")) {
    writeFileSync(path + "/retry.go", ${JSON.stringify(FIXED)});
    writeFileSync(path + "/fix_test.go", ${JSON.stringify(FIX_TEST)});
    const committed = await call("commit_changes", { repo: ${JSON.stringify(repo)}, message: "cap retries at five" });
    if (/ERROR:/.test(committed)) throw new Error(committed);
  }
  const s = ${JSON.stringify(s)};
  const name = repair && s.repairTest ? s.repairTest : s.test;
  return {
    outcome: "IMPLEMENTED", goal: "cap retries", requirements: ["cap"], summary: "raised the cap",
    changes: [], tests: [], pull_requests: {},
    remediation: {
      kind: "ROOT_CAUSE_FIX", root_cause: "the cap is too low", causal_link: "the cap is now five",
      ...(name ? { regression_test: { name, fails_before: true, passes_after: true } } : {}),
      ...(s.limitation ? { verification_limitations: s.limitation } : {}),
    },
  };
};
`,
  );
  process.env.FAKE_CODEX_SCRIPT = path;
}

async function fixRun(s: Scenario) {
  const log = join(root, `prompts-${sequence + 1}.jsonl`);
  writeFileSync(log, "");
  agent(s, log);
  const key = `verify-fixes-${sequence}`;
  await definitions.create({
    key,
    spec: {
      name: "Verified defect fix",
      steps: [
        { key: "design-change", type: "agent" },
        {
          key: "authorize-change",
          type: "human_approval",
          depends_on: ["design-change"],
          config: { show_outputs: ["design-change"] },
        },
        {
          key: "implement",
          type: "coding_agent",
          depends_on: ["authorize-change"],
          config: {
            root_cause_depth: s.depth ?? "standard",
            fallback: { mode: "disabled", providers: ["codex"], auto_health: false },
            verify: { command: "go test -json ./...", baseline: null },
          },
        },
        {
          key: "hold-publication",
          type: "human_approval",
          depends_on: ["implement"],
          config: { message: "Hold publication" },
        },
      ],
    },
  });
  const run = await startRun({
    definitionKey: key,
    title: "Retries are capped too low",
    profile: "STANDARD",
    ownerId,
    repositories: [repo],
    inputs: { risk: "low" },
    agentProvider: "codex",
  });
  runs.push(run.id);
  for (let i = 0; i < 8; i++) {
    await drain();
    const coding = (await one<StepRow>(
      pool,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND key='implement'",
      [run.id],
    ))!;
    if (["COMPLETED", "FAILED", "WAITING_INPUT"].includes(coding.status)) {
      const prompts = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { repair: boolean; prompt: string });
      const attempt = await one<{ metrics: { verification?: Record<string, unknown> } }>(
        pool,
        "SELECT metrics FROM workflow_step_attempts WHERE step_id=$1 ORDER BY id DESC LIMIT 1",
        [coding.id],
      );
      return { run, coding, prompts, verification: attempt?.metrics.verification };
    }
    for (const gate of await q<StepRow>(
      pool,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND status='WAITING_APPROVAL' AND key='authorize-change'",
      [run.id],
    ))
      await approveStep(run.id, gate.key, {});
  }
  throw new Error("the coding step did not settle");
}
interface FixOutput {
  regression_proof?: { status: string; reason: string };
  symptom_signals?: Record<string, Array<{ kind: string }>>;
  verification: { passed: boolean };
}
const out = (coding: StepRow) => coding.output as unknown as FixOutput;

test("a worktree created during the turn is found by the symptom-fix scan and the platform regression proof", async () => {
  const { coding } = await fixRun({ test: "fixfix/TestRetriesCapped" });
  assert.equal(coding.status, "COMPLETED", String(coding.error));
  assert.equal(
    out(coding).regression_proof?.status,
    "verified",
    String(out(coding).regression_proof?.reason),
  );
  assert.deepEqual(
    out(coding).symptom_signals?.[repo].map((x) => x.kind),
    ["limit_raised"],
  );
});

test("a malformed regression test id fails verification, is explained to the agent, and the corrected id is proven", async () => {
  const { run, coding, prompts, verification } = await fixRun({
    test: "TestRetriesCapped",
    repairTest: "fixfix/TestRetriesCapped",
  });
  assert.equal(coding.status, "COMPLETED", String(coding.error));
  assert.equal(verification?.repairs, 1, "one repair round fixed the id");
  const repair = prompts.find((p) => p.repair);
  assert.match(repair?.prompt ?? "", /Required test ownership could not be established/);
  assert.match(repair?.prompt ?? "", /test has no authorized repository owner/);
  assert.equal(out(coding).verification.passed, true);
  assert.equal(out(coding).regression_proof?.status, "verified");
  assert.deepEqual(await verificationNotesOf(run.id), [], "a proven fix needs no note");
});

test("a malformed regression test id that is never corrected cannot complete the step", async () => {
  const { coding, prompts } = await fixRun({ test: "TestRetriesCapped" });
  assert.equal(coding.status, "FAILED");
  assert.match(String(coding.error), /made no progress/);
  assert.match(String(coding.error), /Required test ownership could not be established/);
  assert.equal(prompts.filter((p) => p.repair).length, 1);
  assert.equal(coding.output, null, "a failed step records no accepted output");
});

test("light depth keeps its semantics: the named test is not required there", async () => {
  const { coding, verification } = await fixRun({ test: "TestRetriesCapped", depth: "light" });
  assert.equal(coding.status, "COMPLETED", String(coding.error));
  assert.equal(verification?.repairs, 0);
  assert.equal(out(coding).regression_proof, undefined);
});

test("a documented exception stays valid, and the PR notes say the fix was not proven", async () => {
  const limitation = "needs production traffic to reproduce";
  const { run, coding } = await fixRun({ limitation });
  assert.equal(coding.status, "COMPLETED", String(coding.error));
  assert.equal(out(coding).regression_proof, undefined);
  // The reviewer's documented limitation (root_cause_check) is carried too.
  await q(
    pool,
    `UPDATE workflow_steps SET status='COMPLETED', config = config || '{"independent": true}',
            output = '{"root_cause_check": {"limitations": "the cause is only probable"}}'
      WHERE run_id=$1 AND key='hold-publication'`,
    [run.id],
  );
  const notes = await verificationNotesOf(run.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].step, "implement");
  assert.match(notes[0].lines[0], /ROOT_CAUSE_FIX without a platform-verified regression proof/);
  assert.match(notes[0].lines[0], /no platform-run regression proof/);
  assert.deepEqual(notes[0].lines.slice(1), [
    `limitation documented by the implementer: ${limitation}`,
    "limitation documented by the reviewer: the cause is only probable",
  ]);
  const text = prDescription({
    runId: run.id,
    summary: "s",
    decisions: [],
    commits: "c",
    verificationNotes: notes,
  });
  assert.match(text, /## Verification notes/);
  assert.match(text, /do not establish that the root cause is fixed/);
});
