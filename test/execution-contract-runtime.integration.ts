import { pgEvidenceStore } from "../src/agent/verifyEvidence.ts";
import { before, after, test } from "node:test";
import { startPlatformGo } from "./fixtures/platformGo.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { indexRepository } from "../src/codeIntelligence/indexer.ts";
import { collectMicroEvidence } from "../src/workflow/microEvidence.ts";
import { config } from "../src/config.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { migrate } from "../src/db/migrate.ts";
import { materializeSubtasks, planHash, DecompositionPlan } from "../src/workflow/decomposition.ts";
import { withTx } from "../src/db/pool.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { applyProfile } from "../src/workflow/profiles.ts";
import { validateSpec } from "../src/workflow/graph.ts";
import {
  buildExecutionContract,
  executionContractProblems,
} from "../src/agent/executionContract.ts";
import { repositories } from "../src/repos/service.ts";
import { createUser } from "../src/auth/users.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import {
  startRun,
  approveStep,
  answerQuestions,
  reexecuteStep,
  retryStep,
  cancelRun,
  selectRepositories,
  requestProviderHandoff,
  resumeProviderHandoff,
} from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { agentExecutor as claudeExecutor } from "../src/agent/harness/executor.ts";
import {
  humanApprovalExecutor,
  integrationExecutor,
  commandExecutor,
  runVerificationCommand as runCommand,
} from "../src/workflow/executors/builtin.ts";
import { workspacesOf, prepareWorkspace } from "../src/git/provider.ts";
import { verifyPublication } from "../src/agent/publicationVerification.ts";
import type { ExecutionContext } from "../src/workflow/executors/registry.ts";
import type { StepRow } from "../src/workflow/types.ts";
import type { StepInput } from "../src/workflow/context.ts";

