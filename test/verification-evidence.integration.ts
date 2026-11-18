import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  EvidenceCache,
  pgEvidenceStore,
  purgeVerificationEvidence,
} from "../src/agent/verifyEvidence.ts";
import type { RepoVerification } from "../src/agent/verify.ts";

before(async () => {
  await migrate();
});

after(async () => {
  await pool.end();
});

async function newRun() {
  const key = `evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const def = await definitions.create({
    key,
    spec: { name: key, steps: [{ key: "implement", type: "coding_agent", config: {} }] },
  });
  return (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_runs (definition_key, definition_version_id, title, graph, branch, status, worker_instance, allowed_repositories)
     VALUES ($1, $2, 'Evidence', '[]'::jsonb, 'b', 'RUNNING', $3, '{"r"}') RETURNING id`,
    [key, def!.versions[0].id, config.instanceId],
  ))!.id;
}

const passed = (): RepoVerification =>
  ({
    repo: "r",
    status: "passed",
    passed: true,
    exit_code: 0,
    timed_out: false,
    duration_ms: 1200,
    regressions: [],
    pre_existing: 0,
    pre_existing_tests: [],
    weakened: [],
    suspected: [],
    needs_review: false,
    excerpt: "",
    tested_state: { head: "h", fingerprint: "f" },
  }) as RepoVerification;

test("evidence saved by one step is found by another step of the same run only", async () => {
  const runId = await newRun();
  const other = await newRun();
  const parts = { head: "h", workspace_fingerprint: "f", command: "npm test" };
  const lead = await new EvidenceCache(pgEvidenceStore(pool), {
    runId,
    stepKey: "implement",
  }).begin("r", parts);
  assert.equal(lead.kind, "lead");
  if (lead.kind === "lead") assert.equal(await lead.settle(passed()), null);
  const review = await new EvidenceCache(pgEvidenceStore(pool), { runId, stepKey: "review" }).begin(
    "r",
    parts,
  );
  assert.equal(review.kind, "hit");
  const foreign = await new EvidenceCache(pgEvidenceStore(pool), {
    runId: other,
    stepKey: "implement",
  }).begin("r", parts);
  assert.equal(foreign.kind, "lead");
  if (foreign.kind === "lead") foreign.fail();
});

test("retention removes only evidence older than the window", async () => {
  const runId = await newRun();
  const insert = (age: string) =>
    q(
      pool,
      `INSERT INTO verification_evidence (run_id, step_key, repo, key, parts, status, result, created_at)
       VALUES ($1, 's', 'r', $2, '{}', 'passed', '{}', now() - $3::interval)`,
      [runId, `k-${age}`, age],
    );
  await insert("40 days");
  await insert("2 days");
  assert.ok((await purgeVerificationEvidence(30, pool)) >= 1);
  const left = await q<{ key: string }>(
    pool,
    "SELECT key FROM verification_evidence WHERE run_id = $1 ORDER BY key",
    [runId],
  );
  assert.deepEqual(
    left.map((r) => r.key),
    ["k-2 days"],
  );
});
