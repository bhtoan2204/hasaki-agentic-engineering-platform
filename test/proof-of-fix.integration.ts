import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { registerInstance } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, retryStep, cancelRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import {
  integrationExecutor,
  registerIntegrationAction,
} from "../src/workflow/executors/builtin.ts";
import { proofOfFixStep, fixProofOf } from "../src/workflow/proofOfFixStep.ts";

/** The real engine runs the proof_of_fix action; agent steps are stubbed with recorded evidence (no model call). */
let ownerId = 0;
let implementOutput: Record<string, unknown> = {};
const runs: number[] = [];

const claim = {
  id: "c1",
  claim: "settlement reads the balance outside the transaction",
  classification: "CODE_FACT",
  source_type: "code",
  source_ref: "payment-src@abc",
  repository: "payment-src",
  commit: "abc",
  file_path: "settle.go",
  line_range: "10-20",
  confidence: "high",
  verification_status: "verified",
  provenance: {
    by: "platform",
    status: "VERIFIED_BY_PLATFORM",
    verifies: "location",
    reason: null,
  },
};
const goodImplement = {
  verification: {
    passed: true,
    needs_review: false,
    review_reasons: [],
    last: [{ repo: "payment-src", weakened: [] }],
  },
  tested_heads: { "payment-src": "h1" },
  regression_proof: {
    status: "verified",
    reason: "fails before, passes after",
    repo: "payment-src",
    test_id: "TestSettleTwice",
    head_sha: "h1",
  },
  remediation: {
    kind: "ROOT_CAUSE_FIX",
    root_cause: "read outside tx",
    causal_link: "read inside tx",
    justifications: [],
  },
};

before(async () => {
  await migrate();
  await registerInstance();
  ownerId = (
    await createUser({ username: "pof-owner", password: "proof-of-fix-test", role: "member" })
  ).id;
  registerIntegrationAction("proof_of_fix", proofOfFixStep);
  registerExecutor("integration", integrationExecutor);
  registerExecutor("agent", {
    async execute(ctx) {
      if (ctx.step.key === "root_cause")
        return {
          kind: "completed",
          output: {
            root_cause: "balance read outside the transaction",
            root_cause_assessment: {
              status: "CONFIRMED",
              confidence: "high",
              explanation: "read before commit",
              supporting_claims: ["c1"],
            },
            claims: [claim],
          },
        };
      if (ctx.step.key === "implement") return { kind: "completed", output: implementOutput };
      return {
        kind: "completed",
        output: { verdict: "PASS", findings: [], root_cause_check: { addresses_root_cause: true } },
      };
    },
  });
  await definitions.create({
    key: "pof-bug",
    spec: {
      name: "Proof-of-fix test",
      steps: [
        { key: "root_cause", type: "agent" },
        { key: "implement", type: "agent", depends_on: ["root_cause"] },
        { key: "review", type: "agent", depends_on: ["implement"], config: { independent: true } },
        {
          key: "proof",
          type: "integration",
          depends_on: ["review"],
          config: {
            action: "proof_of_fix",
            root_cause_from: "root_cause",
            implement_from: "implement",
            review_from: "review",
          },
        },
        { key: "pr", type: "integration", depends_on: ["proof"], config: { action: "noop" } },
      ],
    },
  });
});
after(async () => {
  for (const id of runs) await cancelRun(id).catch(() => {});
  await settleBackground();
  await pool.end();
});

async function run(title: string) {
  const r = await startRun({
    definitionKey: "pof-bug",
    title,
    ownerId,
    inputs: { request: title },
  });
  const id = Number((r as { id: number }).id);
  runs.push(id);
  await drain();
  return id;
}
const stepStatus = async (runId: number, key: string) =>
  (await one(pool, "SELECT status FROM workflow_steps WHERE run_id=$1 AND key=$2", [runId, key]))!
    .status;

test("a verified fix gets a persisted VERIFIED report with traceable evidence; retries keep the history", async () => {
  implementOutput = goodImplement;
  const id = await run("Settlement paid twice");
  assert.equal(await stepStatus(id, "pr"), "COMPLETED");
  const proof = await fixProofOf(id);
  assert.equal(proof.current!.verdict, "VERIFIED", JSON.stringify(proof.current!.report.missing));
  assert.equal(proof.current!.report.root_cause.supporting[0].location, "settle.go:10-20");
  assert.equal(proof.current!.report.incident.request, "Settlement paid twice");
  // Re-executing the step (retry / resume / another worker) appends a new report and keeps the earlier one.
  await retryStep(id, "proof");
  await drain();
  const again = await fixProofOf(id);
  assert.equal(again.history.length, 2);
  assert.ok(again.history.every((h) => h.verdict === "VERIFIED"));
  assert.notEqual(again.history[0].attempt_id, again.history[1].attempt_id);
});

test("a failing fix is FAILED and blocks the pull request step", async () => {
  implementOutput = { ...goodImplement, verification: { passed: false, last: [] } };
  const id = await run("Refund timeout");
  assert.equal(await stepStatus(id, "proof"), "FAILED");
  assert.notEqual(await stepStatus(id, "pr"), "COMPLETED");
  assert.equal((await fixProofOf(id)).current!.verdict, "FAILED");
});

test("a symptom-only change is flagged (PARTIAL with the signal named) and still reaches review, not VERIFIED", async () => {
  implementOutput = {
    ...goodImplement,
    symptom_signals: {
      "payment-src": [
        { kind: "log_downgrade", file: "settle.go", line: 33, detail: "error → warn" },
      ],
    },
  };
  const id = await run("Noisy settlement errors");
  const current = (await fixProofOf(id)).current!;
  assert.equal(current.verdict, "PARTIAL");
  assert.match(current.report.missing.join(), /log_downgrade settle.go:33/);
  const rows = await q(pool, "SELECT verdict FROM fix_proofs WHERE run_id=$1", [id]);
  assert.equal(rows.length, 1);
});