const repo = "contract-runtime";
let ownerId: number;
let sequence = 0;
let decompositionOutput: unknown;
let testSelectors = ["business/TestValue"];
let producerFeedback: string[] = [];
let fixSelectorsOnFeedback = false;
/** Overrides the value the fake implementation writes (null: the step's default). */
let lifecycleValue: string | null = null;
const runs: number[] = [];
const git = (path: string, ...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const step = (run: number, key = "implement") =>
  one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2", [run, key]);
let platformGo: Awaited<ReturnType<typeof startPlatformGo>> | undefined;
before(async () => {
  await migrate();
  // Code intelligence (indexing, search) runs only in platform-go, which is ready once the schema is migrated
  // (started here, not in a second root-level before hook: those run concurrently with this one).
  platformGo = await startPlatformGo();
  await shareAllRepositoriesForTests();
  await seedTemplates();
  ownerId = (
    await createUser({ username: "contract-runtime", password: "test-password", role: "member" })
  ).id;
  const primary = join(config.reposRoot, repo),
    origin = join(config.reposRoot, `${repo}.git`);
  mkdirSync(primary);
  git(primary, "init", "--bare", origin);
  git(primary, "init", "-b", "main");
  writeFileSync(join(primary, "go.mod"), "module business\n\ngo 1.20\n");
  writeFileSync(join(primary, "label.go"), 'package business\nconst Label = "old"\n');
  writeFileSync(join(primary, "value.go"), "package business\nfunc Value() int { return 1 }\n");
  writeFileSync(
    join(primary, "value_test.go"),
    'package business\nimport "testing"\nfunc TestValue(t *testing.T) { if Value() < 1 { t.Fatal("positive business value required") } }\n',
  );
  git(primary, "add", ".");
  git(primary, "commit", "-qm", "unchanged baseline");
  git(primary, "remote", "add", "origin", origin);
  git(primary, "push", "-u", "origin", "main");
  await repositories.upsert(repo, { projects: ["Runtime"], default_branch: "main" });
  process.env.CODEX_BIN = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
  process.env.FAKE_CODEX_MODE = "lifecycle";
  process.env.FAKE_LIFECYCLE_REPO = repo;
  registerExecutor("coding_agent", {
    async execute(ctx) {
      process.env.FAKE_LIFECYCLE_VALUE =
        lifecycleValue ?? (ctx.step.key === "implement-second" ? "3" : "2");
      return claudeExecutor.execute(ctx);
    },
  });
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("integration", integrationExecutor);
  registerExecutor("command", commandExecutor);
  registerExecutor("agent", {
    async execute(ctx) {
      if (ctx.step.key === "propose-work")
        return { kind: "completed", output: decompositionOutput };
      producerFeedback.push(String(ctx.input.pending?.feedback ?? ""));
      return {
        kind: "completed",
        output: {
          summary: "Preserve positive business value",
          changes: [{ repo, files: ["value.go"], description: "Update value" }],
          acceptance_criteria: ["Preserve positive values"],
          tests: ["Exercise the value behavior"],
          required_tests:
            fixSelectorsOnFeedback && ctx.input.pending?.feedback
              ? ["business/TestValue"]
              : testSelectors,
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
  await pool.end();
});

async function start(
  profile: "FAST" | "STANDARD" = "STANDARD",
  custom = false,
  multiple = false,
  handoff = true,
) {
  let definitionKey = "feature-implementation";
  if (custom) {
    definitionKey = `contract-custom-${++sequence}`;
    await definitions.create({
      key: definitionKey,
      spec: {
        name: "Custom approval workflow",
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
              fallback: {
                mode: handoff ? "manual" : "disabled",
                providers: ["codex", "copilot"],
                auto_health: false,
                allow_unknown_cost: true,
              },
              output_contract: "{goal, requirements}",
              verify: { command: "go test -json ./...", baseline: null },
            },
          },
          ...(multiple
            ? [
                {
                  key: "implement-second",
                  type: "coding_agent",
                  depends_on: ["implement"],
                  config: {
                    fallback: {
                      mode: handoff ? "manual" : "disabled",
                      providers: ["codex", "copilot"],
                      auto_health: false,
                      allow_unknown_cost: true,
                    },
                    output_contract: "{goal, requirements}",
                    verify: { command: "go test -json ./...", baseline: null },
                  },
                },
              ]
            : []),
          ...(multiple
            ? [
                {
                  key: "regression",
                  type: "command",
                  depends_on: ["implement-second"],
                  config: { command: "go test -json ./...", timeout_seconds: 60 },
                },
              ]
            : []),
          {
            key: "hold-publication",
            type: "human_approval",
            depends_on: [multiple ? "regression" : "implement"],
            config: { message: "Hold publication for runtime evidence checks" },
          },
        ],
      },
    });
  }
  const run = await startRun({
    definitionKey,
    title: "Update the display value",
    profile,
    ownerId,
    repositories: [repo],
    inputs: { risk: "low" },
    agentProvider: "codex",
  });
  runs.push(run.id);
  return run;
}
async function reachCoding(id: number) {
  for (let i = 0; i < 8; i++) {
    await drain();
    const waiting = await q<StepRow>(
      pool,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND status='WAITING_APPROVAL' ORDER BY position",
      [id],
    );
    const coding = await step(id);
    if (["COMPLETED", "FAILED", "WAITING_INPUT"].includes(coding?.status ?? "")) return coding!;
    for (const gate of waiting)
      if (gate.type === "human_approval")
        await approveStep(
          id,
          gate.key,
          gate.config.select_repositories ? { repositories: [repo] } : {},
        );
  }
  throw new Error("Coding was not reached");
}

test("all built-in coding graphs bind their actual approvals and folded profiles", () => {
  for (const template of TEMPLATES)
    for (const profile of ["STANDARD", "DEEP", "FAST", "MICRO"] as const) {
      let graph;
      try {
        graph = applyProfile(validateSpec(template.spec), profile).spec;
      } catch {
        continue;
      }
      for (const coding of graph.steps.filter((s) => s.type === "coding_agent")) {
        const upstream = Object.fromEntries(
          graph.steps
            .filter((s) => s.key !== coding.key)
            .map((s, i) => [
              s.key,
              {
                status: "COMPLETED",
                attempt_id: i + 1,
                output:
                  s.type === "human_approval"
                    ? { approved: true }
                    : {
                        summary: "Concrete planned change",
                        acceptance_criteria: ["Preserve behavior"],
                        verification_strategy: ["Check behavior"],
                      },
              },
            ]),
        );
        const contract = buildExecutionContract(upstream, [repo], null, {
          graph,
          step: coding,
          definition_version_id: 1,
          profile,
          request: { title: "Preserve behavior" },
        });
        assert.deepEqual(
          executionContractProblems(contract, [repo]),
          [],
          `${template.key}/${profile}/${coding.key}`,
        );
        assert.deepEqual(contract.required_tests, [], "strategies never become selectors");
      }
    }
});

test("actual built-in FAST graph implements from a clean baseline and keeps mandatory verification", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "edit";
  const run = await start("FAST");
  assert.equal(run.profile, "FAST");
  const coding = await reachCoding(run.id);
  assert.equal(
    coding.status,
    "COMPLETED",
    JSON.stringify({
      error: coding.error,
      logs: await q(
        pool,
        "SELECT content FROM workflow_artifacts WHERE run_id=$1 AND kind='log' ORDER BY id DESC LIMIT 2",
        [run.id],
      ),
    }),
  );
  assert.equal(coding.output.outcome, "IMPLEMENTED");
  assert.equal(coding.output.verification.passed, true);
  const [workspace] = await workspacesOf(run.id);
  assert.match(readFileSync(join(workspace.path, "value.go"), "utf8"), /return 2/);
  const evidence = coding.output.implementation_evidence;
  assert.notEqual(evidence.baseline[repo].content, evidence.observed[repo].content);
  assert.equal(coding.output.execution_contract.authorization.mode, "workflow");
  const live = (await one(pool, "SELECT * FROM workflow_runs WHERE id=$1", [run.id]))!;
  const rows = await q<StepRow>(
    pool,
    "SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY position",
    [run.id],
  );
  const ctx = {
    run: live,
    signal: new AbortController().signal,
    artifact: async () => 1,
    log: async () => {},
  } as unknown as ExecutionContext;
  assert.deepEqual(
    (await verifyPublication(ctx, rows, await workspacesOf(run.id), runCommand)).problems,
    [],
  );
});

test("custom graph approval, waiting/resume, retry and generation invalidation keep the correct contract and evidence", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "ask";
  const run = await start("STANDARD", true);
  let coding = await reachCoding(run.id);
  assert.equal(
    coding.status,
    "WAITING_INPUT",
    JSON.stringify({
      error: coding.error,
      logs: await q(
        pool,
        "SELECT content FROM workflow_artifacts WHERE run_id=$1 AND kind='log' ORDER BY id DESC LIMIT 2",
        [run.id],
      ),
    }),
  );
  const first = await one<{ input: StepInput }>(
    pool,
    "SELECT input FROM workflow_step_attempts WHERE id=$1",
    [coding.current_attempt_id],
  );
  assert.equal(first!.input.execution_contract?.provenance?.plan_step, "design-change");
  assert.equal(first!.input.execution_contract?.provenance?.approval_step, "authorize-change");
  process.env.FAKE_LIFECYCLE_ACTION = "noop";
  const questions = await q<{ id: number }>(
    pool,
    "SELECT id FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [run.id],
  );
  await answerQuestions(
    Object.fromEntries(questions.map((question) => [question.id, "Yes"])),
    "tester",
  );
  await drain();
  coding = (await step(run.id))!;
  assert.equal(
    coding.status,
    "COMPLETED",
    JSON.stringify({
      error: coding.error,
      logs: await q(
        pool,
        "SELECT content FROM workflow_artifacts WHERE run_id=$1 AND kind='log' ORDER BY id DESC LIMIT 2",
        [run.id],
      ),
    }),
  );
  assert.deepEqual(coding.output.execution_contract, first!.input.execution_contract);
  assert.equal(coding.output.verification.passed, true);
  await reexecuteStep(run.id, "implement");
  await drain();
  coding = (await step(run.id))!;
  assert.equal(coding.status, "FAILED", "a new generation cannot claim earlier implementation");
  await retryStep(run.id, "implement");
  await drain();
  coding = (await step(run.id))!;
  assert.equal(coding.status, "FAILED", "retry cannot manufacture a change");
});

test("pre-existing branch changes and an unchanged provider submission cannot establish IMPLEMENTED", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "noop";
  const run = await start("STANDARD", true);
  const workspace = await prepareWorkspace(run, repo);
  writeFileSync(join(workspace.path, "pre-existing.txt"), "Existing branch implementation\n");
  git(workspace.path, "add", ".");
  git(workspace.path, "commit", "-qm", "pre-existing work");
  const coding = await reachCoding(run.id);
  assert.equal(coding.status, "FAILED");
  assert.match(
    JSON.stringify({
      error: coding.error,
      logs: await q(
        pool,
        "SELECT content FROM workflow_artifacts WHERE run_id=$1 AND kind='log' ORDER BY id DESC LIMIT 2",
        [run.id],
      ),
    }),
    /IMPLEMENTED requires worker-observed implementation/,
  );
});

