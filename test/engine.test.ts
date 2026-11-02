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
  sendFeedback,
  startRun,
} from "../src/workflow/engine.ts";
import { claimJob, drain } from "../src/workflow/scheduler.ts";
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
  setAiRepositoryRanker(null);
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

test("repository selection outside the allowed set is rejected at run start", async () => {
  await assert.rejects(startRun({ definitionKey: "code-review", repositories: ["payment-src"], inputs: { project: "OMS" } }), /not allowed/);
});
