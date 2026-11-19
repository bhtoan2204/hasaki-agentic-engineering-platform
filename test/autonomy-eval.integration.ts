import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { workItems } from "../src/workitems/service.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";
import { recordObservation } from "../src/learning/observations.ts";
import { computeAutonomyMetrics, episodesFromTelemetry } from "../src/eval/autonomy.ts";

let owner = 0;
let other = 0;
before(async () => {
  await migrate();
  await definitions.create({
    key: "ae-fixture",
    spec: {
      name: "AE",
      steps: [{ key: "approve", type: "human_approval", config: { show_outputs: [] } }],
    },
  });
  owner = await ensureTestOwner();
  other = Number(
    (await one(
      pool,
      "INSERT INTO users (username, password_hash, role) VALUES ('ae-other', 'x', 'member') RETURNING id",
    ))!.id,
  );
});
after(async () => {
  await settleBackground();
  await pool.end();
});

async function run(
  ownerId: number,
  opts: {
    workItemId?: number;
    status: string;
    approval?: "human" | "machine";
    autonomous?: boolean;
    observe?: string[];
  },
) {
  const r = await startRun({
    definitionKey: "ae-fixture",
    workItemId: opts.workItemId ?? null,
    ownerId,
    title: "t",
    start: false,
  });
  await q(
    pool,
    "UPDATE workflow_runs SET status = $2, finished_at = now(), autonomy = $3 WHERE id = $1",
    [r.id, opts.status, opts.autonomous ? JSON.stringify({ mode: "AUTONOMOUS" }) : null],
  );
  if (opts.approval)
    await q(
      pool,
      "UPDATE workflow_steps SET status = 'COMPLETED', approval = $2 WHERE run_id = $1",
      [r.id, JSON.stringify({ granted: true, actor_type: opts.approval })],
    );
  for (const kind of opts.observe ?? [])
    await recordObservation({
      kind: kind as never,
      sourceType: "platform",
      sourceRef: `t:${r.id}:${kind}`,
      subject: `run:${r.id}`,
      runId: r.id,
      ownerId,
      verified: true,
    });
  return r.id;
}

test("telemetry episodes: retries of a work item are one episode, machine approvals are not human, owners are isolated, metrics match the records", async () => {
  const wi = await workItems.createManual({ title: "retry episode", ownerId: owner });
  await run(owner, { workItemId: wi.id, status: "FAILED", approval: "human" });
  await run(owner, {
    workItemId: wi.id,
    status: "COMPLETED",
    approval: "human",
    observe: ["run_completed", "tests_passed", "review_passed"],
  });
  const auto = await run(owner, {
    status: "COMPLETED",
    approval: "machine",
    autonomous: true,
    observe: ["run_completed", "tests_passed", "review_passed", "pr_opened"],
  });
  await run(other, { status: "COMPLETED", approval: "human", observe: ["run_completed"] });

  const eps = await episodesFromTelemetry({ ownerId: owner, days: 1 });
  assert.equal(eps.length, 2, "two episodes for this owner; the other owner's run is not visible");
  const retry = eps.find((e) => e.episode_id === `wi:${wi.id}`)!;
  assert.equal(retry.runs, 2);
  assert.equal(retry.status, "completed");
  assert.equal(retry.human_events.length, 2, "both human approvals of the episode count");
  assert.equal(retry.eligibility, "supervised");
  const a = eps.find((e) => e.episode_id === `run:${auto}`)!;
  assert.deepEqual(
    [a.eligibility, a.human_events.length, a.verified_delivery, a.pr],
    ["autonomous", 0, true, "pending"],
  );
  assert.equal(
    a.usage.cost_usd,
    0,
    "no telemetry rows: nothing unknown was reported (no attempts ran)",
  );

  const m = computeAutonomyMetrics(eps);
  assert.deepEqual(
    [m.human_free_completion.numerator, m.human_free_completion.denominator],
    [1, 1],
  );
  assert.equal(m.interventions.total, 2);

  // A late PR outcome arrives: changes requested on the autonomous episode.
  await recordObservation({
    kind: "pr_changes_requested",
    sourceType: "provider",
    sourceRef: `t:${auto}:late`,
    subject: `pr:x`,
    runId: auto,
    ownerId: owner,
    verified: true,
  });
  const later = (await episodesFromTelemetry({ ownerId: owner, days: 1 })).find(
    (e) => e.episode_id === `run:${auto}`,
  )!;
  assert.equal(later.pr, "changes_requested");
  // A regression report makes the earlier claimed success wrong (oracle false) — the false-completion gate sees it.
  await recordObservation({
    kind: "regression_reported",
    sourceType: "manual",
    sourceRef: `t:${auto}:reg`,
    subject: `run:${auto}`,
    runId: auto,
    ownerId: owner,
    verified: false,
  });
  const after = computeAutonomyMetrics(await episodesFromTelemetry({ ownerId: owner, days: 1 }));
  assert.equal(after.false_completion.numerator, 1);
  assert.equal(after.regression_escape.numerator, 1);
  // Admin view sees every owner.
  assert.equal((await episodesFromTelemetry({ ownerId: null, days: 1 })).length, 3);
});