test("multiple implementation steps retain historical evidence while final publication tests the integrated revision", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "edit";
  const run = await start("STANDARD", true, true);
  const first = await reachCoding(run.id);
  await drain();
  const second = (await step(run.id, "implement-second"))!;
  assert.equal(first.status, "COMPLETED", JSON.stringify(first.error));
  assert.equal(second.status, "COMPLETED", JSON.stringify(second.error));
  assert.notEqual(
    first.output.verification.last[0].tested_state.head,
    second.output.verification.last[0].tested_state.head,
  );
  const [integrated] = await workspacesOf(run.id);
  const primary = join(config.reposRoot, repo);
  writeFileSync(join(primary, "base-change.txt"), "New base revision\n");
  git(primary, "add", ".");
  git(primary, "commit", "-qm", "upstream base change");
  git(primary, "push", "origin", "main");
  git(integrated.path, "fetch", "origin");
  git(integrated.path, "rebase", "origin/main");
  assert.notEqual(
    git(integrated.path, "rev-parse", "HEAD"),
    second.output.verification.last[0].tested_state.head,
  );
  const live = (await one(pool, "SELECT * FROM workflow_runs WHERE id=$1", [run.id]))!;
  const steps = await q<StepRow>(
    pool,
    "SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY position",
    [run.id],
  );
  const ctx = {
    run: live,
    signal: new AbortController().signal,
    artifact: async () => 1,
    log: async () => {},
  } as unknown as ExecutionContext;
  const result = await verifyPublication(ctx, steps, await workspacesOf(run.id), runCommand);
  assert.deepEqual(result.problems, []);
  assert.equal(result.tested.length, 3);
  assert.ok(result.tested.some((t) => t.step === "publication:regression"));
  assert.equal(result.tested[0].heads[repo], result.tested[1].heads[repo]);
});

