import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, startPendingRun, getRun } from "../src/workflow/engine.ts";
import { recordWorkspace } from "../src/git/provider.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { repositories } from "../src/repos/service.ts";
import { workItems } from "../src/workitems/service.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";
import { recordRunOutcome } from "../src/learning/outcomes.ts";
import {
  currentObservations,
  observeManual,
  observePullRequest,
  observeRun,
} from "../src/learning/observations.ts";
import { extractLessons, learningOverview } from "../src/learning/lessons.ts";
import { outcomeRecommendations } from "../src/learning/providerPerformance.ts";
import { buildStepInput, resolveContext } from "../src/workflow/context.ts";
import { reviewMemory } from "../src/knowledge/memory.ts";
import { dispatchRunEffects } from "../src/workflow/effects.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const REPO = "learn-repo";
let head = "";
let owner = 0;
let other = 0;
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    encoding: "utf8",
  }).trim();

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  const dir = join(config.reposRoot, REPO);
  mkdirSync(join(dir, "app"), { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", config.baseBranch]);
  writeFileSync(join(dir, "app", "retry.go"), "package app\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  head = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", `refs/remotes/origin/${config.baseBranch}`, head);
  writeFileSync(join(dir, ".git", "FETCH_HEAD"), "");
  utimesSync(join(dir, ".git", "FETCH_HEAD"), new Date(), new Date());
  await repositories.upsert(REPO, { projects: ["LRN"] });
  await repositories.upsert("other-repo", { projects: ["LRN"] });
  owner = await ensureTestOwner();
  other = Number(
    (await one(
      pool,
      "INSERT INTO users (username, password_hash, role) VALUES ('learn-other', 'x', 'member') RETURNING id",
    ))!.id,
  );
  const spec = {
    name: "Learn",
    steps: [
      {
        key: "implement",
        type: "coding_agent",
        config: { verify: { command: "go test ./app/..." } },
      },
      { key: "review", type: "agent", depends_on: ["implement"], config: { independent: true } },
    ],
  };
  await definitions.create({ key: "learn-fixture", spec });
  await definitions.create({ key: "learn-other-kind", spec: { ...spec, name: "Other kind" } });
  registerExecutor("coding_agent", {
    execute: async () => ({
      kind: "completed",
      output: {
        summary: "done",
        verification: {
          passed: true,
          last: [
            {
              repo: REPO,
              required_tests: { [`${REPO}::app/TestRetry`]: "passed" },
              weakened: ["app/retry_test.go: TestRetryInvalid skipped"],
            },
          ],
        },
      },
    }),
  });
  registerExecutor("agent", {
    execute: async () => ({
      kind: "completed",
      output: {
        verdict: "FAIL",
        findings: [
          {
            file: `${REPO}:app/retry.go`,
            explanation:
              "Retrying 13101 hides the malformed phone instead of fixing it at the source token=sk_live_abcdef0123456789",
          },
        ],
      },
    }),
  });
  registerExecutor("integration", { execute: async () => ({ kind: "completed", output: {} }) });
});
after(async () => {
  await settleBackground();
  await pool.end();
});

async function finishedRun(
  definitionKey = "learn-fixture",
  ownerId = owner,
  title = "Fix phone retry",
) {
  const wi = await workItems.createManual({ title, ownerId });
  const run = await startRun({
    definitionKey,
    workItemId: wi.id,
    repositories: [REPO],
    title,
    profile: "STANDARD",
    ownerId,
    start: false,
  });
  // Like a real run: its worktree is recorded, so the outcome knows the final commit before the effects learn from it.
  await recordWorkspace(run.id, {
    repo: REPO,
    branch: config.baseBranch,
    path: join(config.reposRoot, REPO),
    created_from: config.baseBranch,
  });
  await startPendingRun(run.id);
  for (let i = 0; i < 5; i++) await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  await recordRunOutcome(run.id);
  await q(
    pool,
    'UPDATE workflow_runs SET outcome = jsonb_set(outcome, \'{ladder,tests_passed}\', \'{"state":"proven","evidence":"verification"}\') WHERE id = $1',
    [run.id],
  );
  return { run, wi };
}

