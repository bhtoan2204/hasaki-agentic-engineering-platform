import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pool, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { execution } from "../src/auth/execution.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { proposeOperation } from "../src/chat/operations.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { setArgoToken } from "../src/integrations/argocd.ts";
import { clearQcTokens, setQcCredentialSource } from "../src/integrations/qcHttp.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const PASSWORD = "qc-S3cret-pass";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- a QC service stand-in (real HTTP on 127.0.0.1)
const svc = {
  logins: 0,
  valid: new Set<string>(),
  orders: new Map<string, Record<string, unknown>>(),
  requests: [] as Array<{
    method: string;
    path: string;
    auth?: string;
    idem?: string;
    body?: Record<string, unknown>;
  }>,
};
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url!, "http://x").pathname;
    svc.requests.push({
      method: req.method!,
      path,
      auth: req.headers.authorization,
      idem: req.headers["idempotency-key"] as string,
      body,
    });
    const json = (status: number, v: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (path === "/auth/login") {
      if (body?.username !== "qc-bot" || body?.password !== PASSWORD)
        return json(401, { error: "bad credentials" });
      const token = `tok-${++svc.logins}`;
      svc.valid.add(token);
      return json(200, { data: { access_token: token, expires_in: 900 } });
    }
    if (path === "/openapi.json")
      return json(200, {
        info: { title: "OMS QC", version: "1" },
        paths: {
          "/orders": {
            post: {
              summary: "Create order",
              requestBody: {
                content: {
                  "application/json": { schema: { properties: { client_ref: {}, sku: {} } } },
                },
              },
            },
          },
        },
      });
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!svc.valid.has(token)) return json(401, { error: "unauthorized" });
    if (req.method === "POST" && path === "/orders") {
      if (body?.sku === "BROKEN") return json(503, { error: "unavailable" });
      if (body?.sku === "SLOW") return; // never answers: the outcome is unknown
      const code = `SO-${svc.orders.size + 1}`;
      svc.orders.set(code, { order_code: code, ...body, status: "CREATED" });
      return json(201, { order_code: code, access_token: "leaked-should-be-masked" });
    }
    const m = /^\/orders\/(.+)$/.exec(path);
    if (req.method === "GET" && m)
      return svc.orders.has(m[1])
        ? json(200, svc.orders.get(m[1]))
        : json(404, { error: "no order" });
    if (req.method === "POST" && path === "/warranty") return json(201, { warranty_code: "WR-1" });
    json(404, { error: "no route" });
  });
});

let base = "";
let alice: Actor;
let bob: Actor;
const savedQc = { ...config.qcHttp };
const realFetch = globalThis.fetch;

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registerBuiltinTools();
  Object.assign(config.qcHttp, {
    hosts: ["127.0.0.1"],
    internalHosts: ["127.0.0.1"],
    preauthorized: [{ method: "POST", host: "127.0.0.1", path: "/orders" }],
    timeoutMs: 800,
    auth: {
      "oms-qc": {
        hosts: ["127.0.0.1"],
        login: {
          url: `${base}/auth/login`,
          body: { username: "{{username}}", password: "{{password}}" },
          tokenPath: "data.access_token",
          expiresInPath: "data.expires_in",
        },
        credentials: { vault: { path: "kv/qc/oms", usernameKey: "user", passwordKey: "pass" } },
      },
    },
  });
  setQcCredentialSource(async () => ({ user: "qc-bot", pass: PASSWORD }));
  // Argo CD stand-in (its client uses fetch): the application exposes the QC service through an Ingress.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.href.startsWith(config.argocd.baseUrl)) return realFetch(input, init);
    const host = new URL(base).hostname;
    if (url.pathname === "/api/v1/session/userinfo")
      return Response.json({ loggedIn: true, username: "dev" });
    if (url.pathname === "/api/v1/applications/oms-api")
      return Response.json({
        metadata: { name: "oms-api" },
        spec: {
          project: "oms",
          destination: { namespace: "oms" },
          source: { repoURL: "https://example.invalid/oms-api.git" },
        },
      });
    if (url.pathname.endsWith("/resource-tree"))
      return Response.json({
        nodes: [
          {
            kind: "Ingress",
            name: "oms",
            namespace: "oms",
            version: "v1",
            group: "networking.k8s.io",
            networkingInfo: { ingress: [{ hostname: host }] },
          },
        ],
      });
    if (url.pathname.endsWith("/resource"))
      return Response.json({
        manifest: JSON.stringify({
          spec: {
            rules: [
              {
                host,
                http: {
                  paths: [
                    {
                      path: "/orders",
                      backend: { service: { name: "oms-api", port: { number: 8080 } } },
                    },
                  ],
                },
              },
            ],
          },
        }),
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  const mk = async (n: string) => {
    const u = await createUser({
      username: `qcops-${n}-${Date.now()}`,
      password: "local-test-password",
      role: "member",
    });
    return { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
  };
  alice = await mk("alice");
  bob = await mk("bob");
  const jwt = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  await execution.run({ userId: alice.id, kind: "user" }, () =>
    setArgoToken(
      `${jwt({ alg: "none" })}.${jwt({ sub: "dev", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`,
    ),
  );
});
after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config.qcHttp, savedQc);
  setQcCredentialSource(null);
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  server.close();
  await pool.end();
});

