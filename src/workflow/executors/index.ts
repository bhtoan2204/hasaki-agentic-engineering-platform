import { claudeExecutor, rankRepositoriesWithClaude } from "../../agent/claude.ts";
import {
  commandExecutor,
  conditionExecutor,
  humanApprovalExecutor,
  humanInputExecutor,
  integrationExecutor,
  pullRequestExecutor,
  setAiRepositoryRanker,
} from "./builtin.ts";
import { registerExecutor } from "./registry.ts";
import { registerBuiltinTools } from "../../agent/toolRegistry.ts";

/** StepExecutorRegistry defaults. Tests replace individual entries with registerExecutor(). */
export function registerDefaultExecutors() {
  registerExecutor("agent", claudeExecutor);
  registerExecutor("coding_agent", claudeExecutor);
  registerExecutor("human_input", humanInputExecutor);
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("condition", conditionExecutor);
  registerExecutor("command", commandExecutor);
  registerExecutor("integration", integrationExecutor);
  registerExecutor("git_pull_request", pullRequestExecutor);
  setAiRepositoryRanker(rankRepositoriesWithClaude);
  registerBuiltinTools();
}