test("observations: run and PR facts are separate, idempotent across retries; merge is acceptance; a later regression supersedes", async () => {
  const { run } = await finishedRun();
  await observeRun(run.id);
  const again = await observeRun(run.id);
  assert.ok(
    (await currentObservations(run.id)).length >= 2,
    "run status and test evidence are separate facts",
  );
  assert.deepEqual(again, [], "effect retries add nothing");
  await q(
    pool,
    "INSERT INTO pull_requests (provider, repo, source_branch, target_branch, url, title, created, run_id, published_sha) VALUES ('github', $1, 'b-lrn', 'main', 'u', 't', true, $2, $3)",
    [REPO, run.id, head],
  );
  const pr = (await one(pool, "SELECT id, repo, run_id FROM pull_requests WHERE run_id = $1", [
    run.id,
  ]))!;
  const merged = await observePullRequest(pr, "MERGED", head, []);
  assert.ok(merged);
  assert.equal(await observePullRequest(pr, "MERGED", head, []), null, "same poll twice → one row");
  const mergedRow = (await one(pool, "SELECT evidence FROM outcome_observations WHERE id = $1", [
    merged,
  ]))!;
  assert.match(mergedRow.evidence.meaning, /not proof of correctness/);
  const regression = await observeManual({
    runId: run.id,
    kind: "regression_reported",
    note: "rollback after SPX rejects",
    by: "dev",
  });
  assert.ok(regression);
  const kinds = (await currentObservations(run.id)).map((o) => o.kind);
  assert.ok(
    kinds.includes("regression_reported") && kinds.includes("pr_merged"),
    "nothing is erased",
  );
  const recs = await outcomeRecommendations({ ownerId: owner, minSamples: 5 });
  assert.ok(recs.recommendations.every((r) => r.status === "shadow"));
  const g = recs.recommendations
    .flatMap((r) => r.groups)
    .find((x) => x.definition_key === "learn-fixture")!;
  assert.equal(g.successes, 0, "a regression after merge makes the outcome a failure for learning");
});

