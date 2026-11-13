import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import {
  clearKafkaCookie,
  kafkaStatus,
  parseKafkaCookie,
  parseMessageEvents,
  readMessages,
  setKafkaCookie,
} from "../src/integrations/kafka.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

const COOKIE = "SESSION=abc123; _ga=GA1";
let server: Server;
let alive = true;
const reqs: Array<{ method: string; url: URL }> = [];

before(async () => {
  await migrate();
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    reqs.push({ method: req.method!, url });
    const json = (b: unknown) => (
      res.writeHead(200, { "content-type": "application/json" }),
      res.end(JSON.stringify(b))
    );
    if (!alive || !String(req.headers.cookie ?? "").includes("SESSION=abc123"))
      return (res.writeHead(302, { location: "/oauth2/authorization/google" }), res.end());
    if (url.pathname === "/api/clusters")
      return json([{ name: "qc", status: "online", brokerCount: 3, topicCount: 120 }]);
    if (url.pathname === "/api/authorization")
      return json({ rbacEnabled: false, userInfo: { username: "dev@hasaki.vn" } });
    if (url.pathname === "/api/clusters/qc/topics")
      return json({
        pageCount: 1,
        topics: [{ name: "fanout-es-event", partitionCount: 6, replicationFactor: 3 }],
      });
    if (url.pathname === "/api/clusters/qc/consumer-groups/paged")
      return json({
        consumerGroups: [
          { groupId: "payment-projector", state: "STABLE", members: 2, topics: 1, consumerLag: 42 },
        ],
      });
    if (url.pathname === "/api/clusters/qc/consumer-groups/payment-projector")
      return json({
        groupId: "payment-projector",
        state: "STABLE",
        members: 2,
        consumerLag: 42,
        partitions: [
          {
            topic: "fanout-es-event",
            partition: 0,
            currentOffset: 10,
            endOffset: 52,
            consumerLag: 42,
            consumerId: "c1",
            host: "/10.0.0.1",
          },
        ],
      });
    if (url.pathname === "/api/clusters/qc/topics/fanout-es-event/messages/v2") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (o: object) => `data:${JSON.stringify(o)}\n\n`;
      res.end(
        ev({ type: "PHASE", phase: { name: "Polling" } }) +
          ev({
            type: "MESSAGE",
            message: {
              partition: 0,
              offset: 51,
              timestamp: "2026-11-05T07:00:00Z",
              key: "HSK-123",
              content: '{"order_code":"HSK-123","status":"paid","access_token":"abcdefgh12345"}',
              headers: {},
            },
          }) +
          ev({ type: "CONSUMING", consuming: { messagesConsumed: 300, elapsedMs: 120 } }) +
          ev({ type: "DONE" }),
      );
      return;
    }
    (res.writeHead(404), res.end("{}"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.kafka.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.close();
  await pool.end();
});

test("parseKafkaCookie needs SESSION; accepts Cookie header and cURL", () => {
  assert.equal(parseKafkaCookie(`Cookie: ${COOKIE}`), COOKIE);
  assert.equal(
    parseKafkaCookie(
      `curl 'https://kafka-ui-qc-v2.hasaki.dev/api/clusters' -H 'cookie: ${COOKIE}'`,
    ),
    COOKIE,
  );
  assert.throws(() => parseKafkaCookie("_ga=1"), /SESSION/);
});

test("parseMessageEvents reads SSE frames and JSON arrays", () => {
  assert.equal(parseMessageEvents('data:{"type":"MESSAGE"}\n\ndata:{"type":"DONE"}\n').length, 2);
  assert.equal(parseMessageEvents('[{"type":"MESSAGE"}]').length, 1);
});

test("the client never sends anything but GET", () => {
  const src = readFileSync(new URL("../src/integrations/kafka.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(src, /\bbody:/);
});

test("session validated before saving; topics, groups and message search work; expiry detected", async () => {
  await clearKafkaCookie();
  registerBuiltinTools();
  const ctx = { runId: 0, allowedRepositories: [], mode: "analysis" as const };
  assert.match(String((await callTool("kafka.list_topics", {}, ctx)).error), /not connected/);
  await assert.rejects(setKafkaCookie("SESSION=wrong"), /hết hạn|không hợp lệ/);

  const st = await setKafkaCookie(COOKIE);
  assert.equal(st.connected, true);
  assert.equal(st.user, "dev@hasaki.vn");
  assert.equal(st.clusters?.[0].name, "qc");

  const topics: any = (await callTool("kafka.list_topics", { query: "fanout" }, ctx)).result;
  assert.equal(topics.cluster, "qc", "single online cluster picked automatically");
  assert.equal(topics.topics[0].topic, "fanout-es-event");
  const groups: any = (await callTool("kafka.consumer_groups", { query: "payment" }, ctx)).result;
  assert.equal(groups.groups[0].lag, 42);
  const detail: any = (await callTool("kafka.consumer_groups", { group: "payment-projector" }, ctx))
    .result;
  assert.equal(detail.partitions[0].lag, 42);

  const r = await callTool(
    "kafka.read_messages",
    { topic: "fanout-es-event", filter: "HSK-123", since_minutes: 60, limit: 5000 },
    ctx,
  );
  assert.equal(r.ok, false, "limit above 200 rejected by the schema");
  const m: any = await readMessages({
    topic: "fanout-es-event",
    filter: "HSK-123",
    since_minutes: 60,
  });
  assert.equal(m.count, 1);
  assert.equal(m.scanned, 300);
  assert.match(m.messages[0].value, /"status":"paid"/);
  assert.match(m.messages[0].value, /access_token":"\*\*\*/);
  const q = reqs.filter((x) => x.url.pathname.endsWith("/messages/v2")).at(-1)!.url;
  assert.equal(q.searchParams.get("mode"), "FROM_TIMESTAMP");
  assert.equal(q.searchParams.get("stringFilter"), "HSK-123");
  assert.ok(Math.abs(Number(q.searchParams.get("timestamp")) - (Date.now() - 3_600_000)) < 10_000);
  assert.equal((await readMessages({ topic: "fanout-es-event" })).mode, "LATEST");

  alive = false;
  await assert.rejects(readMessages({ topic: "fanout-es-event" }), /hết hạn/);
  assert.equal((await kafkaStatus()).expired, true);
  alive = true;
  await clearKafkaCookie();
  assert.ok(
    reqs.every((x) => x.method === "GET"),
    "only GET requests reached Kafka UI",
  );
});
