import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import {
  clearVaultToken,
  describeValue,
  parseVaultToken,
  setVaultToken,
  vaultKeys,
  vaultList,
  vaultStatus,
} from "../src/integrations/vault.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

const TOKEN = "hvs.CAESIabcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_VALUES = ["sk_live_REALSECRET", "postgres://u:p@db/x", "Zalo-Key-2-abcdef"];
let server: Server;
let valid = true;
const reqs: Array<{ method: string; path: string }> = [];

before(async () => {
  await migrate();
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    reqs.push({ method: req.method!, path: url.pathname + url.search });
    const json = (code: number, b: unknown) => (
      res.writeHead(code, { "content-type": "application/json" }),
      res.end(JSON.stringify(b))
    );
    if (!valid || req.headers["x-vault-token"] !== TOKEN)
      return json(403, { errors: ["permission denied"] });
    const p = url.pathname;
    if (p === "/v1/auth/token/lookup-self")
      return json(200, {
        data: {
          display_name: "oidc-toanbh@hasakigroup.vn",
          policies: ["default", "dev-read"],
          ttl: 3600,
          renewable: true,
          expire_time: "2026-11-06T07:00:00Z",
        },
      });
    if (p === "/v1/sys/internal/ui/mounts")
      return json(200, {
        data: {
          secret: {
            "secret/": { type: "kv", options: { version: "2" } },
            "legacy/": { type: "kv", options: {} },
            "pki/": { type: "pki" },
          },
        },
      });
    if (p === "/v1/secret/metadata/payment/" && url.searchParams.get("list") === "true")
      return json(200, { data: { keys: ["payment-zalopay", "payment-worker/"] } });
    if (p === "/v1/secret/data/payment/payment-zalopay")
      return json(200, {
        data: {
          data: {
            PAYMENT_PROVIDER_ZALOPAY_TIME_OUT_IN_MINUTES: "15",
            STRIPE_SECRET_KEY: SECRET_VALUES[0],
            DATABASE_URL: SECRET_VALUES[1],
            DEBUG: "true",
            EMPTY_ONE: "",
          },
          metadata: { version: 7, created_time: "2026-11-01T00:00:00Z" },
        },
      });
    if (p === "/v1/legacy/payment/zalopay")
      return json(200, { data: { app_key2: SECRET_VALUES[2], retry: "3" } });
    json(404, { errors: [] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.vault.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await clearVaultToken();
  server.close();
  await pool.end();
});

test("parseVaultToken: raw, header line, cURL; rejects junk", () => {
  assert.equal(parseVaultToken(` ${TOKEN} `), TOKEN);
  assert.equal(parseVaultToken(`X-Vault-Token: ${TOKEN}`), TOKEN);
  assert.equal(
    parseVaultToken(
      `curl 'https://vault-qc-v2.hasaki.dev/v1/sys/health' -H 'x-vault-token: ${TOKEN}'`,
    ),
    TOKEN,
  );
  assert.throws(() => parseVaultToken("hello"), /không đúng dạng/);
});

test("describeValue reveals only short numbers/booleans under non-sensitive names", () => {
  assert.deepEqual(describeValue("TIMEOUT_MINUTES", "15"), {
    key: "TIMEOUT_MINUTES",
    set: true,
    value: "15",
  });
  assert.deepEqual(
    describeValue("API_KEY", "12345"),
    { key: "API_KEY", set: true, length: 5 },
    "number under a sensitive name stays hidden",
  );
  assert.deepEqual(describeValue("HOST", "db.internal"), { key: "HOST", set: true, length: 11 });
  assert.deepEqual(describeValue("X", ""), { key: "X", set: false, note: "empty" });
});

test("token validated before saving; list/keys work on KV v1 and v2; secret values never leave; only reads", async () => {
  await clearVaultToken();
  registerBuiltinTools();
  const ctx = { runId: 0, allowedRepositories: [], mode: "analysis" as const };
  assert.match(String((await callTool("vault.list", {}, ctx)).error), /not connected/);
  await assert.rejects(
    setVaultToken("hvs.WRONGabcdefghijklmnopqrstuvwxyz0123"),
    /hết hạn|không hợp lệ/,
  );

  const st = await setVaultToken(TOKEN);
  assert.equal(st.connected, true);
  assert.equal(st.user, "oidc-toanbh@hasakigroup.vn");
  assert.deepEqual(st.policies, ["default", "dev-read"]);
  assert.ok(!JSON.stringify(st).includes(TOKEN));

  assert.deepEqual(
    (await vaultList()).mounts,
    [
      { path: "secret/", kv_version: 2 },
      { path: "legacy/", kv_version: 1 },
    ],
    "only KV mounts",
  );
  assert.deepEqual((await vaultList("secret/payment")).entries, [
    "payment-zalopay",
    "payment-worker/",
  ]);

  const r = await callTool(
    "vault.keys",
    {
      path: "secret/payment/payment-zalopay",
      expect: [
        "PAYMENT_PROVIDER_ZALOPAY_TIME_OUT_IN_MINUTES",
        "debug",
        "PAYMENT_PROVIDER_STRIPE_TIME_OUT_IN_MINUTES",
      ],
    },
    ctx,
  );
  assert.equal(r.ok, true, String(r.error));
  const k: any = r.result;
  assert.equal(k.version, 7);
  assert.deepEqual(
    k.expected.map((e: any) => [e.key, e.present, e.value]),
    [
      ["PAYMENT_PROVIDER_ZALOPAY_TIME_OUT_IN_MINUTES", true, "15"],
      ["debug", true, "true"],
      ["PAYMENT_PROVIDER_STRIPE_TIME_OUT_IN_MINUTES", false, undefined],
    ],
  );
  assert.equal(k.expected[1].actual_name, "DEBUG");
  assert.equal(
    k.keys.find((x: any) => x.key === "STRIPE_SECRET_KEY").length,
    SECRET_VALUES[0].length,
  );

  const v1: any = await vaultKeys("legacy/payment/zalopay");
  assert.equal(v1.keys.find((x: any) => x.key === "retry").value, "3");

  const everything = JSON.stringify([k, v1]);
  for (const s of SECRET_VALUES) assert.ok(!everything.includes(s), `secret value leaked: ${s}`);

  assert.match(String((await callTool("vault.keys", { path: "pki/x" }, ctx)).error), /KV mount/);
  assert.ok(
    reqs.every((x) => x.method === "GET"),
    "no writes (renew-self only runs on the timer)",
  );

  valid = false;
  assert.equal((await vaultStatus(true)).expired, true);
  valid = true;
});
