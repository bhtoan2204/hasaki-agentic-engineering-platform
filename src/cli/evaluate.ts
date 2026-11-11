/** Fixture-only CLI over the same suite APIs, DAG scheduler, metrics and persistence used by Insights. */
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((s) => s.replace(/^--/, "").split("="))
    .map(([k, v]) => [k, v ?? "true"]),
);
if (args.candidate)
  throw new Error("Use versioned fixture adapters; legacy live candidate flags are not accepted");
if (args.live === "true" || args.mode === "live")
  throw new Error(
    "Live benchmark execution requires explicit approval through the API and a verified provider isolation/budget connector; this CLI only runs safe fixtures",
  );
const url = new URL(
  process.env.BENCH_DATABASE_ADMIN_URL ?? "postgres://platform:platform@localhost:55432/platform",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw new Error(
    "Benchmark CLI requires the existing local PostgreSQL test service; remote database refused",
  );
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='platform_bench'")).rowCount)
  await admin.query("CREATE DATABASE platform_bench");
await admin.end();
url.pathname = "/platform_bench";
process.env.DATABASE_URL = url.toString();
const root = process.env.EVAL_DATA_DIR ?? join(tmpdir(), "hasaki-p2-benchmark");
mkdirSync(root, { recursive: true });
const cfg = join(root, "config.json");
writeFileSync(
  cfg,
  JSON.stringify({
    dataDir: root,
    reposRoot: join(root, "unused-business-repositories"),
    instanceId: "p2-local-benchmark",
    projects: {},
    maxConcurrent: 1,
    scheduler: { workers: 1, lightWorkers: 0 },
    learning: { detectChanges: false, evolveSkills: false },
    evaluation: { enabled: true },
    codeIntelligence: { enabled: false },
  }),
);
process.env.PLATFORM_CONFIG = cfg;
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "local-benchmark-fixture-secret-only";
process.env.CLAUDE_USER_SKILLS_DIR = join(root, "no-user-skills");
const { pool } = await import("../db/pool.ts");
const { migrate } = await import("../db/migrate.ts");
const { startInstanceHeartbeat } = await import("../instances.ts");
const { createUser } = await import("../auth/users.ts");
const {
  publishBuiltinSuite,
  createEvaluation,
  createComparison,
  comparisonDetail,
  evaluationDetail,
} = await import("../eval/service.ts");
const { startPendingRun, answerQuestions, approveStep } = await import("../workflow/engine.ts");
const { registerDefaultExecutors } = await import("../workflow/executors/index.ts");
const { runOnce } = await import("../workflow/scheduler.ts");
let heartbeat: Awaited<ReturnType<typeof startInstanceHeartbeat>> | undefined;
try {
  await migrate();
  heartbeat = await startInstanceHeartbeat();
  registerDefaultExecutors();
  let owner = (
    await pool.query("SELECT id FROM users WHERE username='benchmark-fixture-owner' AND active")
  ).rows[0];
  if (!owner)
    owner = await createUser({
      username: "benchmark-fixture-owner",
      password: crypto.randomUUID() + crypto.randomUUID(),
      role: "admin",
    });
  const suite = await publishBuiltinSuite();
  const executions = [];
  const stamp = new Date().toISOString();
  for (const [label, ci] of [
    ["baseline", false],
    ["candidate", true],
  ] as const) {
    const evaluation = await createEvaluation(owner.id, {
      suite_id: suite.id,
      request_key: `cli:${stamp}:${label}`,
      configuration: {
        adapter: args.adapter ?? "reference",
        code_intelligence: ci,
        context_strategy: ci ? "symbols" : "none",
        repetitions: Number(args.repetitions ?? 2),
        case_limit: Number(args.cases ?? 15),
      },
    });
    await startPendingRun(evaluation.workflow_run_id);
    const deadline = Date.now() + 30 * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("Benchmark CLI wall time exceeded");
      const detail = await evaluationDetail(evaluation.id, owner.id);
      if (["COMPLETED", "FAILED", "CANCELED"].includes(detail.status)) break;
      const approvals = (
        await pool.query(
          "SELECT key FROM workflow_steps WHERE run_id=$1 AND status='WAITING_APPROVAL'",
          [detail.workflow_run_id],
        )
      ).rows;
      if (approvals.length && args["answer-fixtures"] === "false")
        throw new Error(`Evaluation ${evaluation.id} awaits explicit approval in the workflow UI`);
      for (const step of approvals)
        await approveStep(detail.workflow_run_id, step.key, {
          by: "benchmark scripted approval (synthetic fixture)",
        });
      const questions = (
        await pool.query(
          "SELECT id,question,options FROM workflow_questions WHERE run_id=$1 AND status='open'",
          [detail.workflow_run_id],
        )
      ).rows;
      if (questions.length) {
        if (args["answer-fixtures"] === "false")
          throw new Error(
            `Evaluation ${evaluation.id} awaits a human; answer through the existing workflow UI and resume`,
          );
        await answerQuestions(
          Object.fromEntries(questions.map((q) => [q.id, q.options[0]])),
          "benchmark scripted answer (synthetic fixture, not model reasoning)",
        );
      }
      if (!(await runOnce())) await new Promise((r) => setTimeout(r, 100));
    }
    executions.push(await evaluationDetail(evaluation.id, owner.id));
  }
  const comparison = await createComparison(owner.id, executions[0].id, executions[1].id, {});
  const report = await comparisonDetail(comparison!.id, owner.id);
  const path = process.env.EVAL_REPORT ?? join(root, "report.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        suite: {
          key: suite.suite_key,
          version: suite.version,
          hash: suite.content_hash,
        },
        provenance: "Synthetic reference controls; no live-agent quality or token claim",
        executions,
        comparison: report,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        report: path,
        database: "platform_bench",
        comparison: report.report.verdict,
        baseline: report.report.baseline,
        candidate: report.report.candidate,
        warnings: report.report.warnings,
      },
      null,
      2,
    ),
  );
} finally {
  await heartbeat?.stop();
  await pool.end();
}
