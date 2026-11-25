import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { restartTarget } from "../src/integrations/argocd.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

const withArgo = async (baseUrl: string, fn: () => Promise<void>) => {
  const saved = config.argocd.baseUrl;
  config.argocd.baseUrl = baseUrl;
  try {
    await fn();
  } finally {
    config.argocd.baseUrl = saved;
  }
};

test("argocd restart target: production Argo CD is refused", async () => {
  for (const url of ["https://argocd.hasaki.vn", "https://argocd-prod.hasaki.dev"])
    await withArgo(url, async () => {
      await assert.rejects(restartTarget({ app: "payment-qc-x" }), /not a QC environment/);
    });
});

test("argocd restart target: production-looking app is refused before any request", async () => {
  await withArgo("https://argocd-qc-v2.hasaki.dev", async () => {
    await assert.rejects(restartTarget({ app: "payment-prod-api" }), /never allowed/);
  });
});

test("argocd.restart cannot be called directly by any agent, only through a confirmed operation", async () => {
  registerBuiltinTools();
  for (const mode of ["analysis", "coding"] as const) {
    const r = await callTool(
      "argocd.restart",
      { app: "payment-qc-payment-fiserv" },
      { runId: 1, allowedRepositories: [], mode },
    );
    assert.equal(r.ok, false);
    assert.match(
      r.error!,
      mode === "analysis" ? /read-only step|confirmed operation/ : /confirmed operation/,
    );
  }
});
