/**
 * Execution-profile benchmark: `npm run bench -- [--live] [--scenarios=1,2] [--profiles=FAST,STANDARD]`
 *
 * Creates a throwaway database and Go fixture repositories, then for each scenario/profile resolves the run graph and
 * (with --live) executes it end to end with the REAL Claude executor. Human gates are auto-approved and questions
 * auto-answered so only machine time is measured. Git pushes/PRs use an in-process fake provider: nothing leaves the
 * machine. Results: printed table + JSON in the bench directory. Without --live only graph resolution is measured.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const live = args.live === "true";
const pick = (s: string | undefined, all: string[]) => (s ? s.split(",") : all);

// ---------------------------------------------------------------- isolated environment (before importing the platform)
const root = mkdtempSync(join(tmpdir(), "ctp-bench-"));
const repos = join(root, "repos");
mkdirSync(repos);
const admin = process.env.BENCH_DATABASE_ADMIN_URL ?? "postgres://platform:platform@localhost:55432/platform";
const db = "platform_bench";
{
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${db}`);
  await c.end();
}
const u = new URL(admin);
u.pathname = "/" + db;
process.env.DATABASE_URL = u.toString();
writeFileSync(join(root, "config.json"), JSON.stringify({ reposRoot: repos, dataDir: join(root, "data"), projects: { BENCH: ["ecom-mapper", "oms-notifier"] }, scheduler: { workers: 2, lightWorkers: 1, leaseSeconds: 120, heartbeatSeconds: 10, pollMs: 200 } }));
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
  "CLAUDE.md": "# ecom-mapper\n\nMaps Ecom (US marketplace) order payloads to OMS customer/shipment models. Package `mapper`.\n",
  "mapper/model.go": "package mapper\n\ntype EcomCustomer struct {\n\tName       string `json:\"name\"`\n\tPhone      string `json:\"phone\"`\n\tAddress    string `json:\"address\"`\n\tCity       string `json:\"city\"`\n\tPostalCode string `json:\"postal_code\"`\n}\n\ntype OmsCustomer struct {\n\tFullName   string\n\tPhone      string\n\tStreet     string\n\tCity       string\n\tPostalCode string\n}\n",
  "mapper/mapper.go": "package mapper\n\nimport \"strings\"\n\n// MapCustomer converts an Ecom customer into the OMS customer model.\nfunc MapCustomer(e EcomCustomer) OmsCustomer {\n\treturn OmsCustomer{\n\t\tFullName: strings.TrimSpace(e.Name),\n\t\tPhone:    e.Phone,\n\t\tStreet:   e.Address,\n\t\tCity:     e.City,\n\t}\n}\n",
  "mapper/mapper_test.go": "package mapper\n\nimport \"testing\"\n\nfunc TestMapCustomerName(t *testing.T) {\n\tif got := MapCustomer(EcomCustomer{Name: \" Ann \"}).FullName; got != \"Ann\" {\n\t\tt.Fatalf(\"got %q\", got)\n\t}\n}\n",
});
gitRepo("oms-notifier", {
  "go.mod": "module example.com/oms-notifier\n\ngo 1.21\n",
  "CLAUDE.md": "# oms-notifier\n\nSends customer notifications (SMS/email) for OMS shipments. Package `notify`.\n",
  "notify/notify.go": "package notify\n\nimport \"fmt\"\n\n// ShipmentMessage renders the SMS sent when a shipment is created.\nfunc ShipmentMessage(name, city string) string {\n\treturn fmt.Sprintf(\"Hi %s, your order to %s is on the way\", name, city)\n}\n",
  "notify/notify_test.go": "package notify\n\nimport \"testing\"\n\nfunc TestShipmentMessage(t *testing.T) {\n\tif ShipmentMessage(\"Ann\", \"LA\") == \"\" {\n\t\tt.Fatal(\"empty\")\n\t}\n}\n",
});

// ---------------------------------------------------------------- platform (imported after env is set)
const { migrate } = await import("../db/migrate.ts");
const { pool, q } = await import("../db/pool.ts");
const { seedTemplates } = await import("../workflow/definitions.ts");
const { syncRepositoriesFromConfig, repositories } = await import("../repos/service.ts");
const { registerDefaultExecutors } = await import("../workflow/executors/index.ts");
const { setGitProvider } = await import("../git/provider.ts");
const { previewRun, startRun, getRun, approveStep, answerQuestions, cancelRun } = await import("../workflow/engine.ts");
const { runOnce } = await import("../workflow/scheduler.ts");
const { runMetrics } = await import("../api/metrics.ts");
const { importHasakiTask } = await import("../work.ts");

await migrate();
await seedTemplates();
await syncRepositoriesFromConfig();
await repositories.upsert("ecom-mapper", { services: ["mapper", "ecom", "customer", "postal"], description: "Maps Ecom order payloads to OMS customer models" });
await repositories.upsert("oms-notifier", { services: ["notify", "sms", "email"], description: "Customer shipment notifications" });
registerDefaultExecutors();
setGitProvider({
  name: "bench-fake",
  async push() {
    return { commits: "(bench: not pushed)" };
  },
  async openOrUpdatePullRequest(pr) {
    return { url: `https://bench.local/${pr.repo}/pr`, created: true, note: "bench: fake PR (nothing pushed)" };
  },
});

const SCENARIOS: Record<string, { name: string; workflow: string; task: Record<string, unknown>; repositories?: string[] }> = {
  "1": { name: "One-field mapping fix", workflow: "bug-investigation", task: { name: "[Bug] Thiếu postal_code khi map customer từ Ecom sang OMS", note: "MapCustomer trong mapper bỏ mất trường postal_code: OmsCustomer.PostalCode luôn rỗng. Cần map PostalCode từ EcomCustomer." } },
  "2": { name: "Small bug, known repository", workflow: "bug-investigation", task: { name: "[Bug] Tên khách hàng không được chuẩn hoá khoảng trắng giữa các từ", note: "MapCustomer chỉ TrimSpace hai đầu; 'Ann   Lee' phải thành 'Ann Lee'." }, repositories: ["ecom-mapper"] },
  "3": { name: "Normal feature", workflow: "feature-implementation", task: { name: "Thêm hỗ trợ ZIP+4 cho postal code khi map customer", note: "Chuẩn hoá postal_code dạng 91911-9191 về 5 số đầu và lưu phần +4 riêng trong OmsCustomer.PostalCodeExt; thêm test." } },
  "4": { name: "Multi-repository change", workflow: "feature-implementation", task: { name: "Hiển thị postal code trong SMS giao hàng", note: "Map postal_code trong ecom-mapper và đưa postal code vào ShipmentMessage của oms-notifier." }, repositories: ["ecom-mapper", "oms-notifier"] },
};

async function drive(runId: number, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    while (await runOnce()) {}
    const run = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(run.status)) return run.status;
    for (const s of run.steps) {
      if (s.status === "WAITING_APPROVAL") await approveStep(runId, s.key, { by: "bench", repositories: s.approval?.request?.select_repositories ? s.approval.request.recommended?.length ? s.approval.request.recommended : run.allowed_repositories.slice(0, 1) : undefined });
      if (s.status === "WAITING_INPUT") {
        const qs = await q(pool, "SELECT id, options FROM workflow_questions WHERE step_id = $1 AND status = 'open'", [s.id]);
        await answerQuestions(Object.fromEntries(qs.map((x: any) => [x.id, x.options?.[0] ?? "Use your best judgement; keep the change minimal."])), "bench");
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await cancelRun(runId, "bench timeout");
  return "TIMEOUT";
}

const results: any[] = [];
let seq = 0;
for (const sk of pick(args.scenarios, Object.keys(SCENARIOS))) {
  const sc = SCENARIOS[sk];
  for (const profile of pick(args.profiles, ["AUTO", "STANDARD"])) {
    const { item } = await importHasakiTask({ data: { id: 777000 + ++seq, code: `BENCH-${sk}-${profile}-${seq}`, project: { name: "BENCH" }, ...sc.task } });
    const prev = await previewRun({ definitionKey: sc.workflow, workItemId: item.id, repositories: sc.repositories, profile: profile as any });
    const row: any = { scenario: `${sk}. ${sc.name}`, requested: profile, profile: prev.profile.profile, steps: prev.graph.steps.length, ai_steps: prev.graph.steps.filter((s: any) => s.type === "agent" || s.type === "coding_agent").length, reasons: prev.profile.reasons.join("; ") };
    if (live) {
      const run = await startRun({ definitionKey: sc.workflow, workItemId: item.id, repositories: sc.repositories, profile: profile as any });
      const status = await drive(run.id, Number(args.timeout ?? 1_200_000));
      const m = await runMetrics(run.id);
      const diff = (await q(pool, "SELECT COALESCE(sum((a.metrics->>'turns')::int),0)::int AS turns FROM workflow_step_attempts a WHERE a.run_id = $1", [run.id]))[0];
      const ws = (await q(pool, "SELECT count(*)::int AS n FROM execution_workspaces WHERE run_id = $1", [run.id]))[0].n;
      const qs = (await q(pool, "SELECT count(*)::int AS n FROM workflow_questions WHERE run_id = $1", [run.id]))[0].n;
      const committed = (await q(pool, "SELECT count(*)::int AS n FROM pull_requests WHERE run_id = $1", [run.id]))[0].n;
      Object.assign(row, { worktrees: ws, questions: qs, prs: committed });
      Object.assign(row, { run_id: run.id, status, wall_s: Math.round(m.wall_ms / 1000), claude_sessions: m.totals.claude_sessions, claude_s: Math.round(m.totals.claude_ms / 1000), turns: diff.turns, tool_calls: m.totals.tool_calls, input_tokens: m.totals.input_tokens, output_tokens: m.totals.output_tokens, cache_read_tokens: m.totals.cache_read_tokens, cost_usd_est: m.totals.cost_usd, test_s: Math.round(m.totals.command_ms / 1000) });
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
writeFileSync(join(root, "bench-results.json"), JSON.stringify(results, null, 2));
console.log("\n" + ["scenario", "requested", "profile", "steps", "ai_steps", ...(live ? ["status", "worktrees", "questions", "prs", "wall_s", "claude_s", "test_s", "claude_sessions", "turns", "tool_calls", "out_tok", "cost≈$"] : [])].join(" | "));
for (const r of results)
  console.log([r.scenario, r.requested, r.profile, r.steps, r.ai_steps, ...(live ? [r.status, r.worktrees, r.questions, r.prs, r.wall_s, r.claude_s, r.test_s, r.claude_sessions, r.turns, r.tool_calls, r.output_tokens, r.cost_usd_est] : [])].join(" | "));
console.log(`\nresults: ${join(root, "bench-results.json")}`);
await pool.end();
process.exit(0);
