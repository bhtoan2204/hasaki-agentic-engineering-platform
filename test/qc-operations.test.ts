import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  maskSecrets,
  qcDestination,
  qcPreauthorized,
  qcRequest,
  summarizeOpenApi,
} from "../src/integrations/qcHttp.ts";
import { endpointsFromArgo } from "../src/integrations/argocd.ts";
import { kafkaPreauthorized } from "../src/integrations/kafka.ts";

const withQc = async (patch: Partial<typeof config.qcHttp>, fn: () => Promise<void> | void) => {
  const saved = { ...config.qcHttp };
  Object.assign(config.qcHttp, patch);
  try {
    await fn();
  } finally {
    Object.assign(config.qcHttp, saved);
  }
};

test("destinations: allowlisted QC hosts only; production, metadata, private addresses and URL credentials are refused", async () => {
  await withQc(
    {
      hosts: [
        "oms.qc.example.dev",
        "*.qc-v2.example.dev",
        "api.example.vn",
        "169.254.169.254",
        "10.0.0.5",
      ],
    },
    () => {
      assert.equal(
        qcDestination("https://oms.qc.example.dev/orders").hostname,
        "oms.qc.example.dev",
      );
      assert.equal(
        qcDestination("https://warranty.qc-v2.example.dev/x").hostname,
        "warranty.qc-v2.example.dev",
      );
      assert.throws(
        () => qcDestination("https://qc-v2.example.dev/x"),
        /not an allowlisted/,
        "suffix pattern needs a subdomain",
      );
      assert.throws(() => qcDestination("https://payment.qc.example.dev/x"), /not an allowlisted/);
      assert.throws(
        () => qcDestination("https://api.example.vn/orders"),
        /production/,
        "a production domain stays refused even when listed",
      );
      assert.throws(() => qcDestination("https://oms.prod.qc-v2.example.dev/x"), /production/);
      assert.throws(() => qcDestination("https://169.254.169.254/latest"), /metadata/);
      assert.throws(() => qcDestination("https://10.0.0.5/x"), /internal address/);
      assert.throws(() => qcDestination("https://u:p@oms.qc.example.dev/x"), /credentials/);
    },
  );
  await withQc({ hosts: [] }, () => {
    assert.throws(
      () => qcDestination("https://oms.qc.example.dev/x"),
      /not an allowlisted/,
      "disabled by default",
    );
  });
});

test("callers cannot set credentials themselves; reads may be pre-authorized, DELETE never is", async () => {
  await withQc(
    {
      hosts: ["oms.qc.example.dev"],
      preauthorized: [
        { method: "POST", host: "oms.qc.example.dev", path: "/orders" },
        { method: "DELETE", host: "oms.qc.example.dev", path: "/" },
      ],
    },
    async () => {
      for (const h of ["Authorization", "cookie", "X-Api-Key", "x-access-token"])
        await assert.rejects(
          qcRequest({ method: "GET", url: "https://oms.qc.example.dev/x", headers: { [h]: "v" } }),
          /set by the platform/,
        );
      assert.equal(qcPreauthorized("POST", "https://oms.qc.example.dev/orders"), true);
      assert.equal(
        qcPreauthorized("POST", "https://oms.qc.example.dev/orders/1/cancel"),
        true,
        "prefix rule",
      );
      assert.equal(qcPreauthorized("POST", "https://oms.qc.example.dev/refunds"), false);
      assert.equal(qcPreauthorized("PUT", "https://oms.qc.example.dev/orders"), false);
      assert.equal(
        qcPreauthorized("DELETE", "https://oms.qc.example.dev/orders/1"),
        false,
        "DELETE always needs a confirmation",
      );
    },
  );
  const saved = config.kafka.publishAllow;
  config.kafka.publishAllow = [{ cluster: "qc", topics: ["warranty.*"], preauthorized: true }];
  try {
    assert.equal(kafkaPreauthorized("warranty.create", "qc"), true);
    assert.equal(kafkaPreauthorized("warranty.prod.create", "qc"), false);
    assert.equal(kafkaPreauthorized("orders.create", "qc"), false);
  } finally {
    config.kafka.publishAllow = saved;
  }
});

