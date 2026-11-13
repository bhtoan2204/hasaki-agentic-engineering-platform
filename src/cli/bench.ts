import { randomUUID } from "node:crypto";
/**
 * Versioned evaluation: `npm run bench -- --suite=backend-v1 --repetitions=2`.
 *
 * Legacy graph-only mode creates a uniquely named throwaway database and Go fixtures.
 * Its old live paths remain below for compatibility with result formats, but are disabled
 * before any setup because they cannot enforce the P2 isolation and budget boundaries.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .map(([k, v]) => [k, v ?? "true"]),
);
if (args.suite === "platform-performance-v1") {
  await import("./benchPerformance.ts");
  process.exit(0);
}
if (args.suite === "backend-v1" || args.suite === "knowledge-ponytail-v1" || args.p2 === "true") {
  await import("./evaluate.ts");
  process.exit(0);
}
if (args.live === "true" || args.candidate === "claude-cli")
  throw new Error(
    "Legacy live benchmarks do not enforce P2 isolation/cost gates and are disabled; use the versioned evaluation framework (live remains BLOCKED until a safe connector is configured).",
  );
const live = args.live === "true";
const pick = (s: string | undefined, all: string[]) => (s ? s.split(",") : all);

// ---------------------------------------------------------------- isolated environment (before importing the platform)
const root = mkdtempSync(join(tmpdir(), "ctp-bench-"));
const repos = join(root, "repos");
mkdirSync(repos);
const admin =
  process.env.BENCH_DATABASE_ADMIN_URL ?? "postgres://platform:platform@localhost:55432/platform";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(admin).hostname))
  throw new Error("Benchmark database must be local");
const db = `platform_legacy_bench_${process.pid}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
{
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${db}`);
  await c.end();
}
const u = new URL(admin);
u.pathname = "/" + db;
process.env.DATABASE_URL = u.toString();
writeFileSync(
  join(root, "config.json"),
  JSON.stringify({
    reposRoot: repos,
    dataDir: join(root, "data"),
    projects: { BENCH: ["ecom-mapper", "oms-notifier"] },
    scheduler: {
      workers: 2,
      lightWorkers: 1,
      leaseSeconds: 120,
      heartbeatSeconds: 10,
      pollMs: 200,
    },
  }),
);
process.env.PLATFORM_CONFIG = join(root, "config.json");
process.env.CLAUDE_USER_SKILLS_DIR = join(root, "no-user-skills");

function gitRepo(name: string, files: Record<string, string>) {
  const dir = join(repos, name);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "release/prod");
  g("config", "user.email", "bench@local");
  g("config", "user.name", "bench");
  g("add", ".");
  g("commit", "-qm", "init");
  // A real (local, bare) origin: prepare_branch fetches origin and cuts branches from origin/release/prod.
  const bare = join(root, "remotes", `${name}.git`);
  mkdirSync(join(root, "remotes"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "release/prod", bare], { stdio: "pipe" });
  g("remote", "add", "origin", bare);
  g("push", "-q", "origin", "release/prod");
  g("fetch", "-q", "origin");
}
gitRepo("ecom-mapper", {
  "go.mod": "module example.com/ecom-mapper\n\ngo 1.21\n",
  "CLAUDE.md":
    "# ecom-mapper\n\nMaps Ecom (US marketplace) order payloads to OMS customer/shipment models. Package `mapper`.\n",
  "mapper/model.go":
    'package mapper\n\ntype EcomCustomer struct {\n\tName       string `json:"name"`\n\tPhone      string `json:"phone"`\n\tAddress    string `json:"address"`\n\tCity       string `json:"city"`\n\tPostalCode string `json:"postal_code"`\n}\n\ntype OmsCustomer struct {\n\tFullName   string\n\tPhone      string\n\tStreet     string\n\tCity       string\n\tPostalCode string\n}\n',
  "mapper/mapper.go":
    'package mapper\n\nimport "strings"\n\n// MapCustomer converts an Ecom customer into the OMS customer model.\nfunc MapCustomer(e EcomCustomer) OmsCustomer {\n\treturn OmsCustomer{\n\t\tFullName: strings.TrimSpace(e.Name),\n\t\tPhone:    e.Phone,\n\t\tStreet:   e.Address,\n\t\tCity:     e.City,\n\t}\n}\n',
  "mapper/mapper_test.go":
    'package mapper\n\nimport "testing"\n\nfunc TestMapCustomerName(t *testing.T) {\n\tif got := MapCustomer(EcomCustomer{Name: " Ann "}).FullName; got != "Ann" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n',
});
gitRepo("oms-notifier", {
  "go.mod": "module example.com/oms-notifier\n\ngo 1.21\n",
  "CLAUDE.md":
    "# oms-notifier\n\nSends customer notifications (SMS/email) for OMS shipments. Package `notify`.\n",
  "notify/notify.go":
    'package notify\n\nimport "fmt"\n\n// ShipmentMessage renders the SMS sent when a shipment is created.\nfunc ShipmentMessage(name, city string) string {\n\treturn fmt.Sprintf("Hi %s, your order to %s is on the way", name, city)\n}\n',
  "notify/notify_test.go":
    'package notify\n\nimport "testing"\n\nfunc TestShipmentMessage(t *testing.T) {\n\tif ShipmentMessage("Ann", "LA") == "" {\n\t\tt.Fatal("empty")\n\t}\n}\n',
});

// ---------------------------------------------------------------- platform (imported after env is set)
const { migrate } = await import("../db/migrate.ts");
const { pool, q } = await import("../db/pool.ts");
const { seedTemplates } = await import("../workflow/definitions.ts");
const { syncRepositoriesFromConfig, repositories } = await import("../repos/service.ts");
const { registerDefaultExecutors } = await import("../workflow/executors/index.ts");
const { setGitProvider } = await import("../git/provider.ts");
const { previewRun, startRun, getRun, approveStep, answerQuestions, cancelRun } =
  await import("../workflow/engine.ts");
const { runOnce } = await import("../workflow/scheduler.ts");
const { runMetrics } = await import("../api/metrics.ts");
const { importHasakiTask } = await import("../work.ts");
const { createUser } = await import("../auth/users.ts");

await migrate();
const benchmarkOwner = await createUser({
  username: "legacy-benchmark-owner",
  password: randomUUID(),
  role: "admin",
});
await seedTemplates();
await syncRepositoriesFromConfig();
await repositories.upsert("ecom-mapper", {
  services: ["mapper", "ecom", "customer", "postal"],
  description: "Maps Ecom order payloads to OMS customer models",
});
await repositories.upsert("oms-notifier", {
  services: ["notify", "sms", "email"],
  description: "Customer shipment notifications",
});
registerDefaultExecutors();
setGitProvider({
  name: "bench-fake",
  async push() {
    return { commits: "(bench: not pushed)" };
  },
  async openOrUpdatePullRequest(pr) {
    return {
      url: `https://bench.local/${pr.repo}/pr`,
      created: true,
      note: "bench: fake PR (nothing pushed)",
    };
  },
});

/**
 * Hidden acceptance checks (never shown to the agent): written into the run's worktree after the run and executed.
 * They grade task correctness separately from the run's execution status.
 */