test("lessons: idempotent; repeats of the same work item do not corroborate; secrets redacted; retrieval scoped by repo, task kind and owner", async () => {
  const { run, wi } = await finishedRun();
  // The outcome effect may already have learned from this run when it finished; extracting again adds nothing.
  await observeRun(run.id);
  await extractLessons(run.id);
  const r2 = await extractLessons(run.id);
  assert.equal(r2.stored + r2.corroborated, 0, "re-running the extraction adds nothing");
  const lessons = await q(
    pool,
    "SELECT i.key, i.owner_id, v.content, v.metadata FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.key LIKE 'memory.lesson.%' AND v.metadata->'memory'->'corroborated_by' ? $1",
    [`wi:${wi.id}`],
  );
  assert.ok(lessons.length >= 3, `lessons from this work item: ${lessons.length}`);
  assert.ok(
    lessons.every(
      (l) => Number(l.owner_id) === owner && l.metadata.memory.authority === "proposal",
    ),
  );
  assert.ok(
    lessons.every((l) => !/sk_live_abcdef0123456789/.test(l.content)),
    "secret redacted",
  );
  // A second, independent task corroborates; the same task re-run would not.
  const { wi: wi2 } = await finishedRun("learn-fixture", owner, "Fix phone retry again");
  const corroborated = await q(
    pool,
    "SELECT v.metadata->'memory'->'corroborated_by' AS by FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.key LIKE 'memory.lesson.%' AND v.metadata->'memory'->'corroborated_by' ? $1",
    [`wi:${wi2.id}`],
  );
  assert.ok(
    corroborated.some((c) => c.by.length >= 2),
    "an independent task corroborates the lesson",
  );
  // Retrieval for a new task of the same kind and repository: the negative lesson is offered, few and labelled.
  const { run: run3 } = await finishedRun("learn-fixture", owner, "Another retry change");
  const step = (await getRun(run3.id)).steps.find((s) => s.key === "implement")!;
  const ctx = await resolveContext(
    pool,
    (await getRun(run3.id)) as never,
    step as never,
    await buildStepInput(pool, (await getRun(run3.id)) as never, step as never),
  );
  const keys = ctx.knowledge.map((k) => k.key).filter((k) => k.startsWith("memory.lesson."));
  assert.ok(
    keys.some((k) => k.startsWith("memory.lesson.negative.")),
    keys.join(","),
  );
  assert.ok(keys.length <= config.learning.maxLessons, "lesson budget");
  // Another kind of task and another owner do not inherit them.
  const { run: run4 } = await finishedRun("learn-other-kind", owner, "Unrelated kind");
  const step4 = (await getRun(run4.id)).steps.find((s) => s.key === "implement")!;
  const ctx4 = await resolveContext(
    pool,
    (await getRun(run4.id)) as never,
    step4 as never,
    await buildStepInput(pool, (await getRun(run4.id)) as never, step4 as never),
  );
  assert.equal(ctx4.knowledge.filter((k) => k.key.startsWith("memory.lesson.")).length, 0);
  const { run: run5 } = await finishedRun("learn-fixture", other, "Other owner");
  const step5 = (await getRun(run5.id)).steps.find((s) => s.key === "implement")!;
  const ctx5 = await resolveContext(
    pool,
    (await getRun(run5.id)) as never,
    step5 as never,
    await buildStepInput(pool, (await getRun(run5.id)) as never, step5 as never),
  );
  assert.equal(
    ctx5.knowledge
      .filter((k) => k.key.startsWith("memory.lesson.") && !k.key.includes(`run-${run5.id}`))
      .filter((k) => Number(k.owner_id) === owner).length,
    0,
    "owner isolation",
  );
  // A human rejects a lesson: it is no longer retrieved.
  const neg = keys.find((k) => k.startsWith("memory.lesson.negative."))!;
  await reviewMemory(neg, "reject", "reviewer", owner);
  const ctx6 = await resolveContext(
    pool,
    (await getRun(run3.id)) as never,
    step as never,
    await buildStepInput(pool, (await getRun(run3.id)) as never, step as never),
  );
  assert.ok(!ctx6.knowledge.some((k) => k.key === neg));
  const overview = await learningOverview(owner);
  assert.ok(overview.lessons.some((l) => l.purpose === "negative"));
});

test("learning effect: the outcome effect records observations and lessons; a failure leaves the effect queued, the run untouched", async () => {
  const { run } = await finishedRun("learn-fixture", owner, "Effect path");
  await q(pool, "DELETE FROM workflow_run_effects WHERE run_id = $1", [run.id]);
  await q(
    pool,
    "INSERT INTO workflow_run_effects (run_id, kind) VALUES ($1, 'outcome') ON CONFLICT DO NOTHING",
    [run.id],
  );
  await dispatchRunEffects();
  assert.ok((await currentObservations(run.id)).length > 0);
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  // Make the learning step fail (observations table temporarily unwritable): the effect stays for a later retry.
  const r2 = await finishedRun("learn-fixture", owner, "Effect failure");
  await q(pool, "DELETE FROM workflow_run_effects WHERE run_id = $1", [r2.run.id]);
  await q(pool, "INSERT INTO workflow_run_effects (run_id, kind) VALUES ($1, 'outcome')", [
    r2.run.id,
  ]);
  await q(
    pool,
    "ALTER TABLE outcome_observations ADD CONSTRAINT block_test CHECK (kind <> 'run_completed') NOT VALID",
  );
  try {
    await dispatchRunEffects();
    assert.ok(
      await one(pool, "SELECT 1 FROM workflow_run_effects WHERE run_id = $1 AND kind = 'outcome'", [
        r2.run.id,
      ]),
      "kept for retry",
    );
    assert.equal((await getRun(r2.run.id)).status, "COMPLETED");
  } finally {
    await q(pool, "ALTER TABLE outcome_observations DROP CONSTRAINT block_test");
  }
});
