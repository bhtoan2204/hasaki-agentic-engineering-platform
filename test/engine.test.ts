import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
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
  sendFeedback,
  startRun,
} from "../src/workflow/engine.ts";
import { claimJob, drain, LIGHT_STEP_TYPES, schedulerStatus, runOnce } from "../src/workflow/scheduler.ts";
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
import { recordWorkspace, setGitProvider } from "../src/git/provider.ts";
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

/** A coding step that "edits" a temp worktree: records the workspace and returns PR content. */
const codingDone: Script = async (ctx) => {
  for (const repo of ctx.run.selected_repositories) {
    const path = mkdtempSync(join(process.env.TEST_ROOT!, `wt-${repo}-`));
    await recordWorkspace(ctx.run.id, { repo, branch: ctx.run.branch, path, created_from: "test" });
  }
  return {
    kind: "completed",
    output: { summary: "implemented", pull_requests: Object.fromEntries(ctx.run.selected_repositories.map((r) => [r, { title: `feat: ${r}`, summary: "s", decisions: [] }])) },
  };
};

let prCalls: Array<{ repo: string; source: string; draft: boolean }> = [];
setGitProvider({
  name: "fake",
  async push() {
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
  scripts.review = () => ({ kind: "completed", output: { approved: true, findings: [] } });
  const run = await startRun({ definitionKey: "feature-implementation", workItemId: wi.id });
  assert.equal(run.branch, wi.code);
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
  assert.equal(final.pull_requests[0].source_branch, wi.code);
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
  assert.equal(run.branch, `wf/run-${run.id}`);
  await drain();
  const d = await runDetail(run.id);
  assert.equal(d.status, "COMPLETED");
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
  assert.equal((await stepOf(run.id, "a")).status, "RETRYING");
  const zombie = await finishAttempt(job.id, job.fencing_token, begun.attempt.id, { kind: "completed", output: { zombie: true } });
  assert.equal(zombie.applied, false);
  await drain();
  const a = await stepOf(run.id, "a");
  assert.equal(a.status, "COMPLETED");
  assert.notEqual(a.output?.zombie, true);
  const hist = await attemptsOf(run.id, "a");
  assert.equal(hist[0].status, "FAILED");
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
  assert.equal((await stepOf(run.id, REPORT_STEP_KEY)).status, "RETRYING");
  await pool.query("UPDATE workflow_jobs SET available_at = now() WHERE run_id = $1 AND status = 'queued'", [run.id]); // skip the 5s backoff
  await drain();
  const rep = await stepOf(run.id, REPORT_STEP_KEY);
  assert.equal(rep.status, "WAITING_APPROVAL");
  const persisted = await q(pool, "SELECT a.status FROM workflow_step_attempts a WHERE a.step_id = $1 ORDER BY a.number", [rep.id]);
  assert.deepEqual(persisted.map((a) => a.status), ["WAITING_APPROVAL", "FAILED", "WAITING_APPROVAL"], "history kept: first draft, crashed attempt, new draft");
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
    assert.match(msgs[0].text, /Cần bạn trả lời câu hỏi/);
    assert.match(msgs[0].text, /Task: HSK-1: Thiếu &lt;ZIP&gt;/, "HTML-escaped task name");
    assert.match(msgs[0].text, new RegExp(`Run: #${run.id}`));
    assert.match(msgs[0].text, /Bước: Hỏi rule \(<code>ask<\/code>\)/);
    assert.match(msgs[0].text, /2 câu hỏi cần trả lời/);
    assert.equal(msgs[0].reply_markup, undefined, "local publicUrl → no URL button");
    assert.ok(msgs[0].text.includes(`/#/runs/${run.id}/ask`), "local link as text");
    // Telegram drops localhost links; 127.0.0.1 stays clickable, as an <a href>
    const local = `http://127.0.0.1:4545/#/runs/${run.id}/ask`;
    assert.ok(msgs[0].text.includes(`<a href="${local}">${local}</a>`), msgs[0].text);
    assert.ok(!msgs[0].text.includes("localhost"));
    // HTTPS publicUrl → inline URL button
    config.publicUrl = "https://platform.example.com";
    const qs = await q(pool, "SELECT id FROM workflow_questions WHERE run_id = $1", [run.id]);
    await answerQuestions(Object.fromEntries(qs.map((x) => [x.id, "ok"])));
    await drain();
    assert.equal(msgs.length, 2, "WAITING_APPROVAL → one more message");
    assert.match(msgs[1].text, /Cần bạn duyệt/);
    assert.match(msgs[1].text, /Duyệt kế hoạch fix/);
    assert.deepEqual(msgs[1].reply_markup.inline_keyboard[0][0], { text: "Mở bước cần xử lý", url: `https://platform.example.com/#/runs/${run.id}/approve` });
    assert.ok(!msgs[1].text.includes("Mở bước cần xử lý:"), "no duplicate text link when the button exists");
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
  assert.equal(r.branch, wi.code, "the run keeps its own branch name for every other repository");
  const explicit = await startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-background"], inputs: { branches: { "oms-background": "HSK-OTHER" } } });
  assert.deepEqual((await getRun(explicit.id)).inputs.branches, { "oms-background": "HSK-OTHER" });
  await assert.rejects(startRun({ definitionKey: key, workItemId: wi.id, repositories: ["oms-background"], inputs: { branches: { "*": "release/prod" } } }), /base branch/);
});
