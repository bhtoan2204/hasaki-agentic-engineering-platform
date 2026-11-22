/**
 * Production Bug Hunter, end to end and offline: incident (persisted evidence) → `production-bug-hunt` run through the
 * real Workflow Engine, scheduler and Agent Harness (Codex provider path: the fake `codex` CLI scripts the agents
 * through the real MCP bridge and broker) → scope from the stack → hunter → triage → independent verifier (hunter
 * output withheld) → reproduction in a throwaway network-isolated export → report → durable findings on the incident.
 *
 * The scripted agents are deliberately imperfect (a hunter that also suspects correct code, a credulous verifier), so
 * these tests check the platform's gates — not a model's bug-finding ability.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { getRun, cancelRun, reexecuteStep } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { bwrapAvailable } from "../src/platform/selfDevelopment.ts";
import {
  bugHuntDetail,
  createFixTask,
  listBugHunts,
  startBugHunt,
} from "../src/bugHunt/service.ts";
import { PRODUCTION_BUG_HUNT } from "../src/workflow/templates.ts";
import { BUG_HUNT_CASES, caseFingerprint } from "../src/eval/bugHuntFixtures.ts";
import {
  runArmA,
  runArmB,
  summarizeBugHunt,
  type BugHuntGrade,
} from "../src/eval/bugHuntBenchmark.ts";
import { setupBugHuntFixture } from "./fixtures/bugHuntRepo.ts";

const root = process.env.TEST_ROOT!;
let owner: PublicUser;
let other: PublicUser;
let fx: Awaited<ReturnType<typeof setupBugHuntFixture>>;
let repo = "";
let primary = "";
let revision = "";
let sandbox = false;
const git = (...args: string[]) => fx.git(...args);
const useScript = (name: string, body: string) => fx.useScript(name, body);
async function drive(runId: number, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}
interface FindingView {
  finding_id: number;
  function: string;
  bug_verification_status: string;
  incident_causality_status: string;
  basis: string;
  causality_basis: string[];
  reproduction: { outcome: string; artifact_id: number };
}
interface HuntView {
  status: string;
  revisions: Record<string, string>;
  stages: Array<{ id: number; key: string; status: string }>;
  findings: FindingView[];
  counts: Record<string, number>;
  report: { rejected: Array<{ basis: string }> };
}
interface StepOutput {
  summary: string;
  functions: Array<{ function: string; source: string; commit: string }>;
  tools: Record<string, string>;
  to_verify: unknown[];
  duplicates: Array<{ merged: number }>;
}
const detail = async (id: number, who: PublicUser = owner) =>
  (await bugHuntDetail(id, who, false)) as unknown as HuntView;
const stepOutput = async (runId: number, key: string) =>
  (await one<{ output: StepOutput }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key=$2",
    [runId, key],
  ))!.output;
const caseOf = (id: string) => BUG_HUNT_CASES.find((c) => c.id === id)!;

before(async () => {
  await migrate();
  owner = await createUser({
    username: `bughunt-${Date.now()}`,
    password: "bug-hunt-pass",
    role: "member",
  });
  other = await createUser({
    username: `bughunt-o-${Date.now()}`,
    password: "bug-hunt-pass",
    role: "member",
  });
  fx = await setupBugHuntFixture(root);
  ({ repo, primary, revision } = fx);
  sandbox = !!(await bwrapAvailable());
});
after(() => pool.end());

test("the template is read-only, bounded, and its verifier never receives the hunter's output", () => {
  const steps = PRODUCTION_BUG_HUNT.steps as Array<{
    key: string;
    type: string;
    config: Record<string, unknown>;
    run_if?: unknown;
  }>;
  assert.ok(steps.every((s) => !["coding_agent", "command", "git_pull_request"].includes(s.type)));
  const verify = steps.find((s) => s.key === "verify")!;
  assert.deepEqual(verify.config.withhold, ["hunt"]);
  assert.ok(verify.run_if, "the verifier is skipped when nothing is worth verifying");
  for (const k of ["hunt", "verify"]) {
    const a = steps.find((s) => s.key === k)!.config.agent as {
      max_tool_calls: number;
      timeout_ms: number;
    };
    assert.ok(a.max_tool_calls > 0 && a.timeout_ms > 0, `${k} has a tool-call and time budget`);
  }
  assert.ok(
    steps.some((s) => s.key === "investigate"),
    "the incident-investigation step is reused",
  );
});

test("starting a hunt needs a repository the requester can read; at most three", async () => {
  const fp = caseFingerprint("real-bug");
  await assert.rejects(startBugHunt(fp, owner, { repositories: [] }), /at least one repository/);
  await assert.rejects(
    startBugHunt(fp, owner, { repositories: ["a", "b", "c", "d"] }),
    /at most 3/,
  );
  await assert.rejects(
    startBugHunt(fp, owner, { repositories: ["not-registered-repo"] }),
    /not found or not accessible/,
  );
  await assert.rejects(
    startBugHunt("0".repeat(20), owner, { repositories: [repo] }),
    /incident not found/,
  );
});

let firstHunt: { hunt_id: number; run_id: number };

test("a hunt confirms a code bug only after independent verification and a failing isolated reproduction; the incident link is a separate verdict", async () => {
  const fp = caseFingerprint("real-bug");
  // Concurrent requests for the same incident, repositories and user get one hunt.
  const [a, b] = await Promise.all([
    startBugHunt(fp, owner, { repositories: [repo], provider: "codex" }),
    startBugHunt(fp, owner, { repositories: [repo], provider: "codex" }),
  ]);
  assert.equal(a.hunt_id, b.hunt_id);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  firstHunt = a;
  assert.equal(await drive(a.run_id), "COMPLETED");
  const d = await detail(a.hunt_id);
  assert.equal(d.revisions[repo], revision, "the investigated revision is recorded");
  assert.deepEqual(
    d.stages.map((s: { key: string }) => s.key),
    [
      "context",
      "scope",
      "investigate",
      "evidence",
      "hunt",
      "triage",
      "verify",
      "reproduce",
      "report",
    ],
  );
  // Scope came from the persisted stack frame, bounded; the tools used (or why not) are recorded.
  const scope = await stepOutput(a.run_id, "scope");
  assert.ok(
    scope.functions.some(
      (f) => f.function === "Apply" && f.source === "stack_frame" && f.commit === revision,
    ),
  );
  assert.ok(scope.tools.lsp, "LSP use (or the reason it was not used) is recorded");
  // Independence: the verifier could not read the hunter's output.
  const verify = await stepOutput(a.run_id, "verify");
  assert.match(verify.summary, /withheld/);
  const f = d.findings[0];
  assert.equal(d.findings.length, 1);
  assert.equal(f.function, "Apply");
  if (sandbox) {
    assert.equal(d.status, "completed");
    assert.equal(f.bug_verification_status, "CONFIRMED", f.basis);
    assert.equal(f.reproduction.outcome, "reproduced");
    assert.match(f.basis, /isolated reproduction test failed/);
    // Incident causality: on the stack, production ran this code, verifier found the link → CONFIRMED (separately).
    assert.equal(f.incident_causality_status, "CONFIRMED", f.causality_basis.join("; "));
    const art = await one<{ content: string }>(
      pool,
      "SELECT content FROM workflow_artifacts WHERE id=$1",
      [f.reproduction.artifact_id],
    );
    assert.match(art!.content, /--- FAIL: TestBugHuntApplyDiscount/);
    assert.match(art!.content, /GOPROXY|go test -count=1/);
  } else {
    // No network-isolated sandbox: the reproduction never runs unsandboxed, and nothing becomes CONFIRMED.
    assert.equal(f.reproduction.outcome, "blocked");
    assert.equal(f.bug_verification_status, "BLOCKED");
    assert.equal(d.status, "partial");
  }
  // Durable, linked rows.
  const row = await one<Record<string, unknown>>(
    pool,
    "SELECT * FROM bug_hunt_findings WHERE hunt_id=$1",
    [a.hunt_id],
  );
  assert.equal(Number(row!.verification_step_id), d.stages.find((s) => s.key === "verify")!.id);
  assert.ok(row!.hunter_attempt_id);
  assert.equal(row!.commit, revision);
  // The original repository is untouched (no reproduction file, no commit, clean tree).
  assert.equal(git("rev-parse", "HEAD"), revision);
  assert.equal(git("status", "--porcelain"), "");
  assert.ok(!existsSync(join(primary, "pricing/bughunt_testbughuntapplydiscount_test.go")));
  assert.equal(git("worktree", "list").split("\n").length, 1);
  // Another user does not see this hunt.
  assert.equal((await listBugHunts(fp, other, false)).hunts.length, 0);
  await assert.rejects(bugHuntDetail(a.hunt_id, other, false), /not found/);
});

test("replaying the report step gives the same findings (replaced, not duplicated)", async () => {
  const before = await q(
    pool,
    "SELECT candidate_id, bug_verification_status FROM bug_hunt_findings WHERE hunt_id=$1 ORDER BY id",
    [firstHunt.hunt_id],
  );
  await reexecuteStep(firstHunt.run_id, "report");
  assert.equal(await drive(firstHunt.run_id), "COMPLETED");
  const after = await q(
    pool,
    "SELECT candidate_id, bug_verification_status FROM bug_hunt_findings WHERE hunt_id=$1 ORDER BY id",
    [firstHunt.hunt_id],
  );
  assert.deepEqual(after, before);
});

test("a follow-up fix task hands a finding to the existing Bug Investigation workflow, once", async () => {
  const d = await detail(firstHunt.hunt_id);
  const fid = d.findings[0].finding_id;
  if (d.findings[0].bug_verification_status === "BLOCKED") {
    await assert.rejects(
      createFixTask(firstHunt.hunt_id, fid, owner),
      /only confirmed or suspected/,
    );
    return;
  }
  const t1 = await createFixTask(firstHunt.hunt_id, fid, owner);
  const t2 = await createFixTask(firstHunt.hunt_id, fid, owner);
  assert.equal(t1.created, true);
  assert.equal(t2.created, false);
  assert.equal(t2.run_id, t1.run_id);
  const run = await getRun(t1.run_id);
  assert.equal(run.definition_key, "bug-investigation");
  await cancelRun(t1.run_id);
});

test("a canceled hunt ends canceled with no fabricated findings", async () => {
  const fp = caseFingerprint("nil-edge-case");
  const h = await startBugHunt(fp, owner, { repositories: [repo], provider: "codex" });
  for (let i = 0; i < 4; i++) await runOnce(); // context, scope, maybe the investigation
  await cancelRun(h.run_id);
  assert.equal(await drive(h.run_id), "CANCELED");
  const d = await detail(h.hunt_id);
  assert.equal(d.status, "canceled");
  assert.equal(d.findings.length, 0);
  assert.equal(d.counts.CONFIRMED, 0);
});

test("the verifier budget: at most three candidates are verified; low-confidence ones stay SUSPECTED, unverified", async () => {
  const many = caseOf("race-condition");
  const fp = caseFingerprint(many.id);
  // A hunter that reports five confident candidates (the same defect class in every function of the file).
  useScript(
    "bughunt-many",
    `export default async ({ call, prompt }) => {
  const scope = JSON.parse(await call("read_step_output", { step_key: "scope" }));
  if (prompt.includes("INDEPENDENT verifier of bug claims")) {
    const t = JSON.parse(await call("read_step_output", { step_key: "triage" }));
    return { summary: "n=" + t.to_verify.length, verdicts: t.to_verify.map((c) => ({ id: c.id, verdict: "SUSPECTED", reason: "unproven", execution_path: [], code_evidence: [], alternative_explanations: [], incident_link: "UNKNOWN", incident_link_reason: "" })) };
  }
  if (!prompt.includes("Hunt for REAL")) return ${JSON.stringify({ summary: "s", hypotheses: [], next_steps: [], claims: [], root_cause_assessment: { status: "INSUFFICIENT_EVIDENCE", confidence: "low", explanation: "none", supporting_claims: [] } })};
  const rev = scope.revisions[${JSON.stringify(repo)}];
  const fns = [["New", 10], ["Reserve", 14], ["Available", 33]];
  const cats = ["race_condition", "resource_leak", "boundary_condition"];
  const candidates = [];
  for (const [fn, line] of fns) for (const cat of cats) candidates.push({ repository: ${JSON.stringify(repo)}, commit: rev, file_path: "stock/store.go", function: fn, line_start: line, line_end: line, category: cat, hypothesis: fn + " " + cat, trigger: "t", expected: "e", actual: "a", supporting_evidence: [], reproduction_strategy: "r", confidence: cat === "boundary_condition" ? 0.2 : 0.9, uncertainty: "u" });
  candidates.push({ ...candidates[0], hypothesis: "duplicate wording" });
  return { summary: "many", candidates, inspected_files: ["stock/store.go"] };
};`,
  );
  try {
    const h = await startBugHunt(fp, owner, { repositories: [repo], provider: "codex" });
    assert.equal(await drive(h.run_id), "COMPLETED");
    const triage = await stepOutput(h.run_id, "triage");
    assert.equal(triage.to_verify.length, 3, "verification is bounded");
    assert.equal(triage.duplicates[0].merged, 1, "the duplicate candidate was merged");
    const d = await detail(h.hunt_id);
    assert.equal(d.counts.CONFIRMED, 0, "nothing unverified is confirmed");
    assert.ok(d.findings.some((f) => /below the verification threshold/.test(f.basis)));
    assert.ok(d.findings.some((f) => /verification budget/.test(f.basis)));
  } finally {
    fx.defaultScript();
  }
});

test("a candidate citing a stale commit or a location that does not exist is rejected by the platform", async () => {
  const fp = caseFingerprint("transaction-consistency");
  useScript(
    "bughunt-stale",
    `export default async ({ call, prompt }) => {
  if (prompt.includes("INDEPENDENT verifier of bug claims")) return { summary: "x", verdicts: [] };
  if (!prompt.includes("Hunt for REAL")) return ${JSON.stringify({ summary: "s", hypotheses: [], next_steps: [], claims: [], root_cause_assessment: { status: "INSUFFICIENT_EVIDENCE", confidence: "low", explanation: "none", supporting_claims: [] } })};
  const base = { repository: ${JSON.stringify(repo)}, line_start: 3, line_end: 4, category: "other", hypothesis: "h", trigger: "t", expected: "e", actual: "a", supporting_evidence: [], reproduction_strategy: "r", confidence: 0.9, uncertainty: "u" };
  return { summary: "stale", inspected_files: [], candidates: [
    { ...base, commit: "0123456789abcdef0123456789abcdef01234567", file_path: "ledger/transfer.go", function: "Transfer" },
    { ...base, commit: "", file_path: "ledger/missing.go", function: "Transfer" },
    { ...base, commit: "", file_path: "ledger/transfer.go", function: "Invented" },
  ] };
};`,
  );
  try {
    const h = await startBugHunt(fp, owner, { repositories: [repo], provider: "codex" });
    assert.equal(await drive(h.run_id), "COMPLETED");
    const steps = await q<{ key: string; status: string }>(
      pool,
      "SELECT key, status FROM workflow_steps WHERE run_id=$1",
      [h.run_id],
    );
    assert.equal(
      steps.find((s) => s.key === "verify")!.status,
      "SKIPPED",
      "nothing left to verify: no verifier cost",
    );
    const d = await detail(h.hunt_id);
    const reasons = (d.report.rejected as Array<{ basis: string }>).map((r) => r.basis).join("\n");
    assert.match(reasons, /investigated revision is/);
    assert.match(reasons, /does not exist/);
    assert.match(reasons, /is not declared/);
  } finally {
    fx.defaultScript();
  }
});

// ---------------------------------------------------------------- benchmark: A (investigation) vs B (bug hunt)

test("offline benchmark: 10 seeded scenarios, incident-investigation (A) vs bug hunt + independent verifier (B)", async () => {
  // A fresh requester: only the recurring incident may reuse a verified finding (reuse is per requester).
  const bench = await createUser({
    username: `bughunt-bench-${Date.now()}`,
    password: "bug-hunt-pass",
    role: "member",
  });
  const grades: BugHuntGrade[] = [];
  for (const c of BUG_HUNT_CASES) {
    if (!c.replays) grades.push(await runArmA(c, { owner: bench, repo, provider: "codex" }));
    grades.push(await runArmB(c, { owner: bench, repo, provider: "codex" }));
  }
  const summary = summarizeBugHunt(grades);
  const B = (id: string) => grades.find((g) => g.arm === "B" && g.case === id)!;
  const A = (id: string) => grades.find((g) => g.arm === "A" && g.case === id)!;
  for (const g of grades) assert.equal(g.run_status, "COMPLETED", `${g.arm} ${g.case}`);
  // Never a confirmed bug in correct code, and never confirmation without the platform's proof.
  assert.equal(
    summary.B.false_positives,
    0,
    JSON.stringify(grades.filter((g) => g.arm === "B" && g.false_positives)),
  );
  assert.equal(B("correct-code-suspected").reported.length, 0);
  assert.ok(
    grades.filter((g) => g.arm === "B").every((g) => g.verifier_saw_hunter_output !== true),
  );
  // The recurring incident reuses the verified finding (byte-identical source): no verifier run.
  assert.equal(B("real-bug").reused, 0, "the first hunt of an incident verifies afresh");
  if (sandbox) {
    assert.equal(B("recurring-incident").reused, 1);
    assert.equal(B("recurring-incident").reported.length, 1);
    assert.equal(summary.B.true_positives, 9, JSON.stringify(summary));
    assert.equal(summary.B.false_negatives, 0);
    // Misleading stack: B confirms the callee defect and attributes it (PROBABLE), A blames the crashing frame.
    assert.equal(B("misleading-stacktrace").attribution, "orders/loader.go#Fill");
    assert.equal(A("misleading-stacktrace").attribution, "orders/render.go#Format");
    assert.equal(A("misleading-stacktrace").attribution_correct, false);
  } else {
    assert.equal(
      summary.B.true_positives,
      0,
      "without a network-isolated sandbox nothing is confirmed",
    );
  }
  // A names the crashing frame of a partner rejection as the cause: a false positive B does not make.
  assert.equal(A("correct-code-suspected").false_positives, 1);
  const out = join(
    import.meta.dirname,
    "..",
    "docs",
    "validation",
    "production-bug-hunter-benchmark.json",
  );
  if (process.env.BUG_HUNT_BENCHMARK_OUT === "1")
    writeFileSync(
      out,
      JSON.stringify(
        { sandbox: sandbox ? "bwrap, network disabled" : "unavailable", summary, grades },
        null,
        2,
      ) + "\n",
    );
  console.log(`BUGHUNT-BENCH ${JSON.stringify({ sandbox, summary })}`);
});
