// Compatibility facade: the workflow engine lives in src/workflow/engine/*.ts (see
// docs/architecture/workflow-engine-modularization.md). Every name exported from here before the split still is.
export { listCodeScans, listRuns, openQuestions, answeredQuestions } from "./runRepository.ts";
export { releaseAttempt, safeRecovery } from "./recovery.ts";
export { advance } from "./progression.ts";
export { EngineError } from "./mutations.ts";
export {
  REPORT_STEP_KEY,
  withReportStep,
  withCleanupStep,
  resolveRunGraph,
  previewRun,
  startRun,
  expandSubtasks,
  startPendingRun,
  startPendingRunInTx,
  setRunBranches,
} from "./engine/runCreation.ts";
export type { StartRunInput, ResolvedRunGraph } from "./engine/runCreation.ts";
export { getRun } from "./engine/shared.ts";
export type { WorkflowActionGuard } from "./engine/shared.ts";
export {
  pauseRun,
  resumeRun,
  cancelRun,
  cancelLockedRun,
  runStepNow,
  stopStep,
  skipStep,
  setStepAgent,
} from "./engine/runControl.ts";
export { selectRepositories } from "./engine/repositorySelection.ts";
export {
  previewReplay,
  reexecuteStep,
  retryStep,
  setFeedbackModel,
  classifyRunFeedback,
  sendFeedback,
} from "./engine/reexecution.ts";
export { answerQuestions, approveStep, rejectStep } from "./engine/decisions.ts";
export type { BegunAttempt, PreparedHandoff } from "./engine/types.ts";
export {
  previewJob,
  beginAttempt,
  heartbeat,
  insertQuestions,
  reapExpiredLeases,
  finishAttempt,
} from "./engine/attempts.ts";
export type { JobPreview } from "./engine/attempts.ts";
export { runDetail, stepDetail, openApprovals } from "./engine/queries.ts";
export {
  prepareProviderPause,
  continueHealthyHandoffForAttempt,
  requestProviderHandoff,
  ResumeHandoff,
  resumeProviderHandoff,
  processAutomaticHandoff,
  providerHandoffOptions,
} from "./engine/handoff.ts";
