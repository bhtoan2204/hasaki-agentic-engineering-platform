import { test, after, before } from "node:test";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import {
  appPods,
  restartTarget,
  restartWorkload,
  argoStatus,
  clearArgoToken,
  listApps,
  parseArgoToken,
  podLogs,
  redact,
  setArgoToken,
} from "../src/integrations/argocd.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

const jwt = (claims: object) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJlLXZhbHVl`;
const GOOD = jwt({ email: "dev@example.vn", exp: Math.floor(Date.now() / 1000) + 3600 });
let server: Server;
const seen: URL[] = [];
const posts: Array<{ path: string; body: unknown }> = [];

before(async () => {
  await migrate();
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    seen.push(url);
    const auth = req.headers.authorization;
    const json = (code: number, body: unknown) => (
      res.writeHead(code, { "content-type": "application/json" }),
      res.end(typeof body === "string" ? body : JSON.stringify(body))
    );
    if (url.pathname === "/api/v1/session/userinfo")
      return json(
        200,
        auth === `Bearer ${GOOD}`
          ? { loggedIn: true, username: "dev@example.vn" }
          : { loggedIn: false },
      );
    if (auth !== `Bearer ${GOOD}`) return json(401, { error: "invalid session" });
    if (url.pathname === "/api/v1/applications")
      return json(200, {
        items: [
          {
            metadata: { name: "payment-zalopay-qc", namespace: "argocd" },
            spec: { project: "payment", destination: { namespace: "payment" } },
            status: { health: { status: "Healthy" }, sync: { status: "Synced" } },
          },
          {
            metadata: { name: "oms-api-qc", namespace: "argocd" },
            spec: { project: "oms", destination: { namespace: "oms" } },
            status: { health: { status: "Degraded" }, sync: { status: "Synced" } },
          },
        ],
      });
    if (req.method === "POST" && url.pathname.endsWith("/resource/actions/v2")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posts.push({ path: url.pathname, body: JSON.parse(raw) });
        json(200, {});
      });
      return;
    }
    if (url.pathname === "/api/v1/applications/payment-multi-qc/resource-tree")
      return json(200, {
        nodes: [
          { kind: "Deployment", group: "apps", version: "v1", name: "a", namespace: "payment" },
          { kind: "Deployment", group: "apps", version: "v1", name: "b", namespace: "payment" },
        ],
      });
    if (url.pathname === "/api/v1/applications/payment-zalopay-qc/resource-tree")
      return json(200, {
        nodes: [
          {
            kind: "Deployment",
            group: "apps",
            version: "v1",
            name: "payment-zalopay",
            namespace: "payment",
            health: { status: "Healthy" },
            images: ["zalopay:1.2.3"],
          },
          {
            kind: "ReplicaSet",
            group: "apps",
            name: "payment-zalopay-7d",
            namespace: "payment",
            createdAt: "2026-11-25T02:00:00Z",
            parentRefs: [{ kind: "Deployment", name: "payment-zalopay" }],
          },
          {
            kind: "Pod",
            name: "payment-zalopay-abc",
            namespace: "payment",
            health: { status: "Healthy" },
            info: [
              { name: "Status Reason", value: "Running" },
              { name: "Restart Count", value: "2" },
              { name: "Containers", value: "1/1" },
            ],
            parentRefs: [{ kind: "ReplicaSet", name: "payment-zalopay-7d" }],
          },
        ],
      });
    if (url.pathname === "/api/v1/applications/payment-zalopay-qc/logs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        [
          {
            result: {
              content: "ERROR callback HSK-T123 failed Authorization: Bearer abcdefghijklmnopqrstu",
              timeStampStr: "2026-11-05T07:00:00Z",
              podName: "payment-zalopay-abc",
            },
          },
          {
            result: {
              content: "client_secret=topsecretvalue ok",
              timeStampStr: "2026-11-05T07:00:01Z",
              podName: "payment-zalopay-abc",
            },
          },
          { result: { content: "", last: true } },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n"),
      );
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.argocd.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(async () => {
  server.close();
  await pool.end();
});

test("parseArgoToken accepts a raw value, Bearer, cookie pair, and split cookie chunks", () => {
  assert.equal(parseArgoToken(`  ${GOOD} `), GOOD);
  assert.equal(parseArgoToken(`Bearer ${GOOD}`), GOOD);
  assert.equal(parseArgoToken(`argocd.token=${GOOD}`), GOOD);
  const [a, b] = [GOOD.slice(0, 20), GOOD.slice(20)];
  assert.equal(
    parseArgoToken(`Cookie: _ga=1; argocd.token-1=${b}; argocd.token=${a}; theme=dark`),
    GOOD,
  );
});

test("redact masks bearer tokens, JWTs and secret assignments", () => {
  assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrstu"), "Authorization: Bearer ***");
  assert.equal(redact(`token ${GOOD}`), "token <jwt>");
  assert.equal(redact('{"client_secret":"s3cr3t-value"}'), '{"client_secret":"***"}');
  assert.equal(redact("order HSK-T123 paid"), "order HSK-T123 paid");
});

test("token is validated against Argo CD before saving; tools work and are read-only", async () => {
  await clearArgoToken();
  registerBuiltinTools();
  const ctx = { runId: 0, allowedRepositories: [], mode: "analysis" as const };
  const off = await callTool("argocd.list_apps", {}, ctx);
  assert.equal(off.ok, false);
  assert.match(String(off.error), /not connected/);

  await assert.rejects(setArgoToken("not-a-jwt"), /JWT/);
  await assert.rejects(setArgoToken(jwt({ exp: 1 })), /hết hạn/);
  await assert.rejects(
    setArgoToken(jwt({ exp: Math.floor(Date.now() / 1000) + 60 })),
    /không chấp nhận/,
  );
  const st = await setArgoToken(`argocd.token=${GOOD}`);
  assert.equal(st.loggedIn, true);
  assert.equal(st.user, "dev@example.vn");

  assert.deepEqual(
    (await listApps("payment zalopay")).map((a) => a.app),
    ["payment-zalopay-qc"],
  );
  const tree = await appPods("payment-zalopay-qc");
  assert.equal(tree.pods[0].restarts, "2");
  assert.equal(tree.workloads[0].name, "payment-zalopay");

  const r = await callTool(
    "argocd.pod_logs",
    {
      app: "payment-zalopay-qc",
      pod: "payment-zalopay-abc",
      filter: "HSK-T123",
      since_minutes: 30,
    },
    ctx,
  );
  assert.equal(r.ok, true, String(r.error));
  const logs = r.result as Awaited<ReturnType<typeof podLogs>>;
  assert.equal(logs.namespace, "payment", "namespace looked up from the resource tree");
  assert.equal(logs.count, 2);
  assert.match(logs.lines[0].line, /Bearer \*\*\*/);
  assert.match(logs.lines[1].line, /client_secret=\*\*\*/);
  const q = seen.filter((u) => u.pathname.endsWith("/logs")).at(-1)!;
  assert.equal(q.searchParams.get("podName"), "payment-zalopay-abc");
  assert.equal(q.searchParams.get("filter"), "HSK-T123");
  assert.equal(q.searchParams.get("sinceSeconds"), "1800");
  assert.equal(q.searchParams.get("follow"), "false");

  const wl = await podLogs({
    app: "payment-zalopay-qc",
    workload: { kind: "Deployment", name: "payment-zalopay" },
  });
  assert.equal(wl.target, "Deployment/payment-zalopay");
  const q2 = seen.filter((u) => u.pathname.endsWith("/logs")).at(-1)!;
  assert.equal(q2.searchParams.get("resourceName"), "payment-zalopay");
  assert.equal(q2.searchParams.get("group"), "apps");

  assert.equal((await clearArgoToken()).loggedIn, false);
  assert.equal(argoStatus().user, null);
});

test("restartWorkload posts the restart action for the app's only workload (QC only)", async () => {
  await setArgoToken(GOOD);
  const saved = config.argocd.baseUrl;
  config.argocd.baseUrl = saved.replace("127.0.0.1", "argocd-qc.localhost");
  posts.length = 0;
  try {
    const r = await restartWorkload({ app: "payment-zalopay-qc" });
    assert.deepEqual(r, {
      restarted: true,
      app: "payment-zalopay-qc",
      kind: "Deployment",
      name: "payment-zalopay",
      namespace: "payment",
      downstream_verified: false,
    });
    assert.deepEqual(posts, [
      {
        path: "/api/v1/applications/payment-zalopay-qc/resource/actions/v2",
        body: {
          appNamespace: "argocd",
          namespace: "payment",
          resourceName: "payment-zalopay",
          version: "v1",
          kind: "Deployment",
          group: "apps",
          resourceActionParameters: [],
          action: "restart",
        },
      },
    ]);
    assert.equal(
      (await restartTarget({ app: "payment-zalopay-qc" })).version,
      "2026-11-25T02:00:00Z",
      "newest ReplicaSet creation time keys the operation",
    );
    await assert.rejects(restartWorkload({ app: "payment-multi-qc" }), /several workloads/);
    await assert.rejects(
      restartWorkload({ app: "payment-zalopay-qc", workload: "nope" }),
      /no restartable workload/,
    );
    assert.equal(posts.length, 1, "refused calls send nothing");
  } finally {
    config.argocd.baseUrl = saved;
  }
});
