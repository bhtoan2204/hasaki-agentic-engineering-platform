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
import { claudeReportReasoner, setReportReasoner, taskResultReportExecutor } from "../../report/executor.ts";
import { claudeTestFailureAdvisor, setTestFailureAdvisor } from "./testFailure.ts";
import { setKnowledgeChangeAnalyzer, setSkillDrafter } from "../../knowledge/learning.ts";
import { modelChangeAnalyzer, modelSkillDrafter } from "../../agent/learningModel.ts";

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
  registerExecutor("task_result_report", taskResultReportExecutor);
  setReportReasoner(claudeReportReasoner);
  setTestFailureAdvisor(claudeTestFailureAdvisor);
  // Continuous learning (knowledge/learning.ts): change detection and skill drafting through the run's provider.
  setKnowledgeChangeAnalyzer(modelChangeAnalyzer);
  setSkillDrafter(modelSkillDrafter);
}
