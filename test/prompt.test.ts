import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTaskPrompt, normalizeTask } from "../src/prompt.ts";

describe("normalizeTask", () => {
  test("extracts fields from wrapped data payload", () => {
    const raw = {
      data: {
        id: 101,
        code: "TASK-101",
        name: "Implement feature",
        project: { name: "Platform" },
      },
    };
    const result = normalizeTask(raw);
    assert.equal(result.workId, 101);
    assert.equal(result.code, "TASK-101");
    assert.equal(result.name, "Implement feature");
    assert.equal(result.project, "Platform");
    assert.deepEqual(result.data, raw.data);
  });

  test("extracts fields from bare data payload without data wrapper", () => {
    const raw = {
      id: "202",
      code: "BUG-202",
      name: "Fix null pointer",
      project: { name: "Billing" },
    };
    const result = normalizeTask(raw);
    assert.equal(result.workId, 202);
    assert.equal(result.code, "BUG-202");
    assert.equal(result.name, "Fix null pointer");
    assert.equal(result.project, "Billing");
  });

  test("handles missing or falsy optional fields (id, project)", () => {
    const withoutId = normalizeTask({
      code: "T-1",
      name: "Task without id",
    });
    assert.equal(withoutId.workId, null);
    assert.equal(withoutId.project, "");

    const withZeroId = normalizeTask({
      id: 0,
      code: "T-2",
      name: "Task with zero id",
    });
    assert.equal(withZeroId.workId, null);

    const withNullProject = normalizeTask({
      id: 5,
      code: "T-3",
      name: "Task with null project",
      project: null,
    });
    assert.equal(withNullProject.project, "");
  });

  test("throws error when code or name is missing or invalid", () => {
    assert.throws(() => normalizeTask(null), /payload must contain data\.code and data\.name/);
    assert.throws(() => normalizeTask(undefined), /payload must contain data\.code and data\.name/);
    assert.throws(() => normalizeTask({}), /payload must contain data\.code and data\.name/);
    assert.throws(
      () => normalizeTask({ code: "T-1" }),
      /payload must contain data\.code and data\.name/,
    );
    assert.throws(
      () => normalizeTask({ name: "Task" }),
      /payload must contain data\.code and data\.name/,
    );
    assert.throws(
      () => normalizeTask({ data: { code: "" } }),
      /payload must contain data\.code and data\.name/,
    );
    assert.throws(
      () => normalizeTask({ data: { code: "T-1", name: "" } }),
      /payload must contain data\.code and data\.name/,
    );
  });
});

describe("buildTaskPrompt", () => {
  const baseTask = {
    code: "TASK-500",
    name: "Refactor checkout",
    project: { name: "Storefront" },
    parent: { code: "PARENT-10", name: "Checkout Epics" },
    milestone: { name: "Sprint 42" },
    created_by_user: { staff_name: "Alice", staff_title: "Tech Lead" },
    assign_to_user: [{ staff_name: "Bob" }, { staff_name: "Charlie" }],
    date_end: "2026-12-01",
    note: "Please optimize order placement performance.",
    task_ai: {
      ai_suggest: {
        object: "order",
        object_value: "12345",
        readiness_reasoning: "Ready for refactor",
      },
    },
  };

  test("formats complete task with all sections present", () => {
    const prompt = buildTaskPrompt(
      baseTask,
      ["repo-order", "repo-payment"],
      ["screenshot.png", "trace.log"],
    );
    assert.match(prompt, /^# Task TASK-500: Refactor checkout/);
    assert.match(prompt, /- Project: Storefront/);
    assert.match(prompt, /- Parent: PARENT-10 Checkout Epics/);
    assert.match(prompt, /- Milestone: Sprint 42/);
    assert.match(prompt, /- Created by: Alice \(Tech Lead\)/);
    assert.match(prompt, /- Assignee: Bob, Charlie/);
    assert.match(prompt, /- Deadline: 2026-12-01/);
    assert.match(prompt, /## Description\nPlease optimize order placement performance\./);
    assert.match(prompt, /## Attachments \(read them with the Read tool/);
    assert.match(prompt, /- screenshot\.png\n- trace\.log/);
    assert.match(prompt, /## Task-system AI hints/);
    assert.match(prompt, /- Object: order = 12345/);
    assert.match(prompt, /- Ready for refactor/);
    assert.match(prompt, /## Repositories you may change/);
    assert.match(prompt, /- repo-order\n- repo-payment/);
  });

  test("handles empty note without attachments", () => {
    const task = {
      code: "TASK-501",
      name: "Empty task",
      note: "   ",
    };
    const prompt = buildTaskPrompt(task, ["repo-a"], []);
    assert.match(prompt, /\(empty — the task has only a title\)/);
    assert.doesNotMatch(prompt, /## Attachments/);
    assert.doesNotMatch(prompt, /- Parent:/);
    assert.doesNotMatch(prompt, /- Milestone:/);
    assert.match(prompt, /- Created by: \? \(\)/);
    assert.match(prompt, /- Assignee: \?/);
    assert.match(prompt, /- Deadline: \?/);
  });

  test("handles empty note with attachments", () => {
    const task = {
      code: "TASK-502",
      name: "Image only bug",
      note: "",
    };
    const prompt = buildTaskPrompt(task, ["repo-a"], ["error.png"]);
    assert.match(prompt, /\(empty — the task has only a title and attachments\)/);
    assert.match(prompt, /## Attachments/);
    assert.match(prompt, /- error\.png/);
  });

  test("omits AI hints section when task_ai.ai_suggest is absent", () => {
    const task = {
      code: "TASK-503",
      name: "No AI hints",
      note: "Normal description",
    };
    const prompt = buildTaskPrompt(task, ["repo-a"], []);
    assert.doesNotMatch(prompt, /Task-system AI hints/);
  });

  test("handles empty repos array and empty files array", () => {
    const task = {
      code: "TASK-504",
      name: "Minimal",
      note: "Minimal note",
    };
    const prompt = buildTaskPrompt(task, [], []);
    assert.ok(
      prompt.endsWith("## Repositories you may change (resolve paths through platform tools)"),
    );
    assert.doesNotMatch(prompt, /## Attachments/);
  });
});
