import { codeAssessmentKey, rubricHash, modelOf } from "../../src/sharing/key.ts";

/** A key built from an installation id: proves the id from the database is a valid key scope. */
export async function assessKeyForTest(scope: string) {
  return codeAssessmentKey({
    scope,
    repos: [{ repo: "oms-api", commit: "a".repeat(40) }],
    workflow: { key: "codebase-assessment", version: 1 },
    rubricHash: rubricHash({ instructions: "x" }),
    model: modelOf("claude", "claude-opus-5-5"),
  }).key;
}
