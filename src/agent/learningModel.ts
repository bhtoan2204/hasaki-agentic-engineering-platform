import { completeForRun } from "./complete.ts";
import { changeAnalysisPrompt, parseSkillDraft, skillDraftPrompt, type ChangeAnalyzer, type SkillDrafter } from "../knowledge/learning.ts";

/**
 * Model-backed halves of continuous learning: one tool-less completion through the RUN's provider (Claude, Codex or
 * Cursor — same routing as repository ranking), no tools, no repository access. Their output is only a candidate:
 * knowledge/learning.ts verifies quotes, targets and scope, and nothing becomes authoritative without human approval.
 */
export const modelChangeAnalyzer: ChangeAnalyzer = async (input, run) => (await completeForRun(run, changeAnalysisPrompt(input))).text;

export const modelSkillDrafter: SkillDrafter = async (x, run) => parseSkillDraft((await completeForRun(run, skillDraftPrompt(x))).text);