test("generated isolated subtasks inherit the approved graph binding and verify their own worktree before integration", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "edit";
  const key = `contract-decomposed-${++sequence}`;
  await definitions.create({
    key,
    spec: {
      name: "Generated coding",
      steps: [
        { key: "propose-work", type: "agent" },
        {
          key: "authorize-work",
          type: "human_approval",
          depends_on: ["propose-work"],
          config: { show_outputs: ["propose-work"] },
        },
        { key: "expansion-ready", type: "human_approval", depends_on: ["authorize-work"] },
        {
          key: "integrate",
          type: "integration",
          depends_on: ["propose-work", "authorize-work", "expansion-ready"],
          config: { action: "integrate_subtasks" },
        },
        { key: "hold", type: "human_approval", depends_on: ["integrate"] },
      ],
    },
  });
  const plan = DecompositionPlan.parse({
    summary: "Generated change",
    subtasks: [
      {
        id: "value",
        title: "Change value",
        description: "Update value",
        objective: "Value remains positive",
        expected_output: "Updated value",
        acceptance_criteria: ["Positive value"],
        target_repos: [repo],
        owned_files: ["value.go"],
        risk: "low",
        execution_strategy: "parallel",
      },
    ],
  });
  decompositionOutput = plan;
  const run = await startRun({
    definitionKey: key,
    title: "Generated value change",
    ownerId,
    repositories: [repo],
    profile: "STANDARD",
    agentProvider: "codex",
  });
  runs.push(run.id);
  await drain();
  await approveStep(run.id, "authorize-work", {
    by: "tester",
    data: { plan_hash: planHash(plan) },
  });
  await withTx(async (c) => {
    await materializeSubtasks(c, run.id, "propose-work", plan, {
      actor: "tester",
      reason: "approved generated task",
      allowedRepositories: [repo],
      isolatedWorkspaces: true,
    });
  });
  await prepareWorkspace(run, repo);
  await drain();
  const generated = (await step(run.id, "subtask-value"))!;
  assert.equal(generated.status, "COMPLETED", JSON.stringify(generated.error));
  assert.ok(generated.depends_on.includes("authorize-work"));
  assert.equal(generated.output.execution_contract.provenance.approval_step, "authorize-work");
  await approveStep(run.id, "expansion-ready");
  await drain();
  const integration = (await step(run.id, "integrate"))!;
  assert.equal(integration.status, "COMPLETED", JSON.stringify(integration.error));
  const [workspace] = await workspacesOf(run.id);
  assert.match(readFileSync(join(workspace.path, "value.go"), "utf8"), /return 2/);
  assert.notEqual(generated.output.implementation_evidence.observed[repo].path, workspace.path);
});