async function settle(a: Actor, id: number) {
  for (let i = 0; i < 400; i++) {
    const d = await chat.get(a, id);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status))) return d;
    await sleep(25);
  }
  throw new Error("turn did not finish");
}
const call = (name: string, args: unknown) =>
  "```chat-tool\n" +
  JSON.stringify({ calls: [{ tool: "tools.call", arguments: { name, arguments: args } }] }) +
  "\n```";
const chatTool = (tool: string, args: unknown) =>
  "```chat-tool\n" + JSON.stringify({ calls: [{ tool, arguments: args }] }) + "\n```";

test("end to end: discover the service, read its contract, create a QC order without asking, read it back, verify; warranty waits for confirmation; no secret reaches the model", async () => {
  const prompts: string[] = [];
  const steps: Array<(prompt: string) => string> = [
    () => call("argocd.service_endpoints", { app: "oms-api" }),
    () => call("qc_http.openapi", { base_url: base }),
    () =>
      call("qc_http.request", {
        method: "POST",
        url: `${base}/orders`,
        auth: "oms-qc",
        body: { client_ref: "REF-1", sku: "A1" },
      }),
    () => call("qc_http.get", { url: `${base}/orders/SO-1`, auth: "oms-qc" }),
    (p) =>
      chatTool("operations.verify", {
        operation_id: Number([...p.matchAll(/"operation_id":\s*(\d+)/g)].at(-1)![1]),
        evidence_seq: 4,
        match: "SO-1",
      }),
    () =>
      call("qc_http.request", {
        method: "POST",
        url: `${base}/warranty`,
        auth: "oms-qc",
        body: { order_code: "SO-1" },
      }),
    () => "Đã tạo đơn SO-1 (đã xác minh). Yêu cầu bảo hành đang chờ bạn xác nhận.",
  ];
  let i = 0;
  setChatProviders(
    Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        (async (prompt: string) => (
          prompts.push(prompt),
          { text: steps[i++](prompt), tokens: null }
        )) as CompletionRunner,
      ]),
    ) as Record<AgentProvider, CompletionRunner>,
  );
  const c = await chat.create(alice, { mode: "ASK", provider: "claude" });
  const msg = await chat.postMessage(alice, c.id, {
    content: "tạo đơn hàng QC cho oms-api rồi tạo bảo hành cho đơn đó",
    client_message_id: "qcops-e2e-1",
  });
  const d = await settle(alice, c.id);
  const turn = d.turns.find((t) => t.id === msg.turn.id)!;
  assert.equal(
    turn.status,
    "completed",
    JSON.stringify([turn.failure, d.tool_calls.map((t) => [t.tool, t.status, t.result])]),
  );
  assert.deepEqual(
    d.tool_calls.map((t) => [t.tool, t.status]),
    [
      ["tools.call", "ok"],
      ["tools.call", "ok"],
      ["tools.call", "ok"],
      ["tools.call", "ok"],
      ["operations.verify", "ok"],
      ["tools.call", "ok"],
    ],
  );
  const discovered = d.tool_calls[0].result as {
    routes: Array<{ hosts: string[]; paths: string[] }>;
  };
  assert.deepEqual(
    [discovered.routes[0].hosts, discovered.routes[0].paths],
    [["127.0.0.1"], ["/orders"]],
  );
  assert.equal((d.tool_calls[1].result as { found: string }).found, `${base}/openapi.json`);

  const posts = svc.requests.filter((r) => r.method === "POST" && r.path === "/orders");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, "Bearer tok-1", "the backend injected the token");
  assert.equal(posts[0].idem?.length, 64, "Idempotency-Key sent");
  assert.equal(svc.logins, 1, "the token is cached across the chain");

  const [order, warranty] = d.operations;
  assert.deepEqual(
    [order.status, order.auto, order.verification?.verified],
    ["succeeded", true, true],
  );
  assert.equal(warranty.status, "pending", "not pre-authorized: waits for the owner");
  assert.ok(!svc.requests.some((r) => r.path === "/warranty"));

  const exposed = JSON.stringify([
    prompts,
    d.tool_calls,
    d.operations,
    d.messages,
    await q(pool, "SELECT data FROM chat_events WHERE conversation_id = $1", [c.id]),
  ]);
  for (const secret of [PASSWORD, "tok-1", "leaked-should-be-masked"])
    assert.ok(!exposed.includes(secret), `${secret} never leaves the backend`);

  await settleBackground();
  const procedure = (await chat.memories(alice)).find((m) => /qc_http\.request/.test(m.content));
  assert.ok(procedure, "the verified operation taught a procedure");
  assert.match(
    procedure!.content,
    /path \/orders.*auth profile oms-qc.*payload fields: client_ref, sku.*verified by reading back with qc_http\.get/,
  );
  assert.doesNotMatch(procedure!.content, /REF-1|SO-1|tok-|S3cret/);

  // The same order request again (another conversation, same owner): refused, nothing sent.
  const again = await proposeOperation(
    { userId: alice.id, conversationId: c.id, turnId: msg.turn.id },
    "qc_http.request",
    {
      method: "POST",
      url: `${base}/orders`,
      auth: "oms-qc",
      body: { client_ref: "REF-1", sku: "A1" },
    },
  );
  assert.equal(again.status, "duplicate");
  assert.equal(svc.requests.filter((r) => r.method === "POST" && r.path === "/orders").length, 1);

  // Budget: this turn already holds two operations.
  const saved = config.qcHttp.maxOperationsPerTurn;
  config.qcHttp.maxOperationsPerTurn = 2;
  try {
    await assert.rejects(
      proposeOperation(
        { userId: alice.id, conversationId: c.id, turnId: msg.turn.id },
        "qc_http.request",
        { method: "POST", url: `${base}/orders`, auth: "oms-qc", body: { client_ref: "REF-9" } },
      ),
      /operation budget/,
    );
  } finally {
    config.qcHttp.maxOperationsPerTurn = saved;
  }
});

