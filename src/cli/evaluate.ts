/**
 * Versioned fixture and explicitly approved live evaluation through the durable scheduler.
 * --paid-approval, --admin and --attest-<cursor|codex>-usage are operator attestations recorded with the run, not
 * authorization: whoever runs this CLI with database access is trusted to have that approval. Codex reports usage
 * only per turn, so its budget is post-hoc and bounded by the per-case wall clock.
 */
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
const live = args.live === "true" || args.mode === "live";
if (live && (args["paid-approval"] !== "true" || args.admin !== "true"))
  throw new Error(
    "Live benchmark execution requires the operator attestations --paid-approval --admin (recorded, not an authorization check) and verified connector prerequisites",
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
const databaseName = `platform_eval_${crypto.randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE ${databaseName}`);
await admin.end();
url.pathname = `/${databaseName}`;
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
    evaluation: { enabled: true, liveEnabled: live },
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
  await (await import("../eval/liveProvider.ts")).sweepEvaluationDatabases();
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
  if (args.suite === "knowledge-ponytail-v1") {
    if (!args["registry-file"])
      throw new Error(
        "Ponytail evaluation requires --registry-file containing an explicit registered-repository snapshot",
      );
    const { readFileSync } = await import("node:fs");
    const { repositories } = await import("../repos/service.ts");
    const snapshot = JSON.parse(readFileSync(args["registry-file"], "utf8"));
    if (!Array.isArray(snapshot))
      throw new Error("Registry snapshot must be an array of repository rows");
    const { config } = await import("../config.ts");
    for (const row of snapshot) {
      if (typeof row.local_path !== "string" || !row.local_path.startsWith("/"))
        throw new Error("Every registry snapshot row needs an absolute local_path");
      config.repositories[row.name] = row.local_path;
      await repositories.upsert(row.name, row);
    }
  }
  const suite = await publishBuiltinSuite(
    args.suite === "knowledge-ponytail-v1" ? "knowledge-ponytail-v1" : "backend-v1",
  );
  if (args.suite === "knowledge-ponytail-v1") {
    const { applyExternalSkills, planExternalSkills } =
      await import("../knowledge/externalImport.ts");
    const plan = planExternalSkills(new URL("../../skills/external/", import.meta.url).pathname);
    if (plan.rejected.length) throw new Error("Bundled skill import failed scanner/hash checks");
    await applyExternalSkills(plan, { by: "evaluation-only skill import" });
    const { knowledge } = await import("../knowledge/service.ts");
    if (
      !(await knowledge.get("skill.ext.ponytail")) ||
      !(await knowledge.get("skill.ext.ponytail-review"))
    )
      throw new Error("Ponytail pilot skills missing from the isolated evaluation registry");
    const { config } = await import("../config.ts");
    for (const provider of ["cursor", "codex"])
      if (args[`attest-${provider}-usage`] === "true")
        config.evaluation.liveUsageProviders = [...config.evaluation.liveUsageProviders, provider];
  }
  const executions = [];
  const stamp = new Date().toISOString();
  const { ponytailConfigurations } = await import("../eval/ponytailSuite.ts");
  const variants =
    args.suite === "knowledge-ponytail-v1"
      ? ponytailConfigurations().map((c) => ({
          label: `${c.provider}:${c.ponytail ? "pilot" : "baseline"}`,
          configuration: { ...c, mode: live ? "live" : "dry_run" },
        }))
      : [false, true].map((ci) => ({
          label: ci ? "candidate" : "baseline",
          configuration: {
            adapter: args.adapter ?? "reference",
            code_intelligence: ci,
            context_strategy: ci ? "symbols" : "none",
            repetitions: Number(args.repetitions ?? 2),
            case_limit: Number(args.cases ?? 15),
            mode: live ? "live" : "fixture",
          },
        }));
  for (const { label, configuration } of variants) {
    const evaluation = await createEvaluation(
      owner.id,
      {
        suite_id: suite.id,
        request_key: `cli:${stamp}:${label}`,
        configuration: { ...configuration, budget_group: stamp },
        paid_approval: live,
      },
      live,
    );
    await startPendingRun(evaluation.workflow_run_id);
    const deadline = Date.now() + (live ? 1800 * 1000 * 8 * 2 : 30 * 60 * 1000);
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
  if (args.suite === "knowledge-ponytail-v1") {
    const { renderPonytailReport, aggregatePonytailArm } =
      await import("../eval/ponytailReport.ts");
    const rows = executions.map((e) =>
      aggregatePonytailArm(
        {
          provider: e.configuration.provider,
          ponytail: e.configuration.ponytail,
          repetitions: e.configuration.repetitions,
        },
        e.cases,
      ),
    );
    const reportPath =
      process.env.EVAL_REPORT ??
      join(
        process.cwd(),
        "docs",
        "evaluation",
        `${new Date().toISOString().slice(0, 10)}-ponytail-ab.md`,
      );
    const { dirname } = await import("node:path");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderPonytailReport(rows));
    console.log(JSON.stringify({ report: reportPath, executions: executions.map((e) => e.id) }));
  } else {
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
          database: databaseName,
          comparison: report.report.verdict,
          baseline: report.report.baseline,
          candidate: report.report.candidate,
          warnings: report.report.warnings,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await heartbeat?.stop();
  await pool.end();
  const cleanup = new pg.Client({
    connectionString:
      process.env.BENCH_DATABASE_ADMIN_URL ??
      "postgres://platform:platform@localhost:55432/platform",
  });
  await cleanup.connect();
  try {
    await cleanup.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  } finally {
    await cleanup.end();
  }
}
