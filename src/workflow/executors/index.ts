import { rankRepositories } from "../../agent/repoRanking.ts";
import { registerPlatformOps } from "../../chat/platformOps.ts";
import { agentExecutor } from "../../agent/harness/executor.ts";
import {
  commandExecutor,
  conditionExecutor,
  humanApprovalExecutor,
  humanInputExecutor,
  integrationExecutor,
  pullRequestExecutor,
  registerIntegrationAction,
  runIsolatedCommand,
  setAiRepositoryRanker,
} from "./builtin.ts";
import { registerBugHuntActions } from "../../bugHunt/steps.ts";
import { registerExecutor } from "./registry.ts";
import { setMergeModel } from "./branchMerge.ts";
import { registerBuiltinTools } from "../../agent/toolRegistry.ts";
import {
  setReportReasoner,
  taskResultReportExecutor,
  workflowReportReasoner,
} from "../../report/executor.ts";
import { providerTestFailureAdvisor, setTestFailureAdvisor } from "./testFailure.ts";
import { setKnowledgeChangeAnalyzer, setSkillDrafter } from "../../knowledge/learning.ts";
import { modelChangeAnalyzer, modelSkillDrafter } from "../../agent/learningModel.ts";
import { completeForRun } from "../../agent/complete.ts";
import { setFeedbackModel } from "../engine.ts";

/** StepExecutorRegistry defaults. Tests replace individual entries with registerExecutor(). */
export function registerDefaultExecutors() {
  registerExecutor("agent", agentExecutor);
  registerExecutor("coding_agent", agentExecutor);
  registerExecutor("human_input", humanInputExecutor);
  registerExecutor("human_approval", humanApprovalExecutor);
  registerExecutor("condition", conditionExecutor);
  registerExecutor("command", commandExecutor);
  registerExecutor("integration", integrationExecutor);
  registerBugHuntActions(registerIntegrationAction, runIsolatedCommand);
  registerExecutor("git_pull_request", pullRequestExecutor);
  setAiRepositoryRanker(rankRepositories);
  registerBuiltinTools();
  registerPlatformOps();
  registerExecutor("task_result_report", taskResultReportExecutor);
  setReportReasoner(workflowReportReasoner);
  setTestFailureAdvisor(providerTestFailureAdvisor);
  // Continuous learning (knowledge/learning.ts): change detection and skill drafting through the run's provider.
  setKnowledgeChangeAnalyzer(modelChangeAnalyzer);
  setSkillDrafter(modelSkillDrafter);
  // Feedback routing: one classification call through the run's provider (engine falls back to cues without it).
  setFeedbackModel(async (run, prompt) => (await completeForRun(run, prompt)).text);
  setMergeModel(async (run, prompt, signal) => (await completeForRun(run, prompt, signal)).text);
}