test("verification is checked by the platform: an identifier not read back, or not the operation's own, is not a verified outcome", async () => {
  const steps: Array<(p: string) => string> = [
    () =>
      call("qc_http.request", {
        method: "POST",
        url: `${base}/orders`,
        auth: "oms-qc",
        body: { client_ref: "REF-2", sku: "B2" },
      }),
    () => call("qc_http.get", { url: `${base}/orders/SO-404`, auth: "oms-qc" }),
    (p) =>
      chatTool("operations.verify", {
        operation_id: Number([...p.matchAll(/"operation_id":\s*(\d+)/g)].at(-1)![1]),
        evidence_seq: 2,
        match: "SO-2",
      }),
    (p) =>
      chatTool("operations.verify", {
        operation_id: Number([...p.matchAll(/"operation_id":\s*(\d+)/g)].at(-1)![1]),
        evidence_seq: 2,
        match: "SO-404",
      }),
    () => "Chưa xác minh được đơn hàng.",
  ];
  let i = 0;
  setChatProviders(
    Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        (async (prompt: string) => ({
          text: steps[i++](prompt),
          tokens: null,
        })) as CompletionRunner,
      ]),
    ) as Record<AgentProvider, CompletionRunner>,
  );
  const c = await chat.create(alice, { mode: "ASK", provider: "claude" });
  await chat.postMessage(alice, c.id, {
    content: "tạo đơn QC rồi kiểm tra",
    client_message_id: "qcops-verify-1",
  });
  const d = await settle(alice, c.id);
  const verify = d.tool_calls.filter((t) => t.tool === "operations.verify");
  assert.deepEqual(
    (verify[0].result as { verified: boolean }).verified,
    false,
    "SO-2 was not in the read-back",
  );
  assert.equal(verify[1].status, "error", "SO-404 is not this operation's identifier");
  assert.equal(d.operations[0].verification?.verified, false);
});

