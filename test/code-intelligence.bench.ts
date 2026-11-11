import { effectiveSql } from "../src/codeIntelligence/store.ts";
/** Run ONLY with test/setup.ts: never benchmarks or migrates a production database. */
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { pool, one, q } from "../src/db/pool.ts";
import { repositories, rankRepositories } from "../src/repos/service.ts";
import { indexRepository } from "../src/codeIntelligence/indexer.ts";
import { searchSymbols, hybridRank, buildCodeContext } from "../src/codeIntelligence/search.ts";
if (process.env.PLATFORM_TEST !== "1")
  throw new Error("Use --import ./test/setup.ts with the isolated local test database");
config.codeIntelligence.enabled = true;
await migrate();
const root = join(config.reposRoot, "ci-benchmark");
mkdirSync(root, { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bench",
      GIT_AUTHOR_EMAIL: "bench@example.com",
      GIT_COMMITTER_NAME: "bench",
      GIT_COMMITTER_EMAIL: "bench@example.com",
    },
    stdio: "ignore",
  });
git("init", "-q", "-b", config.baseBranch);
let sourceBytes = 0;
for (let i = 0; i < 400; i++) {
  const examples = [
    ["go", `package pay\ntype Payment${i} struct { ID string }\nfunc Charge${i}() {}\n`],
    [
      "ts",
      `export interface Payment${i} { id: string }; export function Charge${i}() { return 'ok' };`,
    ],
    [
      "proto",
      `syntax="proto3"; package pay; message Request${i} {} message Response${i} {} service Payment${i} { rpc Charge${i}(Request${i}) returns(Response${i}); }`,
    ],
    [
      "sql",
      `CREATE TABLE payment${i} (id bigint PRIMARY KEY, customer_id bigint REFERENCES customers(id)); CREATE INDEX ix${i} ON payment${i}(id);`,
    ],
  ];
  const [extension, source] = examples[i % 4];
  writeFileSync(join(root, `file${i}.${extension}`), source);
  sourceBytes += Buffer.byteLength(source);
}
git("add", ".");
git("commit", "-qm", "fixture");
await repositories.upsert("ci-benchmark", {
  projects: ["Bench"],
  tags: ["payment"],
});
const timed = async <T>(fn: () => Promise<T>) => {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
};
const initial = await timed(() => indexRepository("ci-benchmark"));
writeFileSync(join(root, "file0.go"), "package pay\nfunc Changed() {}");
git("add", ".");
git("commit", "-qm", "incremental");
const incremental = await timed(() => indexRepository("ci-benchmark"));
const scope = { repositories: ["ci-benchmark"], allowed: ["ci-benchmark"] };
const lookup: number[] = [];
for (let i = 0; i < 20; i++) lookup.push((await timed(() => searchSymbols("Charge101", scope))).ms);
const rows = await repositories.list();
const metadata = await timed(async () =>
  rankRepositories(rows, { text: "Charge101 payment", project: "Bench" }),
);
const hybrid = await timed(() => hybridRank(rows, { text: "Charge101 payment", project: "Bench" }));
const context = await buildCodeContext("Charge101", scope);
await q(pool, "ANALYZE code_intelligence.symbols");
const plan = await q(
  pool,
  "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM code_intelligence.symbols WHERE symbol_name=$1",
  ["Charge101"],
);
const retrievalPlan = await q(
  pool,
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH f AS (${effectiveSql})
 SELECT f.file_path,s.* FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id
 WHERE s.symbol_name=ANY($2) OR s.qualified_name=ANY($2) OR EXISTS(SELECT 1 FROM unnest($2::text[]) t WHERE position(lower(t) in lower(f.file_path))>0)
 ORDER BY CASE WHEN s.qualified_name=ANY($2) THEN 0 WHEN s.symbol_name=ANY($2) THEN 1 ELSE 2 END,f.file_path,s.start_byte,s.id LIMIT 30`,
  [incremental.result.snapshot.id, ["Charge101"]],
);
const storage = await one(
  pool,
  `SELECT sum(pg_total_relation_size(c.oid))::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='code_intelligence' AND c.relkind='r'`,
);
const percentile = (x: number[], p: number) =>
  [...x].sort((a, b) => a - b)[Math.min(x.length - 1, Math.floor(x.length * p))];
const report = {
  fixture: {
    files: 400,
    languages: ["go", "typescript", "proto", "sql"],
    source_bytes: sourceBytes,
    node: process.version,
  },
  initial_ms: initial.ms,
  initial_metrics: initial.result.metrics,
  incremental_ms: incremental.ms,
  incremental_metrics: incremental.result.metrics,
  symbol_lookup_with_git_validation_ms: {
    p50: percentile(lookup, 0.5),
    p95: percentile(lookup, 0.95),
    samples: lookup.length,
  },
  metadata_ranking_ms: metadata.ms,
  hybrid_ranking_ms: hybrid.ms,
  postgres_total_table_and_index_bytes: storage!.bytes,
  context: {
    full_fixture_chars_as_reference: sourceBytes,
    retrieved_chars: context.body.length,
    estimated_retrieved_tokens: Math.ceil(context.body.length / 4),
    note: "Existing implementation does not inline full repositories; full-fixture size is a reference, not a measured prior prompt.",
  },
  exact_symbol_query_plan: plan[0]["QUERY PLAN"],
  hybrid_symbol_retrieval_query_plan: retrievalPlan[0]["QUERY PLAN"],
};
console.log(JSON.stringify(report, null, 2));
await pool.end();
