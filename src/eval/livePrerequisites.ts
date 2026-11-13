import { access, constants } from "node:fs/promises";
import { delimiter, join, isAbsolute } from "node:path";
import { config, codexConfig, antigravityConfig } from "../config.ts";
import { bwrapAvailable } from "../platform/selfDevelopment.ts";
async function executable(bin: string) {
  const candidates = isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? "").split(delimiter).map((path) => join(path, bin));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
export async function livePrerequisites(configuration: {
  provider_sequence?: Array<{ provider?: string }>;
  max_tokens: number;
  max_cost_usd: number;
}): Promise<string | null> {
  const block = (reason: string) => `Live execution is BLOCKED: ${reason}`;
  if (!config.evaluation.liveEnabled) return block("evaluation.liveEnabled is off");
  if (!configuration.provider_sequence?.length) return block("explicit provider sequence required");
  if (!(configuration.max_tokens > 0 && configuration.max_cost_usd > 0))
    return block("positive token and cost budgets required");
  if (!(await bwrapAvailable())) return block("network-isolated verification requires bubblewrap");
  for (const bin of ["initdb", "pg_ctl", "git", "tar"])
    if (!(await executable(bin))) return block(`isolated evaluation runtime missing ${bin}`);
  const bins: Record<string, string> = {
    claude: config.agent.claudeBin || "claude",
    codex: codexConfig().bin,
    cursor: process.env.CURSOR_AGENT_BIN || config.agent.cursorBin || "agent",
    antigravity: antigravityConfig().bin,
  };
  for (const agent of configuration.provider_sequence) {
    const bin = bins[agent.provider ?? ""];
    if (!bin || !(await executable(bin)))
      return block(`provider executable unavailable: ${agent.provider}`);
    if (!config.evaluation.liveUsageProviders.includes(agent.provider ?? ""))
      return block(
        `incremental usage capability has not been attested for ${agent.provider}; configure evaluation.liveUsageProviders after a mocked connector compatibility check`,
      );
  }
  return null;
}
