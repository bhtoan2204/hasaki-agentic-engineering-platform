import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { workItems } from "../src/workitems/service.ts";
import { repositories } from "../src/repos/service.ts";
import { createUser } from "../src/auth/users.ts";

export async function analyticsFixtures() {
  await migrate();
  const owner = await createUser({ username: "analytics-a", password: "analytics-password", role: "member" });
  const other = await createUser({ username: "analytics-b", password: "analytics-password", role: "member" });
  const admin = await createUser({ username: "analytics-admin", password: "analytics-password", role: "admin" });
  await repositories.upsert("oms-api", { projects: ["OMS"] });
  await repositories.upsert("oms-background", { projects: ["OMS"] });
  await definitions.create({
    key: "analytics-fixture",
    spec: {
      name: "Analytics fixture",
      steps: [{ key: "implement", type: "coding_agent", config: { instructions: "fixture" } }],
    },
  });
  const make = async (
    provider: "claude" | "codex" | "cursor",
    user = owner,
    at = "2026-11-01T00:00:00Z",
    verified: boolean | null = true,
    privateCost?: number,
  ) => {
    const item = await workItems.createManual({ title: `${provider} analytics`, project: "OMS", ownerId: user.id });
    const run = await startRun({
      definitionKey: "analytics-fixture",
      workItemId: item.id,
      agentProvider: provider,
      repositories: ["oms-api", "oms-background"],
      start: false,
      ownerId: user.id,
    });
    const status = provider === "cursor" ? "FAILED" : "COMPLETED";
    await pool.query(
      "UPDATE workflow_runs SET status=$2,created_at=$3,started_at=$3,finished_at=$3::timestamptz+interval '2 minutes' WHERE id=$1",
      [run.id, status, at],
    );
    const step = await one(
      pool,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND type='coding_agent' ORDER BY position LIMIT 1",
      [run.id],
    );
    const tokens =
      provider === "cursor"
        ? null
        : {
            input: provider === "codex" ? 200 : 100,
            output: 20,
            cache_read: 30,
            cache_creation: provider === "claude" ? 5 : null,
            reasoning_output: provider === "codex" ? 10 : null,
          };
    const sessions: Record<string, unknown> = {
      main: {
        provider,
        model: privateCost ? "private-model" : `${provider}-test`,
        tokens,
        reported_cost_usd: privateCost ?? (provider === "claude" ? 0.4 : null),
        provider_execution_ms: 1000,
        complete: true,
        start_time: at,
      },
    };
    if (provider === "claude" && !privateCost)
      sessions.partial = {
        provider,
        model: "claude-alt",
        tokens: null,
        reported_cost_usd: null,
        provider_execution_ms: 2000,
        complete: false,
        start_time: at,
      };
    const metrics = {
      provider,
      model: `${provider}-test`,
      provider_sessions: sessions,
      tool_calls: { shell: 2 },
      tool_errors: 1,
      verification: { passed: verified },
      ...(provider === "cursor" ? { normalized_failure_category: "RATE_LIMIT" } : {}),
    };
    const context = await one(
      pool,
      "INSERT INTO context_snapshots(run_id,step_id,hash,content) VALUES($1,$2,'fixture','{\"preparation_duration_ms\":42}') RETURNING id",
      [run.id, step.id],
    );
    const attempt = await one(
      pool,
      `INSERT INTO workflow_step_attempts(run_id,step_id,number,generation,status,started_at,finished_at,metrics,context_snapshot_id)
      VALUES($1,$2,1,1,$3,$4,$4::timestamptz+interval '1 minute',$5,$6) RETURNING id`,
      [run.id, step.id, status, at, JSON.stringify(metrics), context.id],
    );
    await pool.query("UPDATE workflow_steps SET status=$2,current_attempt_id=$3 WHERE id=$1", [
      step.id,
      status,
      attempt.id,
    ]);
    return { ...run, work_item_id: item.id, step_id: step.id, attempt_id: attempt.id };
  };
  const claude = await make("claude");
  const codex = await make("codex", owner, "2026-11-01T17:00:00Z", null);
  const cursor = await make("cursor", owner, "2026-11-01T02:00:00Z", false);
  const hidden = await make("claude", other, "2026-11-01T00:00:00Z", true, 99);
  const before = await make("codex", owner, "2026-10-31T16:59:59Z", null);
  const fingerprint = "a".repeat(20),
    foreignFingerprint = "b".repeat(20);
  for (const [fp, wi] of [
    [fingerprint, claude.work_item_id],
    [foreignFingerprint, hidden.work_item_id],
  ] as const) {
    await pool.query(
      `INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,today_count,yesterday_count,severity,work_item_id,first_seen_at)
      VALUES($1,'oms','oms-api','ERROR','database timeout','2026-11-01',12,4,'high',$2,'2026-11-01T00:00:00Z')`,
      [fp, wi],
    );
    for (let i = 0; i < 2; i++) {
      const scan = await one(
        pool,
        `INSERT INTO prod_error_scans(trigger,ok,finished_at,window_start,window_end) VALUES('manual',true,now(),'2026-11-01T00:00:00Z','2026-11-01T03:00:00Z') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly)
        VALUES($1,$2,12,4,'2026-11-01T00:05:00Z','2026-11-01T01:55:00Z','high',$3)`,
        [
          scan.id,
          fp,
          JSON.stringify([
            { hour: "2026-11-01T00:00:00Z", count: 5 },
            { hour: "2026-11-01T01:00:00Z", count: 7 },
          ]),
        ],
      );
    }
  }
  return { owner, other, admin, claude, codex, cursor, hidden, before, fingerprint, foreignFingerprint };
}
