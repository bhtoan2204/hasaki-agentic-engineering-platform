import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLine, normalizePath, parseGrep } from "../src/impact/contracts.ts";
import { breakingChanges } from "../src/impact/analyze.ts";

/** Labelled lines: what a reviewer expects the extractor to report (kind role key [method]); [] = nothing. */
const CORPUS: Array<{ file: string; text: string; context?: string[]; expect: string[] }> = [
  // Kafka
  {
    file: "oms/ship.ts",
    text: "await producer.send({ topic: 'order.shipped', messages })",
    expect: ["kafka_topic provider order.shipped"],
  },
  {
    file: "worker/consume.ts",
    text: "await consumer.subscribe({ topic: 'order.shipped', fromBeginning: false })",
    expect: ["kafka_topic consumer order.shipped"],
  },
  {
    file: "pay/Listener.java",
    text: '@KafkaListener(topics = "payment.refunded", groupId = "oms")',
    expect: ["kafka_topic consumer payment.refunded"],
  },
  {
    file: "pay/publish.java",
    text: 'kafkaTemplate.send("payment.refunded", event);',
    expect: ["kafka_topic provider payment.refunded"],
  },
  {
    file: "oms/writer.go",
    text: '\tTopic:    "order.created",',
    context: ["w := &kafka.Writer{", "\tAddr: kafka.TCP(brokers...),"],
    expect: ["kafka_topic provider order.created"],
  },
  {
    file: "wk/reader.go",
    text: '\tTopic:   "order.created",',
    context: ["r := kafka.NewReader(kafka.ReaderConfig{", "\tBrokers: brokers,"],
    expect: ["kafka_topic consumer order.created"],
  },
  {
    file: "x/py.py",
    text: "consumer = KafkaConsumer('inventory.reserved', bootstrap_servers=b)",
    expect: ["kafka_topic consumer inventory.reserved"],
  },
  { file: "x/dyn.ts", text: "await producer.send({ topic: cfg.topic, messages })", expect: [] },
  { file: "x/ambig.go", text: '\tTopic: "who.knows",', context: ["cfg := Settings{"], expect: [] },
  // HTTP providers and clients
  {
    file: "pay/routes.ts",
    text: "router.post('/v1/refunds/:id/approve', approveRefund)",
    expect: ["http_route provider /v1/refunds/{}/approve POST"],
  },
  {
    file: "pay/main.go",
    text: '\tr.GET("/v1/payments/:id", h.Get)',
    expect: ["http_route provider /v1/payments/{} GET"],
  },
  {
    file: "pay/Ctl.java",
    text: '  @PostMapping("/v1/refunds")',
    expect: ["http_route provider /v1/refunds POST"],
  },
  {
    file: "pay/app.py",
    text: '@app.get("/v1/health")',
    expect: ["http_route provider /v1/health GET"],
  },
  {
    file: "pay/mux.go",
    text: '\tmux.HandleFunc("/v1/webhooks/zalopay", h.Hook)',
    expect: ["http_route provider /v1/webhooks/zalopay"],
  },
  {
    file: "oms/client.ts",
    text: "const r = await axios.post(`${PAY_URL}/v1/refunds/${id}/approve`, body)",
    expect: ["http_route consumer /v1/refunds/{}/approve POST"],
  },
  {
    file: "oms/f.ts",
    text: "const res = await fetch(`${base}/v1/payments/${id}`)",
    expect: ["http_route consumer /v1/payments/{} GET"],
  },
  {
    file: "oms/c.go",
    text: '\treq, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/refunds", body)',
    expect: ["http_route consumer /v1/refunds POST"],
  },
  { file: "oms/cache.ts", text: "const v = cache.get('/v1/payments/1')", expect: [] },
  // gRPC and enums
  {
    file: "proto/payment.proto",
    text: "service PaymentService {",
    expect: ["grpc_service provider PaymentService"],
  },
  {
    file: "proto/payment.proto",
    text: "enum PaymentStatus {",
    expect: ["shared_enum provider PaymentStatus"],
  },
  {
    file: "oms/grpc.go",
    text: "\tclient := paymentpb.NewPaymentServiceClient(conn)",
    expect: ["grpc_service consumer PaymentService"],
  },
  {
    file: "oms/grpc.ts",
    text: "const c = new PaymentServiceClient(addr, creds)",
    expect: ["grpc_service consumer PaymentService"],
  },
  // Database
  {
    file: "pay/migrations/001_init.sql",
    text: "CREATE TABLE IF NOT EXISTS payments (",
    expect: ["db_table provider payments"],
  },
  {
    file: "worker/repo.go",
    text: '\trows, err := db.Query(ctx, "SELECT id, status FROM payments WHERE order_id=$1", id)',
    expect: ["db_table consumer payments"],
  },
  {
    file: "worker/repo.ts",
    text: "await db.query(`UPDATE payments SET status = $1 WHERE id = $2`, [s, id])",
    expect: ["db_table consumer payments"],
  },
  { file: "docs/readme.ts", text: "// fetch the latest update from the server", expect: [] },
  // Tests never declare contracts
  {
    file: "oms/ship.test.ts",
    text: "await producer.send({ topic: 'order.shipped', messages })",
    expect: [],
  },
];