test("actual MICRO admission, provider implementation and verification reach diff approval without an upstream plan gate", async () => {
  const prior = config.codeIntelligence.enabled;
  config.codeIntelligence.enabled = true;
  try {
    const microRepo = "contract-micro",
      primary = join(config.reposRoot, microRepo),
      origin = join(config.reposRoot, `${microRepo}.git`);
    mkdirSync(join(primary, "src"), { recursive: true });
    mkdirSync(join(primary, "test"));
    git(primary, "init", "--bare", origin);
    git(primary, "init", "-b", "main");
    writeFileSync(join(primary, "src/label.ts"), 'export const label = "old";\n');
    writeFileSync(join(primary, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(primary, "package.json"),
      JSON.stringify({ scripts: { test: "node --test test/label.test.mjs" } }),
    );
    writeFileSync(
      join(primary, "test/label.test.mjs"),
      `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('label vocabulary', () => {
  const source = readFileSync(new URL('../src/label.ts', import.meta.url), 'utf8');
  assert.match(source, /old|new/);
});
`,
    );
    git(primary, "add", ".");
    git(primary, "commit", "-qm", "micro baseline");
    git(primary, "remote", "add", "origin", origin);
    git(primary, "push", "-u", "origin", "main");
    await repositories.upsert(microRepo, { projects: ["MicroRuntime"], default_branch: "main" });
    await indexRepository(microRepo);
    assert.equal((await collectMicroEvidence(microRepo, ["src/label.ts"], 0))?.impactKnown, true);
    process.env.FAKE_LIFECYCLE_ACTION = "label";
    process.env.FAKE_LIFECYCLE_REPO = microRepo;
    process.env.FAKE_LIFECYCLE_SOURCE = "src/label.ts";
    const run = await startRun({
      definitionKey: "micro-change",
      title: "Fix label typo",
      profile: "MICRO",
      ownerId,
      repositories: [microRepo],
      inputs: { risk: "low", files: ["src/label.ts"] },
      agentProvider: "codex",
    });
    runs.push(run.id);
    assert.equal(run.profile, "MICRO");
    await drain();
    const coding = (await step(run.id))!;
    assert.equal(coding.status, "COMPLETED", JSON.stringify(coding.error));
    assert.equal(coding.output.verification.passed, true);
    assert.equal(coding.output.execution_contract.authorization.mode, "workflow");
    assert.equal((await step(run.id, "approve_diff"))!.status, "WAITING_APPROVAL");
  } finally {
    config.codeIntelligence.enabled = prior;
    process.env.FAKE_LIFECYCLE_REPO = repo;
    delete process.env.FAKE_LIFECYCLE_SOURCE;
  }
});

test("invalid required test specifications go back to the producer, then fail before the human approval decision", async () => {
  testSelectors = ["describe the regression strategy"];
  producerFeedback = [];
  try {
    const run = await start("STANDARD", true);
    await drain();
    const gate = (await step(run.id, "authorize-change"))!;
    assert.equal(gate.status, "FAILED");
    assert.match(JSON.stringify(gate.error), /Invalid required tests before approval/);
    assert.equal(producerFeedback.length, 3, "two repair rounds, then stop");
    assert.match(producerFeedback[1], /invalid executable test selector[\s\S]*regression_tests/);
    assert.equal(
      (
        await q(
          pool,
          "SELECT id FROM workflow_step_attempts WHERE step_id=(SELECT id FROM workflow_steps WHERE run_id=$1 AND key='implement')",
          [run.id],
        )
      ).length,
      0,
    );
  } finally {
    testSelectors = ["business/TestValue"];
  }
});

test("a producer that fixes its required tests after feedback reaches the human approval decision", async () => {
  testSelectors = ["describe the regression strategy"];
  producerFeedback = [];
  fixSelectorsOnFeedback = true;
  try {
    const run = await start("STANDARD", true);
    await drain();
    assert.equal((await step(run.id, "authorize-change"))!.status, "WAITING_APPROVAL");
    assert.equal(producerFeedback.length, 2);
  } finally {
    fixSelectorsOnFeedback = false;
    testSelectors = ["business/TestValue"];
  }
});

test("repository selection drift cannot replace the contract on resume or reuse an earlier approval in a new generation", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "ask";
  const run = await start("STANDARD", true);
  let coding = await reachCoding(run.id);
  const pinned = (await one(
    pool,
    "SELECT input->'execution_contract' AS contract FROM workflow_step_attempts WHERE id=$1",
    [coding.current_attempt_id],
  ))!.contract;
  await selectRepositories(run.id, []);
  const questions = await q<{ id: number }>(
    pool,
    "SELECT id FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [run.id],
  );
  await answerQuestions(
    Object.fromEntries(questions.map((question) => [question.id, "Yes"])),
    "tester",
  );
  process.env.FAKE_LIFECYCLE_ACTION = "noop";
  await drain();
  coding = (await step(run.id))!;
  assert.equal(coding.status, "FAILED");
  assert.match(JSON.stringify(coding.error), /renewed authorization|renewed approval/);
  const resumed = (await one(
    pool,
    "SELECT input->'execution_contract' AS contract FROM workflow_step_attempts WHERE id=$1",
    [coding.current_attempt_id],
  ))!.contract;
  assert.deepEqual(resumed, pinned);
});