type Acceptance = { repo: string; pkg: string; file: string; code: string };
const ACCEPT: Record<string, Acceptance[]> = {
  "1": [
    {
      repo: "ecom-mapper",
      pkg: "./mapper",
      file: "mapper/zz_acceptance_test.go",
      code: 'package mapper\n\nimport "testing"\n\nfunc TestAcceptancePostal(t *testing.T) {\n\tif got := MapCustomer(EcomCustomer{PostalCode: "91911"}).PostalCode; got != "91911" {\n\t\tt.Fatalf("postal %q", got)\n\t}\n}\n',
    },
  ],
  "2": [
    {
      repo: "ecom-mapper",
      pkg: "./mapper",
      file: "mapper/zz_acceptance_test.go",
      code: 'package mapper\n\nimport "testing"\n\nfunc TestAcceptanceSpaces(t *testing.T) {\n\tif got := MapCustomer(EcomCustomer{Name: " Ann   Lee "}).FullName; got != "Ann Lee" {\n\t\tt.Fatalf("name %q", got)\n\t}\n}\n',
    },
  ],
  "3": [
    {
      repo: "ecom-mapper",
      pkg: "./mapper",
      file: "mapper/zz_acceptance_test.go",
      code: 'package mapper\n\nimport "testing"\n\nfunc TestAcceptanceZip4(t *testing.T) {\n\tc := MapCustomer(EcomCustomer{PostalCode: "91911-9191"})\n\tif c.PostalCode != "91911" || c.PostalCodeExt != "9191" {\n\t\tt.Fatalf("%q %q", c.PostalCode, c.PostalCodeExt)\n\t}\n}\n',
    },
  ],
};

