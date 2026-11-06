import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import {
  answerQuestions,
  approveStep,
  beginAttempt,
  cancelRun,
  finishAttempt,
  getRun,
  pauseRun,
  reapExpiredLeases,
  reexecuteStep,
  rejectStep,
  resumeRun,
  retryStep,
  runDetail,
  runStepNow,
  startPendingRun,
  stepDetail,
  stopStep,
  skipStep,
  sendFeedback,
  startRun,
} from "../src/workflow/engine.ts";
import { claimJob, drain, LIGHT_STEP_TYPES, schedulerStatus, runOnce, startScheduler } from "../src/workflow/scheduler.ts";
import { registerExecutor, type ExecutionContext } from "../src/workflow/executors/registry.ts";
import {
  commandExecutor,
  conditionExecutor,
  humanApprovalExecutor,
  humanInputExecutor,
  integrationExecutor,
  pullRequestExecutor,
  setAiRepositoryRanker,
} from "../src/workflow/executors/builtin.ts";
import { recordWorkspace, setGitProvider, workspacesOf } from "../src/git/provider.ts";
import { collectEvidence, enforceVerdict, evidenceDrift, normalizeVerdict, repairTargetFor } from "../src/agent/independentReview.ts";
import { repositories } from "../src/repos/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { workItems } from "../src/workitems/service.ts";
import { importHasakiTask } from "../src/work.ts";
import type { ExecResult } from "../src/workflow/types.ts";
import { setReportReasoner, taskResultReportExecutor } from "../src/report/executor.ts";
import { withReportStep, REPORT_STEP_KEY, previewRun } from "../src/workflow/engine.ts";
import { addEvidence } from "../src/report/evidenceStore.ts";
import { OPTIONS, setTestFailureAdvisor } from "../src/workflow/executors/testFailure.ts";
import { testExceptionsOf, prDescription } from "../src/workflow/executors/builtin.ts";

// ---------------------------------------------------------------- fakes

type Script = (ctx: ExecutionContext, call: number) => Promise<ExecResult> | ExecResult;
/** Per step key behaviour for agent / coding_agent steps; default = complete with a small output. */
let scripts: Record<string, Script> = {};
const calls: Record<string, number> = {};
const seen: Record<string, ExecutionContext[]> = {};

const fakeAgent = {
  async execute(ctx: ExecutionContext): Promise<ExecResult> {
    const n = (calls[ctx.step.key] = (calls[ctx.step.key] ?? 0) + 1);
    (seen[ctx.step.key] ??= []).push(ctx);
    const s = scripts[ctx.step.key];
    if (s) return s(ctx, n);
    return { kind: "completed", output: { summary: `${ctx.step.key} done`, keywords: ["shipment", "cancel"] } };
  },
};

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const gitIn = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: GIT_ENV }).trim();
/** Commit `content` to `file` in a worktree; returns the new HEAD. */
const commitFile = (path: string, file: string, content: string, msg = `edit ${file}`) => {
  writeFileSync(join(path, file), content);
  gitIn(path, "add", "-A");
  gitIn(path, "commit", "-qm", msg);
  return gitIn(path, "rev-parse", "HEAD");
};
/** A real git worktree on `branch` with one commit (what a coding step leaves behind). */
const gitWorktree = (repo: string, branch: string, content = "package x\n") => {
  const path = mkdtempSync(join(process.env.TEST_ROOT!, `wt-${repo}-`));
  execFileSync("git", ["init", "-q", "-b", branch, path], { env: GIT_ENV });
  commitFile(path, "x.go", content, "feat: change");
  return path;
};

/** A coding step that edits a (real git) temp worktree: records the workspace and returns PR content. */
const codingDone: Script = async (ctx) => {
  for (const repo of ctx.run.selected_repositories) {
    const path = gitWorktree(repo, ctx.run.branch);
    await recordWorkspace(ctx.run.id, { repo, branch: ctx.run.branch, path, created_from: "test" });
  }
  return {
    kind: "completed",
    output: { summary: "implemented", pull_requests: Object.fromEntries(ctx.run.selected_repositories.map((r) => [r, { title: `feat: ${r}`, summary: "s", decisions: [] }])) },
  };
};

/**
 * Mirrors the Claude executor end to end for a scripted verdict: platform evidence from the run's real worktrees
 * (BLOCKED when not bound to a commit), the verdict, drift re-check, then enforcement with the judged heads.
 */
const liveVerifier = (verdictFor: (n: number, ctx: ExecutionContext, evidence: { heads: Record<string, string>; text: string }) => any): Script => async (ctx, n) => {
  const ws = (await workspacesOf(ctx.run.id)).filter((w) => ctx.run.selected_repositories.includes(w.repo)).map((w) => ({ repo: w.repo, path: w.path }));
  const ev = await collectEvidence(ws, "release/prod");
  if (ev.problems.length) return enforceVerdict({ verdict: "BLOCKED", findings: [], summary: "", blocked_reason: ev.problems.join("; ") }, { repairsUsed: 0, maxRepairs: 0, repairTarget: null, heads: {} });
  let v = normalizeVerdict(await verdictFor(n, ctx, ev));
  const drift = await evidenceDrift(ws, ev.heads);
  if (drift.length && v.verdict === "PASS") v = { ...v, verdict: "BLOCKED", blocked_reason: drift.join("; ") };
  const used = (await one(pool, "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE step_id = $1 AND output->>'verdict' = 'FAIL'", [ctx.step.id])).n;
  return enforceVerdict(v, { repairsUsed: used, maxRepairs: Number(ctx.step.config.max_repairs ?? 2), repairTarget: repairTargetFor(ctx.run.graph, ctx.step.key), heads: ev.heads });
};
/** What the fake provider pushed: the branch tip actually published. */
let pushed: Array<{ path: string; branch: string; sha: string }> = [];
let prCalls: Array<{ repo: string; source: string; draft: boolean }> = [];
setGitProvider({
  name: "fake",
  async push(path: string, branch: string) {
    let sha = "";
    try {
      sha = gitIn(path, "rev-parse", `refs/heads/${branch}`);
    } catch {}
    pushed.push({ path, branch, sha });
    return { commits: "abc123 feat: change" };
  },
  async openOrUpdatePullRequest(pr) {
    prCalls.push({ repo: pr.repo, source: pr.source, draft: pr.draft });
    const first = prCalls.filter((c) => c.repo === pr.repo && c.source === pr.source).length === 1;
    return { url: `https://bitbucket.example/${pr.repo}/pull-requests/1`, created: first, note: first ? "PR created." : "Existing PR updated." };
  },
});

before(async () => {
  await migrate();
  await seedTemplates();
  registerExecutor("agent", fakeAgent);
  registerExecutor("coding_agent", fakeAgent);
  registerExecutor("human_input", humanInputExecutor);
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("condition", conditionExecutor);
  registerExecutor("command", commandExecutor);
  registerExecutor("integration", integrationExecutor);
  registerExecutor("git_pull_request", pullRequestExecutor);
  registerExecutor("task_result_report", taskResultReportExecutor);
  setAiRepositoryRanker(null);
  // Over-eager fake reasoner: claims everything VERIFIED and cites every id (+ a fabricated one); rules must correct it.
  setReportReasoner(async (_ctx, spec, ev) => ({
    summary: "Đã sửa lỗi mapping ZIP.",
    requirements: spec.sections.flatMap((s) => s.requirements).map((r) => ({ id: r.id, status: "VERIFIED" as const, evidence_ids: [...ev.map((e) => e.id), "E999"], explanation: "fake" })),
  }));
  await repositories.upsert("oms-api", { projects: ["OMS"], services: ["shipment", "order"], description: "order management gRPC api" });
  await repositories.upsert("oms-background", { projects: ["OMS"], services: ["outbox", "consumer"], description: "kafka consumers" });
  await repositories.upsert("payment-src", { projects: ["Payment"], services: ["payment", "refund"] });
});
after(() => pool.end());
beforeEach(() => {
  scripts = {};
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of Object.keys(seen)) delete seen[k];
  prCalls = [];
  pushed = [];
});

const stepOf = async (runId: number, key: string) => (await getRun(runId)).steps.find((s) => s.key === key)!;
const attemptsOf = (runId: number, key: string) =>
  q(pool, "SELECT a.* FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = $2 ORDER BY a.number", [runId, key]);
const statuses = async (runId: number) => Object.fromEntries((await getRun(runId)).steps.map((s) => [s.key, s.status]));

let defSeq = 0;
async function customWorkflow(steps: unknown[], extra: Record<string, unknown> = {}) {
  const key = `test-wf-${++defSeq}`;
  await definitions.create({ key, spec: { name: key, steps, ...extra } });
  return key;
}

// ---------------------------------------------------------------- acceptance scenarios

test("Scenario A: manual request through Feature Implementation to a Bitbucket PR", async () => {
  const wi = await workItems.createManual({ title: "Cancel shipment when order is refunded", project: "OMS", description: "Shipments must be cancelled on refund" });
  assert.match(wi.code, /^REQ-\d+$/);
  scripts.implement = codingDone;
  // STANDARD (auto) makes the review an independent verifier: the PR needs its PASS on the exact pushed commits.
  scripts.review = liveVerifier(() => ({ approved: true, findings: [] }));
  const run = await startRun({ definitionKey: "feature-implementation", workItemId: wi.id });
  assert.equal(run.branch, `u${run.owner_id}-${wi.code}`);
  assert.deepEqual(run.allowed_repositories.sort(), ["oms-api", "oms-background"]);

  await drain();
  let st = await statuses(run.id);
  assert.equal(st.analyze, "COMPLETED");
  assert.equal(st.discover, "COMPLETED");
  assert.equal(st.confirm_repos, "WAITING_APPROVAL");
  assert.equal((await getRun(run.id)).status, "WAITING");
  const confirm = await stepOf(run.id, "confirm_repos");
  assert.equal(confirm.approval.request.recommended[0], "oms-api");
  assert.ok(confirm.approval.request.candidates[0].reasons.length > 0, "recommendation explains itself");

  await assert.rejects(approveStep(run.id, "confirm_repos", { repositories: ["payment-src"] }), /outside the allowed set/);
  await approveStep(run.id, "confirm_repos", { repositories: ["oms-api"], comment: "ok" });
  await drain();
  st = await statuses(run.id);
  assert.equal(st.plan, "COMPLETED");
  assert.equal(st.approve_plan, "WAITING_APPROVAL");

  await approveStep(run.id, "approve_plan");
  await drain();
  assert.equal((await stepOf(run.id, "pr")).status, "WAITING_APPROVAL", "PR waits for review of the changes");
  assert.equal(prCalls.length, 0);
  await approveStep(run.id, "pr");
  await drain();
  const final = await runDetail(run.id);
  assert.equal(final.status, "COMPLETED", JSON.stringify(await statuses(run.id)));
  assert.deepEqual(final.selected_repositories, ["oms-api"]);
  assert.equal(final.pull_requests.length, 1);
  assert.equal(final.pull_requests[0].repo, "oms-api");
  assert.equal(final.pull_requests[0].source_branch, final.branch);
  assert.equal(final.pull_requests[0].target_branch, "release/prod");
  assert.ok(final.artifacts.some((a: any) => a.kind === "log"), "test command log stored");
  for (const a of final.attempts) assert.ok(a.context_snapshot_id, "every attempt has a context snapshot");
});

test("Scenario B: agent asks about a business rule, pauses, resumes from checkpoint", async () => {
  const key = await customWorkflow([
    { key: "analyze", type: "agent" },
    { key: "plan", type: "agent", depends_on: ["analyze"] },
    { key: "summary", type: "agent", depends_on: ["plan"] },
  ]);
  scripts.plan = async (ctx, n) => {
    if (n === 1) {
      await ctx.ask([{ question: "Hoàn tiền một phần có huỷ shipment không?", options: ["Không", "Có"] }]);
      return { kind: "waiting_input", checkpoint: { session_id: "sess-1", note: "found refund flow" } };
    }
    return { kind: "completed", output: { decision: ctx.input.answers.map((a) => a.answer).join(",") } };
  };
  const run = await startRun({ definitionKey: key, inputs: { project: "OMS" } });
  await drain();
  assert.deepEqual(await statuses(run.id), { analyze: "COMPLETED", plan: "WAITING_INPUT", summary: "PENDING" });
  assert.equal((await getRun(run.id)).status, "WAITING");
  // Waiting holds no job / worker.
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM workflow_jobs WHERE run_id = $1 AND status IN ('queued','running')", [run.id])).n, 0);
  const qs = await q(pool, "SELECT * FROM workflow_questions WHERE run_id = $1", [run.id]);
  assert.equal(qs.length, 1);
  const firstAttempt = (await attemptsOf(run.id, "plan"))[0];
  assert.equal(qs[0].attempt_id, firstAttempt.id);
  const cp = await one(pool, "SELECT * FROM workflow_checkpoints WHERE attempt_id = $1", [firstAttempt.id]);
  assert.equal(cp.data.session_id, "sess-1");

  const res = await answerQuestions({ [qs[0].id]: "Không" }, "dev");
  assert.deepEqual(res.resumed, [`${run.id}:plan`]);
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  const resumedCtx = seen.plan[1];
  assert.equal(resumedCtx.input.pending.resume.from_attempt_id, firstAttempt.id);
  assert.equal(resumedCtx.input.pending.resume.checkpoint.session_id, "sess-1");
  assert.equal((await stepOf(run.id, "plan")).output.decision, "Không");
  assert.equal(calls.analyze, 1, "completed analysis was not re-run");
  assert.equal((await attemptsOf(run.id, "plan")).length, 2);
});

test("Scenario C: failed implementation is retried without repeating analysis; history kept", async () => {
  const key = await customWorkflow([
    { key: "analyze", type: "agent" },
    { key: "plan", type: "agent", depends_on: ["analyze"] },
    { key: "implement", type: "coding_agent", depends_on: ["plan"], max_attempts: 2, retry_backoff_seconds: 0 },
    { key: "pr", type: "git_pull_request", depends_on: ["implement"] },
  ]);
  let broken = true;
  scripts.implement = async (ctx, n) => (broken ? { kind: "failed", error: `missing GOPRIVATE (call ${n})` } : codingDone(ctx, n));
  const run = await startRun({ definitionKey: key, inputs: { project: "OMS" }, repositories: ["oms-api"] });
  await drain();
  let st = await stepOf(run.id, "implement");
  assert.equal(st.status, "FAILED");
  assert.equal(calls.implement, 2, "automatic retry up to max_attempts");
  assert.equal((await getRun(run.id)).status, "FAILED");

  broken = false; // user fixes configuration
  await retryStep(run.id, "implement");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal(calls.analyze, 1);
  assert.equal(calls.plan, 1);
  const history = await attemptsOf(run.id, "implement");
  assert.deepEqual(history.map((a) => a.status), ["FAILED", "FAILED", "COMPLETED"]);
  assert.ok(history[0].invalidated_at && history[1].invalidated_at && !history[2].invalidated_at);
  assert.equal(history[2].generation, history[0].generation + 1);
});

