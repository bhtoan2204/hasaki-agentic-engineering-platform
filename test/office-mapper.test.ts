import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFromEvents, activityFromTool, mapOffice, poseOf, primaryStep, roleOfStep } from "../web/src/office/workflowToAgentMapper.ts";
import type { OfficeSnapshot } from "../web/src/office/types.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";

test("office: every step of every built-in template maps to the expected character", () => {
  const expected: Record<string, string> = {
    analyze: "analyst", discover: "analyst", confirm_repos: "analyst", select: "analyst", root_cause: "analyst",
    plan: "architect", approve_plan: "architect", fix_proposal: "architect", approve_fix: "architect", architecture: "architect", approval: "architect",
    implement: "developer", refactor: "developer",
    test: "tester", regression_test: "tester",
    review: "reviewer", security: "reviewer", report: "reviewer",
    pr: "pr", task_result_report: "pr",
  };
  for (const t of TEMPLATES) {
    const steps = (t.spec as any).steps as any[];
    for (const s of steps) {
      const role = roleOfStep(s, steps);
      if (expected[s.key]) assert.equal(role, expected[s.key], `${t.key}/${s.key}`);
    }
  }
  assert.equal(roleOfStep({ key: "task_result_report", name: "Task Result Report", type: "task_result_report" }, []), "pr");
});

test("office: pose follows the exact backend step status model", () => {
  const now = Date.parse("2026-11-04T10:00:00Z");
  const cases: Record<string, string> = {
    PENDING: "idle", READY: "prepare", RUNNING: "work", RETRYING: "work", WAITING_INPUT: "ask", WAITING_APPROVAL: "approval",
    FAILED: "frustrated", CANCELED: "stopped", SKIPPED: "skipped",
  };
  for (const [status, pose] of Object.entries(cases)) assert.equal(poseOf(status, null, now), pose, status);
  assert.equal(poseOf("COMPLETED", "2026-11-04T09:59:57Z", now), "celebrate", "brief celebration right after finishing");
  assert.equal(poseOf("COMPLETED", "2026-11-04T09:50:00Z", now), "done");
});

test("office: tool calls map to activities; unknown tools are not invented", () => {
  assert.deepEqual(activityFromTool("Read", { file_path: "/w/app/usecases/payment.go" }), { activity: "reading", text: "Đọc payment.go" });
  assert.equal(activityFromTool("Edit", { file_path: "a/b.go" })!.activity, "typing");
  assert.equal(activityFromTool("Bash", { command: "go test -short ./app/..." })!.activity, "testing");
  assert.equal(activityFromTool("Bash", { command: "git -C oms-api diff --stat" })!.activity, "git");
  assert.equal(activityFromTool("Bash", { command: "ls app" })!.activity, "terminal");
  assert.equal(activityFromTool("mcp__platform__ask_user", {})!.activity, "asking");
  assert.equal(activityFromTool("mcp__platform__read_knowledge", { key: "oms-money-model" })!.activity, "knowledge");
  assert.equal(activityFromTool("SomethingNew", {}), null);
  // latest event wins; thinking after a tool → thinking
  const ev = (id: number, kind: string, data?: any) => ({ id, kind, content: "", data, created_at: "" });
  assert.equal(activityFromEvents([ev(1, "tool", { name: "Read", input: {} }), ev(2, "thinking")], "agent")!.activity, "thinking");
  assert.equal(activityFromEvents([ev(1, "thinking"), ev(2, "tool", { name: "Edit", input: { file_path: "x.go" } })], "coding_agent")!.text, "Sửa x.go");
  assert.equal(activityFromEvents([], "agent"), null);
});

