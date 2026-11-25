import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { vaultWriteTarget } from "../src/integrations/vault.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

const withVault = async (v: Partial<typeof config.vault>, fn: () => Promise<void>) => {
  const saved = { ...config.vault };
  Object.assign(config.vault, v);
  try {
    await fn();
  } finally {
    Object.assign(config.vault, saved);
  }
};

const allow = [{ path: "secret/payment/*", keys: ["OTEL_ENDPOINT"] }];

test("vault write target: production host is refused even when allowlisted", async () => {
  for (const baseUrl of ["https://vault.hasaki.vn", "https://vault-prod.hasaki.dev"])
    await withVault({ baseUrl, writeAllow: allow }, async () => {
      await assert.rejects(
        vaultWriteTarget("secret/payment/app", "OTEL_ENDPOINT"),
        /not a QC environment/,
      );
    });
});

test("vault write target: default config allows any QC path and key, never production", () => {
  assert.deepEqual(config.vault.writeAllow, [{ path: "*", keys: ["*"] }]);
});

test("vault write target: wildcard key still refuses production host and production path", async () => {
  const any = [{ path: "*", keys: ["*"] }];
  await withVault({ baseUrl: "https://vault.hasaki.vn", writeAllow: any }, async () => {
    await assert.rejects(
      vaultWriteTarget("payment/qc/app", "OTEL_ENDPOINT"),
      /not a QC environment/,
    );
  });
  await withVault({ baseUrl: "https://vault-qc-v2.hasaki.dev", writeAllow: any }, async () => {
    await assert.rejects(vaultWriteTarget("payment/prod/app", "OTEL_ENDPOINT"), /production/);
  });
});

test("vault write target: wildcard key and path pass the allowlist step", async () => {
  await withVault(
    { baseUrl: "https://vault-qc-v2.hasaki.dev", writeAllow: [{ path: "*", keys: ["*"] }] },
    async () => {
      await assert.rejects(
        vaultWriteTarget("payment/qc/app", "ANY_KEY"),
        (e: Error) => !/allowlist|disabled/.test(e.message),
      );
    },
  );
});

test("vault write target: empty allowlist disables writes", async () => {
  await withVault({ baseUrl: "https://vault-qc-v2.hasaki.dev", writeAllow: [] }, async () => {
    await assert.rejects(vaultWriteTarget("secret/payment/app", "OTEL_ENDPOINT"), /disabled/);
  });
});

test("vault write target: path and key must match the allowlist", async () => {
  await withVault({ baseUrl: "https://vault-qc-v2.hasaki.dev", writeAllow: allow }, async () => {
    await assert.rejects(
      vaultWriteTarget("secret/order/app", "OTEL_ENDPOINT"),
      /not in the QC write allowlist/,
    );
    await assert.rejects(
      vaultWriteTarget("secret/payment/app", "otel_endpoint"),
      /not in the QC write allowlist/,
    );
    await assert.rejects(
      vaultWriteTarget("secret/payment/app", "DB_PASSWORD"),
      /not in the QC write allowlist/,
    );
  });
});

test("vault write target: path escapes are refused", async () => {
  await withVault({ baseUrl: "https://vault-qc-v2.hasaki.dev", writeAllow: allow }, async () => {
    for (const p of ["secret/payment/../order/app", "secret/payment/./../x", "../secret/payment/x"])
      await assert.rejects(vaultWriteTarget(p, "OTEL_ENDPOINT"), /\.\./);
  });
});

test("vault write target: encoded or backslash path tricks are refused", async () => {
  await withVault({ baseUrl: "https://vault-qc-v2.hasaki.dev", writeAllow: allow }, async () => {
    for (const p of [
      "secret/payment/%2e%2e/order/app",
      "secret/payment/%2E%2e/app",
      "secret/payment\\..\\order\\app",
      "secret/payment/%70rod/app",
      "secret/payment/a?x=1",
      "secret/payment/a#b",
      "secret/payment/a b",
    ])
      await assert.rejects(vaultWriteTarget(p, "OTEL_ENDPOINT"), /unsupported characters/);
  });
});

test("vault write target: production-looking path is refused", async () => {
  await withVault(
    {
      baseUrl: "https://vault-qc-v2.hasaki.dev",
      writeAllow: [{ path: "secret/payment*", keys: ["OTEL_ENDPOINT"] }],
    },
    async () => {
      await assert.rejects(
        vaultWriteTarget("secret/payment-prod/app", "OTEL_ENDPOINT"),
        /production/,
      );
    },
  );
});

test("vault.set_key cannot be called directly by any agent, only through a confirmed operation", async () => {
  registerBuiltinTools();
  for (const mode of ["analysis", "coding"] as const) {
    const r = await callTool(
      "vault.set_key",
      { path: "secret/payment/app", key: "OTEL_ENDPOINT", value: "http://otel:4317" },
      { runId: 1, allowedRepositories: [], mode },
    );
    assert.equal(r.ok, false);
    assert.match(
      r.error!,
      mode === "analysis" ? /read-only step|confirmed operation/ : /confirmed operation/,
    );
  }
});

test("vault.set_key rejects empty and oversized values", async () => {
  registerBuiltinTools();
  for (const value of ["", "x".repeat(4001)]) {
    const r = await callTool(
      "vault.set_key",
      { path: "secret/payment/app", key: "OTEL_ENDPOINT", value },
      { runId: 1, allowedRepositories: [], mode: "coding" },
    );
    assert.equal(r.ok, false);
  }
});
