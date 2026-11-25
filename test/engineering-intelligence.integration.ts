import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { registerInstance } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, cancelRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { integrationExecutor } from "../src/workflow/executors/builtin.ts";
import { saveIntakePolicy } from "../src/workitems/intake.ts";
import { radarScan } from "../src/radar/scan.ts";
import { saveRoutingPreference } from "../src/routing/adaptive.ts";
import { fixProofOf } from "../src/workflow/proofOfFixStep.ts";
import { recallCausal } from "../src/memory/causal.ts";

/**
 * Cross-phase contract: Radar finding → Intake candidate → investigation run (routing consulted at the start) →
 * Proof-of-Fix verdict → Causal memory recallable by the production signature. Agents are stubbed; everything else is
 * the real engine and database.
 */
let owner = 0;
const runs: number[] = [];

before(async () => {
  await migrate();
  await registerInstance();
  owner = (await createUser({ username: "ei-owner", password: "ei-test-password", role: "admin" }))
    .id;
  registerExecutor("integration", integrationExecutor);
  registerExecutor("agent", {
    async execute() {
      return {
        kind: "completed",
        output: {
          root_cause: "connection pool exhausted by unbounded settlement retries",
          root_cause_assessment: {
            status: "CONFIRMED",
            confidence: "high",
            explanation: "connection pool exhausted by unbounded settlement retries",
          },
          claims: [
            {
              id: "c1",
              claim: "pool wait time hits the limit during settlement retries",
              classification: "OBSERVED_FACT",
              source_type: "trace",
              source_ref: "signoz:trace/abc",
              repository: null,
              commit: null,
              file_path: null,
              line_range: null,
              confidence: "high",
              verification_status: "verified",
              provenance: {
                by: "platform",
                status: "VERIFIED_BY_PLATFORM",
                verifies: "source_record",
                reason: null,
              },
            },
          ],
        },
      };
    },
  });
  await definitions.create({
    key: "ei-incident",
    spec: {
      name: "EI incident",
      steps: [
        { key: "investigate", type: "agent" },
        {
          key: "proof",
          type: "integration",
          depends_on: ["investigate"],
          config: { action: "proof_of_fix", root_cause_from: "investigate", block_on: [] },
        },
      ],
    },
  });
  // Production signal history: steady, then a spike (the authorized prod-error scans store these rows).
  await q(
    pool,
    `INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,first_seen_at)
     VALUES('eieieieieieieieieiei','prod','payment-api','ERROR','settlement pool timeout waiting for connection',current_date,now()-interval '20 days')`,
  );
  // Hourly history (as prod_error_observations.hourly stores it): 10 days at ~30/h, then the newest hour at 800.
  for (let i = 10; i >= 0; i--) {
    const hours = i === 0 ? 1 : 24;
    const s = (await one<{ id: number; ws: Date }>(
      pool,
      `INSERT INTO prod_error_scans(trigger,started_at,finished_at,ok,window_start,window_end)
       VALUES('manual',now()-make_interval(days=>$1),now()-make_interval(days=>$1),true,now()-make_interval(days=>$1)-make_interval(hours=>$2),now()-make_interval(days=>$1))
       RETURNING id, window_start AS ws`,
      [i, hours],
    ))!;
    const perHour = i === 0 ? 800 : 30 + (i % 3);
    const hourly = Array.from({ length: hours }, (_, h) => ({
      hour: new Date(new Date(s.ws).getTime() + h * 3_600_000).toISOString(),
      count: perHour,
    }));
    await q(
      pool,
      "INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,severity,hourly) VALUES($1,'eieieieieieieieieiei',$2,30,'low',$3)",
      [s.id, perHour * hours, JSON.stringify(hourly)],
    );
  }
});
after(async () => {
  for (const id of runs) await cancelRun(id).catch(() => {});
  await settleBackground();
  await pool.end();
});

test("radar → intake → investigation (routing consulted) → proof → causal memory", async () => {
  await saveIntakePolicy(
    {
      source: "radar",
      owner_id: owner,
      mode: "SHADOW",
      workflows: ["production-incident-investigation"],
      min_severity: "low",
    },
    "test",
  );
  const scan = (await radarScan())!;
  assert.ok(scan.ingested >= 1, "radar fed the intake queue");
  const item = (await one<{ id: number; incident_fingerprint: string }>(
    pool,
    "SELECT id, incident_fingerprint FROM intake_items WHERE source='radar'",
  ))!;
  assert.equal(item.incident_fingerprint, "eieieieieieieieieiei");

  // Routing participates at the start; with no production history it keeps the defaults and says why.
  await saveRoutingPreference(owner, { enabled: true, preference: "balanced", min_samples: 10 });
  const run = await startRun({
    definitionKey: "ei-incident",
    title: "[Radar] payment-api settlement pool timeout",
    ownerId: owner,
    inputs: { intake_item_id: String(item.id), request: "settlement pool timeouts spiking" },
  });
  runs.push(Number(run.id));
  const routing = (await one<{ config: Record<string, unknown> }>(
    pool,
    "SELECT config FROM workflow_steps WHERE run_id=$1 AND key='investigate'",
    [run.id],
  ))!.config.routing_decision as { applied: boolean; confidence: string };
  assert.equal(routing.applied, false);
  assert.equal(routing.confidence, "insufficient");
  await drain();

  const proof = (await fixProofOf(Number(run.id))).current!;
  assert.equal(proof.mode, "diagnosis");
  assert.equal(proof.verdict, "VERIFIED", proof.report.missing.join("; "));

  // The causal record carries the production signature and service from the intake item → recallable next time.
  const memory = (await one<{
    id: number;
    status: string;
    error_signatures: string[];
    services: string[];
  }>(pool, "SELECT * FROM causal_memories WHERE owner_id=$1 AND run_id=$2", [owner, run.id]))!;
  assert.equal(memory.status, "verified");
  assert.ok(memory.error_signatures.includes("settlement pool timeout waiting for connection"));
  assert.deepEqual(memory.services, ["payment-api"]);
  const recall = await recallCausal(owner, {
    errorSignatures: ["settlement pool timeout waiting for connection"],
    services: ["payment-api"],
  });
  assert.equal(recall.items[0]?.id, memory.id);
  assert.match(recall.items[0].text, /connection pool exhausted/);
});

test("each capability works with the others disabled", async () => {
  const { config } = await import("../src/config.ts");
  const saved = config.radar.enabled;
  config.radar.enabled = false;
  try {
    const { radarTick } = await import("../src/radar/scan.ts");
    const before = (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM radar_scans"))!
      .n;
    await radarTick();
    assert.equal(
      (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM radar_scans"))!.n,
      before,
      "radar off: no pass",
    );
  } finally {
    config.radar.enabled = saved;
  }
  // Proof-of-Fix and causal memory without radar/intake/routing: an ownerless run records its proof and no memory.
  await saveRoutingPreference(owner, { enabled: false });
  const run = await startRun({
    definitionKey: "ei-incident",
    title: "standalone diagnosis",
    ownerId: owner,
  });
  runs.push(Number(run.id));
  await drain();
  assert.equal((await fixProofOf(Number(run.id))).current!.verdict, "VERIFIED");
  const cfg = (await one<{ config: Record<string, unknown> }>(
    pool,
    "SELECT config FROM workflow_steps WHERE run_id=$1 AND key='investigate'",
    [run.id],
  ))!.config;
  assert.equal(cfg.routing_decision, undefined, "routing off: nothing recorded");
});
