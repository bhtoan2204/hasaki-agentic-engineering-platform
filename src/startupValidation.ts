import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { pool, q } from "./db/pool.ts";
import { config, codexConfig } from "./config.ts";
import { repositories } from "./repos/service.ts";
import { validateCheckout } from "./repos/paths.ts";

/** Optional capabilities only warn. Database/migration and identity registration failures abort startup separately. */
export async function validateLocalConfiguration(
  probe = (bin: string) => !spawnSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" }).error,
) {
  accessSync(config.dataDir, constants.R_OK | constants.W_OK);
  const warnings: string[] = [];
  const legacy = await q(pool, "SELECT key FROM settings WHERE key = ANY($1) AND value <> ''", [
    ["argocd_token", "splunk_cookie", "kafka_ui_cookie", "vault_token"],
  ]);
  if (legacy.length)
    warnings.push(
      "Legacy global browser credentials have no verified owner and are no longer loaded. Each user must reconnect Argo/Splunk/Kafka/Vault in Integrations; old rows are preserved for administrator review.",
    );
  for (const repo of await repositories.list()) {
    if (!repo.enabled || repo.repository_url) continue;
    try {
      await validateCheckout(repo);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  for (const [provider, bin] of [
    ["Claude", process.env.CLAUDE_CODE_EXECUTABLE || config.agent.claudeBin || "claude"],
    ["Codex", codexConfig().bin],
    ["Cursor", process.env.CURSOR_AGENT_BIN || config.agent.cursorBin || "agent"],
  ]) {
    if (!probe(bin))
      warnings.push(
        `${provider} CLI unavailable; install/configure it locally and authenticate before selecting this provider. Other providers remain usable.`,
      );
  }
  if (config.codeIntelligence.enabled && !probe("rg"))
    warnings.push(
      "Code intelligence live search unavailable: install ripgrep (rg) on this worker. Indexed navigation remains available.",
    );
  return warnings;
}
