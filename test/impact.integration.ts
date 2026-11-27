import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { analyzeImpact } from "../src/impact/analyze.ts";
import { freshnessOf, indexRepository } from "../src/impact/index.ts";

/**
 * Controlled multi-repository fixture (OMS → Payment → Kafka → Worker → Database, plus a shared proto) with a known
 * ground-truth dependency graph; one repository is private to measure that nothing leaks across permissions.
 */
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
let userId = 0;

const REPOS: Record<string, Record<string, string>> = {
  "imp-proto": {
    "payment.proto":
      'syntax = "proto3";\npackage payment;\nservice PaymentService {\n  rpc Refund(RefundRequest) returns (RefundReply);\n}\nmessage RefundRequest {\n  string order_id = 1;\n  int64 amount = 2;\n  string refund_reason = 4;\n}\nenum PaymentStatus {\n  PAYMENT_STATUS_UNKNOWN = 0;\n  PAYMENT_STATUS_REFUNDED = 4;\n}\n',
  },
  "imp-pay": {
    "src/routes.ts":
      "router.post('/v1/refunds/:id/approve', approveRefund);\nrouter.get('/v1/payments/:id', getPayment);\n",
    "src/consumer.ts":
      "await consumer.subscribe({ topic: 'order.shipped', fromBeginning: false });\n",
    "src/publish.ts": "await producer.send({ topic: 'payment.refunded', messages });\n",
    "migrations/001_init.sql":
      "CREATE TABLE payments (\n  id bigint PRIMARY KEY,\n  status text NOT NULL,\n  legacy_ref text\n);\n",
  },
  "imp-oms": {
    "src/ship.ts":
      "export async function ship(messages) {\n  await producer.send({ topic: 'order.shipped', messages });\n}\n",
    "src/refund.ts":
      "export const approve = (id) => axios.post(`${PAY_URL}/v1/refunds/${id}/approve`, {});\n",
    "src/refunded.ts": "await consumer.subscribe({ topic: 'payment.refunded' });\n",
    "grpc/client.go":
      "package grpc\n\nfunc dial(conn Conn) {\n\tclient := paymentpb.NewPaymentServiceClient(conn)\n\t_ = client\n}\n",
  },
  "imp-worker": {
    "reader.go":
      'package worker\n\nfunc read() {\n\tr := kafka.NewReader(kafka.ReaderConfig{\n\t\tBrokers: brokers,\n\t\tTopic:   "order.shipped",\n\t})\n\t_ = r\n}\n',
    "store.go":
      'package worker\n\nfunc load() {\n\tdb.Query(ctx, "SELECT id, status FROM payments WHERE id=$1", id)\n}\n',
    "reader_test.go":
      'package worker\n\nfunc TestReadsOrderShipped(t *testing.T) { topic := "order.shipped"; _ = topic }\n',
  },
  // A consumer whose topic comes from the environment: cannot be joined, must make kafka analyses partial.
  "imp-dyn": {
    "src/listen.ts": "await consumer.subscribe({ topics: [process.env.SHIPPED_TOPIC] });\n",
  },
  "imp-private": {
    "consumer.ts": "await consumer.subscribe({ topic: 'order.shipped' });\n",
  },
};

function commitAll(root: string, msg: string) {
  git(root, "add", ".");
  git(root, "commit", "-qm", msg);
}

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  userId = (
    await createUser({ username: "impact-user", password: "impact-test-password", role: "member" })
  ).id;
  for (const [name, files] of Object.entries(REPOS)) {
    const root = join(config.reposRoot, name);
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", config.baseBranch);
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), content);
    }
    commitAll(root, "base");
    await repositories.upsert(name, { projects: ["Impact"], default_branch: config.baseBranch });
  }
  // The private repository is not shared with the test user.
  await q(pool, "UPDATE repositories SET shared_access='none' WHERE name='imp-private'");
  // A fresh installation re-extracts at most 3 stale repositories per request and reports the rest as stale: the
  // first request is partial, which is asserted, then the fixture is fully indexed like a warmed-up installation.
  const first = await analyzeImpact(userId, { repository: "imp-oms", files: ["src/ship.ts"] });
  assert.equal(first.partial.complete, false);
  assert.ok(
    first.partial.stale.length >= 1,
    "unindexed repositories are reported, not assumed empty",
  );
  for (const name of Object.keys(REPOS)) await indexRepository(name);
});
after(async () => {
  await pool.end();
});

