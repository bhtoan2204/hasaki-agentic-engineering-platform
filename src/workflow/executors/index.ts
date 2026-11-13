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
import {
  claudeReportReasoner,
  setReportReasoner,
  taskResultReportExecutor,
} from "../../report/executor.ts";
import { claudeTestFailureAdvisor, setTestFailureAdvisor } from "./testFailure.ts";
import { setKnowledgeChangeAnalyzer, setSkillDrafter } from "../../knowledge/learning.ts";
import { modelChangeAnalyzer, modelSkillDrafter } from "../../agent/learningModel.ts";
import { config } from "../../config.ts";
import { decisionEngine } from "../../decision/index.ts";
import { completeForRun } from "../../agent/complete.ts";
import { setFeedbackModel } from "../engine.ts";

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
  // Feedback routing uses the shared decision engine when enabled; legacy provider routing remains unchanged otherwise.
  setFeedbackModel(async (run, prompt, complexity = "medium") => {
    if (!config.decisionEngine.enabled) return (await completeForRun(run, prompt)).text;
    const result = await decisionEngine.decide({
      type: "feedback",
      input: prompt,
      complexity,
      scope: { runId: run.id, revision: JSON.stringify(run.graph) },
    });
    return JSON.stringify(result.decision);
  });
}