test("Scenario D: code review workflow without a work item stores findings, no PR", async () => {
  scripts.analyze = () => ({ kind: "completed", output: { summary: "ok", findings: [{ severity: "medium", repo: "oms-api", file: "a.go", line: 3, issue: "nil deref", suggestion: "check" }] } });
  scripts.architecture = () => ({ kind: "completed", output: { summary: "fine", violations: [] } });
  scripts.security = () => ({ kind: "completed", output: { summary: "1 issue", findings: [{ severity: "high", repo: "oms-api", file: "b.go", line: 9, issue: "SQL injection", suggestion: "bind params" }] } });
  const run = await startRun({ definitionKey: "code-review", repositories: ["oms-api"], inputs: { focus: "refund" } });
  assert.equal(run.work_item_id, null);
  assert.equal(run.branch, `u${run.owner_id}-run-${run.id}`);
  await drain();
  assert.equal((await stepOf(run.id, "fix")).status, "WAITING_APPROVAL", "after the report the run offers to fix the findings");
  await skipStep(run.id, "fix", "report only");
  await drain();
  const d = await runDetail(run.id);
  assert.equal(d.status, "COMPLETED", "skipping the fix ends the run with the report only");
  assert.deepEqual(["fix_test", "fix_pr"].map((k) => d.steps.find((x) => x.key === k)!.status), ["SKIPPED", "SKIPPED"], "no test/PR questions when nothing was fixed");
  const report = d.steps.find((s) => s.key === "report")!;
  assert.equal(report.output.findings_count, 2);
  const art = await one(pool, "SELECT * FROM workflow_artifacts WHERE id = $1", [report.output.report_artifact_id]);
  assert.match(art.content, /SQL injection/);
  assert.equal(d.pull_requests.length, 0);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM work_items WHERE id IS NOT NULL AND code LIKE 'wf/%'")).n, 0);
});

test("Scenario E: imported Hasaki task does not execute until the user starts a workflow", async () => {
  const { item, created } = await importHasakiTask({ data: { id: 991, code: "TASK-991", name: "Sửa lỗi tồn kho", project: { name: "OMS" }, note: "WMS timeout" } });
  assert.ok(created);
  assert.equal(item.source, "hasaki_work");
  assert.equal(item.automation_policy, null);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM workflow_runs WHERE work_item_id = $1", [item.id])).n, 0);
  // re-import only refreshes
  const again = await importHasakiTask({ data: { id: 991, code: "TASK-991", name: "Sửa lỗi tồn kho (v2)", project: { name: "OMS" } } });
  assert.equal(again.created, false);
  assert.equal(again.item.title, "Sửa lỗi tồn kho (v2)");
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM workflow_jobs j JOIN workflow_runs r ON r.id = j.run_id WHERE r.work_item_id = $1", [item.id])).n, 0);

  const run = await startRun({ definitionKey: "work-item-analysis", workItemId: item.id });
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  // A second run of the same work item keeps the first one's history.
  const run2 = await startRun({ definitionKey: "work-item-analysis", workItemId: item.id });
  await drain();
  assert.notEqual(run2.id, run.id);
  assert.equal((await workItems.detail(item.id))!.runs.length, 2);
});

// ---------------------------------------------------------------- engine guarantees

test("re-executing an earlier step invalidates only its downstream steps", async () => {
  const key = await customWorkflow([
    { key: "a", type: "agent" },
    { key: "b", type: "agent", depends_on: ["a"] },
    { key: "c", type: "agent", depends_on: ["b"] },
    { key: "side", type: "agent", depends_on: ["a"] },
  ]);
  const run = await startRun({ definitionKey: key });
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  const cBefore = await stepOf(run.id, "c");
  await reexecuteStep(run.id, "b", { feedback: "use the v2 API" });
  const st = await statuses(run.id);
  assert.equal(st.a, "COMPLETED");
  assert.equal(st.side, "COMPLETED");
  assert.equal(st.c, "PENDING");
  assert.equal((await stepOf(run.id, "c")).output, null, "stale output is not exposed");
  await drain();
  assert.deepEqual([calls.a, calls.b, calls.c, calls.side], [1, 2, 2, 1]);
  assert.equal(seen.b[1].input.pending.feedback, "use the v2 API");
  // c's second attempt saw b's second attempt, not the stale one.
  const bAttempts = await attemptsOf(run.id, "b");
  assert.equal(seen.c[1].input.upstream.b.attempt_id, bAttempts[1].id);
  assert.equal((await stepOf(run.id, "c")).generation, cBefore.generation + 1);
});

test("a result computed from invalidated context is discarded (generation fencing)", async () => {
  const key = await customWorkflow([{ key: "a", type: "agent" }, { key: "b", type: "agent", depends_on: ["a"] }]);
  const run = await startRun({ definitionKey: key });
  await drain(); // a and b complete
  await reexecuteStep(run.id, "b");
  const job = (await claimJob("w-slow", 30))!;
  const begun = (await beginAttempt(job, "w-slow"))!;
  assert.equal(begun.step.key, "b");
  // While the slow worker runs, the user re-executes b again.
  await reexecuteStep(run.id, "a");
  const r = await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { stale: true } });
  assert.equal(r.applied, false);
  const att = await one(pool, "SELECT status FROM workflow_step_attempts WHERE id = $1", [begun.attempt.id]);
  assert.ok(["STALE", "CANCELED"].includes(att.status));
  await drain();
  assert.notEqual((await stepOf(run.id, "b")).output?.stale, true);
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("crashed worker: expired lease is reaped, step retried, zombie result rejected", async () => {
  const key = await customWorkflow([{ key: "a", type: "agent", max_attempts: 2, retry_backoff_seconds: 0 }]);
  const run = await startRun({ definitionKey: key });
  const job = (await claimJob("w-crash", 30))!;
  const begun = (await beginAttempt(job, "w-crash"))!;
  // Concurrent claim cannot take the same job.
  assert.equal(await claimJob("w-other", 30), undefined);
  await pool.query("UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
  assert.equal(await reapExpiredLeases(), 1);
  assert.equal((await stepOf(run.id, "a")).status, "WAITING_INPUT");
  const question = (await one(pool, "SELECT id FROM workflow_questions WHERE run_id = $1 AND status = 'open'", [run.id]))!;
  await answerQuestions({ [question.id]: "Reconciled — continue" });
  const zombie = await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { zombie: true } });
  assert.equal(zombie.applied, false);
  await drain();
  const a = await stepOf(run.id, "a");
  assert.equal(a.status, "COMPLETED");
  assert.notEqual(a.output?.zombie, true);
  const hist = await attemptsOf(run.id, "a");
  assert.equal(hist[0].status, "WAITING_INPUT");
  assert.match(hist[0].error.message, /lease expired/);
});

test("pause stops scheduling, resume continues; cancel stops everything", async () => {
  const key = await customWorkflow([{ key: "a", type: "agent" }, { key: "b", type: "agent", depends_on: ["a"] }]);
  const run = await startRun({ definitionKey: key });
  await pauseRun(run.id);
  assert.equal(await drain(), 0);
  assert.equal((await stepOf(run.id, "a")).status, "READY");
  await resumeRun(run.id);
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");

  const run2 = await startRun({ definitionKey: key });
  await cancelRun(run2.id);
  assert.equal(await drain(), 0);
  assert.deepEqual(await statuses(run2.id), { a: "CANCELED", b: "CANCELED" });
  await assert.rejects(retryStep(run2.id, "a"), /canceled/);
});

