import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createUser } from "../src/auth/users.ts";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { previewRun, startRun } from "../src/workflow/engine.ts";
import { topoOrder, validateSpec } from "../src/workflow/graph.ts";
import { applyProfile } from "../src/workflow/profiles.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { workItems } from "../src/workitems/service.ts";

const KEY = "intelligent-feature-engineering";
const CHAIN = [
  "understand",
  "discover",
  "confirm_repos",
  "architecture",
  "plan",
  "approve_plan",
  "implement",
  "targeted_test",
  "review",
  "regression_test",
  "quality_gate",
  "pr",
] as const;

after(() => pool.end());

test("intelligent feature engineering is a valid executable template", async () => {
  const raw = TEMPLATES.find((t) => t.key === KEY)!.spec;
  const spec = validateSpec(raw);
  assert.equal(spec.name, "Intelligent Feature Engineering");
  assert.equal(spec.execution_mode, "standard");
  assert.equal(spec.feedback_step, "implement");
  assert.deepEqual(
    spec.steps.map((step) => step.key),
    [...CHAIN],
  );
  for (let i = 1; i < CHAIN.length; i++)
    assert.deepEqual(spec.steps[i].depends_on, [CHAIN[i - 1]]);
  const order = topoOrder(spec.steps);
  assert.deepEqual(order, [...CHAIN]);

  const review = spec.steps.find((step) => step.key === "review")!;
  assert.equal(review.type, "agent");
  assert.equal(review.config.independent, true);
  assert.equal(review.config.max_repairs, 2);
  const pr = spec.steps.find((step) => step.key === "pr")!;
  assert.equal(pr.config.mode, "approval");
  assert.equal(pr.config.content_from, "implement");
  assert.equal(spec.steps.find((step) => step.key === "discover")!.config.action, "repository_discovery");
  assert.match(String(spec.steps.find((step) => step.key === "plan")!.config.instructions), /not child runs/i);
  assert.match(
    String(spec.steps.find((step) => step.key === "targeted_test")!.config.command),
    /typecheck/,
  );

  const feature = validateSpec(TEMPLATES.find((t) => t.key === "feature-implementation")!.spec);
  assert.deepEqual(
    feature.steps.map((step) => step.key),
    [
      "analyze",
      "discover",
      "confirm_repos",
      "plan",
      "approve_plan",
      "implement",
      "test",
      "review",
      "pr",
    ],
  );

  const standard = applyProfile(spec, "STANDARD");
  assert.equal(standard.spec.steps.find((step) => step.key === "review")!.config.independent, true);
  assert.equal(
    standard.spec.steps.some((step) => step.key === "quality_gate"),
    true,
  );
  const fast = applyProfile(spec, "FAST");
  assert.equal(
    fast.spec.steps.some((step) => step.key === "review"),
    false,
  );
  for (const key of ["implement", "regression_test", "quality_gate", "pr"])
    assert.equal(
      fast.spec.steps.some((step) => step.key === key),
      true,
      key,
    );

  await migrate();
  await seedTemplates();
  const published = (await definitions.version(KEY))!;
  assert.equal(published.spec.name, spec.name);
  assert.equal(published.spec.steps.length, CHAIN.length);

  const stamp = Date.now();
  const admin = await createUser({
    username: `ife-admin-${stamp}`,
    password: "pw-12345678",
    role: "admin",
  });
  const member = await createUser({
    username: `ife-member-${stamp}`,
    password: "pw-12345678",
    role: "member",
  });
  const stranger = await createUser({
    username: `ife-stranger-${stamp}`,
    password: "pw-12345678",
    role: "member",
  });
  const repo = (await repositories.upsert(`ife-repo-${stamp}`, {
    projects: ["Platform"],
    enabled: true,
    description: "fixture",
  }))!;
  await setRepositoryAccess(repo, member.id, "pull_request", admin.id);
  const item = await workItems.createManual({
    title: "Add a cross-module feature",
    description: "Change the workflow template and its tests.",
    project: "Platform",
    ownerId: member.id,
  });
  const preview = await previewRun({
    definitionKey: KEY,
    workItemId: item.id,
    ownerId: member.id,
    repositories: [repo.name],
    profile: "STANDARD",
  });
  assert.equal(preview.definition.key, KEY);
  assert.deepEqual(
    preview.graph.steps.map((step) => step.key).filter((key) => key !== "task_result_report"),
    [...CHAIN],
  );
  assert.equal(preview.selected_repositories.includes(repo.name), true);

  const started = await startRun({
    definitionKey: KEY,
    workItemId: item.id,
    ownerId: member.id,
    repositories: [repo.name],
    start: false,
    profile: "STANDARD",
  });
  assert.equal(started.status, "PENDING");
  assert.equal(started.definition_key, KEY);
  const keys = new Set(started.steps.map((step) => step.key));
  for (const key of CHAIN) assert.equal(keys.has(key), true, key);
  assert.equal(started.steps.find((step) => step.key === "pr")?.type, "git_pull_request");

  const foreign = await workItems.createManual({
    title: "Unauthorized",
    project: "Platform",
    ownerId: stranger.id,
  });
  await assert.rejects(
    () =>
      previewRun({
        definitionKey: KEY,
        workItemId: foreign.id,
        ownerId: stranger.id,
        repositories: [repo.name],
      }),
    /not accessible/,
  );
});