test("contract extraction: precision/recall on a labelled corpus (Kafka, HTTP, gRPC, DB, enums)", () => {
  let tp = 0,
    fp = 0,
    fn = 0;
  const errors: string[] = [];
  for (const c of CORPUS) {
    const got = extractLine(c.file, 1, c.text, c.context ?? []).map((x) =>
      [x.kind, x.role, x.key, ...(x.method ? [x.method] : [])].join(" "),
    );
    for (const e of c.expect)
      if (got.includes(e)) tp++;
      else {
        fn++;
        errors.push(`FN ${c.file}: ${e} (got ${JSON.stringify(got)})`);
      }
    for (const g of got)
      if (!c.expect.includes(g)) {
        fp++;
        errors.push(`FP ${c.file}: ${g}`);
      }
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  console.log(
    `contract extraction: precision ${precision.toFixed(2)} recall ${recall.toFixed(2)} (${CORPUS.length} lines)`,
  );
  assert.deepEqual(errors, []);
});

test("path normalization: params, templates, hosts and queries collapse to one route key", () => {
  for (const p of [
    "/v1/orders/:id",
    "/v1/orders/{orderId}",
    "${base}/v1/orders/${id}",
    "https://pay.svc/v1/orders/42?x=1",
    "/v1/orders/<id>/",
  ])
    assert.equal(normalizePath(p), "/v1/orders/{}", p);
});

test("git grep output parsing keeps per-file context", () => {
  const rev = "a".repeat(40);
  const out = [
    // `git grep -n -z` format: <rev>:<path> NUL <line> NUL <text>; context and matches look alike.
    `${rev}:w.go\x0010\x00w := &kafka.Writer{`,
    `${rev}:w.go\x0011\x00\tTopic: "t.x",`,
    "--",
    `${rev}:r.go\x003\x00fetch('/v1/x')`,
  ].join("\n");
  const m = parseGrep(rev, out);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].context, ["w := &kafka.Writer{"]);
  assert.equal(m[0].line, 11);
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

test("breaking changes: labelled diffs (topic rename, route removal, proto, SQL, state transitions) vs compatible changes", () => {
  const cases: Array<[string, string, string[]]> = [
    [
      "topic renamed",
      diff(
        "oms/ship.ts",
        ["await producer.send({ topic: 'order.shipped', messages })"],
        ["await producer.send({ topic: 'order.dispatched', messages })"],
      ),
      ["kafka_topic order.shipped"],
    ],
    [
      "route removed",
      diff("pay/routes.ts", ["router.post('/v1/refunds/:id/approve', approve)"], []),
      ["http_route /v1/refunds/{}/approve"],
    ],
    [
      "route method changed",
      diff(
        "pay/routes.ts",
        ["router.post('/v1/refunds', create)"],
        ["router.put('/v1/refunds', create)"],
      ),
      ["http_route /v1/refunds"],
    ],
    [
      "proto field removed",
      diff("proto/payment.proto", ["  string refund_reason = 4;"], []),
      ["schema refund_reason"],
    ],
    [
      "proto field renumbered",
      diff("proto/payment.proto", ["  int64 amount = 2;"], ["  int64 amount = 3;"]),
      ["schema amount"],
    ],
    [
      "enum value removed",
      diff("proto/payment.proto", ["  PAYMENT_STATUS_REFUNDED = 4;"], []),
      ["shared_enum PAYMENT_STATUS_REFUNDED"],
    ],
    [
      "column dropped",
      diff("pay/migrations/007.sql", [], ["ALTER TABLE payments DROP COLUMN legacy_ref;"]),
      ["db_table payments"],
    ],
    [
      "column type",
      diff(
        "pay/migrations/008.sql",
        [],
        ["ALTER TABLE payments ALTER COLUMN amount TYPE numeric(20,4);"],
      ),
      ["db_table payments"],
    ],
    [
      "event field removed",
      diff("oms/event.go", ['\tCarrier string `json:"carrier"`'], []),
      ["schema carrier"],
    ],
    [
      "payment state transition",
      diff(
        "pay/state.go",
        ["\tcase StatusAuthorized: return StatusCaptured"],
        ["\tcase StatusAuthorized: return StatusSettled"],
      ),
      ["state_transition"],
    ],
    // compatible changes
    ["field added", diff("proto/payment.proto", [], ["  string note = 9;"]), []],
    ["route added", diff("pay/routes.ts", [], ["router.get('/v1/refunds/:id', getRefund)"]), []],
    [
      "nullable column added",
      diff("pay/migrations/009.sql", [], ["ALTER TABLE payments ADD COLUMN note text;"]),
      [],
    ],
    [
      "refactor keeps the topic",
      diff(
        "oms/ship.ts",
        ["await producer.send({ topic: 'order.shipped', messages: m })"],
        ["await producer.send({ topic: 'order.shipped', messages: build(m) })"],
      ),
      [],
    ],
  ];
  let tp = 0,
    fp = 0,
    fn = 0;
  const errors: string[] = [];
  for (const [name, d, expect] of cases) {
    const got = breakingChanges(d).breaking.map((b) =>
      b.kind === "state_transition" ? b.kind : `${b.kind} ${b.key}`,
    );
    for (const e of expect)
      if (got.includes(e)) tp++;
      else {
        fn++;
        errors.push(`FN ${name}: ${e} (got ${JSON.stringify(got)})`);
      }
    for (const g of got)
      if (!expect.includes(g)) {
        fp++;
        errors.push(`FP ${name}: ${g}`);
      }
  }
  console.log(
    `breaking-change detection: precision ${(tp / (tp + fp || 1)).toFixed(2)} recall ${(tp / (tp + fn || 1)).toFixed(2)} (${cases.length} diffs)`,
  );
  assert.deepEqual(errors, []);
});

test("pathological long lines are bounded (no super-linear regex on user diffs)", () => {
  for (const unit of ["http.NewRequest(", "http.Get(", "axios.get('", "fetch(`"]) {
    const line = unit.repeat(Math.ceil(300_000 / unit.length));
    const t = Date.now();
    extractLine("a.go", 1, line);
    const d = diff("a.go", [], [line]);
    breakingChanges(d);
    assert.ok(Date.now() - t < 200, `${unit}: ${Date.now() - t} ms`);
  }
  // Below the cap the recognisers are still linear: a 4 KB adversarial line stays fast.
  const t = Date.now();
  for (let i = 0; i < 100; i++) extractLine("a.go", 1, "http.NewRequest(".repeat(250));
  assert.ok(Date.now() - t < 500, `100 x 4 KB lines took ${Date.now() - t} ms`);
});

test("moved code is not a removal; runtime-built keys are never static", () => {
  const moved = [
    diff("a.ts", ["router.get('/v1/orders', list)"], []),
    diff("b.ts", [], ["router.get('/v1/orders', list)"]),
  ].join("\n");
  assert.deepEqual(breakingChanges(moved).breaking, []);
  assert.deepEqual(extractLine("L.java", 1, '@KafkaListener(topics = "${app.topic}")'), []);
  const concat = extractLine("c.go", 1, '\tresp, err := http.Get(baseURL + "/v1/orders/" + id)');
  assert.equal(concat[0].confidence, "inferred");
  const fmt = extractLine(
    "c.go",
    1,
    '\treq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/pay", base), nil)',
  );
  assert.ok(fmt.every((c) => c.confidence === "inferred"));
});

test("SQL needs a statement shape; error/log text is not a table; lowercase SQL is found", () => {
  assert.deepEqual(extractLine("x.ts", 1, "throw new Error('cannot DELETE from cache')"), []);
  assert.deepEqual(extractLine("x.ts", 1, "logger.info('update from the server')"), []);
  assert.deepEqual(
    extractLine("x.ts", 1, "await db.query('insert into orders (id) values ($1)', [id])").map(
      (c) => c.key,
    ),
    ["orders"],
  );
  assert.deepEqual(
    extractLine("x.ts", 1, "await db.query('update orders set status = $1')").map(
      (c) => `${c.key}:${c.access}`,
    ),
    ["orders:write"],
  );
});

test("grep output with date-named paths (NUL-delimited) keeps every match", () => {
  const rev = "b".repeat(40);
  const out = [
    `${rev}:migrations/2023-01-01-init.sql\x003\x00CREATE TABLE orders (`,
    `${rev}:src/a-1-b.ts\x004\x00app.get('/x', h)`,
    `${rev}:src/a-1-b.ts\x003\x00// context line`,
  ].join("\n");
  const m = parseGrep(rev, out);
  assert.deepEqual(
    m.map((x) => `${x.file}:${x.line}`),
    ["migrations/2023-01-01-init.sql:3", "src/a-1-b.ts:4"],
  );
});

test("a removed line whose text looks like a diff header stays content", () => {
  const d = [
    "diff --git a/m.sql b/m.sql",
    "--- a/m.sql",
    "+++ b/m.sql",
    "@@ -1,2 +1,1 @@",
    "--- a/other.sql",
    "-CREATE TABLE gone (",
  ].join("\n");
  assert.equal(breakingChanges(d).changed[0]?.file, "m.sql");
});

test("adversarial dynamic contracts: runtime-built keys are never contracts, but are reported as unresolved sites", async () => {
  const { dynamicSites } = await import("../src/impact/contracts.ts");
  const DYNAMIC: Array<[string, string, string]> = [
    ["p.ts", "await producer.send({ topic: config.ordersTopic, messages })", "kafka_topic"],
    ["p.ts", "await kafkaProducer.send(TOPIC, payload)", "kafka_topic"],
    ["w.go", "w := kafka.Writer{Topic: cfg.Topic}", "kafka_topic"],
    ["c.ts", "await consumer.subscribe({ topics: [process.env.TOPIC] })", "kafka_topic"],
    ["L.java", '@KafkaListener(topics = "${app.orders.topic}")', "kafka_topic"],
    ["L.java", "@KafkaListener(topics = ORDERS_TOPIC)", "kafka_topic"],
    ["f.ts", 'const r = await fetch(url, { method: "POST" })', "http_route"],
    ["f.ts", "const r = await fetch(`${endpoint}`)", "http_route"],
    ["a.ts", "await axios.post(target, body)", "http_route"],
    ["h.go", "req, _ := http.NewRequest(http.MethodPost, target, body)", "http_route"],
    ["h.go", "resp, err := http.Get(u)", "http_route"],
    ["m.go", "mux.HandleFunc(routes.Orders, h)", "http_route"],
    ["C.java", "@GetMapping(ORDERS_PATH)", "http_route"],
    ["C.java", '@PostMapping("${api.refund.path}")', "http_route"],
    ["q.ts", 'db.query("SELECT * FROM " + table + " WHERE id=$1")', "db_table"],
    ["q.ts", "db.query(`DELETE FROM ${table} WHERE id = $1`)", "db_table"],
    ["q.py", 'cur.execute(f"SELECT * FROM {table} WHERE id=%s")', "db_table"],
    ["q.go", 'q := fmt.Sprintf("UPDATE %s SET status=$1", tbl)', "db_table"],
  ];
  for (const [file, line, kind] of DYNAMIC) {
    const contracts = extractLine(file, 1, line).filter((c) => c.kind === kind && c.confidence === "static");
    assert.deepEqual(contracts, [], `no static ${kind} from a runtime key: ${line}`);
    assert.deepEqual(dynamicSites(file, 1, line).map((d) => d.kind), [kind], `reported: ${line}`);
  }
  // Literal keys are contracts, not unresolved sites; unrelated look-alikes, tests and unsupported languages are neither.
  const CLEAN: Array<[string, string]> = [
    ["p.ts", "await producer.send({ topic: 'orders.created', messages })"],
    ["f.ts", "const r = await fetch(`${base}/v1/orders/${id}`)"],
    ["q.ts", 'db.query("SELECT * FROM orders WHERE id=$1")'],
    ["k.ts", "const v = cache.get(key)"],
    ["k.ts", "const v = map.get(id); headers.set(name, value)"],
    ["p.test.ts", "await producer.send({ topic: t })"],
    ["p.rb", "producer.send(topic)"],
  ];
  for (const [file, line] of CLEAN) assert.deepEqual(dynamicSites(file, 1, line), [], line);
  // Bounded: adversarial repetition stays linear.
  const t = Date.now();
  for (const unit of ["fetch(", "http.NewRequest(", "FROM \" + ", "Topic: ", "@KafkaListener(topics = "])
    dynamicSites("a.go", 1, unit.repeat(Math.floor(4000 / unit.length)));
  assert.ok(Date.now() - t < 300, `dynamic-site scan took ${Date.now() - t} ms`);
});
