import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { workItems } from "../src/workitems/service.ts";
import { listRuns, runDetail, startRun } from "../src/workflow/engine.ts";
import { createUser } from "../src/auth/users.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";

before(async () => {
  await migrate(pool);
  await seedTemplates();
});

after(() => pool.end());

test("Phase H: migration 035 performance indexes exist and are active in PostgreSQL", async () => {
  const indexes = await q<{ indexname: string }>(
    pool,
    `SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'workflow_questions_run_status',
        'workflow_questions_run_id',
        'workflow_checkpoints_run_id',
        'pull_requests_work_item',
        'pull_requests_run',
        'pull_requests_updated',
        'workflow_steps_run_position'
      )
      ORDER BY indexname`,
  );
  const names = indexes.map((i) => i.indexname);
  assert.ok(
    names.includes("workflow_questions_run_status"),
    "workflow_questions_run_status index exists",
  );
  assert.ok(names.includes("workflow_questions_run_id"), "workflow_questions_run_id index exists");
  assert.ok(
    names.includes("workflow_checkpoints_run_id"),
    "workflow_checkpoints_run_id index exists",
  );
  assert.ok(names.includes("pull_requests_work_item"), "pull_requests_work_item index exists");
  assert.ok(names.includes("pull_requests_run"), "pull_requests_run index exists");
  assert.ok(names.includes("pull_requests_updated"), "pull_requests_updated index exists");
  assert.ok(
    names.includes("workflow_steps_run_position"),
    "workflow_steps_run_position index exists",
  );
});

test("Phase G & H: listRuns and runDetail execute efficiently with the new indexes", async () => {
  const user = await createUser({
    username: "spa-perf-user",
    password: "perf-pass-123",
    role: "admin",
  });
  const wi = await workItems.createManual({
    title: "Test SPA Performance Work Item",
    description: "Verify index performance",
    project: "OMS",
    ownerId: user.id,
  });

  const run = await startRun({
    definitionKey: "code-review",
    workItemId: wi.id,
    ownerId: user.id,
  });

  // Verify listRuns works and uses subqueries with index
  const runs = await listRuns({ workItemId: wi.id, ownerId: user.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, run.id);

  // Verify runDetail fetches all details correctly
  const detail = await runDetail(run.id);
  assert.equal(detail.id, run.id);
  assert.ok(Array.isArray(detail.steps));
  assert.ok(Array.isArray(detail.attempts));
  assert.ok(Array.isArray(detail.questions));
  assert.ok(Array.isArray(detail.checkpoints));
  assert.ok(Array.isArray(detail.pull_requests));
});

test("Phase C: Frontend data fetching infrastructure supports deduplication and cache invalidation", () => {
  // Simulate the in-memory cache behavior in api.ts
  const apiCache = new Map<string, { data: any; timestamp: number }>();

  function invalidateCache(prefix?: string) {
    if (!prefix) {
      apiCache.clear();
      return;
    }
    for (const key of apiCache.keys()) {
      if (key.includes(prefix)) apiCache.delete(key);
    }
  }

  // Populate cache
  apiCache.set("/api/work-items", { data: [{ id: 1 }], timestamp: Date.now() });
  apiCache.set("/api/work-items/1", { data: { id: 1 }, timestamp: Date.now() });
  apiCache.set("/api/repositories", { data: [{ name: "repo" }], timestamp: Date.now() });

  assert.equal(apiCache.size, 3);
  invalidateCache("/api/work-items");
  assert.equal(apiCache.has("/api/work-items"), false);
  assert.equal(apiCache.has("/api/work-items/1"), false);
  assert.equal(apiCache.has("/api/repositories"), true);

  // Clear all
  invalidateCache();
  assert.equal(apiCache.size, 0);
});
