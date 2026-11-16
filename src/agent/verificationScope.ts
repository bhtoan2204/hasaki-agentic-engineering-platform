import type { BusinessRisk } from "../workflow/profileTransitions.ts";
export interface VerificationScopeInput {
  files: string[];
  approvedFiles: string[];
  impactKnown: boolean;
  risk: BusinessRisk;
  /** All commands come from the versioned workflow, never agent output or repository text. */
  mandatory: string;
  targeted?: string;
  broad?: string;
}
export function selectVerificationScope(input: VerificationScopeInput) {
  const sensitive =
    /(^|\/)(auth|security|migrations?|config|permissions?)(\/|\.)|(^|\/)(package-lock\.json|go\.sum|go\.mod|Dockerfile)$/i;
  const escalate =
    !input.impactKnown ||
    input.risk !== "low" ||
    !input.files.length ||
    input.files.some((file) => !input.approvedFiles.includes(file) || sensitive.test(file));
  return {
    commands: [
      ...new Set(
        [input.mandatory, escalate ? input.broad : input.targeted].filter((s): s is string => !!s),
      ),
    ],
    mode: escalate ? "broad" : "targeted",
    escalate,
    reasons: [
      escalate
        ? "risk, scope or dependency impact requires broader verification"
        : "verified low-risk dependency impact",
    ],
  };
}
