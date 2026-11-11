/**
 * Versions of the execution policies a run is executed under, stamped on the run at creation (workflow_runs.
 * policy_versions). Content-addressed: each version is a hash of the source that implements the policy, so any change
 * to a prompt template, verification rule, scope rule or context policy yields a new version without anyone having to
 * remember to bump it. Old runs keep the versions they actually used (historical accuracy); runs can be grouped and
 * compared by version (outcomes.ts), and a worse version is rolled back by reverting its source.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_POLICY_VERSION } from "../agent/independentReview.ts";
import { OUTCOME_VERSION } from "./outcomes.ts";

const SRC = join(import.meta.dirname, "..");
const POLICY_SOURCES = {
  prompt_template: ["agent/stepPrompt.ts", "workflow/templates.ts"],
  verification: ["agent/independentReview.ts", "agent/verify.ts"],
  scope: ["agent/scopeGuard.ts", "agent/evidence.ts"],
  context_retrieval: ["context/pack.ts", "context/plan.ts", "codeIntelligence/search.ts"],
  routing: ["workflow/profiles.ts", "eval/optimization.ts"],
} as const;

function digest(files: readonly string[]) {
  const h = createHash("sha256");
  for (const f of files) {
    try {
      h.update(f)
        .update("\0")
        .update(readFileSync(join(SRC, f)));
    } catch {
      h.update(f).update("\0missing");
    }
  }
  return h.digest("hex").slice(0, 12);
}

let cached: Record<string, string> | null = null;
export function executionPolicyVersions(): Record<string, string> {
  if (!cached) {
    cached = Object.fromEntries(
      Object.entries(POLICY_SOURCES).map(([k, files]) => [k, digest(files)]),
    );
    cached.review_rules = REVIEW_POLICY_VERSION;
    cached.outcome_rules = String(OUTCOME_VERSION);
  }
  return cached;
}

/** One comparable key for "same policies": the sorted version map. */
export const policyKey = (v: Record<string, string> | null | undefined) =>
  v
    ? createHash("sha256")
        .update(
          JSON.stringify(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          ),
        )
        .digest("hex")
        .slice(0, 12)
    : "unversioned";
