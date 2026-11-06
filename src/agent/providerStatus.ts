import { codexConfig } from "../config.ts";
import { codexCapabilities } from "./codex/run.ts";
import { cursorCapabilities } from "./cursor/run.ts";

/**
 * Readiness of each agent provider on this worker, for the run forms. Probes the installed CLIs only (version, flags,
 * login status, model catalog); no model is called, nothing is billed, and no credential is read or returned.
 */
export async function agentProviderStatus(refresh = false) {
  const [cursor, codex] = await Promise.all([cursorCapabilities(refresh).catch((e) => ({ ok: false, error: String(e?.message ?? e) })), codexCapabilities(refresh).catch((e) => ({ ok: false, error: String(e?.message ?? e) }) as const)]);
  const cfg = codexConfig();
  return [
    { id: "claude", ok: true },
    { id: "cursor", ok: cursor.ok, error: cursor.ok ? undefined : cursor.error },
    {
      id: "codex",
      ok: codex.ok,
      error: codex.ok ? undefined : codex.error,
      kind: "kind" in codex ? codex.kind : undefined,
      version: "version" in codex ? codex.version : undefined,
      /** e.g. "ChatGPT": how the WORKER's Codex CLI is logged in. Runs execute with that account, not per platform user. */
      auth: "auth" in codex ? codex.auth : undefined,
      model: cfg.model || null,
      reasoning_effort: cfg.reasoningEffort || null,
      models: "models" in codex ? codex.models?.map((m) => m.slug) : undefined,
    },
  ];
}
