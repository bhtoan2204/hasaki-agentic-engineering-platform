import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlatformGo } from "./fixtures/platformGo.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { config } from "../src/config.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { repositories } from "../src/repos/service.ts";
import { createUser } from "../src/auth/users.ts";
import { startRun, approveStep, cancelRun, listCodeScans } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor, type StepExecutor } from "../src/workflow/executors/registry.ts";
import { agentExecutor } from "../src/agent/harness/executor.ts";
import {
  commandExecutor,
  humanApprovalExecutor,
  integrationExecutor,
} from "../src/workflow/executors/builtin.ts";
import type { StepRow } from "../src/workflow/types.ts";

/**
 * The codebase-improvement workflow end to end on the real engine and harness: scripted agents (fake codex CLI, no
 * model call) on a real Go repository whose Contains() allocates on every call. Deterministic steps (blast radius,
 * verification, regression proof, regression tests, impact, proof) run for real.
 */
const repo = "codebase-improve";
const SLOW = `package improve

import "strings"

// Contains reports whether id is one of ids.
func Contains(ids []string, id string) bool {
	return strings.Contains(","+strings.Join(ids, ",")+",", ","+id+",")
}
`;
const FAST = `package improve

// Contains reports whether id is one of ids.
func Contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}
`;
const BROKEN = FAST.replace("return true", "return false");
const ALLOC_TEST = `package improve

import "testing"

func TestContainsDoesNotAllocate(t *testing.T) {
	ids := []string{"a", "b", "c", "d"}
	if a := testing.AllocsPerRun(50, func() { _ = Contains(ids, "d") }); a != 0 {
		t.Fatalf("Contains allocates %.0f times per call; budget 0", a)
	}
}
`;
const BEHAVIOUR_TEST = `package improve

import "testing"

func TestContains(t *testing.T) {
	if !Contains([]string{"a", "b", "c"}, "b") || Contains([]string{"a"}, "z") {
		t.Fatal("membership is wrong")
	}
}
`;
let ownerId: number;
let root: string;
let baseSha: string;
let sequence = 0;
const runs: number[] = [];
const scripts: Record<string, string> = {};
const git = (path: string, ...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
let platformGo: Awaited<ReturnType<typeof startPlatformGo>> | undefined;

const scripted: StepExecutor = {
  async execute(ctx) {
    const script = scripts[ctx.step.key];
    if (!script) throw new Error(`no scripted agent for ${ctx.step.key}`);
    process.env.FAKE_CODEX_SCRIPT = script;
    return agentExecutor.execute(ctx);
  },
};

before(async () => {
  await migrate();
  platformGo = await startPlatformGo();
  await shareAllRepositoriesForTests();
  await seedTemplates();
  ownerId = (
    await createUser({ username: "codebase-improve", password: "test-password", role: "member" })
  ).id;
  root = mkdtempSync(join(tmpdir(), "codebase-improve-"));
  const primary = join(config.reposRoot, repo),
    origin = join(config.reposRoot, `${repo}.git`);
  mkdirSync(primary);
  git(primary, "init", "--bare", origin);
  git(primary, "init", "-b", "main");
  writeFileSync(join(primary, "go.mod"), "module improve\n\ngo 1.20\n");
  writeFileSync(join(primary, "ids.go"), SLOW);
  writeFileSync(join(primary, "ids_test.go"), BEHAVIOUR_TEST);
  git(primary, "add", ".");
  git(primary, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "baseline");
  git(primary, "remote", "add", "origin", origin);
  git(primary, "push", "-u", "origin", "main");
  baseSha = git(primary, "rev-parse", "HEAD");
  await repositories.upsert(repo, { projects: ["Improve"], default_branch: "main" });
  Object.assign(process.env, {
    CODEX_BIN: join(import.meta.dirname, "fixtures", "fake-codex.mjs"),
    FAKE_CODEX_MODE: "script",
  });
  registerExecutor("agent", scripted);
  registerExecutor("coding_agent", scripted);
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("integration", integrationExecutor);
  registerExecutor("command", commandExecutor);
});
after(async () => {
  platformGo?.stop();
  for (const id of runs) await cancelRun(id).catch(() => {});
  await settleBackground();
  for (const key of ["CODEX_BIN", "FAKE_CODEX_MODE", "FAKE_CODEX_SCRIPT"]) delete process.env[key];
  await pool.end();
});

function script(name: string, body: string) {
  const path = join(root, `${name}-${++sequence}.mjs`);
  writeFileSync(path, body);
  return path;
}
const CLAIMS = () => [
  {
    id: "F1",
    claim: "Contains joins every id into a new string on each call (heap allocation per lookup)",
    classification: "CODE_FACT",
    repository: repo,
    commit: baseSha,
    file_path: "ids.go",
    line_range: "6-8",
    confidence: "high",
    verification_status: "verified",
  },
  {
    id: "R1",
    claim: "The per-call allocation comes from building the joined string in Contains",
    classification: "CONFIRMED_ROOT_CAUSE",
    supports: ["F1"],
    confidence: "high",
    verification_status: "verified",
  },
];
const ROOT = {
  status: "CONFIRMED",
  confidence: "high",
  explanation: "The code at ids.go:6-8 allocates on every call.",
  supporting_claims: ["R1", "F1"],
};
const returns = (output: unknown) => `export default async () => (${JSON.stringify(output)});`;

function assessAgent(decision: "IMPROVE" | "NO_CHANGES_NEEDED") {
  scripts.assess = script(
    "assess",
    returns(
      decision === "IMPROVE"
        ? {
            decision,
            summary: "Contains allocates on every lookup",
            findings: [
              {
                id: "P1",
                kind: "PERFORMANCE",
                severity: "medium",
                repo,
                file: "ids.go",
                line: 7,
                issue: "a heap allocation per membership check",
                evidence: "F1",
                implementable: true,
              },
            ],
            selected: {
              finding_id: "P1",
              kind: "PERFORMANCE",
              expected_benefit: "0 allocations per call",
            },
            target: { repo, files: ["ids.go"], symbols: ["Contains"] },
            coverage: { inspected: ["ids.go"], signals: ["allocation profile"], not_inspected: [] },
            root_cause_assessment: ROOT,
            claims: CLAIMS(),
          }
        : {
            decision,
            summary: "No finding is backed by evidence",
            findings: [],
            coverage: {
              inspected: ["ids.go", "ids_test.go"],
              signals: ["go vet", "tests"],
              not_inspected: [],
            },
            root_cause_assessment: {
              status: "INSUFFICIENT_EVIDENCE",
              confidence: "high",
              explanation: "No defect, bottleneck or risk was found.",
              supporting_claims: [],
            },
            claims: [],
          },
    ),
  );
}
function proposalAgent(
  blast: "ESTABLISHED" | "PARTIAL",
  test = "improve/TestContainsDoesNotAllocate",
) {
  scripts.proposal = script(
    "proposal",
    returns({
      summary: "Scan the slice instead of joining it",
      finding_id: "P1",
      changes: [
        {
          repo,
          files: ["ids.go", "ids_alloc_test.go"],
          description: "linear scan without allocation",
        },
      ],
      blast_radius: {
        status: blast,
        confirmed: ["Contains has no callers outside this package"],
        uncertain: blast === "PARTIAL" ? ["callers through reflection were not searched"] : [],
      },
      expected_benefit: { metric: "allocations per call", current: ">0", target: "0" },
      verification_plan: ["allocation budget test fails before, passes after", "full test suite"],
      regression_tests: ["allocation budget test"],
      required_tests: [test],
      risks: [],
      root_cause_assessment: ROOT,
      fix_assessment: {
        risk: "LOW",
        confidence: "high",
        explanation: "Same membership result without building a string.",
        side_effects: "none",
        rollback: "revert the commit",
      },
      claims: CLAIMS(),
    }),
  );
}
function implementAgent(o: { source: string; test?: string; extra?: string }) {
  scripts.implement = script(
    "implement",
    `import { existsSync, writeFileSync } from "node:fs";
export default async ({ call }) => {
  const prepared = await call("prepare_branch", { repo: ${JSON.stringify(repo)} });
  const path = /Work ONLY in: ([^\\n]+)/.exec(prepared)?.[1];
  if (!path) throw new Error(prepared);
  if (!existsSync(path + "/ids_alloc_test.go")) {
    writeFileSync(path + "/ids.go", ${JSON.stringify(o.source)});
    writeFileSync(path + "/ids_alloc_test.go", ${JSON.stringify(ALLOC_TEST)});
    ${o.extra ? `writeFileSync(path + "/IMPROVEMENT_REPORT.md", "# audit\\n");` : ""}
    const committed = await call("commit_changes", { repo: ${JSON.stringify(repo)}, message: "perf: scan ids without allocating" });
    if (/ERROR:/.test(committed)) throw new Error(committed);
  }
  return {
    outcome: "IMPLEMENTED", summary: "Contains scans the slice", verification: {},
    pull_requests: { ${JSON.stringify(repo)}: { title: "perf: Contains without allocation", summary: "", decisions: [] } },
    remediation: { kind: "ROOT_CAUSE_FIX", root_cause: "a string is built per call", causal_link: "the scan builds nothing",
      regression_test: { name: ${JSON.stringify(o.test ?? "improve/TestContainsDoesNotAllocate")}, fails_before: true, passes_after: true } },
  };
};
`,
  );
}
function reviewAgent() {
  scripts.review = script(
    "review",
    returns({
      verdict: "PASS",
      approved: true,
      findings: [],
      summary: "The scan keeps membership and removes the allocation.",
      root_cause_check: {
        addresses_root_cause: true,
        regression_test_demonstrates_fix: true,
        remediation_kind: "ROOT_CAUSE_FIX",
        justified_signals: [],
        symptom_only_changes: [],
        observability_reduced: false,
      },
      scope_check: {
        in_scope: true,
        unsupported_assumptions: [],
        unintended_state_transitions: [],
        invariants_preserved: true,
        tests_cover_failure_paths: true,
        diagnosis_uncertainty_preserved: true,
      },
    }),
  );
}

const stepOf = (run: number, key: string) =>
  one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2", [run, key]);
const statuses = async (run: number) =>
  Object.fromEntries(
    (
      await q<{ key: string; status: string }>(
        pool,
        "SELECT key, status FROM workflow_steps WHERE run_id=$1 ORDER BY position",
        [run],
      )
    ).map((r) => [r.key, r.status]),
  );

async function improvementRun(approve: { ack?: boolean } | false = {}) {
  const run = await startRun({
    definitionKey: "codebase-improvement",
    title: "Improve codebase-improve",
    profile: "STANDARD",
    ownerId,
    repositories: [repo],
    inputs: { repositories: [repo] },
    agentProvider: "codex",
  });
  runs.push(run.id);
  let approval: unknown = null;
  for (let i = 0; i < 12; i++) {
    await drain();
    const gate = await stepOf(run.id, "approve");
    if (gate?.status === "WAITING_APPROVAL" && approve && approval === null) {
      approval = gate.approval;
      await approveStep(
        run.id,
        "approve",
        approve.ack
          ? { comment: "blast radius reviewed by hand", data: { acknowledge_risk: true } }
          : {},
      );
      continue;
    }
    const st = await statuses(run.id);
    const settled = Object.values(st).every((s) =>
      ["COMPLETED", "SKIPPED", "FAILED", "WAITING_APPROVAL", "WAITING_INPUT", "CANCELED"].includes(
        s,
      ),
    );
    const blocked = Object.values(st).some((s) => ["FAILED", "WAITING_INPUT"].includes(s));
    if (blocked || st.pr === "WAITING_APPROVAL" || (settled && st.approve !== "WAITING_APPROVAL"))
      break;
    if (st.approve === "WAITING_APPROVAL" && !approve) break;
  }
  return { run, st: await statuses(run.id) };
}
type Out = Record<string, unknown> & {
  regression_proof?: { status: string; base_sha?: string; head_sha?: string; reason?: string };
  tested_heads?: Record<string, string>;
  blast_radius?: { established: boolean; status: string };
  evidence_gate?: { satisfied: boolean; missing: string[] };
};
const out = async (run: number, key: string) => ((await stepOf(run, key))?.output ?? {}) as Out;

test("no actionable findings: the run completes after the assessment with its report and changes nothing", async () => {
  assessAgent("NO_CHANGES_NEEDED");
  const { run, st } = await improvementRun();
  assert.equal(st.assess, "COMPLETED");
  assert.equal(st.report, "COMPLETED");
  for (const key of ["blast_radius", "proposal", "approve", "implement", "review", "proof", "pr"])
    assert.equal(st[key], "SKIPPED", key);
  assert.equal(
    (await one<{ status: string }>(pool, "SELECT status FROM workflow_runs WHERE id=$1", [run.id]))
      ?.status,
    "COMPLETED",
  );
  const workspaces = await q(pool, "SELECT 1 FROM execution_workspaces WHERE run_id=$1", [run.id]);
  assert.equal(workspaces.length, 0, "no worktree, no branch");
  const report = await q<{ name: string }>(
    pool,
    "SELECT name FROM workflow_artifacts WHERE run_id=$1 AND kind='report'",
    [run.id],
  );
  assert.equal(report.length, 1, "the assessment is stored as a run artifact");
});

test("a justified improvement: blast radius established, before/after proof verified, evidence bound to the commit, only source and test changed", async () => {
  assessAgent("IMPROVE");
  proposalAgent("ESTABLISHED");
  implementAgent({ source: FAST });
  reviewAgent();
  const { run, st } = await improvementRun();
  assert.equal(st.pr, "WAITING_APPROVAL", JSON.stringify(st));
  const blast = await out(run.id, "blast_radius");
  assert.equal(blast.blast_radius?.established, true, JSON.stringify(blast.blast_radius));
  const proposal = await out(run.id, "proposal");
  assert.equal(proposal.evidence_gate?.satisfied, true, JSON.stringify(proposal.evidence_gate));
  const implement = await out(run.id, "implement");
  assert.equal(
    implement.regression_proof?.status,
    "verified",
    String(implement.regression_proof?.reason),
  );
  assert.equal(
    implement.regression_proof?.base_sha,
    baseSha,
    "baseline measured on the base revision",
  );
  assert.equal(implement.regression_proof?.head_sha, implement.tested_heads?.[repo]);
  const proof = await one<{ verdict: string; attempt_id: number; step_id: number }>(
    pool,
    "SELECT verdict, attempt_id, step_id FROM fix_proofs WHERE run_id=$1 ORDER BY id DESC LIMIT 1",
    [run.id],
  );
  assert.equal(proof?.verdict, "VERIFIED");
  assert.ok(proof?.attempt_id && proof.step_id, "the verdict is bound to a step attempt");
  const logs = await q<{ attempt_id: number }>(
    pool,
    "SELECT attempt_id FROM workflow_artifacts WHERE run_id=$1 AND kind='log' AND attempt_id IS NOT NULL",
    [run.id],
  );
  assert.ok(logs.length > 0, "verification output is stored as attempt artifacts");
  const ws = await one<{ path: string }>(
    pool,
    "SELECT path FROM execution_workspaces WHERE run_id=$1",
    [run.id],
  );
  assert.deepEqual(
    git(ws!.path, "diff", "--name-only", `${baseSha}..HEAD`).split("\n").sort(),
    ["ids.go", "ids_alloc_test.go"],
    "the branch holds the fix and its durable regression test, no evidence files",
  );
});

test("insufficient blast radius: approval needs an explicit, commented risk acknowledgement", async () => {
  assessAgent("IMPROVE");
  proposalAgent("PARTIAL");
  const { run, st } = await improvementRun(false);
  assert.equal(st.approve, "WAITING_APPROVAL");
  const gate = (await out(run.id, "proposal")).evidence_gate;
  assert.equal(gate?.satisfied, false);
  assert.ok(gate?.missing.some((m) => m.startsWith("blast radius not established")));
  const approval = (await stepOf(run.id, "approve"))?.approval as {
    request?: { requires_risk_acknowledgement?: boolean };
  };
  assert.equal(approval.request?.requires_risk_acknowledgement, true);
  await assert.rejects(approveStep(run.id, "approve", {}), /explicit risk acknowledgement/);
  await assert.rejects(
    approveStep(run.id, "approve", { data: { acknowledge_risk: true } }),
    /requires a comment/,
  );
  assert.equal((await stepOf(run.id, "implement"))?.status, "PENDING", "nothing implemented");
});

test("a regression after implementation: the existing behaviour test fails and the change never reaches review", async () => {
  assessAgent("IMPROVE");
  proposalAgent("ESTABLISHED");
  implementAgent({ source: BROKEN });
  const { run, st } = await improvementRun();
  assert.equal(st.implement, "FAILED", JSON.stringify(st));
  assert.match(String((await stepOf(run.id, "implement"))?.error), /TestContains/);
  for (const key of ["review", "proof", "pr"]) assert.equal(st[key], "PENDING", key);
});

test("incomplete verification: a regression test that does not reproduce the finding is not a pass", async () => {
  assessAgent("IMPROVE");
  proposalAgent("ESTABLISHED", "improve/TestContains");
  implementAgent({ source: FAST, test: "improve/TestContains" });
  reviewAgent();
  const { run, st } = await improvementRun();
  assert.notEqual(st.pr, "WAITING_APPROVAL", JSON.stringify(st));
  assert.notEqual(st.proof, "COMPLETED");
  const implement = await out(run.id, "implement");
  assert.equal(
    implement.regression_proof?.status,
    "invalid",
    String(implement.regression_proof?.reason),
  );
  const verdicts = await q<{ verdict: string | null }>(
    pool,
    `SELECT a.output->>'verdict' AS verdict FROM workflow_step_attempts a JOIN workflow_steps s ON s.id=a.step_id
      WHERE s.run_id=$1 AND s.key='review' ORDER BY a.id`,
    [run.id],
  );
  assert.ok(
    verdicts.length > 0 && verdicts.every((v) => v.verdict !== "PASS"),
    JSON.stringify(verdicts),
  );
});

test("an evidence file committed to the source repository stops the run for renewed scope approval", async () => {
  assessAgent("IMPROVE");
  proposalAgent("ESTABLISHED");
  implementAgent({ source: FAST, extra: "report" });
  const { run, st } = await improvementRun();
  assert.equal(st.implement, "WAITING_INPUT", JSON.stringify(st));
  const waiting = await one<{
    scope: { requires_reapproval?: boolean; out_of_scope_files?: unknown };
  }>(
    pool,
    `SELECT a.output->'scope_check' AS scope FROM workflow_step_attempts a JOIN workflow_steps s ON s.id=a.step_id
      WHERE s.run_id=$1 AND s.key='implement' ORDER BY a.id DESC LIMIT 1`,
    [run.id],
  );
  assert.equal(waiting?.scope.requires_reapproval, true);
  assert.match(JSON.stringify(waiting?.scope.out_of_scope_files), /IMPROVEMENT_REPORT\.md/);
  const question = await one<{ question: string }>(
    pool,
    "SELECT question FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [run.id],
  );
  assert.match(String(question?.question), /IMPROVEMENT_REPORT\.md|out-of-scope/);
  assert.notEqual(st.pr, "WAITING_APPROVAL");
});

test("assessment then choice: a read-only run lists findings with severity, a fix starts only from the chosen finding", async () => {
  scripts.assess = script(
    "scan",
    returns({
      decision: "FINDINGS",
      summary: "Two evidence-backed findings",
      findings: [
        {
          id: "P1",
          kind: "PERFORMANCE",
          severity: "medium",
          repo,
          file: "ids.go",
          line: 7,
          issue: "a heap allocation per membership check",
          evidence: "F1",
          implementable: true,
        },
        {
          id: "M2",
          kind: "MAINTAINABILITY",
          severity: "low",
          repo,
          file: "ids.go",
          line: 5,
          issue: "doc comment restates the name",
          evidence: "ids.go:5",
          implementable: false,
          why_not: "no behaviour a test can demonstrate",
        },
      ],
      coverage: { inspected: ["ids.go"], signals: ["tests"], not_inspected: [] },
      claims: CLAIMS(),
    }),
  );
  const scan = await startRun({
    definitionKey: "codebase-assessment",
    title: "Assess codebase-improve",
    profile: "STANDARD",
    ownerId,
    repositories: [repo],
    inputs: { repositories: [repo] },
    agentProvider: "codex",
  });
  runs.push(scan.id);
  for (let i = 0; i < 6; i++) await drain();
  const st = await statuses(scan.id);
  assert.deepEqual(st, { select: "COMPLETED", assess: "COMPLETED", report: "COMPLETED" });
  assert.equal(
    (await q(pool, "SELECT 1 FROM execution_workspaces WHERE run_id=$1", [scan.id])).length,
    0,
    "read-only: no worktree",
  );
  let listed = (await listCodeScans({ ownerId })).find((s) => s.id === scan.id)!;
  assert.equal(listed.decision, "FINDINGS");
  assert.deepEqual(
    (listed.findings as Array<{ id: string; severity: string }>).map((f) => [f.id, f.severity]),
    [
      ["P1", "medium"],
      ["M2", "low"],
    ],
  );
  assert.equal(listed.fixes, null, "nothing is fixed before a person chooses");

  const fix = await startRun({
    definitionKey: "codebase-improvement",
    title: "Fix P1",
    profile: "STANDARD",
    ownerId,
    repositories: [repo],
    inputs: {
      repositories: [repo],
      finding: { id: "P1", issue: "a heap allocation per membership check", scan_run_id: scan.id },
    },
    agentProvider: "codex",
    start: false,
  });
  runs.push(fix.id);
  listed = (await listCodeScans({ ownerId })).find((s) => s.id === scan.id)!;
  assert.deepEqual(
    listed.fixes?.map((f) => [f.finding_id, f.run_id]),
    [["P1", fix.id]],
  );
  assert.ok(
    !(await listCodeScans({ ownerId })).some((s) => s.id === fix.id),
    "fix runs are not listed as assessments",
  );
  assert.equal((await listCodeScans({ ownerId: ownerId + 1000 })).length, 0);
});
