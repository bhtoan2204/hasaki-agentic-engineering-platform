/** The kinds of shared analyses (shared_analyses.kind). */
export const SHARED_KINDS = [
  "prod_error.runtime_rca",
  "prod_error.bug_hunt",
  "code_assessment",
] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];