test("a retry and a provider handoff preserve implementation already observed in the same generation", async () => {
  for (const continuation of ["retry", "handoff"]) {
    process.env.FAKE_LIFECYCLE_ACTION = "fail-after-edit";
    const run = await start("STANDARD", true, false, continuation === "handoff");
    let coding = await reachCoding(run.id);
    assert.equal(coding.status, continuation === "handoff" ? "WAITING_INPUT" : "FAILED");
    const original = (await one(
      pool,
      "SELECT input->'execution_contract' AS contract FROM workflow_step_attempts WHERE id=$1",
      [coding.current_attempt_id],
    ))!.contract;
    process.env.FAKE_LIFECYCLE_ACTION = "noop";
    if (continuation === "retry") await retryStep(run.id, "implement");
    else {
      process.env.COPILOT_BIN = join(import.meta.dirname, "fixtures", "fake-copilot.mjs");
      process.env.FAKE_COPILOT_MODE = "ok";
      setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
      const handoff = await requestProviderHandoff(
        run.id,
        "implement",
        {
          expected_attempt_id: coding.current_attempt_id,
          reason: "Continue observed implementation",
        },
        ownerId,
      );
      assert.equal(handoff.status, "READY", JSON.stringify(handoff));
      await resumeProviderHandoff(
        run.id,
        "implement",
        {
          handoff_id: handoff.id,
          expected_attempt_id: coding.current_attempt_id,
          provider: "copilot",
          model: null,
          confirm: true,
          checkpoint_fingerprint: handoff.workspace_fingerprint,
        },
        ownerId,
      );
    }
    try {
      await drain();
      coding = (await step(run.id))!;
      assert.equal(coding.status, "COMPLETED", JSON.stringify(coding.error));
      assert.equal(coding.output.verification.passed, true);
      assert.deepEqual(coding.output.execution_contract, original);
      assert.notEqual(
        coding.output.implementation_evidence.baseline[repo].content,
        coding.output.implementation_evidence.observed[repo].content,
      );
    } finally {
      setHandoffReadinessForTests(undefined);
    }
  }
});