/** The fixture's OWN tests (no hidden ones yet): did the candidate break existing behaviour? */
function regressionIn(dir: string): boolean {
  try {
    execFileSync("bash", ["-lc", "go test -count=1 ./..."], {
      cwd: dir,
      stdio: "pipe",
      timeout: 300_000,
    });
    return false;
  } catch {
    return true;
  }
}
/** Hidden acceptance tests are written only now — after the candidate finished — and run in `dirFor(repo)`. */
function gradeIn(
  dirFor: (repo: string) => string | null,
  checks: Acceptance[] | undefined,
): { correct: boolean | null; regression: boolean | null } {
  if (!checks) return { correct: null, regression: null };
  let regression = false;
  for (const c of checks) {
    const dir = dirFor(c.repo);
    if (!dir) return { correct: false, regression: null }; // nothing was changed in that repository
    regression ||= regressionIn(dir);
    writeFileSync(join(dir, c.file), c.code);
    try {
      execFileSync("bash", ["-lc", `go test -count=1 -run Acceptance ${c.pkg}`], {
        cwd: dir,
        stdio: "pipe",
        timeout: 300_000,
      });
    } catch {
      return { correct: false, regression };
    }
  }
  return { correct: true, regression };
}
async function acceptance(runId: number, checks: Acceptance[] | undefined) {
  const ws = await q(
    pool,
    "SELECT repo, path FROM execution_workspaces WHERE run_id = $1 ORDER BY id DESC",
    [runId],
  );
  return gradeIn((repo) => ws.find((w: any) => w.repo === repo)?.path ?? null, checks);
}

const SCENARIOS: Record<
  string,
  { name: string; workflow: string; task: Record<string, unknown>; repositories?: string[] }
> = {
  "1": {
    name: "One-field mapping fix",
    workflow: "bug-investigation",
    task: {
      name: "[Bug] Thiếu postal_code khi map customer từ Ecom sang OMS",
      note: "MapCustomer trong mapper bỏ mất trường postal_code: OmsCustomer.PostalCode luôn rỗng. Cần map PostalCode từ EcomCustomer.",
    },
  },
  "2": {
    name: "Small bug, known repository",
    workflow: "bug-investigation",
    task: {
      name: "[Bug] Tên khách hàng không được chuẩn hoá khoảng trắng giữa các từ",
      note: "MapCustomer chỉ TrimSpace hai đầu; 'Ann   Lee' phải thành 'Ann Lee'.",
    },
    repositories: ["ecom-mapper"],
  },
  "3": {
    name: "Normal feature",
    workflow: "feature-implementation",
    task: {
      name: "Thêm hỗ trợ ZIP+4 cho postal code khi map customer",
      note: "Chuẩn hoá postal_code dạng 91911-9191 về 5 số đầu và lưu phần +4 riêng trong OmsCustomer.PostalCodeExt; thêm test.",
    },
  },
  "4": {
    name: "Multi-repository change",
    workflow: "feature-implementation",
    task: {
      name: "Hiển thị postal code trong SMS giao hàng",
      note: "Map postal_code trong ecom-mapper và đưa postal code vào ShipmentMessage của oms-notifier.",
    },
    repositories: ["ecom-mapper", "oms-notifier"],
  },
};

