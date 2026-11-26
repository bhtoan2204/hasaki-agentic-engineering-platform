import { test } from "node:test";
import assert from "node:assert/strict";
import { humanApprovalExecutor } from "../src/workflow/executors/builtin.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec } from "../src/workflow/graph.ts";

const refactoring = validateSpec(TEMPLATES.find((t) => t.key === "refactoring")!.spec);
const select = refactoring.steps.find((s) => s.key === "select")!;

const decide = (
  selected: string[],
  discovery: Record<string, unknown> | null,
  inputs: Record<string, unknown> = {},
) =>
  humanApprovalExecutor.execute({
    step: { ...select, id: 1 },
    run: {
      id: 1,
      selected_repositories: selected,
      allowed_repositories: ["pay", "auth", "web"],
      graph: refactoring,
    },
    input: {
      upstream: discovery ? { discover: { status: "COMPLETED", output: discovery } } : {},
      run: { inputs },
    },
  } as never);

const clear = { candidates: [{ repo: "pay", score: 9 }], recommended: ["pay"], ambiguous: false };
const unclear = {
  candidates: [
    { repo: "pay", score: 9 },
    { repo: "auth", score: 8 },
  ],
  recommended: ["pay", "auth"],
  ambiguous: true,
};

test("refactoring discovers its repository from the task instead of requiring one at start", () => {
  assert.equal(refactoring.inputs?.repositories?.required, false);
  assert.equal(refactoring.steps[0].key, "discover");
  assert.equal(select.type, "human_approval");
  assert.deepEqual(select.depends_on, ["discover"]);
  assert.deepEqual(refactoring.steps.find((s) => s.key === "analyze")!.depends_on, ["select"]);
});

test("repositories the run was started with pass straight through", async () => {
  const r = await decide(["auth"], { ...unclear });
  assert.equal(r.kind, "completed");
  assert.deepEqual(
    (r as unknown as { output: { selected_repositories: string[] } }).output.selected_repositories,
    ["auth"],
  );
});

test("a clear discovery is selected without asking", async () => {
  const r = await decide(["pay"], { ...clear, selected_repositories: ["pay"] });
  assert.equal(r.kind, "completed");
  assert.deepEqual(
    (r as unknown as { output: { selected_repositories: string[] } }).output.selected_repositories,
    ["pay"],
  );
});

test("an ambiguous discovery's provisional pick is not auto-approved: the developer chooses", async () => {
  const r = await decide(["pay", "auth"], { ...unclear, selected_repositories: ["pay", "auth"] });
  assert.equal(r.kind, "waiting_approval");
  const request = (r as unknown as { request: { candidates: unknown[]; recommended: string[] } })
    .request;
  assert.deepEqual(request.recommended, ["pay", "auth"]);
  assert.equal(request.candidates.length, 2);
});