test("a re-execution or retry keeps implementation observed in an earlier generation that never completed", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "fail-after-edit";
  const run = await start("STANDARD", true, false, false);
  let coding = await reachCoding(run.id);
  assert.equal(coding.status, "FAILED");
  process.env.FAKE_LIFECYCLE_ACTION = "noop";
  await reexecuteStep(run.id, "implement");
  await drain();
  coding = (await step(run.id))!;
  assert.equal(coding.status, "COMPLETED", JSON.stringify(coding.error));
  assert.notEqual(
    coding.output.implementation_evidence.baseline[repo].content,
    coding.output.implementation_evidence.observed[repo].content,
  );
  await reexecuteStep(run.id, "implement");
  await drain();
  coding = (await step(run.id))!;
  assert.equal(coding.status, "FAILED", "accepted implementation cannot be claimed again");
  await retryStep(run.id, "implement");
  await drain();
  coding = (await step(run.id))!;
  assert.equal(
    coding.status,
    "FAILED",
    "accepted implementation cannot be claimed by a retry either",
  );
});

test("a repair round sent back with feedback may make no new changes; a plain re-execution still may not", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "edit";
  const run = await start("STANDARD", true, false, false);
  let coding = await reachCoding(run.id);
  assert.equal(coding.status, "COMPLETED", JSON.stringify(coding.error));
  process.env.FAKE_LIFECYCLE_ACTION = "noop";
  await reexecuteStep(run.id, "implement", { feedback: "Tests failed: investigate" });
  await drain();
  coding = (await step(run.id))!;
  assert.equal(coding.status, "COMPLETED", JSON.stringify(coding.error));
  assert.equal(coding.output.no_new_changes, true);
  process.env.FAKE_LIFECYCLE_ACTION = "fail-after-edit";
  await reexecuteStep(run.id, "implement", { feedback: "Tests failed again: investigate" });
  await drain();
  assert.equal((await step(run.id))!.status, "FAILED");
  process.env.FAKE_LIFECYCLE_ACTION = "noop";
  await retryStep(run.id, "implement");
  await drain();
  coding = (await step(run.id))!;
  assert.equal(
    coding.status,
    "COMPLETED",
    "a retry of a failed repair round is still a repair round",
  );
  await reexecuteStep(run.id, "implement");
  await drain();
  assert.equal((await step(run.id))!.status, "FAILED");
});