const snap = (over: Partial<OfficeSnapshot> = {}): OfficeSnapshot => ({
  run: { id: 7, title: "HSK-1", status: "RUNNING" },
  graph: [
    { key: "analyze", type: "agent" },
    { key: "approve", type: "human_approval", depends_on: ["analyze"] },
    { key: "implement", type: "coding_agent", depends_on: ["approve"] },
    { key: "test", type: "command", depends_on: ["implement"] },
  ],
  steps: [
    { key: "analyze", name: "Requirement Analysis", type: "agent", status: "COMPLETED", current_attempt_id: 1, position: 0 },
    { key: "approve", name: "Approve", type: "human_approval", status: "COMPLETED", current_attempt_id: 2, position: 1 },
    { key: "implement", name: "Implementation", type: "coding_agent", status: "RUNNING", current_attempt_id: 3, position: 2 },
    { key: "test", name: "Testing", type: "command", status: "PENDING", current_attempt_id: null, position: 3 },
  ],
  attempts: [
    { id: 1, step_key: "analyze", number: 1, status: "COMPLETED", started_at: "2026-11-04T09:00:00Z", finished_at: "2026-11-04T09:05:00Z" },
    { id: 2, step_key: "approve", number: 1, status: "COMPLETED", started_at: "2026-11-04T09:05:00Z", finished_at: "2026-11-04T09:06:00Z" },
    { id: 3, step_key: "implement", number: 1, status: "RUNNING", started_at: "2026-11-04T09:58:00Z", finished_at: null },
  ],
  questions: [],
  events: { 3: [{ id: 10, kind: "tool", content: "", data: { name: "Edit", input: { file_path: "app/x.go" } }, created_at: "" }] },
  ...over,
});
const NOW = Date.parse("2026-11-04T10:00:00Z");

test("office: real run state drives the characters", () => {
  const a = Object.fromEntries(mapOffice(snap(), NOW).map((x) => [x.role, x]));
  assert.equal(a.developer.pose, "work");
  assert.equal(a.developer.activity, "typing");
  assert.equal(a.developer.bubble, "Sửa x.go");
  assert.equal(a.developer.durationMs, 120000);
  assert.equal(a.analyst.pose, "done");
  assert.equal(a.tester.pose, "idle");
  assert.match(a.tester.bubble, /Chờ tới lượt: Testing/);
  assert.equal(a.reviewer.step, null, "no review step in this run");
  assert.equal(a.pr.pose, "idle");
});

test("office: no transcript yet → role's default work, no invented tool activity", () => {
  const a = mapOffice(snap({ events: {} }), NOW).find((x) => x.role === "developer")!;
  assert.equal(a.activity, "typing");
  assert.equal(a.bubble, "Implementation…");
});

test("office: waiting, failures, retries and concurrency", () => {
  const steps = snap().steps.map((s) => (s.key === "approve" ? { ...s, status: "WAITING_APPROVAL" } : s.key === "analyze" ? { ...s, status: "WAITING_INPUT" } : s));
  const s1 = snap({ steps, questions: [{ step_key: "analyze", status: "open" }, { step_key: "analyze", status: "open" }, { step_key: "analyze", status: "answered" }] });
  const analyst = mapOffice(s1, NOW).find((x) => x.role === "analyst")!;
  assert.equal(analyst.pose, "ask", "waiting input outranks the approval of the same role");
  assert.equal(analyst.bubble, "Cần bạn trả lời 2 câu hỏi");
  assert.equal(analyst.activeCount, 2);

  const failed = snap({
    steps: snap().steps.map((s) => (s.key === "implement" ? { ...s, status: "FAILED" } : s)),
    attempts: snap().attempts.map((a) => (a.id === 3 ? { ...a, status: "FAILED", finished_at: "2026-11-04T09:59:00Z", error: { message: "go build failed\nmore" } } : a)),
  });
  const dev = mapOffice(failed, NOW).find((x) => x.role === "developer")!;
  assert.equal(dev.pose, "frustrated");
  assert.equal(dev.bubble, "Lỗi: go build failed");

  const retry = mapOffice(snap({ steps: snap().steps.map((s) => (s.key === "implement" ? { ...s, status: "RETRYING" } : s)) }), NOW).find((x) => x.role === "developer")!;
  assert.equal(retry.retrying, true);
  assert.match(retry.bubble, /^Thử lại! /);

  assert.equal(primaryStep([{ key: "a", name: "a", type: "agent", status: "COMPLETED" }, { key: "b", name: "b", type: "agent", status: "RUNNING" }], [])!.key, "b");
});

test("office: empty office when no run is selected", () => {
  const agents = mapOffice({ run: null, steps: [], graph: [], attempts: [], questions: [], events: {} }, NOW);
  assert.equal(agents.length, 6);
  assert.ok(agents.every((a) => a.pose === "idle" && a.step === null && a.bubble === "Đang chờ việc ☕"));
});
