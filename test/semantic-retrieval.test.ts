import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { config } from "../src/config.ts";
import { fusedSearchOrder, planKnowledge } from "../src/context/plan.ts";
import { semanticFallbacks, semanticRanks, semanticRanksByKey } from "../src/retrieval/semantic.ts";
import { planItems, planOptions } from "./fixtures/plan-knowledge.ts";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const mandatoryKeys = ["policy.security", "rule.refund.window", "skill.assigned", "skill.reexec"];

test("planKnowledge without the semantic option is byte-identical to the lexical planner", () => {
  // Hashes of the pre-fusion planner's output on the shared fixture (src/context/plan.ts at HEAD before semantic retrieval).
  const golden = [
    "2cc77d1e3789d9aacd520b489a93a5c77b43e144ef29cd68b9159c54a8bb8baf",
    "ccfcae2d2203d6c279fff43842e19b6b10541a221ac09a2af933a2a9271d38b3",
    "21f27e56f6b31f00926f7253bb71a5ba05d7a1b219477df5f835dae0d9942a6d",
  ];
  planOptions.forEach((o, i) => assert.equal(sha(planKnowledge(planItems, o)), golden[i]));
});

test("an empty semantic ranking keeps the lexical order and tiers", () => {
  for (const o of planOptions) {
    const base = planKnowledge(planItems, o);
    const fused = planKnowledge(planItems, { ...o, semantic: new Map() });
    assert.deepEqual(
      fused.map((d) => [d.key, d.disclosure, d.score, d.why]),
      base.map((d) => [d.key, d.disclosure, d.score, d.why]),
    );
  }
});

test("fusion leaves mandatory items exactly as they were and only reorders the given items", () => {
  const reversed = [...planItems].reverse().map((k, i) => [k.key, i + 1] as const);
  for (const o of planOptions) {
    const base = planKnowledge(planItems, o);
    const fused = planKnowledge(planItems, {
      ...o,
      semantic: new Map([...reversed, ["not.authorized", 1]]),
    });
    const pick = (p: typeof base) => p.filter((d) => mandatoryKeys.includes(d.key));
    assert.deepEqual(pick(fused), pick(base));
    assert.deepEqual(fused.map((d) => d.key).sort(), base.map((d) => d.key).sort());
    assert.ok(!fused.some((d) => d.key === "not.authorized"));
  }
});

test("unverified suggestions stay pinned to the index whatever their semantic rank", () => {
  const o = planOptions[0];
  for (const rank of [1, 50]) {
    const plan = planKnowledge(planItems, {
      ...o,
      semantic: new Map([["memory.task.unverified", rank]]),
    });
    const entry = plan.find((d) => d.key === "memory.task.unverified")!;
    assert.equal(entry.disclosure, "index");
    const slots = plan.filter(
      (d) => d.disclosure === "index" && d.key !== "memory.task.unverified",
    );
    assert.equal(slots.length, o.indexSize);
  }
});

test("a semantic hit lifts a lexically weak item and is recorded in the plan", () => {
  const o = planOptions[0];
  const base = planKnowledge(planItems, o);
  assert.equal(base.find((d) => d.key === "doc.unrelated")!.disclosure, "search");
  const plan = planKnowledge(planItems, {
    ...o,
    semantic: new Map([
      ["doc.unrelated", 1],
      ["doc.shipping", 2],
    ]),
  });
  const entry = plan.find((d) => d.key === "doc.unrelated")!;
  assert.equal(entry.disclosure, "index");
  assert.equal(entry.semantic_rank, 1);
  assert.ok(entry.fused! > 1 / 61);
  assert.match(entry.why, /semantic similarity rank 1/);
  const mandatory = plan.find((d) => d.key === "policy.security")!;
  assert.equal(mandatory.fused, undefined);
  assert.equal(mandatory.semantic_rank, undefined);
});

test("fusedSearchOrder: semantic-only hits join, ties break by key, absent lists contribute nothing", () => {
  const x = (key: string) => ({ k: { key } });
  const all = ["a", "b", "c", "d"].map(x);
  const lexical = [all[0], all[1]];
  assert.deepEqual(
    fusedSearchOrder(all, lexical, new Map()).map((y) => y.k.key),
    ["a", "b"],
  );
  assert.deepEqual(
    fusedSearchOrder(
      all,
      lexical,
      new Map([
        ["c", { rank: 1 }],
        ["b", { rank: 2 }],
      ]),
    ).map((y) => y.k.key),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    fusedSearchOrder(all, lexical, new Map([["zzz", { rank: 1 }]])).map((y) => y.k.key),
    ["a", "b"],
  );
});

// ------------------------------------------------------------------ client

