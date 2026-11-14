import { codexConfig, antigravityConfig } from "../config.ts";
import { providerEnabled } from "./provider.ts";
import { probeAgentHealth, rememberedQuota } from "./health.ts";
import { codexCapabilities } from "./codex/run.ts";
import { cursorCapabilities } from "./cursor/run.ts";
import { antigravityCapabilities } from "./antigravity/capabilities.ts";

/**
 * Readiness of each agent provider on this worker, for the run forms. Probes the installed CLIs only (version, flags,
 * login status, model catalog); no model is called, nothing is billed, and no credential is read or returned.
 */
export async function agentProviderStatus(refresh = false) {
  const [cursor, codex, antigravity, claudeHealth] = await Promise.all([
    cursorCapabilities(refresh).catch((e) => ({
      ok: false,
      error: String(e?.message ?? e),
    })),
    codexCapabilities(refresh).catch(
      (e) => ({ ok: false, error: String(e?.message ?? e) }) as const,
    ),
    antigravityCapabilities(refresh).catch(
      (e) => ({ ok: false, error: String(e?.message ?? e) }) as const,
    ),
    probeAgentHealth(["claude"]).then((rows) => rows[0]),
  ]);
  const cfg = codexConfig();
  const agyCfg = antigravityConfig();
  return [
    {
      id: "claude",
      enabled: providerEnabled("claude"),
      ok: claudeHealth.connected && claudeHealth.quota !== "exhausted",
      error: claudeHealth.reason,
      quota: claudeHealth.quota,
    },
    {
      id: "cursor",
      enabled: providerEnabled("cursor"),
      ok: cursor.ok && rememberedQuota("cursor") !== "exhausted",
      error:
        rememberedQuota("cursor") === "exhausted"
          ? "quota exhausted"
          : cursor.ok
            ? undefined
            : cursor.error,
      quota: rememberedQuota("cursor"),
    },
    {
      id: "codex",
      enabled: providerEnabled("codex"),
      ok: codex.ok && rememberedQuota("codex") !== "exhausted",
      error:
        rememberedQuota("codex") === "exhausted"
          ? "quota exhausted"
          : codex.ok
            ? undefined
            : codex.error,
      quota: rememberedQuota("codex"),
      kind: "kind" in codex ? codex.kind : undefined,
      version: "version" in codex ? codex.version : undefined,
      /** e.g. "ChatGPT": how the WORKER's Codex CLI is logged in. Runs execute with that account, not per platform user. */
      auth: "auth" in codex ? codex.auth : undefined,
      model: cfg.model || null,
      reasoning_effort: cfg.reasoningEffort || null,
      models: "models" in codex ? codex.models?.map((m) => m.slug) : undefined,
    },
    {
      id: "antigravity",
      enabled: providerEnabled("antigravity"),
      ok: antigravity.ok && rememberedQuota("antigravity") !== "exhausted",
      error:
        rememberedQuota("antigravity") === "exhausted"
          ? "quota exhausted"
          : antigravity.ok
            ? undefined
            : antigravity.error,
      quota: rememberedQuota("antigravity"),
      kind: "kind" in antigravity ? antigravity.kind : undefined,
      version: "version" in antigravity ? antigravity.version : undefined,
      auth: "auth" in antigravity ? antigravity.auth : undefined,
      model: agyCfg.model || null,
      reasoning_effort: agyCfg.effort || null,
      models: "models" in antigravity ? antigravity.models?.map((m) => m.slug) : undefined,
    },
  ];
}