test("responses: token-like fields are masked wherever they are", () => {
  const out = maskSecrets({
    data: { access_token: "abc", order_code: "SO-1", nested: [{ password: "x", sku: "A" }] },
    Session: "s",
  });
  assert.deepEqual(out, {
    data: {
      access_token: "[masked]",
      order_code: "SO-1",
      nested: [{ password: "[masked]", sku: "A" }],
    },
    Session: "[masked]",
  });
});

test("contracts: an OpenAPI document becomes a bounded list of operations with request schemas", () => {
  const s = summarizeOpenApi({
    info: { title: "OMS", version: "2" },
    paths: {
      "/orders": {
        post: {
          summary: "Create order",
          operationId: "createOrder",
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateOrder" } },
            },
          },
        },
        get: { summary: "List" },
      },
      "/warranty": {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: { properties: { order_code: {}, reason: {} } } },
            },
          },
        },
      },
    },
  });
  assert.equal(s.total, 3);
  assert.deepEqual(s.operations[0], {
    method: "GET",
    path: "/orders",
    summary: "List",
    operation_id: undefined,
    request: undefined,
  });
  assert.equal(s.operations[1].request, "CreateOrder");
  assert.deepEqual(s.operations[2].request, ["order_code", "reason"]);
});

test("service discovery: routes, hosts, paths, backends, service ports and source repository from Argo CD", () => {
  const e = endpointsFromArgo(
    {
      metadata: { name: "oms-api" },
      spec: {
        project: "oms",
        destination: { namespace: "oms" },
        source: {
          repoURL: "https://bitbucket.org/hsk/oms-api.git",
          path: "deploy",
          targetRevision: "qc",
        },
      },
      status: { summary: { externalURLs: ["https://oms.qc.example.dev"] } },
    },
    {
      nodes: [
        {
          kind: "Ingress",
          name: "oms",
          namespace: "oms",
          networkingInfo: { ingress: [{ hostname: "oms.qc.example.dev" }] },
        },
        { kind: "HTTPRoute", name: "oms-route", namespace: "oms" },
        { kind: "Service", name: "oms-api", namespace: "oms" },
        { kind: "Pod", name: "p" },
      ],
    },
    [
      {
        kind: "Ingress",
        name: "oms",
        manifest: {
          spec: {
            rules: [
              {
                host: "oms.qc.example.dev",
                http: {
                  paths: [
                    {
                      path: "/api",
                      backend: { service: { name: "oms-api", port: { number: 8080 } } },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        kind: "HTTPRoute",
        name: "oms-route",
        manifest: {
          spec: {
            hostnames: ["oms-gw.qc.example.dev"],
            parentRefs: [{ name: "qc-gateway" }],
            rules: [
              {
                matches: [{ path: { value: "/v2" } }],
                backendRefs: [{ name: "oms-api", port: 8080 }],
              },
            ],
          },
        },
      },
      {
        kind: "Service",
        name: "oms-api",
        manifest: {
          spec: { type: "ClusterIP", ports: [{ name: "http", port: 8080, targetPort: 8080 }] },
        },
      },
    ],
  );
  assert.deepEqual(
    e.routes.map((r) => [r.kind, r.hosts, r.paths, r.backends]),
    [
      ["Ingress", ["oms.qc.example.dev"], ["/api"], ["oms-api:8080"]],
      ["HTTPRoute", ["oms-gw.qc.example.dev"], ["/v2"], ["oms-api:8080"]],
    ],
  );
  assert.deepEqual(e.routes[1].gateways, ["qc-gateway"]);
  assert.deepEqual(e.services[0], {
    name: "oms-api",
    namespace: "oms",
    type: "ClusterIP",
    ports: [{ name: "http", port: 8080, target: 8080 }],
    cluster_dns: "oms-api.oms.svc",
  });
  assert.equal(e.source.repo_url, "https://bitbucket.org/hsk/oms-api.git");
  assert.deepEqual(e.external_urls, ["https://oms.qc.example.dev"]);
});