test("final publication reuses only fully bound verification evidence on the integrated revision", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "edit";
  const run = await start("STANDARD", true, true);
  await reachCoding(run.id);
  await drain();
  const second = (await step(run.id, "implement-second"))!;
  assert.equal(second.status, "COMPLETED", JSON.stringify(second.error));
  const [integrated] = await workspacesOf(run.id);
  assert.equal(
    git(integrated.path, "rev-parse", "HEAD"),
    second.output.verification.last[0].tested_state.head,
  );
  const live = (await one(pool, "SELECT * FROM workflow_runs WHERE id=$1", [run.id]))!;
  const steps = await q<StepRow>(
    pool,
    "SELECT * FROM workflow_steps WHERE run_id=$1 ORDER BY position",
    [run.id],
  );
  const logs: string[] = [];
  const commands: string[] = [];
  const ctx = {
    run: live,
    signal: new AbortController().signal,
    artifact: async () => 1,
    log: async (_kind: string, text: string) => void logs.push(text),
  } as unknown as ExecutionContext;
  const counting: typeof runCommand = (command, ...rest) => (
    commands.push(command),
    runCommand(command, ...rest)
  );
  const sideEffect = "echo publish-side-effect";
  const withSideEffect = [...steps, {
    ...second, key: "external-effect", type: "command" as const,
    config: { command: sideEffect }, status: "COMPLETED" as const,
    output: { tested_heads: { [integrated.repo]: git(integrated.path, "rev-parse", "HEAD") } },
  }];
  const result = await verifyPublication(ctx, withSideEffect, await workspacesOf(run.id), counting, pgEvidenceStore(pool));
  assert.ok(!commands.includes(sideEffect), "publication never invokes unrelated command steps");
  assert.deepEqual(result.problems, []);
  assert.ok(
    logs.some((l) => /reused evidence/.test(l)),
    logs.join("\n"),
  );
  assert.ok(result.tested.some((t) => t.step === "publication:implement-second"));
  // The first implementation step passed on an older commit, so it alone is re-verified on the integrated revision.
  assert.ok(commands.length > 0, "an older revision still requires verification");
  writeFileSync(join(integrated.path, "uncommitted.txt"), "changed after verification\n");
  const logsAfter: string[] = [];
  const dirty = await verifyPublication(
    {
      ...ctx,
      log: async (_k: string, text: string) => void logsAfter.push(text),
    } as unknown as ExecutionContext,
    steps,
    await workspacesOf(run.id),
    runCommand,
    pgEvidenceStore(pool),
  );
  assert.ok(!logsAfter.some((l) => /reused evidence/.test(l)), "an uncommitted change forces a rerun");
  void dirty;
});

test("a repair that changes nothing stops the verify loop without re-running the tests (real harness and engine)", async () => {
  process.env.FAKE_LIFECYCLE_ACTION = "edit";
  process.env.FAKE_LIFECYCLE_REPAIR = "noop";
  lifecycleValue = "0"; // Value() returns 0: TestValue fails
  try {
    const run = await start("FAST");
    const coding = await reachCoding(run.id);
    assert.equal(coding.status, "FAILED");
    assert.match(String(coding.error), /the repair changed no source; verification was not re-run/);
    const attempt = (await one<{ metrics: { verification?: Record<string, unknown> } }>(
      pool,
      "SELECT metrics FROM workflow_step_attempts WHERE step_id = $1 ORDER BY id DESC LIMIT 1",
      [coding.id],
    ))!;
    const v = attempt.metrics.verification!;
    assert.deepEqual([v.rounds, v.repairs, v.stop_reason], [1, 1, "unchanged_source"]);
    const decision = await one<{ action: string; reason: string }>(
      pool,
      "SELECT action, reason FROM execution_decisions WHERE run_id = $1 AND kind = 'recovery' AND action = 'STOP' ORDER BY id LIMIT 1",
      [run.id],
    );
    assert.match(String(decision?.reason), /changed no source/);
    console.log(`EFF-E2E ${JSON.stringify({ run_id: run.id, verification: v, decision })}`);
  } finally {
    lifecycleValue = null;
    delete process.env.FAKE_LIFECYCLE_REPAIR;
  }
});
