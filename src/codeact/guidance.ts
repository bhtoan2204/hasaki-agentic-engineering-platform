/**
 * When CodeAct is worth its overhead, and what to do when a program fails — one wording for the chat `code.execute`
 * and the workflow `execute_code` descriptions. It weighs expected work and result size, not a tool-count threshold,
 * and never forces CodeAct: the agent decides. Kept short: it is part of every tool list that offers CodeAct.
 */
export const CODEACT_GUIDANCE =
  "Prefer a direct call for one small, bounded lookup or a single piece of evidence. " +
  "Use a program when results would be large (filter or aggregate in code), several read-only results must be correlated, or direct calls would take several rounds. " +
  "On failure read `failure`/`recovery`: fix a program or argument error and retry once; narrow queries after a size or budget failure; never retry an unavailable or unauthorized capability, use direct calls.";