async function drive(runId: number, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    while (await runOnce()) {
      // Drain ready jobs before inspecting human gates or terminal status.
    }
    const run = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(run.status)) return run.status;
    for (const s of run.steps) {
      if (s.status === "WAITING_APPROVAL")
        await approveStep(runId, s.key, {
          by: "bench",
          repositories: s.approval?.request?.select_repositories
            ? s.approval.request.recommended?.length
              ? s.approval.request.recommended
              : run.allowed_repositories.slice(0, 1)
            : undefined,
        });
      if (s.status === "WAITING_INPUT") {
        const qs = await q(
          pool,
          "SELECT id, options FROM workflow_questions WHERE step_id = $1 AND status = 'open'",
          [s.id],
        );
        await answerQuestions(
          Object.fromEntries(
            qs.map((x: any) => [
              x.id,
              x.options?.[0] ?? "Use your best judgement; keep the change minimal.",
            ]),
          ),
          "bench",
        );
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await cancelRun(runId, "bench timeout");
  return "TIMEOUT";
}

const results: any[] = [];
let seq = 0;
for (const sk of args.candidate === "claude-cli"
  ? []
  : pick(args.scenarios, Object.keys(SCENARIOS))) {
  const sc = SCENARIOS[sk];
  for (const profile of pick(args.profiles, ["AUTO", "STANDARD"])) {
    const { item } = await importHasakiTask(
      {
        data: {
          id: 777000 + ++seq,
          code: `BENCH-${sk}-${profile}-${seq}`,
          project: { name: "BENCH" },
          ...sc.task,
        },
      },
      null,
      Number(benchmarkOwner.id),
    );
    const prev = await previewRun({
      definitionKey: sc.workflow,
      workItemId: item.id,
      repositories: sc.repositories,
      profile: profile as any,
    });
    const row: any = {
      scenario: `${sk}. ${sc.name}`,
      requested: profile,
      profile: prev.profile.profile,
      steps: prev.graph.steps.length,
      ai_steps: prev.graph.steps.filter((s: any) => s.type === "agent" || s.type === "coding_agent")
        .length,
      reasons: prev.profile.reasons.join("; "),
    };
    if (live) {
      const run = await startRun({
        definitionKey: sc.workflow,
        workItemId: item.id,
        repositories: sc.repositories,
        profile: profile as any,
      });
      const status = await drive(run.id, Number(args.timeout ?? 1_200_000));
      const m = await runMetrics(run.id);
      const diff = (
        await q(
          pool,
          "SELECT COALESCE(sum((a.metrics->>'turns')::int),0)::int AS turns FROM workflow_step_attempts a WHERE a.run_id = $1",
          [run.id],
        )
      )[0];
      const ws = (
        await q(pool, "SELECT count(*)::int AS n FROM execution_workspaces WHERE run_id = $1", [
          run.id,
        ])
      )[0].n;
      const qs = (
        await q(pool, "SELECT count(*)::int AS n FROM workflow_questions WHERE run_id = $1", [
          run.id,
        ])
      )[0].n;
      const committed = (
        await q(pool, "SELECT count(*)::int AS n FROM pull_requests WHERE run_id = $1", [run.id])
      )[0].n;
      Object.assign(row, { worktrees: ws, questions: qs, prs: committed });
      // harness evaluation — separate from execution status
      const v = (
        await q(
          pool,
          `SELECT count(*) FILTER (WHERE a.metrics ? 'verification')::int AS verified,
                                         bool_and((a.metrics->'verification'->>'passed')::boolean) FILTER (WHERE a.metrics ? 'verification') AS passed,
                                         COALESCE(sum((a.metrics->'verification'->>'repairs')::int), 0)::int AS repairs,
                                         COALESCE(sum((a.metrics->'verification'->>'rounds')::int), 0)::int AS rounds,
                                         string_agg(DISTINCT a.metrics->'verification'->>'outcome', ',') AS outcomes
                                    FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.type = 'coding_agent'`,
          [run.id],
        )
      )[0];
      const gates = (
        await q(
          pool,
          "SELECT count(*)::int AS n FROM workflow_steps WHERE run_id = $1 AND type IN ('human_approval', 'human_input') AND status = 'COMPLETED'",
          [run.id],
        )
      )[0].n;
      const graded = await acceptance(run.id, ACCEPT[sk]);
      const iv = (
        await q(
          pool,
          "SELECT output->>'verdict' AS verdict FROM workflow_steps WHERE run_id = $1 AND output ? 'verdict' ORDER BY position DESC LIMIT 1",
          [run.id],
        )
      )[0];
      const ivFails = (
        await q(
          pool,
          "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE run_id = $1 AND output->>'verdict' = 'FAIL'",
          [run.id],
        )
      )[0].n;
      Object.assign(row, {
        correct: graded.correct,
        regression: graded.regression,
        verdict: iv?.verdict ?? null,
        verify_passed: v.passed,
        verify_rounds: v.rounds,
        repairs: v.repairs + ivFails,
        verify_outcomes: v.outcomes,
        human_gates: gates + qs,
      });
      Object.assign(row, {
        run_id: run.id,
        status,
        wall_s: Math.round(m.wall_ms / 1000),
        claude_sessions: m.totals.claude_sessions,
        claude_s: Math.round(m.totals.claude_ms / 1000),
        turns: diff.turns,
        tool_calls: m.totals.tool_calls,
        input_tokens: m.totals.input_tokens,
        output_tokens: m.totals.output_tokens,
        cache_read_tokens: m.totals.cache_read_tokens,
        cost_usd_est: m.totals.cost_usd,
        test_s: Math.round(m.totals.command_ms / 1000),
      });
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
// ---------------------------------------------------------------- candidate: Claude Code CLI on the same fixtures
// Same task text, a clean clone of the fixture repo, no hidden tests on disk; graded afterwards exactly like the platform.
if (args.candidate === "claude-cli") {
  for (const sk of pick(args.scenarios, Object.keys(SCENARIOS))) {
    const sc = SCENARIOS[sk];
    const repo = sc.repositories?.[0] ?? ACCEPT[sk]?.[0]?.repo;
    if (!repo || (sc.repositories?.length ?? 0) > 1) {
      console.log(`skip ${sk}: the CLI candidate runs single-repository scenarios`);
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), `cli-${sk}-`));
    execFileSync("git", ["clone", "-q", join(repos, repo), dir]);
    const prompt = `${sc.task.name}\n\n${sc.task.note}\n\nChange the code in this repository to complete the task, keep the change minimal, run the tests, and commit.`;
    const t0 = Date.now();
    let out: any = {};
    let status = "COMPLETED";
    try {
      const raw = execFileSync(
        "claude",
        [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Read,Edit,Write,Grep,Glob,Bash(go test:*),Bash(go build:*),Bash(git:*)",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: Number(args.timeout ?? 1_200_000),
          maxBuffer: 64 << 20,
        },
      );
      out = JSON.parse(raw.trim().split("\n").pop() ?? "{}");
      if (out.is_error) status = "FAILED";
    } catch (e) {
      status = (e as any).signal === "SIGTERM" ? "TIMEOUT" : "ERROR";
    }
    const graded = gradeIn((r) => (r === repo ? dir : null), ACCEPT[sk]);
    const row = {
      scenario: `${sk}. ${sc.name}`,
      candidate: "claude-cli",
      status,
      correct: graded.correct,
      regression: graded.regression,
      wall_s: Math.round((Date.now() - t0) / 1000),
      cost_usd_est: out.total_cost_usd ?? null,
      turns: out.num_turns ?? null,
      output_tokens: out.usage?.output_tokens ?? null,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}

writeFileSync(join(root, "bench-results.json"), JSON.stringify(results, null, 2));

// ---------------------------------------------------------------- persist to the MAIN database (Insights → Evals)
if (live || args.candidate) {
  const main = new pg.Client({ connectionString: admin });
  try {
    await main.connect();
    for (const r of results) {
      if (!("status" in r)) continue;
      await main.query(
        `INSERT INTO eval_results (suite, scenario, candidate, profile, status, correct, regression, verdict, repairs, human_gates, wall_s, cost_usd, tokens, run_id, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          String(args.suite ?? "bench-v2"),
          r.scenario,
          r.candidate ?? "platform",
          r.candidate ? null : r.profile,
          r.status,
          r.correct ?? null,
          r.regression ?? null,
          r.verdict ?? null,
          r.repairs ?? 0,
          r.human_gates ?? 0,
          r.wall_s ?? null,
          r.cost_usd_est ?? null,
          Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0) || null,
          r.run_id ?? null,
          JSON.stringify(r),
        ],
      );
    }
    console.log(
      `persisted ${results.filter((r) => "status" in r).length} result(s) to eval_results`,
    );
  } catch (e) {
    console.log(
      `could not persist eval results (run migrations on the main database first): ${(e as Error).message}`,
    );
  } finally {
    await main.end().catch(() => {});
  }
}
console.log(
  "\n" +
    [
      "scenario",
      "requested",
      "profile",
      "steps",
      "ai_steps",
      ...(live
        ? [
            "status",
            "correct",
            "verify",
            "repairs",
            "human",
            "worktrees",
            "questions",
            "prs",
            "wall_s",
            "claude_s",
            "test_s",
            "claude_sessions",
            "turns",
            "tool_calls",
            "out_tok",
            "cost≈$",
          ]
        : []),
    ].join(" | "),
);
for (const r of results)
  console.log(
    [
      r.scenario,
      r.requested,
      r.profile,
      r.steps,
      r.ai_steps,
      ...(live
        ? [
            r.status,
            r.correct ?? "n/a",
            r.verify_passed ?? "n/a",
            r.repairs,
            r.human_gates,
            r.worktrees,
            r.questions,
            r.prs,
            r.wall_s,
            r.claude_s,
            r.test_s,
            r.claude_sessions,
            r.turns,
            r.tool_calls,
            r.output_tokens,
            r.cost_usd_est,
          ]
        : []),
    ].join(" | "),
  );
if (live) {
  // Evaluation summary (correctness ≠ execution status: a COMPLETED run can still be wrong).
  const graded = results.filter((r) => r.correct !== null && r.correct !== undefined);
  const verified = results.filter((r) => r.verify_passed !== null && r.verify_passed !== undefined);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
  console.log(
    `\nevaluation: correct ${pct(graded.filter((r) => r.correct).length, graded.length)} of ${graded.length} graded · verification pass ${pct(verified.filter((r) => r.verify_passed).length, verified.length)} · repairs/run ${(results.reduce((s, r) => s + (r.repairs ?? 0), 0) / Math.max(1, results.length)).toFixed(2)} · runs with human gates ${pct(results.filter((r) => r.human_gates > 0).length, results.length)} · cost≈$${results.reduce((s, r) => s + (r.cost_usd_est ?? 0), 0).toFixed(3)}`,
  );
}
console.log(`\nresults: ${join(root, "bench-results.json")}`);
await pool.end();
const cleanup = new pg.Client({ connectionString: admin });
try {
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${db} WITH (FORCE)`);
} finally {
  await cleanup.end();
}
process.exit(0);
