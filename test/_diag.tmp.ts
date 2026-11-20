import pg from "pg";
import { readFileSync, statSync } from "node:fs";
const url = new URL(process.env.DATABASE_URL!);
const host = url.searchParams.get("host")!;
const db = url.pathname.slice(1);
{
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const sql of [
    `ALTER DATABASE "${db}" SET session_preload_libraries='auto_explain'`,
    `ALTER DATABASE "${db}" SET auto_explain.log_min_duration='${process.env.DIAG_MIN ?? 300}ms'`,
    `ALTER DATABASE "${db}" SET auto_explain.log_analyze=on`,
    `ALTER DATABASE "${db}" SET auto_explain.log_buffers=on`,
  ]) await c.query(sql);
  await c.end();
}
const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool } = await import("../src/db/pool.ts");
const { seedAnalyticsDataset } = await import("./fixtures/analyticsDataset.ts");
const { parseAnalyticsFilters } = await import("../src/api/analytics/filters.ts");
const { loadDashboard } = await import("../src/api/analytics/engine.ts");
const { startPlatformGo } = await import("./fixtures/platformGo.ts");
await migrate();
await seedAnalyticsDataset({ users: 6, runs: Number(process.env.DIAG_RUNS ?? 5000), days: 60, groups: 1500 });
const go = await startPlatformGo({ DATABASE_POOL_MAX: "4" });
const admin = (await pool.query("SELECT id FROM users WHERE username='bench-user-1'")).rows[0].id;
const day = (o: number) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const log = `${host}/server.log`;
for (const [d, extra] of (process.env.DIAG_CASES ?? "usage:,health:,workflows:,performance:").split(",").map((x) => x.split(":"))) {
  for (const engine of ["typescript", "go"] as const) {
    config.analytics.engine = engine;
    const f = parseAnalyticsFilters(new URLSearchParams(`from=${day(-30)}&to=${day(1)}&timezone=Asia/Bangkok${extra ?? ""}`));
    const offset = statSync(log).size;
    const t = performance.now();
    await loadDashboard(d as never, f, { ownerId: admin, all: true });
    const ms = performance.now() - t;
    await new Promise((r) => setTimeout(r, 300));
    const text = readFileSync(log, "utf8").slice(offset);
    const plans = text.split(/LOG:\s+duration: /).slice(1);
    console.log(`\n===== ${d}${extra ?? ""} [${engine}] ${ms.toFixed(0)} ms, ${plans.length} slow statement(s)`);
    for (const p of plans) {
      const lines = p.split("\n");
      console.log("  duration " + lines[0].slice(0, 30));
      const hot = lines.filter((l) => { const m = /actual time=[0-9.]+\.\.([0-9.]+) rows=[0-9.]+ loops=([0-9]+)/.exec(l); return m && Number(m[1]) * Number(m[2]) > Number(process.env.DIAG_NODE ?? 150); });
      for (const l of hot.slice(0, Number(process.env.DIAG_LINES ?? 25))) console.log("   " + l.replace(/\s+\(cost=[^)]*\)/, "").slice(0, 200));
    }
  }
}
go.stop();
await pool.end();
process.exit(0);