test("human_input step completes with answers; condition + run_if skip branches", async () => {
  const key = await customWorkflow([
    { key: "ask", type: "human_input", config: { questions: [{ question: "Deploy window?", options: ["night", "day"] }] } },
    { key: "check", type: "condition", depends_on: ["ask"], config: { path: "upstream.ask.output.answers.0.answer", op: "eq", value: "night" } },
    { key: "night_job", type: "agent", depends_on: ["check"], run_if: { step: "check", equals: true } },
    { key: "day_job", type: "agent", depends_on: ["check"], run_if: { step: "check", equals: false } },
  ]);
  const run = await startRun({ definitionKey: key });
  await drain();
  assert.equal((await stepOf(run.id, "ask")).status, "WAITING_INPUT");
  const [qq] = await q(pool, "SELECT id FROM workflow_questions WHERE run_id = $1", [run.id]);
  await answerQuestions({ [qq.id]: "night" });
  await drain();
  const st = await statuses(run.id);
  assert.equal(st.ask, "COMPLETED");
  assert.equal(st.night_job, "COMPLETED");
  assert.equal(st.day_job, "SKIPPED");
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("rejecting an approval re-executes the configured upstream step with feedback", async () => {
  const key = await customWorkflow([
    { key: "plan", type: "agent" },
    { key: "approve", type: "human_approval", depends_on: ["plan"], config: { show_outputs: ["plan"], on_reject: { reexecute: "plan" } } },
    { key: "build", type: "agent", depends_on: ["approve"] },
  ]);
  const run = await startRun({ definitionKey: key });
  await drain();
  assert.equal((await stepOf(run.id, "approve")).approval.request.outputs.plan.summary, "plan done");
  await rejectStep(run.id, "approve", { comment: "split the migration" });
  await drain();
  assert.equal(calls.plan, 2);
  assert.match(seen.plan[1].input.pending.feedback, /split the migration/);
  assert.equal((await stepOf(run.id, "approve")).status, "WAITING_APPROVAL");
  await approveStep(run.id, "approve");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("PR step: approval gate, draft mode, and no duplicate PRs on retry / feedback", async () => {
  const key = await customWorkflow(
    [
      { key: "implement", type: "coding_agent" },
      { key: "pr", type: "git_pull_request", depends_on: ["implement"], config: { mode: "approval", content_from: "implement" } },
    ],
    { feedback_step: "implement" },
  );
  scripts.implement = codingDone;
  const wi = await workItems.createManual({ title: "PR gate", project: "OMS" });
  const run = await startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-api"] });
  await drain();
  const pr = await stepOf(run.id, "pr");
  assert.equal(pr.status, "WAITING_APPROVAL");
  assert.equal(pr.approval.gate, true);
  assert.equal(prCalls.length, 0, "no PR before approval");
  await approveStep(run.id, "pr");
  await drain();
  assert.equal(prCalls.length, 1);

  await sendFeedback(run.id, "rename the field"); // review feedback → implement + pr re-run
  await drain();
  assert.equal((await stepOf(run.id, "pr")).status, "WAITING_APPROVAL", "gate applies again to the new generation");
  await approveStep(run.id, "pr");
  await drain();
  assert.equal(prCalls.length, 2);
  const rows = await q(pool, "SELECT * FROM pull_requests WHERE run_id = $1", [run.id]);
  assert.equal(rows.length, 1, "same PR updated, not duplicated");

  const draftKey = await customWorkflow([
    { key: "implement", type: "coding_agent" },
    { key: "pr", type: "git_pull_request", depends_on: ["implement"], config: { mode: "draft" } },
  ]);
  const run2 = await startRun({ definitionKey: draftKey, repositories: ["oms-background"], inputs: { project: "OMS" } });
  await drain();
  assert.equal(prCalls.at(-1)!.draft, true);
  assert.equal((await one(pool, "SELECT draft FROM pull_requests WHERE run_id = $1", [run2.id])).draft, true);
});

test("runs stay pinned to the definition version they started with", async () => {
  const key = await customWorkflow([{ key: "a", type: "agent" }]);
  const run1 = await startRun({ definitionKey: key, start: false });
  await definitions.saveDraft(key, { name: key, steps: [{ key: "a", type: "agent" }, { key: "b", type: "agent", depends_on: ["a"] }] });
  const pub = await definitions.publish(key, "add b");
  assert.equal(pub.version, 2);
  const run2 = await startRun({ definitionKey: key });
  assert.equal((await getRun(run1.id)).steps.length, 1);
  assert.equal(run2.steps.length, 2);
  assert.equal((await getRun(run1.id)).status, "PENDING", "start: false creates without executing");
  await assert.rejects(definitions.publish(key), /no draft/, "publishing consumes the draft");
  assert.equal((await definitions.get(key))!.versions.length, 2);
  await drain(); // leave no queued work behind for later tests
});

test("context snapshots record applied knowledge versions and are immutable", async () => {
  await knowledge.create({ key: "refund-once", category: "business_rule", scope_type: "PROJECT", scope_ref: "OMS", title: "Refund once", content: "A shipment is refunded at most once." });
  await knowledge.create({ key: "payment-only", category: "business_rule", scope_type: "PROJECT", scope_ref: "Payment", title: "Payment", content: "irrelevant" });
  const key = await customWorkflow([{ key: "a", type: "agent", config: { skills: ["security-review-test"] } }]);
  await knowledge.create({ key: "security-review-test", category: "agent_skill", scope_type: "GLOBAL", title: "Sec", content: "check authz", metadata: { required_tools: ["Read"] } });
  const run = await startRun({ definitionKey: key, inputs: { project: "OMS" } });
  await drain();
  const mine = () => seen.a.filter((c) => c.run.id === run.id);
  const keys1 = mine()[0].context.knowledge.map((k) => `${k.key}@${k.version}`).sort();
  assert.ok(keys1.includes("refund-once@1") && keys1.includes("security-review-test@1"));
  assert.ok(!keys1.some((k) => k.startsWith("payment-only")));

  await knowledge.update("refund-once", { content: "A shipment is refunded at most once, partial refunds included.", change_note: "clarify" });
  await reexecuteStep(run.id, "a");
  await drain();
  const keys2 = mine()[1].context.knowledge.map((k) => `${k.key}@${k.version}`);
  assert.ok(keys2.includes("refund-once@2"));
  const [s1] = await q(pool, "SELECT * FROM context_snapshots WHERE run_id = $1 ORDER BY id", [run.id]);
  assert.ok(s1.content.knowledge.some((k: any) => k.key === "refund-once" && k.version === 1), "old snapshot unchanged");
  await assert.rejects(pool.query("UPDATE context_snapshots SET hash = 'x' WHERE id = $1", [s1.id]), /immutable/);
  assert.equal((await knowledge.get("refund-once"))!.versions.length, 2);
});

test("command step is skipped (not failed) when the run changed no code", async () => {
  const key = await customWorkflow([
    { key: "implement", type: "coding_agent" },
    { key: "test", type: "command", depends_on: ["implement"], config: { command: "go test ./..." } },
    { key: "pr", type: "git_pull_request", depends_on: ["test"] },
  ]);
  scripts.implement = () => ({ kind: "completed", output: { summary: "already fixed upstream, no change" } });
  const run = await startRun({ definitionKey: key, repositories: ["oms-api"], inputs: { project: "OMS" } });
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal((await stepOf(run.id, "test")).output.skipped, true);
  assert.deepEqual((await stepOf(run.id, "pr")).output.pull_requests, []);
});

test("repository selection outside the allowed set is rejected at run start", async () => {
  await assert.rejects(startRun({ definitionKey: "code-review", repositories: ["payment-src"], inputs: { project: "OMS" } }), /not allowed/);
});

test("step mode: a paused run executes one chosen step at a time; inspector API and NOTIFY", async () => {
  const key = await customWorkflow([{ key: "a", type: "agent" }, { key: "b", type: "agent", depends_on: ["a"] }, { key: "c", type: "agent", depends_on: ["a"] }]);
  const listen = await pool.connect();
  const notes: string[] = [];
  listen.on("notification", (n) => notes.push(n.payload!));
  await listen.query("LISTEN workflow_events");
  const run = await startRun({ definitionKey: key, start: false });
  await startPendingRun(run.id, undefined, true);
  assert.equal((await getRun(run.id)).status, "PAUSED");
  assert.equal(await drain(), 0, "nothing runs by itself in step mode");
  await assert.rejects(runStepNow(run.id, "b"), /only READY/);
  await runStepNow(run.id, "a");
  assert.equal(await drain(), 1);
  assert.deepEqual(await statuses(run.id), { a: "COMPLETED", b: "READY", c: "READY" });
  assert.equal((await getRun(run.id)).status, "PAUSED");
  await runStepNow(run.id, "c");
  await drain();
  assert.deepEqual(await statuses(run.id), { a: "COMPLETED", b: "READY", c: "COMPLETED" });
  await resumeRun(run.id);
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  const d = await stepDetail(run.id, "a");
  assert.equal(d.attempts.length, 1);
  assert.equal(d.snapshots.length, 1);
  await new Promise((r) => setTimeout(r, 100));
  listen.release();
  assert.ok(notes.some((n) => JSON.parse(n).run_id === run.id), "events are announced for SSE");
});

test("light lane: short steps are claimable while a long agent/command step holds the general worker", async () => {
  const heavy = await customWorkflow([{ key: "long", type: "agent" }]);
  const light = await customWorkflow([{ key: "noop", type: "integration", config: { action: "noop" } }]);
  const r1 = await startRun({ definitionKey: heavy });
  const r2 = await startRun({ definitionKey: light });
  const busy = (await claimJob("general", 30))!; // the general worker takes the oldest job: the long agent step
  const begun = (await beginAttempt(busy, "general"))!;
  assert.equal(begun.step.key, "long");
  const st = await schedulerStatus();
  assert.ok(st.running.some((j: any) => j.run_id === r1.id && j.step_key === "long"));
  assert.ok(st.queued.some((j: any) => j.run_id === r2.id));
  assert.equal(await claimJob("light", 30, ["human_approval"]), undefined, "type filter is respected");
  const lj = (await claimJob("light", 30, LIGHT_STEP_TYPES))!;
  assert.equal(lj.run_id, r2.id);
  await finishAttempt(busy.id, busy.fencing_token, begun.attempt.id, { kind: "completed", output: {} });
  await pool.query("UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL WHERE id = $1", [lj.id]);
  await drain();
  assert.equal((await getRun(r2.id)).status, "COMPLETED");
});

test("command output streams while running; Stop kills the whole process tree and fails the step", async () => {
  const cwd = mkdtempSync(join(process.env.TEST_ROOT!, "cmd-"));
  const key = await customWorkflow([{ key: "slow", type: "command", config: { cwd, command: "echo started; (sleep 30; echo child-done) & sleep 30; echo finished" } }]);
  const run = await startRun({ definitionKey: key });
  const t0 = Date.now();
  const worker = runOnce("w-cmd", { leaseSeconds: 30, heartbeatSeconds: 1 });
  let logs: any[] = [];
  for (let i = 0; i < 50 && !logs.some((e) => e.content.includes("started")); i++) {
    await new Promise((r) => setTimeout(r, 200));
    logs = await q(pool, "SELECT kind, content FROM workflow_events WHERE run_id = $1 AND kind = 'log'", [run.id]);
  }
  assert.ok(logs.some((e) => e.content.includes("started")), "output is visible before the command finishes");
  await stopStep(run.id, "slow");
  await worker;
  assert.ok(Date.now() - t0 < 15000, "stop does not wait for sleep 30");
  const st = await stepOf(run.id, "slow");
  assert.equal(st.status, "FAILED");
  assert.match(st.error!, /stopped/);
  assert.equal((await attemptsOf(run.id, "slow"))[0].status, "CANCELED");
  const all = (await q(pool, "SELECT content FROM workflow_events WHERE run_id = $1 AND kind = 'log'", [run.id])).map((e) => e.content).join("");
  assert.ok(!all.includes("finished") && !all.includes("child-done"));
});

test("regression test step compares Go failures with the base branch (real go + git)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(process.env.TEST_ROOT!, "gomod-"));
  const sh = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  writeFileSync(join(dir, "go.mod"), "module example.com/m\n\ngo 1.21\n");
  mkdirSync(join(dir, "calc"));
  writeFileSync(join(dir, "calc/calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
  // pre-existing failure on base (like the integration test needing an unreachable DB)
  writeFileSync(join(dir, "calc/old_test.go"), 'package calc\n\nimport "testing"\n\nfunc TestNeedsDB(t *testing.T) { t.Fatal("dial tcp 172.16.200.135:3306: timeout") }\n');
  sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  sh("add", "."); sh("commit", "-qm", "base"); sh("update-ref", "refs/remotes/origin/release/prod", "HEAD");
  sh("checkout", "-qb", "TASK-1");
  writeFileSync(join(dir, "calc/calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n\nfunc Sub(a, b int) int { return a - b }\n");
  writeFileSync(join(dir, "calc/sub_test.go"), 'package calc\n\nimport "testing"\n\nfunc TestSub(t *testing.T) { if Sub(3, 1) != 2 { t.Fatal("bad") } }\n');
  sh("add", "."); sh("commit", "-qm", "add Sub");

  const key = await customWorkflow([{ key: "test", type: "command", config: { command: 'go test ${GO_TEST_SKIP:+-skip "$GO_TEST_SKIP"} ./...', baseline_compare: "go", on_failure: "fail", timeout_seconds: 300 } }]);
  const run = await startRun({ definitionKey: key, start: false });
  await recordWorkspace(run.id, { repo: "calc", branch: "TASK-1", path: dir, created_from: "test" });
  await startPendingRun(run.id);
  await drain();
  let st = await stepOf(run.id, "test");
  assert.equal(st.status, "COMPLETED", st.error ?? "");
  assert.deepEqual(st.output.results[0].baseline.pre_existing[0].tests, ["TestNeedsDB"]);
  assert.equal(st.output.results[0].baseline.regressions.length, 0);

  // now introduce a real regression on the branch
  writeFileSync(join(dir, "calc/calc.go"), "package calc\n\nfunc Add(a, b int) int { return a - b }\n\nfunc Sub(a, b int) int { return a - b }\n");
  writeFileSync(join(dir, "calc/add_test.go"), 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(1, 1) != 2 { t.Fatal("bad") } }\n');
  await reexecuteStep(run.id, "test");
  await drain();
  st = await stepOf(run.id, "test");
  assert.equal(st.status, "FAILED");
  assert.match(st.error!, /1 regression/);
  assert.match(st.error!, /TestAdd/);
  assert.doesNotMatch(st.error!, /TestNeedsDB/);
  // the pre-existing failure was persisted for this base SHA and is skipped on the next run (no re-run, no baseline pass)
  assert.ok((await q(pool, "SELECT 1 FROM test_baselines WHERE report->'tests' ? 'TestNeedsDB'")).length >= 1);
  await reexecuteStep(run.id, "test");
  await drain();
  st = await stepOf(run.id, "test");
  const r0 = (st.output ?? (await attemptsOf(run.id, "test")).at(-1)!.error.details).results[0];
  assert.deepEqual(r0.skipped_known_failures, ["TestNeedsDB"]);
});

test("server shutdown kills detached command process groups (no orphaned go test)", async () => {
  const { childGroups } = await import("../src/workflow/local.ts");
  const { execSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(process.env.TEST_ROOT!, "orphan-"));
  const marker = `orphan-marker-${Date.now()}`;
  const key = await customWorkflow([{ key: "slow", type: "command", config: { cwd, command: `sleep 30; echo ${marker}` } }]);
  await startRun({ definitionKey: key });
  const worker = runOnce("w-orphan", { leaseSeconds: 30, heartbeatSeconds: 5 });
  const alive = () => execSync(`ps -eo args | grep -c "[s]leep 30; echo ${marker}" || true`).toString().trim();
  for (let i = 0; i < 25 && alive() === "0"; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(), "1", "command is running");
  childGroups.killAll(); // what the SIGINT/SIGTERM handler and process exit do
  await worker;
  assert.equal(alive(), "0", "no orphaned process left");
});

test("context snapshot records the prompt plan; big upstream outputs are summarized; metrics are persisted", async () => {
  const key = await customWorkflow([
    { key: "investigate", type: "agent" },
    { key: "fix", type: "agent", depends_on: ["investigate"], config: { upstream_tokens: 800, instructions: "fix the refund" } },
  ]);
  scripts.investigate = () => ({ kind: "completed", output: { summary: "cause", evidence: Array.from({ length: 400 }, (_, i) => `a.go:${i} ${"x".repeat(60)}`) } });
  scripts.fix = async (ctx) => {
    await ctx.recordMetrics({ cost_usd: 0.42, turns: 7, tool_calls: { Read: 3 } });
    return { kind: "completed", output: { ok: true } };
  };
  const run = await startRun({ definitionKey: key });
  await drain();
  const fixCtx = seen.fix.find((c) => c.run.id === run.id)!;
  assert.equal(fixCtx.context.upstream.plan.investigate.mode, "summary");
  assert.ok(fixCtx.context.upstream.plan.investigate.tokens <= 800);
  const snap = await one(pool, "SELECT content FROM context_snapshots WHERE id = $1", [fixCtx.context.snapshot_id]);
  assert.equal(snap.content.prompt_plan.upstream.investigate.mode, "summary");
  assert.ok(Array.isArray(snap.content.prompt_plan.knowledge));
  assert.deepEqual(snap.content.prompt_plan.setting_sources, []);
  const a = (await attemptsOf(run.id, "fix"))[0];
  assert.equal(a.metrics.cost_usd, 0.42);
  const { runMetrics, metricsSummary } = await import("../src/api/metrics.ts");
  assert.equal((await runMetrics(run.id)).totals.cost_usd, 0.42);
  const summary = await metricsSummary(1);
  assert.ok(summary.tools.some((t: any) => t.tool === "Read"));
});

// ---------------------------------------------------------------- Task Result Report
const AI = {
  suggest_id: "855580c2",
  has_report_constraints: false,
  report: {
    "Kết quả test đơn hàng": ["Ảnh chụp thông tin đơn hàng sau khi fix hiển thị đầy đủ postal_code trong customer_info"],
    "Kiểm tra luồng mapping ZIP Code": ["Ảnh chụp code hoặc log thể hiện việc sửa lỗi mapping trường postal_code từ Ecom sang OMS"],
  },
  reasoning: "Staff cần báo cáo bằng chứng.",
  task_readiness: 0.2,
  object: "Mã đơn hàng",
  object_value: "261030US91TZ",
};
let reportSeq = 0;
async function reportItem(ai: unknown = AI) {
  const code = `RPT-${++reportSeq}`;
  return (await importHasakiTask({ data: { id: 9000 + reportSeq, code, name: "ZIP mapping", project: { name: "OMS" }, task_ai: { ai_verify: null, ai_suggest: ai } } })).item;
}
const branchy = () =>
  customWorkflow([
    { key: "implement", type: "coding_agent" },
    { key: "test", type: "command", depends_on: ["implement"], config: { command: "echo ok" } },
    { key: "review", type: "agent", depends_on: ["implement"] },
  ]);

test("report step: appended to the run graph only, last, depending on every terminal step; definition untouched", async () => {
  const key = await branchy();
  const wi = await reportItem();
  const run = await startRun({ definitionKey: key, workItemId: wi.id });
  const st = run.steps.find((s) => s.key === REPORT_STEP_KEY)!;
  assert.equal(st.type, "task_result_report");
  assert.deepEqual([...st.depends_on].sort(), ["review", "test"], "all terminal steps");
  assert.equal(st.position, Math.max(...run.steps.map((s) => s.position)), "last node");
  assert.equal(run.graph.steps.at(-1)!.key, REPORT_STEP_KEY);
  const def = (await definitions.get(key))!;
  assert.ok(!def.versions[0].spec.steps.some((s: any) => s.key === REPORT_STEP_KEY), "published definition is not mutated");
  assert.equal(def.latest_version, 1);
  await cancelRun(run.id);
});

test("report step: not added without ai_suggest, with null suggest, or an empty report; existing workflows unaffected", async () => {
  const key = await branchy();
  for (const ai of [null, { report: {} }, { report: { A: [] } }]) {
    const wi = await reportItem(ai);
    const run = await startRun({ definitionKey: key, workItemId: wi.id });
    assert.ok(!run.steps.some((s) => s.key === REPORT_STEP_KEY), JSON.stringify(ai));
    await cancelRun(run.id);
  }
  const noItem = await startRun({ definitionKey: key });
  assert.ok(!noItem.steps.some((s) => s.key === REPORT_STEP_KEY));
  await cancelRun(noItem.id);
});

test("report step: never inserted twice (idempotent; custom workflow that already has one)", async () => {
  const { parseAiSuggest } = await import("../src/report/aiSuggest.ts");
  const ai = parseAiSuggest({ task_ai: { ai_suggest: AI } });
  const spec: any = { name: "x", steps: [{ key: "a", type: "agent", depends_on: [], config: {} }] };
  const once = withReportStep(spec, ai);
  assert.equal(withReportStep(once, ai), once);
  assert.equal(once.steps.filter((s) => s.key === REPORT_STEP_KEY).length, 1);
  const key = await customWorkflow([{ key: "a", type: "agent" }, { key: "my_report", type: "task_result_report", depends_on: ["a"] }]);
  const run = await startRun({ definitionKey: key, workItemId: (await reportItem()).id });
  assert.equal(run.steps.filter((s) => s.type === "task_result_report").length, 1);
  await cancelRun(run.id);
});

test("report flow: draft waits for review (run not COMPLETED), evidence upload + regenerate, approve with limitations", async () => {
  const key = await branchy();
  scripts.implement = codingDone;
  const wi = await reportItem();
  const run = await startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-api"] });
  await drain();
  let rep = await stepOf(run.id, REPORT_STEP_KEY);
  assert.equal(rep.status, "WAITING_APPROVAL");
  assert.equal((await getRun(run.id)).status, "WAITING", "run is not COMPLETED while the report awaits review");
  let draft = rep.approval.request.report;
  const reqs = draft.sections.flatMap((s: any) => s.requirements);
  const shot = reqs.find((r: any) => r.text.startsWith("Ảnh chụp thông tin"));
  const code = reqs.find((r: any) => r.text.startsWith("Ảnh chụp code"));
  assert.equal(shot.status, "MISSING", "fake reasoner said VERIFIED, rules say no screenshot");
  assert.equal(code.status, "VERIFIED");
  assert.ok(!code.evidence.some((e: any) => e.id === "E999"));
  assert.ok(rep.approval.request.markdown.includes("❌ **THIẾU**"));
  const drafts1 = await q(pool, "SELECT id FROM workflow_artifacts WHERE step_id = $1 AND kind = 'report'", [rep.id]);
  assert.equal(drafts1.length, 1, "draft persisted as an artifact");

  // user attaches the missing screenshot to that requirement, then regenerates
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  await addEvidence(run.id, REPORT_STEP_KEY, { requirement_id: shot.id, name: "order.png", mime: "image/png", data_base64: png });
  await assert.rejects(addEvidence(run.id, REPORT_STEP_KEY, { name: "x.exe", mime: "application/x-msdownload", data_base64: png }), /unsupported/);
  await reexecuteStep(run.id, REPORT_STEP_KEY, { feedback: "regenerate" });
  await drain();
  rep = await stepOf(run.id, REPORT_STEP_KEY);
  draft = rep.approval.request.report;
  assert.equal(draft.sections.flatMap((s: any) => s.requirements).find((r: any) => r.id === shot.id).status, "VERIFIED");
  assert.equal((await q(pool, "SELECT id FROM workflow_artifacts WHERE step_id = $1 AND kind = 'report'", [rep.id])).length, 2, "previous draft kept");

  // approve with an edited markdown
  await approveStep(run.id, REPORT_STEP_KEY, { comment: "ok", by: "toan", data: { markdown: "# Báo cáo (đã sửa)\n" } });
  await drain();
  rep = await stepOf(run.id, REPORT_STEP_KEY);
  assert.equal(rep.status, "COMPLETED");
  assert.equal(rep.output.final, true);
  assert.equal(rep.output.markdown, "# Báo cáo (đã sửa)\n");
  assert.equal(rep.output.report.approval.by, "toan");
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("report: approving with missing evidence records limitations instead of claiming verification", async () => {
  const key = await customWorkflow([{ key: "implement", type: "coding_agent" }]);
  scripts.implement = codingDone;
  const run = await startRun({ definitionKey: key, workItemId: (await reportItem()).id, repositories: ["oms-api"] });
  await drain();
  await approveStep(run.id, REPORT_STEP_KEY, {});
  await drain();
  const rep = await stepOf(run.id, REPORT_STEP_KEY);
  assert.equal(rep.output.report.approval.with_unverified_requirements, 1);
  assert.ok(rep.output.limitations.some((l: string) => /chưa xác minh/.test(l)));
  assert.match(rep.output.markdown, /THIẾU/);
  assert.match(rep.output.markdown, /## Phê duyệt/);
});

test("report: re-executing an upstream step invalidates the report; the new draft uses the latest evidence", async () => {
  const key = await customWorkflow([{ key: "implement", type: "coding_agent" }]);
  let version = 1;
  scripts.implement = async (ctx, n) => {
    await codingDone(ctx, n);
    return { kind: "completed", output: { summary: `implementation v${version}`, pull_requests: {} } };
  };
  const run = await startRun({ definitionKey: key, workItemId: (await reportItem()).id, repositories: ["oms-api"] });
  await drain();
  const first = await stepOf(run.id, REPORT_STEP_KEY);
  assert.ok(first.approval.request.evidence.some((e: any) => e.detail.includes("implementation v1")));
  version = 2;
  await reexecuteStep(run.id, "implement", { feedback: "again" });
  const mid = await stepOf(run.id, REPORT_STEP_KEY);
  assert.equal(mid.status, "PENDING");
  assert.equal(mid.generation, first.generation + 1);
  await drain();
  const second = await stepOf(run.id, REPORT_STEP_KEY);
  const ev = second.approval.request.evidence;
  assert.ok(ev.some((e: any) => e.detail.includes("implementation v2")) && !ev.some((e: any) => e.detail.includes("implementation v1")));
  // approving now finalizes from the CURRENT generation's draft, not the invalidated one
  await approveStep(run.id, REPORT_STEP_KEY, {});
  await drain();
  assert.match((await stepOf(run.id, REPORT_STEP_KEY)).output.report.summary, /Đã sửa/);
});

test("report: a worker crash while generating is recovered from PostgreSQL (lease reaped, retried, draft persisted)", async () => {
  const key = await customWorkflow([{ key: "implement", type: "coding_agent" }]);
  scripts.implement = codingDone;
  const run = await startRun({ definitionKey: key, workItemId: (await reportItem()).id, repositories: ["oms-api"] });
  await drain(); // implement done; report generated
  await reexecuteStep(run.id, REPORT_STEP_KEY);
  const job = (await claimJob("w-report-crash", 30))!;
  const begun = (await beginAttempt(job, "w-report-crash"))!;
  assert.equal(begun.step.key, REPORT_STEP_KEY);
  await pool.query("UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
  await reapExpiredLeases();
  assert.equal((await stepOf(run.id, REPORT_STEP_KEY)).status, "READY");
  await pool.query("UPDATE workflow_jobs SET available_at = now() WHERE run_id = $1 AND status = 'queued'", [run.id]); // skip the 5s backoff
  await drain();
  const rep = await stepOf(run.id, REPORT_STEP_KEY);
  assert.equal(rep.status, "WAITING_APPROVAL");
  const persisted = await q(pool, "SELECT a.status FROM workflow_step_attempts a WHERE a.step_id = $1 ORDER BY a.number", [rep.id]);
  assert.deepEqual(persisted.map((a) => a.status), ["WAITING_APPROVAL", "STALE", "WAITING_APPROVAL"], "history kept: first draft, crashed attempt, new draft");
});

// ---------------------------------------------------------------- execution profiles & reuse
async function zipItem(extra: Record<string, unknown> = {}) {
  const code = `PERF-${++reportSeq}`;
  return (await importHasakiTask({ data: { id: 9500 + reportSeq, code, name: "[Bug] Thiếu ZIP Code đơn Ecom US", note: "postal_code mapping bị mất", project: { name: "OMS" }, ...extra } })).item;
}

test("AUTO profile: small known-repo bug runs FAST (one Claude step instead of four), graph persisted, preview matches", async () => {
  const wi = await zipItem();
  const prev = await previewRun({ definitionKey: "bug-investigation", workItemId: wi.id, repositories: ["oms-api"] });
  assert.equal(prev.profile.profile, "FAST");
  const run = await startRun({ definitionKey: "bug-investigation", workItemId: wi.id, repositories: ["oms-api"] });
  assert.equal(run.profile, "FAST");
  assert.deepEqual(run.steps.map((s) => s.key), prev.graph.steps.map((s: any) => s.key));
  assert.equal(run.steps.filter((s) => s.type === "agent" || s.type === "coding_agent").length, 1);
  assert.equal((run.graph as any).profile, "FAST");
  assert.ok((run.graph as any).profile_changes.length >= 4);
  scripts.implement = codingDone;
  await drain();
  // confirm_repos auto-approved (repository known), PR gate still waits for a human
  assert.equal((await stepOf(run.id, "confirm_repos")).status, "COMPLETED");
  assert.equal((await stepOf(run.id, "pr")).status, "WAITING_APPROVAL");
  const implCtx = seen.implement.find((c) => c.run.id === run.id)!;
  assert.match(String(implCtx.step.config.instructions), /FAST profile/);
  assert.equal(calls.analyze ?? 0, 0, "no separate analysis session");
  await approveStep(run.id, "pr");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("profiles: manual override and high-risk fallback; FAST keeps the Task Result Report", async () => {
  const wi = await zipItem();
  const std = await startRun({ definitionKey: "bug-investigation", workItemId: wi.id, repositories: ["oms-api"], profile: "STANDARD", start: false });
  assert.equal(std.profile, "STANDARD");
  assert.equal(std.steps.length, 9);
  const pay = (await importHasakiTask({ data: { id: 9800 + ++reportSeq, code: `PAY-${reportSeq}`, name: "[Bug] Refund field mapping sai", project: { name: "OMS" } } })).item;
  const p = await startRun({ definitionKey: "bug-investigation", workItemId: pay.id, repositories: ["oms-api"], start: false });
  assert.equal(p.profile, "STANDARD");
  const rep = await zipItem({ task_ai: { ai_suggest: AI } });
  const fast = await startRun({ definitionKey: "feature-implementation", workItemId: rep.id, repositories: ["oms-api"], start: false });
  assert.equal(fast.profile, "FAST");
  const r = fast.steps.find((s) => s.key === REPORT_STEP_KEY)!;
  assert.deepEqual(r.depends_on, ["pr"], "report depends on the FAST graph's terminal step");
  assert.equal(fast.steps.filter((s) => s.key === REPORT_STEP_KEY).length, 1);
  const cr = await startRun({ definitionKey: "code-review", repositories: ["oms-api"], profile: "FAST", start: false });
  assert.equal(cr.profile, "STANDARD", "FAST not applicable → STANDARD");
  assert.match(JSON.stringify(cr.profile_decision), /not applicable/);
  for (const id of [std.id, p.id, fast.id, cr.id]) await cancelRun(id);
});

test("FAST is resumable: a question inside the merged step pauses and resumes the same step", async () => {
  const wi = await zipItem();
  scripts.implement = async (ctx, n) => {
    if (n === 1) {
      await ctx.ask([{ question: "ZIP+4: cắt 5 số đầu?", options: ["Có", "Không"] }]);
      return { kind: "waiting_input", checkpoint: { session_id: "s-fast" } };
    }
    return codingDone(ctx, n);
  };
  const run = await startRun({ definitionKey: "bug-investigation", workItemId: wi.id, repositories: ["oms-api"] });
  await drain();
  assert.equal((await stepOf(run.id, "implement")).status, "WAITING_INPUT");
  const [qq] = await q(pool, "SELECT id FROM workflow_questions WHERE run_id = $1", [run.id]);
  await answerQuestions({ [qq.id]: "Có" });
  await drain();
  assert.equal((await stepOf(run.id, "implement")).status, "COMPLETED");
  assert.equal(seen.implement.filter((c) => c.run.id === run.id)[1].input.pending.resume.checkpoint.session_id, "s-fast");
  await cancelRun(run.id);
});

test("reuse: a second run of the same work item reuses confirmed repositories and skips re-ranking", async () => {
  const wi = await zipItem();
  const r1 = await startRun({ definitionKey: "bug-investigation", workItemId: wi.id, repositories: ["oms-background"], profile: "STANDARD" });
  await cancelRun(r1.id);
  const prev = await previewRun({ definitionKey: "bug-investigation", workItemId: wi.id, profile: "STANDARD" });
  assert.equal(prev.reused_repositories, true);
  assert.deepEqual(prev.selected_repositories, ["oms-background"]);
  const r2 = await startRun({ definitionKey: "bug-investigation", workItemId: wi.id, profile: "STANDARD" });
  await drain();
  const disc = await stepOf(r2.id, "discover");
  assert.equal(disc.output.method, "reused");
  assert.deepEqual(disc.output.recommended, ["oms-background"]);
  await cancelRun(r2.id);
});

test("context reuse: file references flow from upstream attempts; invalidated attempts are not reused", async () => {
  const key = await customWorkflow([{ key: "analyze", type: "agent" }, { key: "implement", type: "coding_agent", depends_on: ["analyze"] }]);
  let target = "app/repos/address_repo.go";
  scripts.analyze = async (ctx) => {
    await ctx.log("tool", `Read ${target}`, { id: `t-${target}`, name: "Read", input: { file_path: `/w/${target}` } });
    return { kind: "completed", output: { summary: "found", files: ["pkg/utils/string.go:42"] } };
  };
  const run = await startRun({ definitionKey: key });
  await drain();
  const refs1 = seen.implement.find((c) => c.run.id === run.id)!.context.fileRefs.map((f) => f.path);
  assert.ok(refs1.includes("/w/app/repos/address_repo.go") && refs1.includes("pkg/utils/string.go:42"));
  target = "app/usecases/order.go";
  await reexecuteStep(run.id, "analyze");
  await drain();
  const refs2 = seen.implement.filter((c) => c.run.id === run.id)[1].context.fileRefs.map((f) => f.path);
  assert.ok(refs2.includes("/w/app/usecases/order.go"));
  assert.ok(!refs2.includes("/w/app/repos/address_repo.go"), "refs from the invalidated attempt are not handed on");
  const snap = await one(pool, "SELECT content FROM context_snapshots WHERE id = $1", [seen.implement.filter((c) => c.run.id === run.id)[1].context.snapshot_id]);
  assert.ok(snap.content.prompt_plan.file_refs.length >= 1, "recorded in the snapshot");
});

test("report: deterministic generation (no Claude call) when no requirement needs semantic judgement", async () => {
  let reasonerCalls = 0;
  setReportReasoner(async () => (reasonerCalls++, { requirements: [] }));
  const key = await customWorkflow([{ key: "implement", type: "coding_agent" }]);
  scripts.implement = codingDone;
  const onlyShots = { report: { "Kết quả": ["Ảnh chụp màn hình đơn hàng sau khi fix"] } };
  const run = await startRun({ definitionKey: key, workItemId: (await reportItem(onlyShots)).id, repositories: ["oms-api"] });
  await drain();
  assert.equal((await stepOf(run.id, REPORT_STEP_KEY)).status, "WAITING_APPROVAL");
  assert.equal(reasonerCalls, 0);
  const run2 = await startRun({ definitionKey: key, workItemId: (await reportItem()).id, repositories: ["oms-api"] });
  await drain();
  assert.equal(reasonerCalls, 1, "code/log requirement with evidence → semantic judgement");
  for (const id of [run.id, run2.id]) await cancelRun(id);
});

test("work item description: manual edits survive re-import and reach the agent prompt", async () => {
  const { buildUserPrompt } = await import("../src/agent/stepPrompt.ts");
  const code = `DESC-${++reportSeq}`;
  const payload = { data: { id: 99100 + reportSeq, code, name: "[Bug] Sai trạng thái", note: "", project: { name: "OMS" } } };
  const { item } = await importHasakiTask(payload);
  assert.equal(item.description, "");
  await workItems.update(item.id, { description: "Đơn 123: trạng thái phải là Delivered sau khi GHN callback." });
  const again = await importHasakiTask(payload); // Hasaki still sends an empty note
  assert.equal(again.item.description, "Đơn 123: trạng thái phải là Delivered sau khi GHN callback.");
  const changed = await importHasakiTask({ data: { ...payload.data, note: "note from Hasaki" } });
  assert.equal(changed.item.description, "Đơn 123: trạng thái phải là Delivered sau khi GHN callback.", "manual edit wins over a later imported note");
  const wi = (await workItems.get(item.id))!;
  const prompt = buildUserPrompt({ run: { inputs: {}, selected_repositories: [] }, work_item: wi, upstream: {}, answers: [], pending: null } as any, []);
  assert.match(prompt, /GHN callback/);
});

// ---------------------------------------------------------------- Telegram notifications
test("telegram: one message per step entering WAITING_INPUT / WAITING_APPROVAL, deep link to the step, never fails the workflow", async () => {
  const { createServer } = await import("node:http");
  const { config } = await import("../src/config.ts");
  const msgs: any[] = [];
  let status = 200;
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      msgs.push({ path: req.url, ...JSON.parse(body) });
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(status === 200 ? { ok: true } : { ok: false, description: "Bad Request: chat not found" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const saved = { ...config.telegram, publicUrl: config.publicUrl };
  Object.assign(config.telegram, { botToken: "TEST:TOKEN", chatId: "42", apiBase: `http://127.0.0.1:${port}` });
  config.publicUrl = "http://localhost:4545";
  const { ensureTestOwner } = await import("../src/auth/testOwner.ts");
  const { putUserSecret } = await import("../src/auth/secrets.ts");
  await putUserSecret(await ensureTestOwner(), "telegram_chat", "42");
  try {
    const key = await customWorkflow([
      { key: "ask", type: "human_input", name: "Hỏi rule", config: { questions: [{ question: "COD?" }, { question: "Refund?" }] } },
      { key: "approve", type: "human_approval", name: "Duyệt kế hoạch", depends_on: ["ask"], config: { message: "Duyệt kế hoạch fix" } },
      { key: "gated", type: "agent", name: "Gated step", depends_on: ["approve"], requires_approval: true },
    ]);
    const run = await startRun({ definitionKey: key, title: "HSK-1: Thiếu <ZIP>" });
    await drain();
    assert.equal(msgs.length, 1, "WAITING_INPUT → exactly one message (no extra run-level WAITING message)");
    assert.equal(msgs[0].path, "/botTEST:TOKEN/sendMessage");
    assert.equal(msgs[0].chat_id, "42");
    assert.match(msgs[0].text, /CẦN BẠN TRẢ LỜI/);
    assert.match(msgs[0].text, /<b>HSK-1: Thiếu &lt;ZIP&gt;<\/b>/, "HTML-escaped task name");
    assert.match(msgs[0].text, new RegExp(`Run: #${run.id}`));
    assert.match(msgs[0].text, /Bước: <b>Hỏi rule<\/b> · <code>ask<\/code>/);
    assert.match(msgs[0].text, /2 câu hỏi cần trả lời/);
    assert.equal(msgs[0].reply_markup, undefined, "local publicUrl → no URL button");
    assert.ok(msgs[0].text.includes(`/#/runs/${run.id}/ask`), "local link as text");
    // Telegram drops localhost links; 127.0.0.1 stays clickable, as an <a href>
    const local = `http://127.0.0.1:4545/#/runs/${run.id}/ask`;
    assert.ok(msgs[0].text.includes(`<a href="${local}">Mở để trả lời</a>`), msgs[0].text);
    assert.ok(!msgs[0].text.includes("localhost"));
    // HTTPS publicUrl → inline URL button
    config.publicUrl = "https://platform.example.com";
    const qs = await q(pool, "SELECT id FROM workflow_questions WHERE run_id = $1", [run.id]);
    await answerQuestions(Object.fromEntries(qs.map((x) => [x.id, "ok"])));
    await drain();
    assert.equal(msgs.length, 2, "WAITING_APPROVAL → one more message");
    assert.match(msgs[1].text, /CẦN BẠN DUYỆT/);
    assert.match(msgs[1].text, /Duyệt kế hoạch fix/);
    assert.deepEqual(msgs[1].reply_markup.inline_keyboard[0][0], { text: "Mở để duyệt", url: `https://platform.example.com/#/runs/${run.id}/approve` });
    assert.ok(!msgs[1].text.includes("<a href"), "no duplicate text link when the button exists");
    // Telegram failing (HTTP 400) must not affect the workflow; the approval gate still notifies
    status = 400;
    await approveStep(run.id, "approve");
    await drain();
    assert.equal(msgs.length, 3, "approval gate (requires_approval) → one message");
    assert.equal(msgs[2].reply_markup.inline_keyboard[0][0].url, `https://platform.example.com/#/runs/${run.id}/gated`);
    assert.equal((await stepOf(run.id, "gated")).status, "WAITING_APPROVAL");
    // unreachable API: still no effect on the workflow
    config.telegram.apiBase = "http://127.0.0.1:1";
    await approveStep(run.id, "gated");
    await drain();
    assert.equal((await getRun(run.id)).status, "COMPLETED");
    // not configured → nothing sent
    Object.assign(config.telegram, { botToken: "", apiBase: `http://127.0.0.1:${port}` });
    const run2 = await startRun({ definitionKey: key });
    await drain();
    assert.equal(msgs.length, 3);
    await cancelRun(run2.id);
  } finally {
    Object.assign(config.telegram, { botToken: saved.botToken, chatId: saved.chatId, apiBase: saved.apiBase });
    config.publicUrl = saved.publicUrl;
    srv.close();
  }
});

// ---------------------------------------------------------------- interactive test failure handling (real go + git)
async function goRepo(opts: { baseFailing: boolean; branchBug: boolean }) {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(process.env.TEST_ROOT!, "tf-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  writeFileSync(join(dir, "go.mod"), "module example.com/m\n\ngo 1.21\n");
  mkdirSync(join(dir, "calc"));
  writeFileSync(join(dir, "calc/calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
  writeFileSync(join(dir, "calc/add_test.go"), 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(1, 1) != 2 { t.Fatal("Add(1,1) != 2") } }\n');
  if (opts.baseFailing) writeFileSync(join(dir, "calc/db_test.go"), 'package calc\n\nimport "testing"\n\nfunc TestNeedsDB(t *testing.T) { t.Fatal("failed to initialize database, got error dial tcp 172.16.200.135:3306: connect: connection timed out") }\n');
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  g("add", "."); g("commit", "-qm", "base"); g("update-ref", "refs/remotes/origin/release/prod", "HEAD");
  g("checkout", "-qb", "TASK-TF");
  if (opts.branchBug) writeFileSync(join(dir, "calc/calc.go"), "package calc\n\nfunc Add(a, b int) int { return a - b }\n");
  else writeFileSync(join(dir, "calc/calc.go"), "package calc\n\n// Add adds.\nfunc Add(a, b int) int { return a + b }\n");
  g("commit", "-qam", "change");
  return dir;
}
async function tfRun(dir: string) {
  const key = await customWorkflow([
    { key: "implement", type: "coding_agent" },
    { key: "test", type: "command", depends_on: ["implement"], config: { command: "go test ./...", baseline_compare: "go", timeout_seconds: 300 } },
    { key: "pr", type: "git_pull_request", depends_on: ["test"] },
  ]);
  scripts.implement = async (ctx) => {
    await recordWorkspace(ctx.run.id, { repo: "calc", branch: "TASK-TF", path: dir, created_from: "test" });
    return { kind: "completed", output: { summary: "changed calc", pull_requests: {} } };
  };
  const run = await startRun({ definitionKey: key, repositories: ["oms-api"], inputs: { project: "OMS" } });
  await drain();
  return run;
}
const openQ = async (runId: number) => q(pool, "SELECT * FROM workflow_questions WHERE run_id = $1 AND status = 'open' ORDER BY id", [runId]);
const liveJobs = async (runId: number) => (await one(pool, "SELECT count(*)::int AS n FROM workflow_jobs WHERE run_id = $1 AND status IN ('queued','running')", [runId])).n;

test("test failure 1/4: only baseline failures → diagnosis, confirmation required, exception recorded, test stays FAILED", async () => {
  setTestFailureAdvisor({ explain: async () => ({ text: "TestNeedsDB cần DB nội bộ; cũng fail trên baseline.", suggestion: "Có thể tiếp tục với ngoại lệ." }), interpret: async () => ({ kind: "unclear", question: "Bạn muốn chạy lại hay tiếp tục?" }) });
  const dir = await goRepo({ baseFailing: true, branchBug: false });
  const run = await tfRun(dir);
  let st = await stepOf(run.id, "test");
  assert.equal(st.status, "WAITING_INPUT");
  assert.equal(await liveJobs(run.id), 0, "worker released while waiting");
  const a1 = (await attemptsOf(run.id, "test")).at(-1)!;
  const d = a1.output.diagnosis;
  assert.equal(d.command, "go test ./...");
  assert.equal(d.results[0].exit_code, 1);
  assert.deepEqual(d.counts, { pre_existing: 1, new: 0, environment: 0, insufficient: 0 });
  assert.equal(d.failures[0].test, "TestNeedsDB");
  assert.match(d.failures[0].log, /dial tcp 172\.16\.200\.135/);
  assert.ok(d.failures[0].env_signal);
  assert.match(d.explanation.text, /baseline/);
  let [q1] = await openQ(run.id);
  assert.ok(q1.options.includes(OPTIONS.accept));
  // "tiếp tục" without explicit confirmation → asked again
  await answerQuestions({ [q1.id]: "tiếp tục" });
  await drain();
  st = await stepOf(run.id, "test");
  assert.equal(st.status, "WAITING_INPUT");
  [q1] = await openQ(run.id);
  assert.match(q1.question, /xác nhận/);
  await answerQuestions({ [q1.id]: OPTIONS.accept });
  await drain();
  st = await stepOf(run.id, "test");
  assert.equal(st.status, "COMPLETED");
  assert.equal(st.output.test_status, "FAILED");
  assert.equal(st.output.passed, false);
  assert.equal(st.output.accepted_exception.failures[0].test, "TestNeedsDB");
  const exc = await testExceptionsOf(run.id);
  assert.equal(exc.length, 1);
  assert.match(prDescription({ runId: run.id, summary: "", decisions: [], commits: "", testExceptions: exc }), /Test exceptions[\s\S]*TestNeedsDB/);
  assert.equal((await stepOf(run.id, "pr")).status, "COMPLETED");
});

test("test failure 2/4: new failure → accept refused; 'Sửa rồi test lại' re-executes the coding step with instructions, tests rerun", async () => {
  setTestFailureAdvisor(null);
  const dir = await goRepo({ baseFailing: false, branchBug: true });
  const run = await tfRun(dir);
  let [qq] = await openQ(run.id);
  const d = (await attemptsOf(run.id, "test")).at(-1)!.output.diagnosis;
  assert.deepEqual(d.counts, { pre_existing: 0, new: 1, environment: 0, insufficient: 0 });
  assert.equal(d.failures[0].test, "TestAdd");
  assert.equal(d.explanation.by, "rules");
  assert.ok(!qq.options.includes(OPTIONS.accept), "accept is not offered");
  await answerQuestions({ [qq.id]: "Tiếp tục với lỗi baseline (tôi xác nhận ngoại lệ)" });
  await drain();
  assert.equal((await stepOf(run.id, "test")).status, "WAITING_INPUT", "refused: not all failures are on the baseline");
  [qq] = await openQ(run.id);
  assert.match(qq.question, /Không thể tiếp tục/);
  const { writeFileSync } = await import("node:fs");
  scripts.implement = async (ctx) => {
    assert.match(ctx.input.pending.feedback, /Add phải cộng/);
    assert.match(ctx.input.pending.feedback, /TestAdd/);
    writeFileSync(join(dir, "calc/calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
    await recordWorkspace(ctx.run.id, { repo: "calc", branch: "TASK-TF", path: dir, created_from: "test" });
    return { kind: "completed", output: { summary: "fixed Add", pull_requests: {} } };
  };
  await answerQuestions({ [qq.id]: "Sửa rồi test lại: Add phải cộng chứ không trừ" });
  await drain();
  const st = await stepOf(run.id, "test");
  assert.equal(st.status, "COMPLETED");
  assert.equal(st.output.passed, true);
  const hist = await attemptsOf(run.id, "test");
  assert.ok(hist.some((a) => a.output?.decision?.kind === "fix" && a.output.decision.target === "implement"), "decision recorded on the attempt");
  assert.ok(hist.length >= 3 && hist.some((a) => a.invalidated_at), "old attempts kept (invalidated)");
});

test("test failure 3/4: old + new failures shown separately; rerun creates a new attempt keeping old logs; stop fails the step", async () => {
  setTestFailureAdvisor(null);
  const dir = await goRepo({ baseFailing: true, branchBug: true });
  const run = await tfRun(dir);
  const d = (await attemptsOf(run.id, "test")).at(-1)!.output.diagnosis;
  assert.equal(d.counts.pre_existing, 1);
  assert.equal(d.counts.new, 1);
  assert.equal(d.all_pre_existing, false);
  assert.deepEqual(d.failures.map((f: any) => `${f.test}:${f.category}`).sort(), ["TestAdd:new", "TestNeedsDB:pre_existing"]);
  let [qq] = await openQ(run.id);
  await answerQuestions({ [qq.id]: OPTIONS.rerun });
  await drain();
  const hist = await attemptsOf(run.id, "test");
  assert.equal(hist.length, 2);
  assert.equal(hist[1].output.decision.kind, "rerun");
  assert.ok(hist[1].output.diagnosis, "rerun failed again → diagnosed and asked again");
  assert.equal((await q(pool, "SELECT count(*)::int AS n FROM workflow_artifacts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = 'test' AND a.kind = 'log'", [run.id]))[0].n, 2, "both attempts' logs kept");
  [qq] = await openQ(run.id);
  await answerQuestions({ [qq.id]: OPTIONS.stop });
  await drain();
  const st = await stepOf(run.id, "test");
  assert.equal(st.status, "FAILED");
  assert.match(st.error!, /stopped after test failure/);
  assert.equal((await getRun(run.id)).status, "FAILED");
});

test("test failure 4/4: waiting state survives a restart (all in PostgreSQL); duplicate or stale answers trigger no job", async () => {
  setTestFailureAdvisor(null);
  const dir = await goRepo({ baseFailing: true, branchBug: false });
  const run = await tfRun(dir);
  const [qq] = await openQ(run.id);
  // "restart": nothing in memory is needed — question, diagnosis and checkpoint are read back from the database
  const detail = await stepDetail(run.id, "test");
  assert.equal(detail.step.status, "WAITING_INPUT");
  assert.equal(detail.questions.filter((x: any) => x.status === "open").length, 1);
  assert.equal(detail.checkpoints.at(-1).data.test_failure.counts.pre_existing, 1);
  assert.equal(await liveJobs(run.id), 0);
  await answerQuestions({ [qq.id]: OPTIONS.rerun });
  assert.equal(await liveJobs(run.id), 1, "exactly one job for the answer");
  await assert.rejects(answerQuestions({ [qq.id]: OPTIONS.rerun }), /no open questions/);
  assert.equal(await liveJobs(run.id), 1, "re-sending the same answer creates no job");
  await drain();
  assert.equal((await stepOf(run.id, "test")).status, "WAITING_INPUT", "asked again after the rerun");
  await assert.rejects(answerQuestions({ [qq.id]: OPTIONS.accept }), /no open questions/, "the old attempt's question cannot be answered again");
  assert.equal(await liveJobs(run.id), 0);
  await cancelRun(run.id);
});

// ---------------------------------------------------------------- re-execute with instructions + skills
test("re-execute with instructions + skill: stored before enqueue, pinned version, in snapshot and real prompts; downstream reruns", async () => {
  const { buildSystemAppend, buildUserPrompt } = await import("../src/agent/stepPrompt.ts");
  const { seedKnowledge } = await import("../src/knowledge/service.ts");
  await seedKnowledge();
  const skill = (await knowledge.get("latency-service-boundaries"))!;
  assert.equal(skill.category, "agent_skill");
  const key = await customWorkflow([
    { key: "implement", type: "coding_agent", max_attempts: 2, retry_backoff_seconds: 0 },
    { key: "test", type: "agent", depends_on: ["implement"] },
    { key: "review", type: "agent", depends_on: ["test"], requires_approval: true },
  ]);
  let version = "v1";
  scripts.implement = async (ctx, n) => {
    if (ctx.input.pending?.reexecute && n === 2) return { kind: "failed", error: "transient", retryable: true }; // first re-exec attempt fails → retry
    return { kind: "completed", output: { summary: `implementation ${version}: calls service B` } };
  };
  scripts.test = (ctx) => ({ kind: "completed", output: { tested: ctx.input.upstream.implement.output.summary } });
  const run = await startRun({ definitionKey: key });
  await drain();
  await approveStep(run.id, "review");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  const firstImpl = (await attemptsOf(run.id, "implement"))[0];

  version = "v2";
  await reexecuteStep(run.id, "implement", { feedback: "Xem lại call sang service B. Dữ liệu đã có trong payload", skills: ["latency-service-boundaries"], by: "toan" });
  // stored on the step before any worker runs; review must be approved again for the new generation
  const pendingNow = (await stepOf(run.id, "implement")).pending_input;
  assert.equal(pendingNow.reexecute.instructions, "Xem lại call sang service B. Dữ liệu đã có trong payload");
  assert.deepEqual(pendingNow.reexecute.skills.map((x: any) => `${x.key}@${x.version}`), [`latency-service-boundaries@${skill.current_version}`]);
  // the skill changes before the job runs (e.g. worker restarted) → the pinned version is still used
  await knowledge.update("latency-service-boundaries", { content: skill.versions[0].content + "\nEDITED LATER", change_note: "edit" });
  await drain();
  const impl = await stepOf(run.id, "implement");
  assert.equal(impl.status, "COMPLETED");
  const reCtxs = seen.implement.filter((c) => c.run.id === run.id && c.input.pending?.reexecute);
  assert.equal(reCtxs.length, 2, "the retry after a transient failure used the same stored input");
  for (const c of reCtxs) assert.equal(c.input.pending.reexecute.instructions, pendingNow.reexecute.instructions);
  const ctx = reCtxs[1];
  const pinned = ctx.context.knowledge.find((k) => k.key === "latency-service-boundaries")!;
  assert.equal(pinned.version, skill.current_version);
  assert.ok(!pinned.content.includes("EDITED LATER"));
  assert.match(pinned.reason, /selected for this re-execution/);
  assert.equal(ctx.context.disclosure.find((d) => d.key === "latency-service-boundaries")!.disclosure, "inline");
  // actual prompts of the new attempt
  const sys = buildSystemAppend(ctx.run, ctx.step, ctx.context, "coding");
  const user = buildUserPrompt(ctx.input, [], [], ctx.context.upstream, ctx.context.fileRefs, [{ title: "Current worktree state", body: "(state)" }]);
  assert.match(sys, /Latency & Service Boundaries/);
  assert.match(sys, /trace the request path/i);
  assert.match(sys, /RE-EXECUTION: the worktree already contains work/);
  assert.match(user, /Developer instructions for this re-execution[\s\S]*Dữ liệu đã có trong payload/);
  assert.match(user, /Skills selected for this re-execution[\s\S]*latency-service-boundaries v/);
  assert.match(user, new RegExp(`previous attempt of this step \\(#${firstImpl.number}`));
  assert.match(user, /implementation v1: calls service B/, "the previous attempt's output is referenced");
  const snap = await one(pool, "SELECT content FROM context_snapshots WHERE id = $1", [ctx.context.snapshot_id]);
  assert.equal(snap.content.prompt_plan.reexecute.instructions, pendingNow.reexecute.instructions);
  assert.deepEqual(snap.content.prompt_plan.reexecute.skills, [`latency-service-boundaries@v${skill.current_version}`]);
  // old attempt still viewable; downstream reran with the new output; approval asked again
  const hist = await attemptsOf(run.id, "implement");
  assert.equal(hist[0].output.summary, "implementation v1: calls service B");
  assert.ok(hist[0].invalidated_at);
  assert.equal((await stepOf(run.id, "test")).output.tested, "implementation v2: calls service B");
  assert.equal((await stepOf(run.id, "review")).status, "WAITING_APPROVAL", "approval re-requested for the new generation");
  assert.equal(impl.pending_input, null, "pending cleared once the step completed");
});

test("re-execute without instructions behaves as before; unknown skills are rejected; worktree changes cannot be discarded", async () => {
  const { buildUserPrompt } = await import("../src/agent/stepPrompt.ts");
  const { decideBash } = await import("../src/agent/toolPolicy.ts");
  const key = await customWorkflow([{ key: "a", type: "agent" }, { key: "b", type: "agent", depends_on: ["a"] }]);
  const run = await startRun({ definitionKey: key });
  await drain();
  await reexecuteStep(run.id, "a");
  assert.equal((await stepOf(run.id, "a")).pending_input, null);
  await drain();
  const ctx = seen.a.filter((c) => c.run.id === run.id).at(-1)!;
  assert.equal(ctx.input.previous_attempt, null);
  assert.doesNotMatch(buildUserPrompt(ctx.input, []), /re-execution|previous attempt/i);
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  await assert.rejects(reexecuteStep(run.id, "a", { skills: ["does-not-exist"] }), /unknown skill/);
  const coding = { mode: "coding" as const, workspaces: ["/w"], baseBranch: "release/prod" };
  for (const cmd of ["git restore pkg/x.go", "git stash", "git -C /w stash push", "git checkout -- .", "git checkout ."]) assert.ok(!decideBash(cmd, coding, "/w").allow, cmd);
  assert.ok(decideBash("git status && git diff", coding, "/w").allow);
});

test("existing-branch directive in the work item description lands in run.inputs.branches; explicit inputs win", async () => {
  const key = await customWorkflow([{ key: "implement", type: "coding_agent", name: "Implementation" }]);
  const wi = await workItems.createManual({ title: "VNPay installment", project: "OMS", description: "Làm tiếp từ branch HSK-QA679L33 ở oms-background, không checkout sang branch mới.\nXử lý installment." });
  const run = await startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-background"] });
  const r = await getRun(run.id);
  assert.deepEqual(r.inputs.branches, { "oms-background": "HSK-QA679L33" });
  assert.equal(r.inputs.branches_source, "work item description");
  assert.equal(r.branch, `u${r.owner_id}-${wi.code}`, "the run keeps its own branch name for every other repository");
  const explicit = await startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-background"], inputs: { branches: { "oms-background": "HSK-OTHER" } } });
  assert.deepEqual((await getRun(explicit.id)).inputs.branches, { "oms-background": "HSK-OTHER" });
  await assert.rejects(startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-background"], inputs: { branches: { "*": "release/prod" } } }), /base branch/);
});

// ---------------------------------------------------------------- independent verification + failure recovery
/** Mirrors the Claude executor's enforcement for a scripted verifier verdict. */
const verifier = (verdictFor: (n: number, ctx: ExecutionContext) => any): Script => async (ctx, n) => {
  const used = (await one(pool, "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE step_id = $1 AND output->>'verdict' = 'FAIL'", [ctx.step.id])).n;
  return enforceVerdict(normalizeVerdict(verdictFor(n, ctx)), { repairsUsed: used, maxRepairs: Number(ctx.step.config.max_repairs ?? 2), repairTarget: repairTargetFor(ctx.run.graph, ctx.step.key), heads: { svc: `sha${n}` } });
};
const FAIL = { verdict: "FAIL", findings: [{ severity: "high", file: "pay.go", line: 12, explanation: "refund ignores installments", evidence: "pay.go:12 uses amount" }], summary: "x" };

test("independent verification: STANDARD isolates the verifier, FAIL repairs then re-verifies, PASS continues", async () => {
  const key = await customWorkflow(
    [
      { key: "implement", type: "coding_agent", retry_backoff_seconds: 0 },
      { key: "review", type: "agent", name: "Code Review", depends_on: ["implement"] },
      { key: "after", type: "agent", depends_on: ["review"] },
    ],
    { feedback_step: "implement" },
  );
  const feedbacks: Array<{ run: number; text: string }> = [];
  scripts.implement = async (ctx, n) => (ctx.input.pending?.feedback && feedbacks.push({ run: ctx.run.id, text: ctx.input.pending.feedback }), { kind: "completed", output: { summary: `my reasoning v${n}: trust me`, decisions: ["d"], verification: { passed: true, status: "clean" } } });
  scripts.review = verifier((n, ctx) => {
    assert.equal(ctx.step.config.independent, true, "STANDARD marks the review as independent");
    assert.equal(ctx.input.upstream.implement.output.summary, undefined, "author's summary withheld");
    assert.deepEqual(ctx.input.upstream.implement.output.verification, { passed: true, status: "clean" }, "platform evidence kept");
    return n < 3 ? FAIL : { verdict: "PASS", findings: [], summary: "ok" };
  });
  const run = await startRun({ definitionKey: key, title: "iv", profile: "STANDARD" } as any);
  await drain();
  assert.equal((await stepOf(run.id, "review")).status, "COMPLETED");
  assert.equal((await stepOf(run.id, "review")).output.verdict, "PASS");
  assert.deepEqual((await stepOf(run.id, "review")).output.verified_heads, { svc: "sha3" });
  // count per run: drain() also executes leftover jobs of earlier tests
  assert.deepEqual((await attemptsOf(run.id, "review")).map((a: any) => a.output?.verdict), ["FAIL", "FAIL", "PASS"]);
  assert.equal((await attemptsOf(run.id, "implement")).length, 3, "two repair rounds");
  const mine = feedbacks.filter((f) => f.run === run.id).map((f) => f.text);
  assert.equal(mine.length, 2);
  assert.match(mine[0], /repair 1 of 2[\s\S]*pay\.go:12 — refund ignores installments/);
  assert.equal((await stepOf(run.id, "after")).status, "COMPLETED");
});

test("independent verification: repair budget exhausted → FAILED, downstream never runs; BLOCKED asks a human", async () => {
  const key = await customWorkflow(
    [
      { key: "implement", type: "coding_agent", retry_backoff_seconds: 0 },
      { key: "review", type: "agent", name: "Review", depends_on: ["implement"], config: { max_repairs: 1 } },
      { key: "pr", type: "agent", depends_on: ["review"] },
    ],
    { feedback_step: "implement" },
  );
  scripts.review = verifier(() => FAIL);
  const run = await startRun({ definitionKey: key, title: "iv2", profile: "STANDARD" } as any);
  await drain();
  const review = await stepOf(run.id, "review");
  assert.equal(review.status, "FAILED");
  assert.match(String(review.error), /independent verification FAILED after 1 repair/);
  assert.equal((await attemptsOf(run.id, "implement")).length, 2);
  assert.equal((await stepOf(run.id, "pr")).status, "PENDING", "no PR without a PASS");
  const failAttempt = (await attemptsOf(run.id, "review")).at(-1);
  assert.equal(failAttempt.error.failure.class, "code");

  scripts.review = verifier(() => ({ verdict: "BLOCKED", blocked_reason: "no acceptance criteria for installment refunds", findings: [] }));
  const run2 = await startRun({ definitionKey: key, title: "iv3", profile: "STANDARD" } as any);
  await drain();
  assert.equal((await stepOf(run2.id, "review")).status, "WAITING_INPUT");
  const qs = await openQ(run2.id);
  assert.match(qs[0].question, /BLOCKED: no acceptance criteria/);
});

test("failure recovery: auth stops at once, workspace conflict pauses for a human, rate limits back off", async () => {
  const key = await customWorkflow([{ key: "a", type: "agent", max_attempts: 3, retry_backoff_seconds: 0 }]);
  scripts.a = () => ({ kind: "failed", error: "Bitbucket HTTP 401 Unauthorized", retryable: true });
  const r1 = await startRun({ definitionKey: key, title: "auth" } as any);
  await drain();
  assert.equal((await stepOf(r1.id, "a")).status, "FAILED");
  assert.equal((await attemptsOf(r1.id, "a")).length, 1, "no pointless retries of an auth error");
  assert.equal((await attemptsOf(r1.id, "a"))[0].error.failure.class, "auth");

  const tries: Record<number, number> = {};
  scripts.a = (ctx) => ((tries[ctx.run.id] = (tries[ctx.run.id] ?? 0) + 1) === 1 ? { kind: "failed", error: "push rejected (non-fast-forward)", retryable: true } : { kind: "completed", output: { ok: true } });
  const r2 = await startRun({ definitionKey: key, title: "conflict" } as any);
  await drain();
  assert.equal((await stepOf(r2.id, "a")).status, "WAITING_INPUT");
  const q2 = await openQ(r2.id);
  assert.match(q2[0].question, /workspace/);
  await answerQuestions({ [q2[0].id]: "Đã xử lý xong — chạy lại bước" }, "dev");
  await drain();
  assert.equal((await stepOf(r2.id, "a")).status, "COMPLETED", "resumed after the human fixed it");

  scripts.a = () => ({ kind: "failed", error: "merge conflict in go.mod", retryable: true });
  const r3 = await startRun({ definitionKey: key, title: "conflict-stop" } as any);
  await drain();
  const q3 = await openQ(r3.id);
  await answerQuestions({ [q3[0].id]: "Dừng ở đây" }, "dev");
  await drain();
  assert.equal((await stepOf(r3.id, "a")).status, "FAILED");

  const key1 = await customWorkflow([{ key: "a", type: "agent", max_attempts: 1, retry_backoff_seconds: 0 }]);
  scripts.a = () => ({ kind: "failed", error: "429 Too Many Requests: rate limit", retryable: true });
  const r4 = await startRun({ definitionKey: key1, title: "rate" } as any);
  await drain();
  assert.equal((await stepOf(r4.id, "a")).status, "RETRYING", "rate limits retry even on max_attempts=1");
  const job = await one(pool, "SELECT available_at > now() + interval '20 seconds' AS later FROM workflow_jobs j JOIN workflow_steps s ON s.id = j.step_id WHERE s.run_id = $1 AND j.status = 'queued'", [r4.id]);
  assert.equal(job.later, true, "backoff delay applied");
  await cancelRun(r4.id, "test done");
});

test("cross-task memory: only verified/approved AND provably FRESH memory reaches the context", async () => {
  // A real clone of oms-api with origin/release/prod, so freshness can be proven (or not).
  const rel = `memfix-${Date.now()}`;
  const root = join(process.env.TEST_ROOT!, "repos"), origin = join(process.env.TEST_ROOT!, `${rel}.git`), repo = join(root, rel);
  execFileSync("git", ["init", "-q", "--bare", "-b", "release/prod", origin], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", origin, repo], { env: GIT_ENV });
  gitIn(repo, "checkout", "-qb", "release/prod");
  commitFile(repo, "refund.go", "package r\n", "base");
  const sha = commitFile(repo, "cancel.go", "package r\n", "task: cancel"); // the task commit (merged as-is)
  gitIn(repo, "push", "-q", "origin", "release/prod");
  commitFile(repo, "refund.go", "package r\n// rewritten later\n", "later");
  gitIn(repo, "push", "-q", "origin", "release/prod");
  gitIn(repo, "fetch", "-q", "origin");
  const saved = (await repositories.get("oms-api"))!.path;
  await repositories.upsert("oms-api", { path: rel });
  try {
    const meta = (trust: string, over: Record<string, unknown> = {}) => ({ run_id: 1, work_item: "OLD-1", repo: "oms-api", commit_sha: sha, base_branch: "release/prod", files: ["cancel.go"], trust, confidence: "high", extracted_at: "", sources: [], ...over });
    const mk = (key: string, m: Record<string, unknown>, enabled = true) =>
      knowledge.create({ key, category: "task_memory", scope_type: "REPOSITORY", scope_ref: "oms-api", title: `${key} shipment cancel refund`, content: `memory ${key}`, enabled, applicability: { repos: ["oms-api"] }, metadata: { load: "on_demand", description: "shipment cancel refund", memory: m } });
    await mk("memory.t1.oms-api.facts", meta("verified"));
    await mk("memory.t1.oms-api.conclusions", meta("unverified")); // force-enabled through the generic API: still excluded
    await mk("memory.t2.oms-api.conclusions", meta("approved"));
    await mk("memory.t3.oms-api.facts", meta("verified", { commit_sha: "" })); // no provenance → UNKNOWN, never assumed fresh
    await mk("memory.t4.oms-api.facts", meta("verified", { files: ["refund.go"] })); // edited on the base later → STALE
    await mk("memory.t5.oms-api.facts", meta("verified", { commit_sha: "f".repeat(40) })); // commit not in this clone → UNKNOWN
    const key = await customWorkflow([{ key: "a", type: "agent" }]);
    let keys: string[] = [];
    let plan: any = null;
    scripts.a = async (ctx) => {
      keys = ctx.context.disclosure.map((d) => d.key);
      plan = (await one(pool, "SELECT content FROM context_snapshots WHERE id = $1", [ctx.context.snapshot_id])).content.prompt_plan;
      return { kind: "completed", output: {} };
    };
    await startRun({ definitionKey: key, title: "cancel shipment refund", repositories: ["oms-api"] } as any);
    await drain();
    assert.ok(keys.includes("memory.t1.oms-api.facts"));
    assert.ok(keys.includes("memory.t2.oms-api.conclusions"), "human approval still enables conclusions");
    for (const k of ["memory.t1.oms-api.conclusions", "memory.t3.oms-api.facts", "memory.t4.oms-api.facts", "memory.t5.oms-api.facts"]) assert.ok(!keys.includes(k), k);
    // (memory extracted by earlier tests' runs points at other clones: also UNKNOWN → excluded; only this test's keys are asserted)
    const mine = (k: string) => k.startsWith("memory.t");
    assert.ok(plan.memory_freshness.filter((m: any) => !mine(m.key)).every((m: any) => m.state !== "FRESH"));
    assert.deepEqual([...plan.memory_excluded].filter(mine).sort(), ["memory.t1.oms-api.conclusions", "memory.t3.oms-api.facts", "memory.t4.oms-api.facts", "memory.t5.oms-api.facts"]);
    const state = Object.fromEntries(plan.memory_freshness.filter((m: any) => mine(m.key)).map((m: any) => [m.key, m.state]));
    assert.deepEqual(state, {
      "memory.t1.oms-api.facts": "FRESH", "memory.t1.oms-api.conclusions": "UNKNOWN", "memory.t2.oms-api.conclusions": "FRESH",
      "memory.t3.oms-api.facts": "UNKNOWN", "memory.t4.oms-api.facts": "STALE", "memory.t5.oms-api.facts": "UNKNOWN",
    });
  } finally {
    await repositories.upsert("oms-api", { path: saved ?? "" });
  }
});

test("cross-task memory: a COMPLETED run with a worktree yields verified facts + disabled conclusions", async () => {
  const { extractRunMemory } = await import("../src/knowledge/memory.ts");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const root = mkdtempSync(join(process.env.TEST_ROOT!, "memx-"));
  const origin = join(root, "o.git"), wt = join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, wt]);
  sh(wt, "checkout", "-qb", "release/prod");
  writeFileSync(join(wt, "a.go"), "package a\n");
  sh(wt, "add", "."), sh(wt, "commit", "-qm", "base"), sh(wt, "push", "-q", "origin", "release/prod");
  sh(wt, "checkout", "-qb", "T");
  writeFileSync(join(wt, "a.go"), "package a\n// change\n");
  sh(wt, "commit", "-qam", "change");
  const key = await customWorkflow([{ key: "implement", type: "coding_agent" }]);
  scripts.implement = async (ctx) => {
    await recordWorkspace(ctx.run.id, { repo: "oms-api", branch: "T", path: wt, created_from: "test" });
    return { kind: "completed", output: { summary: "Use the installment amount for refunds.", decisions: [{ title: "cache", detail: "skip cache for refunds" }] } };
  };
  const run = await startRun({ definitionKey: key, title: "memory run", repositories: ["oms-api"] } as any);
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  await extractRunMemory(run.id); // idempotent with the afterCommit hook
  const facts = await knowledge.get(`memory.run-${run.id}.oms-api.facts`, pool, run.owner_id);
  const concl = await knowledge.get(`memory.run-${run.id}.oms-api.conclusions`, pool, run.owner_id);
  assert.equal(await knowledge.get(`memory.run-${run.id}.oms-api.facts`), undefined, "task memory is not shared");
  assert.ok(facts && concl, "both items written");
  assert.equal(facts.enabled, true);
  assert.deepEqual(facts.versions[0].metadata.memory.files, ["a.go"]);
  assert.equal(concl.enabled, false, "conclusions wait for approval");
  assert.match(concl.versions[0].content, /> Use the installment amount for refunds\./);
});

// ---------------------------------------------------------------- end to end: defective code vs independent verification
/**
 * A local workflow whose coding step writes genuinely defective code into a real git worktree. The verifier does not
 * know the attempt number: it executes the code at the commit it judges against hidden acceptance cases and reports
 * what it observes, exactly like a reviewer working only from platform evidence.
 */
const REFUND_BAD = "module.exports = (amount, installments) => amount; // refunds the whole amount per installment\n";
const REFUND_GOOD = "module.exports = (amount, installments) => Math.round(amount / Math.max(1, installments));\n";
const ACCEPTANCE: Array<[number, number, number]> = [[1200, 3, 400], [500, 1, 500]];
const refundVerifier = liveVerifier((_n, ctx, ev) => {
  const findings: any[] = [];
  for (const [repo, head] of Object.entries(ev.heads)) {
    const src = execFileSync("git", ["-C", workspacePath[`${ctx.run.id}:${repo}`], "show", `${head}:refund.js`], { encoding: "utf8" });
    const mod: any = { exports: null };
    new Function("module", src)(mod);
    for (const [amount, n, want] of ACCEPTANCE) {
      const got = mod.exports(amount, n);
      if (got !== want) findings.push({ severity: "high", file: "refund.js", line: 1, explanation: `refund(${amount}, ${n}) returned ${got}, acceptance requires ${want}`, evidence: `git show ${head.slice(0, 12)}:refund.js` });
    }
  }
  return findings.length ? { verdict: "FAIL", findings, summary: "acceptance cases fail" } : { verdict: "PASS", findings: [], summary: "acceptance cases pass" };
});
const workspacePath: Record<string, string> = {};
/** Coding step: first attempt writes the defect; a repair (feedback) writes `repairWith` and commits it. */
const refundCoder = (repairWith: () => string): Script => async (ctx) => {
  for (const repo of ctx.run.selected_repositories) {
    const k = `${ctx.run.id}:${repo}`;
    if (!workspacePath[k]) {
      workspacePath[k] = gitWorktree(repo, ctx.run.branch);
      commitFile(workspacePath[k], "refund.js", REFUND_BAD, "feat: installment refunds");
      await recordWorkspace(ctx.run.id, { repo, branch: ctx.run.branch, path: workspacePath[k], created_from: "test" });
    } else if (ctx.input.pending?.feedback) commitFile(workspacePath[k], "refund.js", repairWith(), "fix: verifier findings");
  }
  return { kind: "completed", output: { summary: "refunds implemented and fully tested, trust me", verification: { passed: true, status: "clean" } } };
};
const refundWorkflow = (prMode: string, maxRepairs = 2) =>
  customWorkflow(
    [
      { key: "implement", type: "coding_agent", retry_backoff_seconds: 0 },
      { key: "review", type: "agent", name: "Code Review", depends_on: ["implement"], config: { max_repairs: maxRepairs } },
      { key: "pr", type: "git_pull_request", depends_on: ["review"], config: { mode: prMode, content_from: "implement" } },
    ],
    { feedback_step: "implement" },
  );

test("e2e: the verifier catches the defect, FAIL blocks the PR and triggers a bounded repair, the genuine PASS publishes exactly the verified commit", async () => {
  const key = await refundWorkflow("auto");
  scripts.implement = refundCoder(() => REFUND_GOOD);
  let prSawReviewStatus: string[] = [];
  scripts.review = async (ctx, n) => {
    const r = await refundVerifier(ctx, n);
    prSawReviewStatus.push(`${r.kind}`);
    return r;
  };
  const run = await startRun({ definitionKey: key, title: "installment refunds", profile: "STANDARD", repositories: ["oms-api"] } as any);
  await drain();
  const verdicts = (await attemptsOf(run.id, "review")).map((a: any) => a.output?.verdict);
  assert.deepEqual(verdicts, ["FAIL", "PASS"], "defect caught, then the repaired code passes");
  assert.match(String((await attemptsOf(run.id, "review"))[0].output.findings[0].explanation), /refund\(1200, 3\) returned 1200, acceptance requires 400/);
  assert.deepEqual(prSawReviewStatus, ["reexecute", "completed"]);
  assert.equal((await attemptsOf(run.id, "implement")).length, 2, "one repair round");
  assert.equal((await attemptsOf(run.id, "pr")).length, 1, "the PR step never ran while the verdict was FAIL");
  const review = await stepOf(run.id, "review");
  const head = gitIn(workspacePath[`${run.id}:oms-api`], "rev-parse", "HEAD");
  assert.deepEqual(review.output.verified_heads, { "oms-api": head });
  assert.equal((await stepOf(run.id, "pr")).status, "COMPLETED");
  assert.deepEqual(pushed.map((p) => p.sha), [head], "the published commit is the verified commit");
  assert.equal(prCalls.length, 1);
});

test("e2e: a defect that survives every repair exhausts the bounded budget — FAILED, no PR", async () => {
  const key = await refundWorkflow("auto", 2);
  scripts.implement = refundCoder(() => REFUND_BAD.replace("whole", `whole (try ${Math.random()})`));
  scripts.review = refundVerifier;
  const run = await startRun({ definitionKey: key, title: "still broken", profile: "STANDARD", repositories: ["oms-api"] } as any);
  await drain();
  assert.equal((await attemptsOf(run.id, "review")).length, 3, "verified, repaired twice, verified again each time");
  assert.equal((await attemptsOf(run.id, "implement")).length, 3, "exactly max_repairs (2) repair rounds, then stop");
  assert.equal((await stepOf(run.id, "review")).status, "FAILED");
  assert.match(String((await stepOf(run.id, "review")).error), /independent verification FAILED after 2 repair/);
  assert.equal((await stepOf(run.id, "pr")).status, "PENDING");
  assert.equal(pushed.length + prCalls.length, 0, "nothing was published");
});

test("e2e: changing the code after a PASS invalidates it — the PR is refused until the new commit is verified", async () => {
  const key = await refundWorkflow("approval");
  scripts.implement = refundCoder(() => REFUND_GOOD);
  scripts.review = refundVerifier;
  const run = await startRun({ definitionKey: key, title: "late edit", profile: "STANDARD", repositories: ["oms-api"] } as any);
  await drain();
  assert.equal((await stepOf(run.id, "review")).output.verdict, "PASS");
  assert.equal((await stepOf(run.id, "pr")).status, "WAITING_APPROVAL");
  const wt = workspacePath[`${run.id}:oms-api`];
  const verified = (await stepOf(run.id, "review")).output.verified_heads["oms-api"];

  // 1. uncommitted edit after the PASS → refused (would not be the reviewed content)
  writeFileSync(join(wt, "refund.js"), REFUND_BAD);
  await approveStep(run.id, "pr");
  await drain();
  let pr = await stepOf(run.id, "pr");
  assert.equal(pr.status, "WAITING_INPUT", "a dirty worktree is a workspace problem: a human decides");
  const q1 = await openQ(run.id);
  assert.match(q1[0].question, /uncommitted changes in the worktree/);
  assert.equal(pushed.length, 0);

  // 2. the human commits the edit and answers → the PASS is stale for that commit → refused for good
  const late = commitFile(wt, "refund.js", REFUND_BAD, "sneaky late change");
  assert.notEqual(late, verified);
  await answerQuestions({ [q1[0].id]: "committed it, retry" }, "dev");
  await drain();
  pr = await stepOf(run.id, "pr");
  assert.equal(pr.status, "FAILED");
  assert.match(String(pr.error), new RegExp(`oms-api: changed after independent verification "review" \\(verified ${verified.slice(0, 12)}, now ${late.slice(0, 12)}\\)`));
  assert.equal(pushed.length + prCalls.length, 0, "unverified content never published");

  // 3. re-verification judges the NEW commit: it is defective → FAIL → repair → PASS → PR (re-approved) publishes it
  await reexecuteStep(run.id, "review", { by: "dev" });
  await drain();
  const verdicts = (await attemptsOf(run.id, "review")).map((a: any) => a.output?.verdict);
  assert.deepEqual(verdicts.slice(-2), ["FAIL", "PASS"], "the late defect is caught on re-verification");
  assert.equal((await stepOf(run.id, "pr")).status, "WAITING_APPROVAL", "re-verification resets the PR approval");
  await approveStep(run.id, "pr");
  await drain();
  assert.equal((await stepOf(run.id, "pr")).status, "COMPLETED");
  const final = gitIn(wt, "rev-parse", "HEAD");
  assert.deepEqual(pushed.map((p) => p.sha), [final]);
  assert.equal((await stepOf(run.id, "review")).output.verified_heads["oms-api"], final);
});

test("e2e: verification never judges uncommitted work; optional (opted-out) verification keeps the old PR behaviour", async () => {
  const key = await refundWorkflow("auto");
  scripts.implement = async (ctx, n) => {
    const r = await refundCoder(() => REFUND_GOOD)(ctx, n);
    writeFileSync(join(workspacePath[`${ctx.run.id}:oms-api`], "refund.js"), REFUND_GOOD); // forgot to commit
    return r;
  };
  scripts.review = refundVerifier;
  const run = await startRun({ definitionKey: key, title: "dirty", profile: "STANDARD", repositories: ["oms-api"] } as any);
  await drain();
  const review = await stepOf(run.id, "review");
  assert.equal(review.status, "WAITING_INPUT");
  assert.match((await openQ(run.id))[0].question, /BLOCKED: .*uncommitted changes/);
  assert.equal(pushed.length, 0);

  // Intentionally optional: the definition opts the review out of independent verification → no gate.
  const optional = await customWorkflow([
    { key: "implement", type: "coding_agent" },
    { key: "review", type: "agent", name: "Code Review", depends_on: ["implement"], config: { independent: false } },
    { key: "pr", type: "git_pull_request", depends_on: ["review"], config: { content_from: "implement" } },
  ]);
  scripts.implement = refundCoder(() => REFUND_GOOD);
  scripts.review = () => ({ kind: "completed", output: { approved: true } });
  const run2 = await startRun({ definitionKey: optional, title: "optional", profile: "STANDARD", repositories: ["oms-api"] } as any);
  await drain();
  assert.equal((await stepOf(run2.id, "review")).config.independent, false);
  assert.equal((await stepOf(run2.id, "pr")).status, "COMPLETED");
  assert.equal(pushed.length, 1);
});

test("graceful shutdown: an interrupted step is requeued without using a retry, then completes", async () => {
  const { config } = await import("../src/config.ts");
  const key = await customWorkflow([{ key: "long", type: "agent", max_attempts: 1 }]);
  let started = false;
  scripts.long = (ctx) =>
    new Promise<ExecResult>((resolve) => {
      started = true;
      ctx.signal.addEventListener("abort", () => resolve({ kind: "failed", error: "agent process killed", retryable: true }));
    });
  const run = await startRun({ definitionKey: key });
  assert.equal((await getRun(run.id)).worker_instance, config.instanceId, "a new run is pinned to the instance that created it");
  const sched = startScheduler({ workers: 1, lightWorkers: 0, leaseSeconds: 30, heartbeatSeconds: 5, pollMs: 50 });
  for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(started, "the step is running");
  await sched.drain("test shutdown");
  const st = await stepOf(run.id, "long");
  assert.equal(st.status, "WAITING_INPUT", "interrupted agent requires reconciliation");
  assert.equal(st.attempt_count, 0, "the interrupted attempt does not count against max_attempts");
  const [a] = await attemptsOf(run.id, "long");
  assert.equal(a.status, "WAITING_INPUT");
  assert.equal(a.error.interrupted, true);
  const job = await one(pool, "SELECT status, lease_owner FROM workflow_jobs WHERE step_id = $1", [st.id]);
  assert.deepEqual(job, { status: "done", lease_owner: null });
  const question = (await one(pool, "SELECT id FROM workflow_questions WHERE run_id = $1 AND status = 'open'", [run.id]))!;
  await answerQuestions({ [question.id]: "Reconciled — continue" });
  scripts.long = () => ({ kind: "completed", output: { ok: true } });
  await drain();
  assert.equal((await stepOf(run.id, "long")).status, "COMPLETED", "max_attempts=1 still allows the real attempt");
});

test("worker affinity: resume never adopts another machine; unassigned legacy runs require an administrator", async () => {
  const { config } = await import("../src/config.ts");
  const key = await customWorkflow([{ key: "only", type: "agent" }]);
  scripts.only = () => ({ kind: "completed", output: { ok: true } });
  const run = await startRun({ definitionKey: key });
  await q(pool, "UPDATE workflow_runs SET worker_instance = 'teammate-laptop' WHERE id = $1", [run.id]);
  assert.equal(await claimJob("w-affinity", 30), undefined, "another machine's run is not claimed here");
  // An instance on OLD code claims without the worker_instance filter: the database itself refuses (migration 019).
  const stale = await q(pool, `UPDATE workflow_jobs SET status = 'running', lease_owner = 'zzz:70324:205ac1a3:w1', lease_expires_at = now() + interval '60 seconds'
                               WHERE run_id = $1 AND status = 'queued' RETURNING id`, [run.id]);
  assert.equal(stale.length, 0, "a claim by another instance is skipped by the trigger");
  assert.equal((await one(pool, "SELECT status FROM workflow_jobs WHERE run_id = $1", [run.id])).status, "queued");
  await pauseRun(run.id);
  await assert.rejects(resumeRun(run.id), /belongs to teammate-laptop/);
  assert.equal((await getRun(run.id)).worker_instance, "teammate-laptop");
  const legacy = await startRun({ definitionKey: key });
  await q(pool, "UPDATE workflow_runs SET worker_instance = NULL WHERE id = $1", [legacy.id]);
  assert.equal(await claimJob("legacy", 30), undefined);
  await pauseRun(legacy.id);
  await assert.rejects(resumeRun(legacy.id), /administrator/);
  await cancelRun(run.id);
  await cancelRun(legacy.id);
});

test("dropped database connections mid-step (Wi-Fi/VPN blip) do not fail the step", async () => {
  const { isTransientDbError, retryTransient } = await import("../src/db/pool.ts");
  assert.ok(isTransientDbError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
  assert.ok(isTransientDbError(new Error("Connection terminated unexpectedly")));
  assert.ok(!isTransientDbError(Object.assign(new Error("duplicate key"), { code: "23505" })), "SQL errors are not retried");
  let calls = 0;
  assert.equal(await retryTransient(async () => (++calls < 3 ? Promise.reject(new Error("Connection terminated unexpectedly")) : "ok"), "t", [1, 1, 1]), "ok");
  assert.equal(calls, 3);

  const key = await customWorkflow([{ key: "blip", type: "agent", max_attempts: 1 }]);
  scripts.blip = async (ctx) => {
    await ctx.log("agent", "before the network drop");
    // What a VPN reconnect does: every open connection to the database is killed at once.
    await q(pool, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'");
    await ctx.log("agent", "after the network drop");
    return { kind: "completed", output: { ok: true } };
  };
  const run = await startRun({ definitionKey: key });
  await drain();
  assert.equal((await stepOf(run.id, "blip")).status, "COMPLETED");
  const logs = await q(pool, "SELECT content FROM workflow_events WHERE run_id = $1 AND kind = 'agent' ORDER BY id", [run.id]);
  assert.deepEqual(logs.map((l: any) => l.content), ["before the network drop", "after the network drop"]);
});

test("run summary: built from the run's own records and stored when the run finishes", async () => {
  const { getRunSummary } = await import("../src/report/runSummary.ts");
  const key = await customWorkflow([
    { key: "investigate", type: "agent", max_attempts: 2 },
    { key: "ask", type: "agent", depends_on: ["investigate"] },
  ]);
  scripts.investigate = (_ctx, n) =>
    n === 1
      ? { kind: "failed", error: "ECONNRESET talking to the provider", retryable: true }
      : { kind: "completed", output: { summary: "Found the empty CDC payload path.", findings: [{ file: "kafka/consumer.go", line: 148, issue: "tombstone not skipped", severity: "high" }], risks: ["more topics may emit tombstones"] } };
  scripts.ask = (_ctx, n) => (n === 1 ? { kind: "waiting_input", questions: [{ question: "Skip tombstones or log them?" }] } : { kind: "completed", output: { summary: "Will skip tombstones." } });
  const run = await startRun({ definitionKey: key });
  await q(pool, "UPDATE workflow_steps SET retry_backoff_s = 0 WHERE run_id = $1", [run.id]);
  await drain();
  await q(pool, "UPDATE workflow_jobs SET available_at = now() WHERE run_id = $1 AND status = 'queued'", [run.id]);
  await drain();
  const qn = await one(pool, "SELECT id FROM workflow_questions WHERE run_id = $1", [run.id]);
  await answerQuestions({ [qn.id]: "Skip them" }, "toan");
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");

  const stored = (await one(pool, "SELECT summary FROM workflow_runs WHERE id = $1", [run.id])).summary;
  assert.ok(stored, "snapshot stored when the run finished");
  const s = await getRunSummary(run.id);
  assert.equal(s.run.status, "COMPLETED");
  const inv = s.steps.find((x) => x.key === "investigate")!;
  assert.equal(inv.summary, "Found the empty CDC payload path.");
  assert.equal(inv.attempts, 2);
  assert.deepEqual(inv.lists.map((l) => l.items[0]), ["[high] tombstone not skipped (kafka/consumer.go:148)", "more topics may emit tombstones"]);
  assert.equal(s.totals.retries, 1);
  assert.ok(s.problems.some((p) => p.step === "investigate" && /ECONNRESET/.test(p.message)), "the failed attempt is listed");
  assert.deepEqual(s.decisions.map((d) => [d.question, d.answer, d.by]), [["Skip tombstones or log them?", "Skip them", "toan"]]);
  assert.match(s.markdown, /Found the empty CDC payload path\./);
  assert.match(s.markdown, /Skip tombstones or log them\?/);
});

test("code-review without repositories asks which to review (instead of failing); with them it passes through", async () => {
  for (const k of ["analyze", "architecture", "security"]) scripts[k] = () => ({ kind: "completed", output: { findings: [], summary: "ok" } });
  const run = await startRun({ definitionKey: "code-review", inputs: { focus: "history detail" } });
  await drain();
  let sel = await stepOf(run.id, "select");
  assert.equal(sel.status, "WAITING_APPROVAL", "the run waits for the developer to pick repositories");
  assert.equal(sel.approval?.request?.select_repositories, true);
  assert.ok((sel.approval?.request?.candidates ?? []).some((c: any) => c.repo === "oms-api"), "the project's repositories are offered");
  await assert.rejects(approveStep(run.id, "select", {}), /select at least one repository/);
  await approveStep(run.id, "select", { repositories: ["oms-api"], by: "toan" });
  await drain();
  assert.deepEqual((await getRun(run.id)).selected_repositories, ["oms-api"]);
  assert.equal((await stepOf(run.id, "analyze")).status, "COMPLETED", "review continues with the picked repository");

  const given = await startRun({ definitionKey: "code-review", inputs: { repositories: "oms-api" } }); // e.g. from the API, as a string
  await drain();
  sel = await stepOf(given.id, "select");
  assert.equal(sel.status, "COMPLETED", "repositories passed at start: no question");
  assert.equal(sel.output.auto, true);
  assert.deepEqual((await getRun(given.id)).selected_repositories, ["oms-api"]);
});


test("code review → fix: branch chosen with the repositories, fixes approved with a note, committed on the reviewed branch", async () => {
  const { branchFor } = await import("../src/workflow/branches.ts");
  scripts.analyze = () => ({ kind: "completed", output: { summary: "2 issues", findings: [{ severity: "high", repo: "oms-api", file: "a.go", line: 3, issue: "nil deref", suggestion: "check" }, { severity: "low", repo: "oms-api", file: "b.go", line: 1, issue: "naming", suggestion: "rename" }] } });
  scripts.architecture = () => ({ kind: "completed", output: { summary: "fine", violations: [] } });
  scripts.security = () => ({ kind: "completed", output: { summary: "none", findings: [] } });
  let seenNote = "", seenBranch = "";
  scripts.fix = (ctx) => {
    seenNote = String(ctx.input.approval?.comment ?? "");
    seenBranch = branchFor(ctx.run, "oms-api").branch;
    return { kind: "completed", output: { summary: "fixed the nil deref", fixed: [{ finding: "nil deref", repo: "oms-api", file: "a.go", change: "guard nil" }], not_fixed: [{ finding: "naming", reason: "low severity" }] } };
  };
  const run = await startRun({ definitionKey: "code-review", inputs: { focus: "history" } });
  await drain();
  const sel = await stepOf(run.id, "select");
  assert.equal(sel.approval?.request?.ask_branch, true, "the selection also asks for the branch to review");
  await assert.rejects(approveStep(run.id, "select", { repositories: ["oms-api"], data: { branch: "release/prod" } }), /base branch/);
  await approveStep(run.id, "select", { repositories: ["oms-api"], data: { branch: "origin/HSK-G391U53I" } });
  assert.equal((await getRun(run.id)).inputs.branch, "HSK-G391U53I", "origin/ prefix stripped, stored as the reviewed branch");
  await drain();
  assert.equal((await stepOf(run.id, "fix")).status, "WAITING_APPROVAL");
  await approveStep(run.id, "fix", { comment: "chỉ sửa finding nil deref" });
  await drain();
  assert.equal(seenNote, "chỉ sửa finding nil deref", "the approval note reaches the fixing agent");
  assert.equal(seenBranch, "HSK-G391U53I", "fixes are committed on the reviewed branch, not a new one");
  assert.equal((await stepOf(run.id, "fix_pr")).status, "WAITING_APPROVAL", "the PR still needs the developer's approval");
  await approveStep(run.id, "fix_pr", {});
  await drain();
  const d = await runDetail(run.id);
  assert.equal(d.status, "COMPLETED");
  const { getRunSummary } = await import("../src/report/runSummary.ts");
  const fix = (await getRunSummary(run.id)).steps.find((x) => x.key === "fix")!;
  assert.deepEqual(fix.lists.map((l) => l.items[0]), ["nil deref (a.go) → guard nil", "naming — low severity"]);
});

test("code review: a different branch per repository (and none = base) for review, OCR targets and fixes", async () => {
  const { branchFor } = await import("../src/workflow/branches.ts");
  for (const k of ["analyze", "architecture", "security"]) scripts[k] = () => ({ kind: "completed", output: { findings: [], summary: "ok" } });
  const run = await startRun({ definitionKey: "code-review", inputs: { focus: "split" } });
  await drain();
  const candidates = ((await stepOf(run.id, "select")).approval?.request?.candidates ?? []).map((c: any) => c.repo);
  assert.ok(candidates.length >= 3, `need three candidate repositories, got ${candidates}`);
  const [a, b, c] = candidates;
  await assert.rejects(approveStep(run.id, "select", { repositories: [a, b], data: { branches: { [a]: "release/prod" } } }), /base branch/, "per-repo values are validated too");
  await approveStep(run.id, "select", { repositories: [a, b, c], data: { branch: "", branches: { [a]: "origin/split/8-channel-splitting", [b]: "split/6-channel-splitting", [c]: "" } } });
  const r = await getRun(run.id);
  assert.deepEqual(r.inputs.branches, { [a]: "split/8-channel-splitting", [b]: "split/6-channel-splitting" }, "only repositories with a branch");
  assert.equal(r.inputs.branch, null, "no single common branch");
  assert.deepEqual(branchFor(r, a), { branch: "split/8-channel-splitting", existing: true });
  assert.deepEqual(branchFor(r, b), { branch: "split/6-channel-splitting", existing: true });
  assert.equal(branchFor(r, c).existing, false, "no branch → the run's own branch (review on base)");

  // the common field fills repositories left empty
  const run2 = await startRun({ definitionKey: "code-review", inputs: { focus: "x" } });
  await drain();
  await approveStep(run2.id, "select", { repositories: [a, b], data: { branch: "HSK-1", branches: { [b]: "HSK-2" } } });
  assert.deepEqual((await getRun(run2.id)).inputs.branches, { [a]: "HSK-1", [b]: "HSK-2" });
});
