/**
 * Read-only API benchmark against the configured database: `npm run bench:api -- [user] [runId] [path,path…]`.
 * Dispatches GET routes in-process (no HTTP, no singleflight) as `user` and reports latency, query count and
 * response size per route, so a change to a hot path can be compared before/after on real data.
 */
import pg from "pg";
import { routes } from "../api/routes.ts";
import { pool } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { userByUsername, publicUser } from "../auth/users.ts";
import { loadOperatorSettings } from "../platform/operatorSettings.ts";
import { loadAccountSettings } from "../integrations/accounts.ts";

let queries = 0;
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof clientQuery>) {
  queries++;
  return clientQuery.apply(this, args);
} as typeof clientQuery;

const [username = "admin", runArg, list] = process.argv.slice(2);
await loadOperatorSettings();
await loadAccountSettings();
const user = await userByUsername(username);
if (!user) throw new Error(`no user ${username}`);
const actor = publicUser(user);
const first = async (sql: string, params: unknown[]) =>
  (await pool.query<{ v: string | number }>(sql, params)).rows[0]?.v;
const run = Number(
  runArg ?? (await first("SELECT max(id) AS v FROM workflow_runs WHERE owner_id = $1", [actor.id])),
);
const conv = await first("SELECT max(id) AS v FROM chat_conversations WHERE owner_id = $1", [
  actor.id,
]);
const step = await first(
  "SELECT key AS v FROM workflow_steps WHERE run_id = $1 ORDER BY attempt_count DESC, position LIMIT 1",
  [run],
);
const paths = list
  ? list.split(",")
  : [
      "/api/runs",
      `/api/runs/${run}`,
      `/api/runs/${run}/steps/${step}`,
      `/api/runs/${run}/summary`,
      `/api/metrics/runs/${run}`,
      "/api/chat/conversations",
      `/api/chat/conversations/${conv}`,
      "/api/work-items",
      "/api/approvals",
      "/api/questions",
      "/api/workflows",
      "/api/agent-providers",
      "/api/prod-errors",
      "/api/pull-requests",
      "/api/knowledge",
    ];
const N = Number(process.env.BENCH_N ?? 7);
for (const path of paths) {
  const url = new URL(path, "http://bench");
  const route = routes.find(([m, p]) => m === "GET" && p.test(url.pathname));
  if (!route) {
    console.log(`${path}\tno route`);
    continue;
  }
  const p = (url.pathname.match(route[1]) ?? []).slice(1).map((s) => decodeURIComponent(s ?? ""));
  const ctx = { p, body: {}, url, actor };
  const times: number[] = [];
  let count = 0;
  let bytes = 0;
  let error = "";
  for (let i = 0; i < N; i++) {
    queries = 0;
    const t = performance.now();
    try {
      const out = await execution.run({ userId: actor.id, kind: "user" }, async () =>
        route[2](ctx),
      );
      bytes = JSON.stringify(out ?? null).length;
    } catch (e) {
      error = (e as Error).message.slice(0, 80);
    }
    times.push(performance.now() - t);
    count = queries;
  }
  times.sort((a, b) => a - b);
  const ms = (v: number) => `${v.toFixed(0).padStart(5)}ms`;
  console.log(
    `${path.padEnd(44)} p50 ${ms(times[N >> 1])} max ${ms(times[N - 1])} queries ${String(count).padStart(3)} ${(bytes / 1024).toFixed(1).padStart(7)}KB ${error}`,
  );
}
await pool.end();
process.exit(0);