test("production and unlisted destinations are refused before anything is sent; failures are never retried; an unknown outcome blocks a repeat", async () => {
  const ctx = { runId: null, allowedRepositories: [], mode: "analysis" as const };
  const read = (url: string) =>
    execution.run({ userId: alice.id, kind: "user" }, () =>
      callTool("qc_http.get", { url, auth: "oms-qc" }, ctx),
    );
  assert.match((await read("https://api.example.vn/orders/1")).error!, /production/);
  assert.match((await read("https://oms.example.com/orders/1")).error!, /not an allowlisted/);
  assert.match(
    (await read("https://169.254.169.254/latest")).error!,
    /not an allowlisted|metadata/,
  );
  const c = await chat.create(alice, { mode: "ASK", provider: "claude" });
  const b = { userId: alice.id, conversationId: c.id, turnId: null as unknown as number };
  await assert.rejects(
    proposeOperation(b, "qc_http.request", {
      method: "POST",
      url: "https://oms.prod.example.dev/orders",
      body: {},
    }),
    /production/,
  );
  assert.equal(
    (await q(pool, "SELECT 1 FROM chat_operations WHERE conversation_id = $1", [c.id])).length,
    0,
  );
  const direct = await callTool(
    "qc_http.request",
    { method: "POST", url: `${base}/orders`, body: {} },
    { ...ctx, mode: "coding" },
  );
  assert.match(direct.error!, /confirmed operation/, "no agent can call it directly");

  const before = svc.requests.length;
  const broken = await proposeOperation(b, "qc_http.request", {
    method: "POST",
    url: `${base}/orders`,
    auth: "oms-qc",
    body: { sku: "BROKEN" },
  });
  assert.equal(broken.status, "succeeded", "the HTTP exchange completed; the 503 is in the result");
  assert.equal((broken as unknown as { result: { status: number } }).result.status, 503);
  assert.equal(
    svc.requests.slice(before).filter((r) => r.body?.sku === "BROKEN").length,
    1,
    "a 503 on a state-changing request is not retried",
  );

  const slow = await proposeOperation(b, "qc_http.request", {
    method: "POST",
    url: `${base}/orders`,
    auth: "oms-qc",
    body: { sku: "SLOW" },
  });
  assert.equal(slow.status, "unknown");
  const repeat = await proposeOperation(b, "qc_http.request", {
    method: "POST",
    url: `${base}/orders`,
    auth: "oms-qc",
    body: { sku: "SLOW" },
  });
  assert.equal(repeat.status, "duplicate", "an unknown outcome is not re-sent");
});

test("authentication: per-user token isolation and refresh after the service rejects an expired token", async () => {
  clearQcTokens();
  const ctx = { runId: null, allowedRepositories: [], mode: "analysis" as const };
  const read = (who: Actor) =>
    execution.run({ userId: who.id, kind: "user" }, () =>
      callTool("qc_http.get", { url: `${base}/orders/SO-1`, auth: "oms-qc" }, ctx),
    );
  const logins = svc.logins;
  assert.equal(((await read(alice)).result as { status: number }).status, 200);
  assert.equal(((await read(bob)).result as { status: number }).status, 200);
  assert.equal(svc.logins, logins + 2, "each user has their own session");
  svc.valid.clear(); // the service expires every token
  const r = await read(alice);
  assert.equal((r.result as { status: number }).status, 200, "refreshed and retried once");
  assert.equal(svc.logins, logins + 3);
  const tokens = svc.requests.slice(-4).map((x) => x.auth);
  assert.ok(new Set(tokens).size >= 2);
});