const schema = JSON.parse(
  readFileSync(new URL("../go/contracts/retrieval-v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
const validate = (def: string, v: unknown) => {
  const ok = ajv.validate(`retrieval-v1#/$defs/${def}`, v);
  assert.ok(ok, `${def}: ${ajv.errorsText()}`);
};

type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end();
const requests: Array<{
  headers: IncomingMessage["headers"];
  body: { source_ids?: number[] };
  url?: string;
}> = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ headers: req.headers, body, url: req.url });
    handler(req, body, res);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const searchFixture = JSON.parse(
  readFileSync(new URL("./fixtures/retrieval-v1/search-response.json", import.meta.url), "utf8"),
);

beforeEach(() => {
  Object.assign(config.retrieval.semantic, {
    enabled: true,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    timeoutMs: 800,
    topK: 30,
    minSimilarity: 0.35,
  });
  process.env.RETRIEVAL_INTERNAL_TOKEN = "test-token";
  config.retrieval.internalToken = "test-token";
  requests.length = 0;
  handler = (_req, _body, res) => json(res, 200, searchFixture);
});
after(() => {
  config.retrieval.semantic.enabled = false;
  delete process.env.RETRIEVAL_INTERNAL_TOKEN;
  config.retrieval.internalToken = "";
});

const ask = (extra: Partial<Parameters<typeof semanticRanks>[0]> = {}) =>
  semanticRanks({ ownerId: 7, query: "hoàn tiền", sourceIds: [12, 40], ...extra });

test("client: ranks the best chunk per source and sends a contract-valid request", async () => {
  const hits = await ask({ sourceKinds: ["knowledge", "chat_memory"] });
  assert.deepEqual([...hits!.keys()], [12, 40]);
  assert.equal(hits!.get(12)!.rank, 1);
  assert.equal(hits!.get(12)!.similarity, 0.82);
  assert.equal(hits!.get(40)!.rank, 2);
  const [r] = requests;
  assert.equal(r.url, "/internal/v1/retrieval/search");
  assert.equal(r.headers.authorization, "Bearer test-token");
  assert.equal(r.headers["x-request-timeout-ms"], "800");
  validate("SearchRequest", r.body);
  assert.deepEqual(r.body.source_ids, [12, 40]);
});

test("client: drops hits below min similarity and sources it did not ask for", async () => {
  config.retrieval.semantic.minSimilarity = 0.5;
  assert.deepEqual([...(await ask())!.keys()], [12]);
  config.retrieval.semantic.minSimilarity = 0.35;
  assert.deepEqual([...(await ask({ sourceIds: [40] }))!.keys()], [40]);
});

test("client: falls back (null) when disabled, without token, on 503, invalid body or timeout", async () => {
  const before = { ...semanticFallbacks };
  const delta = (k: string) => (semanticFallbacks[k] ?? 0) - (before[k] ?? 0);

  config.retrieval.semantic.enabled = false;
  assert.equal(await ask(), null);
  config.retrieval.semantic.enabled = true;
  delete process.env.RETRIEVAL_INTERNAL_TOKEN;
  config.retrieval.internalToken = "";
  assert.equal(await ask(), null);
  assert.equal(requests.length, 0);
  process.env.RETRIEVAL_INTERNAL_TOKEN = "test-token";
  config.retrieval.internalToken = "test-token";

  handler = (_req, _body, res) =>
    json(res, 503, { error: "pgvector missing", code: "vector_unavailable" });
  assert.equal(await ask(), null);
  handler = (_req, _body, res) =>
    json(res, 200, { ...searchFixture, results: [{ source_id: 12 }] });
  assert.equal(await ask(), null);
  handler = (_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not json");
  };
  assert.equal(await ask(), null);

  config.retrieval.semantic.timeoutMs = 50;
  handler = (_req, _body, res) => setTimeout(() => json(res, 200, searchFixture), 400);
  const started = Date.now();
  assert.equal(await ask(), null);
  assert.ok(Date.now() - started < 350);
  assert.equal(requests.at(-1)!.headers["x-request-timeout-ms"], "50");

  assert.equal(delta("disabled"), 1);
  assert.equal(delta("missing_token"), 1);
  assert.equal(delta("http_503"), 1);
  assert.equal(delta("invalid_response"), 2);
  assert.equal(delta("timeout"), 1);
});

test("client: no request for an empty query or an empty source set", async () => {
  assert.equal(await ask({ query: "   " }), null);
  assert.equal(await ask({ sourceIds: [] }), null);
  assert.equal(requests.length, 0);
});

test("client: fallback warnings are rate limited per reason", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  handler = (_req, _body, res) => json(res, 500, { error: "x", code: "internal" });
  await ask();
  await ask();
  assert.equal(warn.mock.calls.filter((c) => /http_500/.test(String(c.arguments[0]))).length, 1);
});

test("semanticRanksByKey drops stale versions and renumbers ranks by key", async () => {
  const ranks = await semanticRanksByKey(7, "refund", [
    { id: 12, key: "rule.refund.window", version: 4 },
    { id: 40, key: "memory.chat.7.preference", version: 1 },
  ]);
  assert.deepEqual(
    [...ranks!].map(([k, h]) => [k, h.rank]),
    [["memory.chat.7.preference", 1]],
  );
  assert.equal(
    await semanticRanksByKey(null, "refund", [{ id: 12, key: "k", version: 3 }]),
    undefined,
  );
});

test("contract: example responses validate against the schema and parse in the client", async () => {
  const dirs = [
    new URL("./fixtures/retrieval-v1/", import.meta.url),
    new URL("../go/contracts/examples/", import.meta.url),
  ].filter((d) => existsSync(d));
  const defOf = (f: string) =>
    /search.*response/i.test(f)
      ? "SearchResponse"
      : /search.*request/i.test(f)
        ? "SearchRequest"
        : /reindex.*response/i.test(f)
          ? "ReindexResponse"
          : /reindex.*request/i.test(f)
            ? "ReindexRequest"
            : /status/i.test(f)
              ? "Status"
              : /error/i.test(f)
                ? "Error"
                : null;
  let checked = 0;
  for (const d of dirs)
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
      const def = defOf(f);
      if (!def) continue;
      const body = JSON.parse(readFileSync(new URL(f, d), "utf8"));
      validate(def, body);
      checked++;
      if (def === "SearchResponse") {
        handler = (_req, _body, res) => json(res, 200, body);
        const ids = [
          ...new Set<number>(
            (body.results as Array<{ source_id: number }>).map((r) => r.source_id),
          ),
        ];
        assert.notEqual(await ask({ sourceIds: ids.length ? ids : [1] }), null, f);
      }
    }
  assert.ok(checked >= 4);
});