const diff = (file: string, removed: string[], added: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

/** Ground truth per scenario: the (repo, kind, key) impacts a correct analysis must report — and nothing else. */
const SCENARIOS: Array<{
  name: string;
  repository: string;
  req: Record<string, unknown>;
  expect: string[];
  breaking: string[];
}> = [
  {
    name: "Kafka topic renamed by the OMS producer",
    repository: "imp-oms",
    req: {
      diff: diff(
        "src/ship.ts",
        ["  await producer.send({ topic: 'order.shipped', messages });"],
        ["  await producer.send({ topic: 'order.dispatched', messages });"],
      ),
    },
    expect: ["imp-pay kafka_topic order.shipped", "imp-worker kafka_topic order.shipped"],
    breaking: ["imp-pay", "imp-worker"],
  },
  {
    name: "Payment removes the approve route",
    repository: "imp-pay",
    req: {
      diff: diff("src/routes.ts", ["router.post('/v1/refunds/:id/approve', approveRefund);"], []),
    },
    expect: ["imp-oms http_route /v1/refunds/{}/approve"],
    breaking: ["imp-oms"],
  },
  {
    name: "Payment drops a column read by the worker",
    repository: "imp-pay",
    req: {
      diff: diff("migrations/002_drop.sql", [], ["ALTER TABLE payments DROP COLUMN legacy_ref;"]),
    },
    expect: ["imp-worker db_table payments"],
    breaking: ["imp-worker"],
  },
  {
    name: "Shared proto removes a field",
    repository: "imp-proto",
    req: {
      diff: diff("payment.proto", ["  string refund_reason = 4;"], []),
      files: ["payment.proto"],
    },
    expect: ["imp-oms grpc_service PaymentService"],
    breaking: ["imp-oms"],
  },
  {
    name: "OMS refund consumer file touched (who provides it?)",
    repository: "imp-oms",
    req: { files: ["src/refunded.ts"] },
    expect: ["imp-pay kafka_topic payment.refunded"],
    breaking: [],
  },
];

test("controlled fixtures: dependencies and breaking changes match the ground truth; private repositories never leak", async () => {
  let tp = 0,
    fp = 0,
    fn = 0;
  const latencies: number[] = [];
  const errors: string[] = [];
  for (const s of SCENARIOS) {
    const r = await analyzeImpact(userId, { repository: s.repository, ...s.req });
    latencies.push(r.metrics.latency_ms);
    const got = new Set(r.impacts.map((i) => `${i.repo} ${i.kind} ${i.key}`));
    for (const e of s.expect)
      if (got.has(e)) tp++;
      else {
        fn++;
        errors.push(`FN ${s.name}: ${e}`);
      }
    for (const g of got)
      if (!s.expect.includes(g)) {
        fp++;
        errors.push(`FP ${s.name}: ${g}`);
      }
    assert.deepEqual(
      [...r.coordinated_repositories].sort(),
      s.breaking,
      `${s.name}: coordinated repositories`,
    );
    assert.ok(
      !JSON.stringify(r).includes("imp-private"),
      `${s.name}: the private repository is never mentioned`,
    );
    for (const i of r.impacts)
      assert.ok(
        i.evidence.some((e) => e.side === i.repo && e.file && e.line && e.commit),
        "explainable evidence path",
      );
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  console.log(
    `impact analysis: precision ${precision.toFixed(2)} recall ${recall.toFixed(2)} over ${SCENARIOS.length} scenarios; latency p50 ${latencies.sort((a, b) => a - b)[latencies.length >> 1]} ms, max ${Math.max(...latencies)} ms`,
  );
  assert.deepEqual(errors, []);
});

test("static vs inferred links, regression tests and compatibility checks are reported", async () => {
  const r = await analyzeImpact(userId, {
    repository: "imp-oms",
    diff: diff(
      "src/ship.ts",
      ["  await producer.send({ topic: 'order.shipped', messages });"],
      ["  await producer.send({ topic: 'order.dispatched', messages });"],
    ),
  });
  assert.ok(
    r.impacts.every((i) => i.confidence === "static"),
    "literal topic on both sides is static",
  );
  assert.deepEqual(r.regression_tests["imp-worker"], ["reader_test.go"]);
  assert.ok(r.compatibility_checks.some((c) => /Kafka order\.shipped/.test(c)));
  const grpc = await analyzeImpact(userId, { repository: "imp-proto", files: ["payment.proto"] });
  assert.equal(
    grpc.impacts.find((i) => i.kind === "grpc_service")!.confidence,
    "inferred",
    "a generated-client naming convention is inferred",
  );
});

test("stale indexes are detected and only the changed repository is re-extracted; unknown repositories are refused", async () => {
  const before = await q(
    pool,
    "SELECT repo, extract(epoch FROM indexed_at)::text AS indexed_at FROM impact_index_state ORDER BY repo",
  );
  const root = join(config.reposRoot, "imp-worker");
  writeFileSync(
    join(root, "extra.go"),
    'package worker\n\nfunc more() {\n\tdb.Query(ctx, "SELECT * FROM refunds")\n}\n',
  );
  commitAll(root, "more");
  assert.equal((await freshnessOf("imp-worker")).stale, true);
  const r = await analyzeImpact(userId, { repository: "imp-oms", files: ["src/ship.ts"] });
  assert.equal(r.metrics.reindexed, 1, "only the stale repository was re-extracted");
  assert.equal(r.partial.complete, true);
  const after = await q(
    pool,
    "SELECT repo, extract(epoch FROM indexed_at)::text AS indexed_at FROM impact_index_state ORDER BY repo",
  );
  const prev = new Map(before.map((b) => [b.repo, String(b.indexed_at)]));
  const changed = after.filter((a) => prev.get(a.repo) !== String(a.indexed_at)).map((a) => a.repo);
  assert.deepEqual(changed, ["imp-worker"]);
  // A repository without a local checkout is reported, not assumed empty.
  await repositories.upsert("imp-missing", { projects: ["Impact"] });
  const partial = await analyzeImpact(userId, { repository: "imp-oms", files: ["src/ship.ts"] });
  assert.ok(partial.partial.unavailable.some((u) => u.repo === "imp-missing"));
  assert.equal(partial.partial.complete, false);
  await assert.rejects(
    analyzeImpact(userId, { repository: "imp-private", files: ["consumer.ts"] }),
    /not accessible/,
  );
  const again = await indexRepository("imp-oms");
  assert.equal(again.skipped, "fresh", "an unchanged commit is not re-extracted");
});

test("the background refresh re-extracts stale indexes in bounded batches without any analysis request", async () => {
  const { refreshStaleIndexes } = await import("../src/impact/index.ts");
  for (const name of ["imp-pay", "imp-oms"]) {
    const root = join(config.reposRoot, name);
    writeFileSync(join(root, "bg-refresh.txt"), name);
    commitAll(root, "bg refresh");
    assert.equal((await freshnessOf(name)).stale, true);
  }
  const first = await refreshStaleIndexes(1);
  assert.equal(first.reindexed, 1, "the batch is bounded");
  const second = await refreshStaleIndexes(1);
  assert.equal(second.reindexed, 1);
  for (const name of ["imp-pay", "imp-oms"]) assert.equal((await freshnessOf(name)).stale, false);
  assert.equal((await refreshStaleIndexes(1)).reindexed, 0, "nothing left to do");
});

test("concurrent re-extraction of one repository never duplicates contracts", async () => {
  const { indexRepository } = await import("../src/impact/index.ts");
  await Promise.all([
    indexRepository("imp-pay", { force: true }),
    indexRepository("imp-pay", { force: true }),
  ]);
  const dup = await q(
    pool,
    "SELECT kind, role, key, file, line, count(*) FROM impact_contracts WHERE repo='imp-pay' GROUP BY 1,2,3,4,5 HAVING count(*) > 1",
  );
  assert.deepEqual(dup, []);
});

test("a run's repository scope limits the analysis (no paths from the owner's other repositories)", async () => {
  const r = await analyzeImpact(userId, {
    repository: "imp-oms",
    diff: diff("src/ship.ts", ["  await producer.send({ topic: 'order.shipped', messages });"], []),
    allowedRepositories: ["imp-oms", "imp-pay"],
  });
  assert.deepEqual([...new Set(r.impacts.map((i) => i.repo))], ["imp-pay"]);
  assert.ok(!JSON.stringify(r).includes("imp-worker"));
});

test("oversized diffs and invalid branches are refused, not parsed", async () => {
  await assert.rejects(
    analyzeImpact(userId, { repository: "imp-oms", diff: "+x\n".repeat(300_000) }),
    /diff too large/,
  );
  for (const branch of ["--output=/tmp/x", "a..b", "-p"])
    await assert.rejects(
      analyzeImpact(userId, { repository: "imp-oms", branch }),
      /invalid branch/,
    );
});

test("coverage is explicit: runtime-keyed counterparts, dynamic changed sites, config-only and complete analyses", async () => {
  // An earlier test registers a repository without a checkout: every analysis would (correctly) be stale.
  const stale = await analyzeImpact(userId, {
    repository: "imp-oms",
    diff: diff("src/x.ts", [], ["const a = 1;"]),
  });
  assert.equal(stale.analysis.status, "stale");
  await q(pool, "DELETE FROM repositories WHERE name='imp-missing'");
  // The rename still finds its static consumers — and says another repository may consume it through a runtime key.
  const rename = await analyzeImpact(userId, {
    repository: "imp-oms",
    diff: diff(
      "src/ship.ts",
      ["  await producer.send({ topic: 'order.shipped', messages });"],
      ["  await producer.send({ topic: 'order.dispatched', messages });"],
    ),
  });
  assert.equal(rename.conclusion, "impact_found");
  assert.equal(rename.analysis.status, "partial");
  assert.deepEqual(rename.analysis.blind_counterparts, [
    { repo: "imp-dyn", kind: "kafka_topic", sites: 1 },
  ]);
  assert.ok(
    !rename.impacts.some((i) => i.repo === "imp-dyn"),
    "a runtime-keyed site is never claimed as a static link",
  );

  // A new producer whose topic is configuration: nothing can be joined → unknown, never "no impact".
  const dynamic = await analyzeImpact(userId, {
    repository: "imp-oms",
    diff: diff("src/notify.ts", [], ["await producer.send({ topic: cfg.notifyTopic, messages });"]),
  });
  assert.equal(dynamic.impacts.length, 0);
  assert.equal(dynamic.analysis.status, "partial");
  assert.equal(dynamic.conclusion, "unknown");
  assert.equal(dynamic.analysis.dynamic_sites[0].kind, "kafka_topic");
  assert.match(dynamic.conclusion_note, /not evidence of no impact/);

  // Only configuration changed (where topics are often defined): nothing analysable.
  const config_ = await analyzeImpact(userId, {
    repository: "imp-oms",
    diff: diff(
      "config/application.yml",
      ["orders.topic: order.shipped"],
      ["orders.topic: order.dispatched"],
    ),
  });
  assert.equal(config_.analysis.status, "unsupported");
  assert.equal(config_.conclusion, "unknown");
  assert.ok(config_.analysis.limitations.some((l) => /configuration file/.test(l)));

  // Fully analysable change of a kind nobody resolves at runtime, with no counterpart: the strongest negative answer is
  // still only "no static dependency found".
  const route = await analyzeImpact(userId, {
    repository: "imp-pay",
    diff: diff("src/health.ts", [], ["router.get('/v1/health', health);"]),
  });
  assert.equal(route.analysis.status, "complete", route.analysis.limitations.join("; "));
  assert.equal(route.conclusion, "no_static_dependency_found");
  assert.notEqual(route.conclusion, "no_impact");
  assert.match(route.conclusion_note, /not excluded/);
});
